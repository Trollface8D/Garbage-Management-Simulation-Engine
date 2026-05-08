import json
import pathlib
from typing import Any, Dict, List, Optional, TYPE_CHECKING

if TYPE_CHECKING:
    from .entity_object_template import entity_object
    from .policy_template import Policy

# ---------------------------------------------------------
# THE MEDIATOR (Environment)
# ---------------------------------------------------------
class SimulationEnvironment:
    """
    Acts as the Mediator. All entities can talk to the environment.

    The environment maintains:
    1. entity_objects (both active and passive)
    2. Global properties that affect all entity_objects
    3. Global policies and system behaviors
    4. Map graph loaded from map.json (nodes + edges + adjacency)

    Active entity_objects can modify global properties through set_property().
    All entity_objects can observe global properties through get_property().
    """
    def __init__(self, entities: list = None, policies: list = None):
        self.entities: List['entity_object'] = list(entities or [])
        self.entity_objects: List['entity_object'] = self.entities  # alias
        self.policies: List['Policy'] = list(policies or [])
        self.behaviors: list = []

        # Global properties that affect all entity_objects
        self._global_properties: Dict[str, Any] = {}

        # Map graph loaded from map.json
        self._nodes: Dict[str, dict] = {}
        self._edges: List[dict] = []
        self._adjacency: Dict[str, List[str]] = {}
        self._load_map()

        # Backward compatibility
        self.stakeholders = []
        self.objects = []

    # ==================== MAP LOADING ====================

    def _load_map(self) -> None:
        """Load map.json from same directory as this file. Silent no-op if absent."""
        map_path = pathlib.Path(__file__).parent / "map.json"
        if map_path.exists():
            try:
                data = json.loads(map_path.read_text(encoding="utf-8"))
                for n in data.get("nodes", []):
                    self._nodes[n["id"]] = n
                self._edges = data.get("edges", [])
                for n in data.get("nodes", []):
                    self._adjacency[n["id"]] = n.get("neighbors", [])
            except Exception:
                pass

    # ==================== MAP ACCESSORS ====================

    def get_nodes(self, type: str = None) -> List[dict]:
        """Return all nodes, optionally filtered by type."""
        nodes = list(self._nodes.values())
        return [n for n in nodes if n.get("type") == type] if type else nodes

    def get_node(self, node_id: str) -> Optional[dict]:
        """Return a single node dict by id, or None."""
        return self._nodes.get(node_id)

    def get_edges(self) -> List[dict]:
        """Return all edge dicts."""
        return list(self._edges)

    def get_neighbors(self, node_id: str) -> List[str]:
        """Return list of neighbor node IDs for a given node."""
        return list(self._adjacency.get(node_id, []))

    def get_node_types(self) -> List[str]:
        """Return list of distinct node type strings present in the map."""
        return list({n.get("type") for n in self._nodes.values() if n.get("type")})

    # ==================== TICK / TIME STEP ====================

    def tick(self, dt: float) -> None:
        """Advance simulation by dt seconds."""
        for policy in self.policies:
            if hasattr(policy, "before_tick"):
                policy.before_tick(self, dt)
        for entity in self.entities:
            entity.step(dt, self)
        for policy in self.policies:
            if hasattr(policy, "after_tick"):
                policy.after_tick(self, dt)

    # ==================== ENTITY MANAGEMENT ====================

    def register_entity_object(self, entity_object: 'entity_object'):
        if entity_object not in self.entity_objects:
            self.entity_objects.append(entity_object)

    def unregister_entity_object(self, entity_object_id: str):
        self.entity_objects = [a for a in self.entity_objects if a.entity_object_id != entity_object_id]

    def get_entity_object(self, entity_object_id: str) -> Optional['entity_object']:
        for entity_object in self.entity_objects:
            if entity_object.entity_object_id == entity_object_id:
                return entity_object
        return None

    def get_all_entity_objects(self) -> List['entity_object']:
        return self.entity_objects.copy()

    # ==================== GLOBAL PROPERTY MANAGEMENT ====================

    def set_property(self, key: str, value: Any):
        self._global_properties[key] = value

    def get_property(self, key: str, default: Any = None) -> Any:
        return self._global_properties.get(key, default)

    def get_all_properties(self) -> Dict[str, Any]:
        return self._global_properties.copy()

    def remove_property(self, key: str):
        if key in self._global_properties:
            del self._global_properties[key]

    # ==================== POLICY MANAGEMENT ====================

    def add_global_policy(self, policy: 'Policy'):
        if policy not in self.policies:
            self.policies.append(policy)

    def remove_global_policy(self, policy_name: str):
        self.policies = [p for p in self.policies if p.policy_name != policy_name]

    def get_global_policies(self) -> List['Policy']:
        return self.policies.copy()

    # ==================== BACKWARD COMPATIBILITY ====================

    def register_entity(self, entity):
        self.register_entity_object(entity)
