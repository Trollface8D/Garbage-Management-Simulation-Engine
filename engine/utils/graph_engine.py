import networkx as nx

import json
import uuid
from pathlib import Path
from typing import Dict, List, Tuple, Any, Optional
import networkx as nx
from enum import Enum
from pydantic import BaseModel

# Assuming GraphVecDB is in utils/vector_db.py
from utils.vector_db import GraphVecDB

# --- Constants & Schemas ---
DEFAULT_RELATE_THRESHOLD: float = 0.66

class EdgeRole(str, Enum):
    HAS_CAUSE = "HAS_CAUSE"
    HAS_EFFECT = "HAS_EFFECT"
    IS_CLOSE_RELATIVE = "IS_CLOSE_RELATIVE"

class EdgeAssignment(BaseModel):
    role: EdgeRole

# --- 1. Graph Construction Logic ---

def _add_entity_node(
    G: nx.DiGraph, 
    vecdb: GraphVecDB, 
    entity_name: str, 
    threshold: float
) -> str:
    """Helper to add an entity node, checking for semantic similarity to existing nodes."""
    node_id: str = entity_name.replace(" ", "_")
    
    # Search for similar existing nodes
    search_results = vecdb.search(entity_name, top_k=5)
    
    max_confidence: float = 0.0
    relate_node_id: str = ""
    
    if search_results:
        # Simple relateness calculation based on your PoC
        top_match = search_results[0]
        scores = [res['score'] for res in search_results if res['id'] == top_match['id']]
        max_confidence = sum(scores) / len(scores) if scores else 0.0
        relate_node_id = top_match['id']

    if max_confidence > threshold and relate_node_id != node_id:
        # Link to existing semantic relative
        G.add_node(node_id, label=entity_name, type="Entity", synonyms=[entity_name])
        edge_data = EdgeAssignment(role=EdgeRole.IS_CLOSE_RELATIVE)
        G.add_edge(relate_node_id, node_id, role=edge_data.role)
        vecdb.add_entity(node_id, entity_name)
    else:
        # Create entirely new distinct node
        G.add_node(node_id, label=entity_name, type="Entity", synonyms=[entity_name])
        vecdb.add_entity(node_id, entity_name)
        
    return node_id

def build_graph_from_json(
    source_json_path: str | Path, 
    model_name: str, 
    threshold: float = DEFAULT_RELATE_THRESHOLD
) -> Tuple[str, str]:
    """Reads extracted JSON, builds the NetworkX graph and VectorDB, and saves them."""
    G = nx.DiGraph()
    vecdb = GraphVecDB(model_name)
    
    file_path = Path(source_json_path)
    with open(file_path, 'r', encoding='utf-8') as f:
        data = json.load(f)
        
    # Handle the list of dictionaries from our extraction page output
    for record in data:
        relationship: str = record.get("relationship", "")
        head: str = record.get("subject", "")
        tail: str = record.get("object", "")
        detail: str = record.get("reasoning", "")
        
        if not relationship or not head or not tail:
            continue

        event_id: str = relationship.replace(" ", "_")
        
        if not G.has_node(event_id):
            event_id = f"{event_id}_{str(uuid.uuid4())[:4]}"
            G.add_node(
                event_id, 
                type="CausalEvent", 
                description=relationship,
                detail=detail,
                pattern=record.get("pattern_type", ""),
                source_citation=record.get("source_text", "")
            )
            vecdb.add_entity(event_id, relationship)

        # Process Head (Cause)
        node_id = _add_entity_node(G, vecdb, head, threshold)
        cause_edge = EdgeAssignment(role=EdgeRole.HAS_CAUSE)
        G.add_edge(node_id, event_id, role=cause_edge.role)

        # Process Tail (Effect)
        obj_id = _add_entity_node(G, vecdb, tail, threshold)
        effect_edge = EdgeAssignment(role=EdgeRole.HAS_EFFECT)
        G.add_edge(event_id, obj_id, role=effect_edge.role)

    # Save outputs
    save_dir = Path(file_path.parent.parent / "kg_indexes")
    save_dir.mkdir(parents=True, exist_ok=True)
    
    graph_filename = f"graph_{file_path.stem}.pickle"
    db_filename = f"vecdb_{file_path.stem}.pt"
    
    nx.write_pickle(G, save_dir / graph_filename)
    vecdb.save(save_dir / db_filename)
    
    return str(save_dir / graph_filename), str(save_dir / db_filename)


# --- 2. GraphRAG Engine Logic ---

class GraphRAGEngine:
    def __init__(self, graph_path: str | Path):
        self.G = nx.read_pickle(Path(graph_path)) if graph_path else nx.DiGraph()

    def exhaustive_retrieval(self, start_node_id: str, max_depth: int = 3) -> Dict[str, Any]:
        """Exhaustively traverses the graph to map out all behaviors."""
        visited = set()
        
        def trace_chain(node_id: str, depth: int) -> List[Dict[str, Any]]:
            if depth > max_depth or node_id in visited:
                return []
            
            visited.add(node_id)
            chains = []
            
            for neighbor in self.G.successors(node_id):
                edge_data = self.G.get_edge_data(node_id, neighbor)
                node_data = self.G.nodes[neighbor]
                
                step = {
                    "relation": edge_data.get("role"),
                    "type": node_data.get("type"),
                    "label": node_data.get("label") or node_data.get("description"),
                    "pattern": node_data.get("pattern"),
                    "detail": node_data.get("detail"),
                    "depth": depth,
                    "next_steps": trace_chain(neighbor, depth + 1)
                }
                chains.append(step)
            return chains

        return {
            "root": start_node_id,
            "paths": trace_chain(start_node_id, 0)
        }

    def to_llm_context(self, result_dict: Dict[str, Any], indent: int = 0) -> str:
        """Formats the nested graph traversal into a readable 'Logic Story' string for the LLM."""
        output: str = ""
        if indent == 0:
            output += f"LOGIC SOURCE: {result_dict.get('root', 'Unknown')}\n"
            
        for path in result_dict.get('paths', []):
            spacing = "  " * indent
            rel = path.get('relation', 'UNKNOWN_RELATION')
            label = path.get('label', 'Unknown')
            
            if rel == EdgeRole.HAS_CAUSE.value:
                line = f"{spacing}└── DO: {label} (Pattern: {path.get('pattern', 'N/A')})"
            elif rel == EdgeRole.HAS_EFFECT.value:
                line = f"{spacing}└── TO: {label}"
            else:
                line = f"{spacing}└── [{rel}]: {label}"
                
            output += line + "\n"
            
            if path.get('detail'):
                output += f"{spacing}    DETAIL: {path['detail']}\n"
                
            if path.get('next_steps'):
                output += self.to_llm_context({"paths": path['next_steps']}, indent + 1)
                
        return output