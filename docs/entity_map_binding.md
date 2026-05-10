# Entity–Map Binding Plan

## Problem

Three gaps make simulation behaviour inaccurate:

1. **No entity→node binding.** Entities of conceptual type `place` (sorting facility, collection point) and `equipment` (trash bin, truck depot) are not linked to map nodes. Generated code cannot query "where is this entity on the map," so logic like "go to trash bin to collect waste" degenerates into abstract calls with no spatial grounding.

2. **Multi-instance placement is wrong.** When the scenario has 3 trash bins at different map nodes, the pipeline emits one entity class with no per-instance location. All instances are effectively at the same conceptual point; behaviour diverges from physical reality.

3. **Traversal time is unmodelled.** Map edges carry a `weight` field but nothing converts weight to time. Policies that depend on "agent arrives at node X after T seconds" have no API to call, so generated code either ignores travel or hardcodes guesses.

---

## Root Cause — Where Each Gap Lives

| Gap | Current state | Missing |
|-----|--------------|---------|
| No entity→node binding | `state1` classifies entities as `actor / resource / environment / policy` | `place` and `equipment` types; a binding stage that maps entity_id → node_id(s) |
| Multi-instance placement | `state3` constructs one instance per entity class | Per-node instantiation loop using binding table |
| Traversal time | `environment_template.py` has `get_neighbors()` only | `get_travel_time(from, to, speed)` and `get_path(from, to)` via weighted shortest-path |

---

## Proposed Pipeline Additions

### 1. Extend Entity Type Vocabulary (State 1)

Add two new type values to `STATE1_ENTITY_LIST_SCHEMA`:

```
"type": { "enum": ["actor", "resource", "environment", "policy", "place", "equipment"] }
```

**Guidance in prompt:**
- `place` — a named location that entities travel *to* (sorting facility, collection zone, disposal site)
- `equipment` — a physical object fixed at one or more map nodes (trash bin, recycling station)
- `actor` — remains for mobile agents (worker, truck driver, vehicle)

This change is backward-compatible: existing `actor / resource` still valid.

---

### 2. New Stage: `state1d_entity_map_binding`

**Position in pipeline:** after `state1c_entity_dependencies`, before `state2_code_entity_object`.

**Trigger condition:** map graph is present AND at least one entity has type `place` or `equipment`.

**Inputs:**
- `state1_entity_list.entities` — entity objects
- `mapGraph.nodes` — map node list with `id`, `label`, `type`, `x`, `y`

**What it does:**  
LLM receives entity labels (filtered to `place`/`equipment`) and map node labels. It outputs a binding table matching each entity to zero-or-more map node IDs, plus an instance count and confidence.

**Output schema:**
```json
{
  "bindings": [
    {
      "entity_id": "trash_bin",
      "map_node_ids": ["node_B", "node_D", "node_G"],
      "instance_count": 3,
      "confidence": 0.91
    },
    {
      "entity_id": "sorting_facility",
      "map_node_ids": ["node_F"],
      "instance_count": 1,
      "confidence": 0.95
    }
  ]
}
```

**Fallback:** if no map graph or no matching entities → stage emits `{"bindings": []}` and pipeline continues unchanged.

**Checkpoint key:** `state1d_entity_map_binding`

---

### 3. Propagate Bindings into State 2 Entity Code

Each entity object generated in `state2_code_entity_object` must receive its binding.

Changes to `build_state2_code_entity_prompt`:
- Inject per-entity binding: `map_node_ids` list and `instance_count`
- For `equipment`/`place` entities: template initialises `self.node_id: str` from constructor argument
- Prompt rule: "if `map_node_ids` is non-empty, the class `__init__` must accept `node_id: str` and store it as `self.node_id`"

Entity class skeleton for `equipment`/`place`:
```python
class Entity_TrashBin(entity_object):
    def __init__(self, entity_id: str, node_id: str, env=None):
        super().__init__(entity_id, env)
        self.node_id = node_id          # bound map node
        self.fill_level: float = 0.0
    ...
```

For mobile `actor` entities that need current position:
```python
class Entity_Worker(entity_object):
    def __init__(self, entity_id: str, env=None):
        super().__init__(entity_id, env)
        self.current_node_id: str | None = None  # changes during traversal
    ...
```

---

### 4. Multi-Instance Instantiation in State 3 (Environment)

`_stage_state3_code_environment` already writes `environment.py`. With binding data available it must:

1. Read `state1d_entity_map_binding` checkpoint.
2. For each binding with `instance_count > 1`, emit a loop that instantiates the entity class once per node:

```python
# generated inside environment constructor
for i, nid in enumerate(["node_B", "node_D", "node_G"]):
    self.entities.append(Entity_TrashBin(f"trash_bin_{i}", node_id=nid, env=self))
```

3. For `instance_count == 1`, emit a single instantiation with `node_id=map_node_ids[0]`.

4. Entities with no binding (`map_node_ids == []`) are instantiated without `node_id` (current behaviour preserved).

---

### 5. Environment API — Traversal & Binding Accessors

Add to `environment_template.py`:

```python
import heapq

# ==================== ENTITY-NODE BINDING ====================

def get_entity_nodes(self, entity_id: str) -> List[str]:
    """Return all map node IDs bound to entities with matching entity_id prefix."""
    return [
        e.node_id
        for e in self.entities
        if hasattr(e, "node_id") and e.entity_id.startswith(entity_id)
    ]

def get_entity_at_node(self, node_id: str) -> Optional['entity_object']:
    """Return the entity whose node_id equals node_id, or None."""
    for e in self.entities:
        if getattr(e, "node_id", None) == node_id:
            return e
    return None

# ==================== TRAVERSAL ====================

def get_path(self, from_node: str, to_node: str) -> List[str]:
    """Dijkstra shortest path by edge weight. Returns node_id list including endpoints."""
    dist: Dict[str, float] = {from_node: 0.0}
    prev: Dict[str, str | None] = {from_node: None}
    pq = [(0.0, from_node)]
    while pq:
        d, u = heapq.heappop(pq)
        if u == to_node:
            break
        if d > dist.get(u, float("inf")):
            continue
        for edge in self._edges:
            v = None
            if edge.get("source") == u:
                v = edge.get("target")
            elif edge.get("target") == u:
                v = edge.get("source")  # undirected fallback
            if v and v in self._nodes:
                nd = d + float(edge.get("weight", 1.0))
                if nd < dist.get(v, float("inf")):
                    dist[v] = nd
                    prev[v] = u
                    heapq.heappush(pq, (nd, v))
    if to_node not in prev:
        return []
    path, cur = [], to_node
    while cur is not None:
        path.append(cur)
        cur = prev.get(cur)
    return list(reversed(path))

def get_travel_time(self, from_node: str, to_node: str, speed: float = 1.0) -> float:
    """Total weighted path distance divided by speed. Returns inf if unreachable."""
    path = self.get_path(from_node, to_node)
    if len(path) < 2:
        return 0.0 if from_node == to_node else float("inf")
    total = 0.0
    for i in range(len(path) - 1):
        u, v = path[i], path[i + 1]
        edge = next(
            (e for e in self._edges
             if (e.get("source") == u and e.get("target") == v)
             or (e.get("target") == u and e.get("source") == v)),
            None,
        )
        total += float(edge.get("weight", 1.0)) if edge else 1.0
    return total / max(speed, 1e-9)
```

Update `_MAP_ACCESSOR_API_SUMMARY` in `code_gen_runner.py`:
```
env.get_entity_nodes(entity_id) -> list[str]    # node_ids of all instances
env.get_entity_at_node(node_id) -> entity|None  # entity sitting at that node
env.get_path(from_node, to_node) -> list[str]   # shortest node_id path
env.get_travel_time(from, to, speed=1.0) -> float  # total seconds/units to traverse
```

---

## Implementation Sequence

| Step | File(s) | Work |
|------|---------|------|
| 1 | `code_gen_prompts.py` | Add `place`, `equipment` to `STATE1_ENTITY_LIST_SCHEMA` enum and `STATE1_ENTITY_LIST_SCHEMA_TEXT` guidance |
| 2 | `code_gen_prompts.py` | Add `build_state1d_entity_map_binding_prompt()` and its JSON schema |
| 3 | `code_gen_runner.py` | Implement `_stage_state1d_entity_map_binding()` stage function |
| 4 | `code_gen_runner.py` | Wire stage into pipeline dispatch after `state1c` |
| 5 | `code_gen_prompts.py` | Inject binding into `build_state2_code_entity_prompt()` |
| 6 | `code_gen_runner.py` | Read binding in `_stage_state3_code_environment()` → emit per-node instantiation loop |
| 7 | `templates/environment_template.py` | Add `get_entity_nodes`, `get_entity_at_node`, `get_path`, `get_travel_time` |
| 8 | `code_gen_runner.py` | Update `_MAP_ACCESSOR_API_SUMMARY` constant |

---

## What Does NOT Change

- Entities with type `actor`/`resource`/`policy` — no binding required, instantiation unchanged.
- Map extraction pipeline (`map_extract_runner.py`) — reads, does not write.
- Frontend payload format — `mapGraph` field already carries `vertices`+`edges`; no API contract change.
- Jobs with no map graph — binding stage no-ops, full backward compatibility.

---

## Open Questions

1. **Binding confidence threshold** — below what confidence do we treat a match as unbound? Suggest 0.70 as default, configurable via `runtime_prompts`.
2. **Directed vs undirected edges** — `get_path` currently treats edges as undirected fallback. If map edges are directional (one-way roads), we should only follow directed edges. Map extract pipeline needs to surface this.
3. **Dynamic relocation** — actors like trucks change `current_node_id` during simulation. Do we need `env.move_entity(entity_id, to_node)` as a first-class API, or is direct attribute mutation sufficient for generated code?
