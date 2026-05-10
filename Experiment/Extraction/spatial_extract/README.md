# Spatial (Map) Extraction — Schema Reference

> **⚠️ IN PROGRESS** — No standalone experiment notebooks yet. The spatial extraction pipeline lives entirely in the engine (`engine/backend/`). This document captures the schema derived from the implementation code. Add experiment notebooks here as prompt iterations are conducted.

Schema source files:
- `engine/backend/app/response_schema/map_extract_nodes.schema.json`
- `engine/backend/app/response_schema/map_extract_edges.schema.json`
- `engine/backend/app/models/job_models.py`
- `engine/backend/prompt/map_extarct.json`

---

## Purpose

The map extraction pipeline reads physical campus maps (images, PDFs, floor plan photos) and produces a structured node-edge graph. This graph is consumed by the code generation pipeline to:

1. Ground entity placement — `place` and `equipment` entities are bound to specific nodes (`state1d_entity_map_binding`)
2. Enable traversal computation — `env.get_path()` / `env.get_travel_time()` use the edge graph for Dijkstra shortest-path
3. Support multi-instance instantiation — if 3 trash bins appear at 3 nodes, the environment instantiates 3 entity objects

Without map data the code generation pipeline falls back to a spatial-stub environment (no real traversal distances).

---

## Node Schema

```json
{
  "nodes": [
    {
      "id":       "string",       // required
      "label":    "string",       // required
      "type":     "string",       // optional — semantic type (e.g. "bin", "corridor", "building")
      "x":        number,         // optional — pixel x position on source image
      "y":        number,         // optional — pixel y position on source image
      "metadata": {}              // optional — free-form key-value bag
    }
  ]
}
```

### Field Justification

| Field | Required | Why |
|---|---|---|
| `id` | Yes | Stable key used by edges (`source`/`target`) and by entity-map binding to reference locations |
| `label` | Yes | Human-readable name used by the LLM entity-map binding stage to match entity labels to nodes via semantic similarity |
| `type` | No | Semantic category (bin, corridor, collection point, road, etc.) — helps the binding stage distinguish traversal nodes from location nodes |
| `x`, `y` | No | Pixel coordinates from source image; used for visual rendering and spatial distance estimation when edge weights are absent |
| `metadata` | No | Capacity, accessibility notes, floor level — any domain attribute the map extraction stage identifies |

**Only `id` and `label` are required** because the LLM may fail to infer coordinates or types from low-resolution map images. Missing optional fields degrade spatial accuracy but do not block code generation.

---

## Edge Schema

```json
{
  "edges": [
    {
      "id":               "string",   // optional
      "source":           "string",   // required — node id
      "target":           "string",   // required — node id
      "approximate_cost": number,     // optional — traversal cost (distance in metres or pixel-derived units)
      "label":            "string"    // optional — description of connection
    }
  ]
}
```

### Field Justification

| Field | Required | Why |
|---|---|---|
| `source` | Yes | Origin node id — must match a node in the nodes list |
| `target` | Yes | Destination node id — must match a node in the nodes list |
| `id` | No | Optional stable identifier for the edge; used by UI for edit tracking |
| `approximate_cost` | No | Traversal weight used by Dijkstra in `env.get_path()` and `env.get_travel_time()`. Named "approximate" because values come from pixel distance estimation, not ground-truth measurement. Defaults to `1.0` if absent. |
| `label` | No | Human-readable description (e.g., "outdoor path between building A and sorting facility") — used in entity-map binding fuzzy matching |

**`approximate_cost` is the edge weight** used by `env.get_travel_time(from, to, speed)`. When absent, all edges have equal weight 1.0, making the simulation path-length-correct but not time-accurate. Actual ground-truth distances were not measured; values are estimated from pixel coordinates.

> **Known limitation:** edges are currently treated as **undirected** in `env.get_path()` (bidirectional fallback). One-way paths (e.g., a one-way service road) cannot be modelled until the map extraction pipeline surfaces edge directionality. See `docs/entity_map_binding.md` — Open Questions §2.

---

## Full Example Graph

```json
{
  "nodes": [
    { "id": "node_A", "label": "Building 4 lobby",       "type": "building_entry", "x": 120, "y": 340 },
    { "id": "node_B", "label": "Outdoor trash bin #1",   "type": "bin",            "x": 200, "y": 420 },
    { "id": "node_C", "label": "Sorting facility",        "type": "facility",       "x": 450, "y": 380 },
    { "id": "node_D", "label": "Truck collection point",  "type": "collection",     "x": 600, "y": 400 }
  ],
  "edges": [
    { "source": "node_A", "target": "node_B", "approximate_cost": 45,  "label": "outdoor path" },
    { "source": "node_B", "target": "node_C", "approximate_cost": 120, "label": "outdoor path" },
    { "source": "node_C", "target": "node_D", "approximate_cost": 80,  "label": "service road" }
  ]
}
```

---

## Pipeline Stages

The map extraction runs as a multi-stage background job (6 stages). Each stage is checkpointed independently.

```
extractmap_symbol   → identify map symbols and spatial markers from image
extractmap_text     → OCR / extract text labels from map
tabular_extraction  → structure location data into tabular form
support_enrichment  → enrich nodes with semantic metadata (type, function)
edge_extraction     → identify traversal connections; estimate approximate_cost from pixel distance
finalize_graph      → merge all stage outputs into {nodes, edges} JSON
```

**Checkpoint location:** `engine/data/map_extract_jobs/<job_id>/`

Each stage checkpoint is a JSON file (`<stage_name>.json`). The final graph is assembled in `finalize_graph.json`.

**Cold-start recovery:** if the backend restarts mid-job, `/status` reconstructs job state from disk checkpoints. Resume re-runs only the failed stage onward.

---

## Prompt Reference

Prompt template: `engine/backend/prompt/map_extarct.json`
Prompt flow doc: `engine/backend/prompt/map_extract_prompt_flow.md`

---

## How This Connects to Code Generation

After map extraction completes, the job result is passed to the code generation pipeline as `mapGraph`:

```json
{
  "mapGraph": {
    "nodes": [...],
    "edges": [...]
  }
}
```

Stage `state1d_entity_map_binding` (planned — see `docs/entity_map_binding.md`) uses the node labels to bind entity types `place` and `equipment` to specific node IDs. The environment generator then instantiates one entity object per bound node.

If no map graph is provided, `state3_code_environment` uses `codegen_fallback_map_policy` to generate a spatial-stub class with a warning comment. The simulation still runs but without real traversal geometry.

---

## Adding Experiments Here

When prompt iteration for map extraction begins, add notebooks/scripts to this directory:

```
Experiment/Extraction/spatial_extract/
├── README.md                  # This file
├── notebooks/                 # Prompt comparison notebooks
├── sample_maps/               # Test map images
└── outputs/                   # Extraction results for evaluation
```

Compare extraction quality by running the same map image through different prompt versions and inspecting the `nodes`/`edges` output for:
- Label accuracy (do node labels match ground-truth location names?)
- Edge connectivity (are all traversable paths captured?)
- `approximate_cost` plausibility (do distances roughly match real distances?)
