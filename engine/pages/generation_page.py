import dash
from dash import html, dcc, callback, Input, Output, State, no_update
import dash_bootstrap_components as dbc
import dash_cytoscape as cyto
import networkx as nx
from pathlib import Path
import os

from utils.graph_engine import build_graph_from_json, GraphRAGEngine
from utils.vector_db import GraphVecDB

try:
    from utils.gemini import GeminiClient
    from config import API_KEY
except ImportError:
    API_KEY = None

dash.register_page(__name__, path='/code-generation', name='Code Generation')

# --- Directory Constants ---
PROJECT_ROOT = Path(__file__).parent.parent
OUTPUT_DIR = PROJECT_ROOT / "data_extract" / "output"
KG_INDEX_DIR = PROJECT_ROOT / "data_extract" / "kg_indexes"

def get_extracted_jsons():
    if OUTPUT_DIR.exists():
        return [f.name for f in OUTPUT_DIR.glob('*.json') if f.name != "validation_scores_saved.json"]
    return []

def get_saved_graphs():
    if KG_INDEX_DIR.exists():
        return [f.name for f in KG_INDEX_DIR.glob('*.pickle')]
    return []

# --- Layout ---
layout = dbc.Container([
    html.H2("Code Generation & GraphRAG Studio", className="mb-4"),
    
    dbc.Row([
        # --- SIDEBAR CONFIGURATION ---
        dbc.Col([
            dbc.Card([
                dbc.CardHeader("Pipeline Configuration", className="fw-bold"),
                dbc.CardBody([
                    dbc.Label("LLM Strategy:"),
                    dbc.RadioItems(
                        id="llm-strategy-radio",
                        options=[
                            {"label": "Zero-Shot (Raw Data)", "value": "zero_shot"},
                            {"label": "GraphRAG Assisted", "value": "graph_rag"}
                        ],
                        value="graph_rag",
                        className="mb-4"
                    ),
                    
                    html.Div(id="graph-selection-container", children=[
                        dbc.Label("Select Knowledge Graph:"),
                        dbc.Select(
                            id="active-graph-select",
                            options=[{"label": g, "value": g} for g in get_saved_graphs()],
                            className="mb-3"
                        )
                    ])
                ])
            ], className="mb-4")
        ], width=3),
        
        # --- MAIN CONTENT AREA ---
        dbc.Col([
            dbc.Tabs([
                # TAB 1: Code Generation Execution
                dbc.Tab(label="Generation Console", tab_id="tab-generation", children=[
                    html.Div(className="p-4 border border-top-0", children=[
                        html.H5("Prompt & Code Output"),
                        dbc.Textarea(
                            id="code-generation-prompt",
                            placeholder="Enter your system prompt or task here (e.g., 'Generate the C++ logic for handling overflowing garbage')...", 
                            style={"height": "150px"}, 
                            className="mb-3"
                        ),
                        dbc.Button("Generate Code", id="btn-generate-code", color="success", className="w-100 mb-4"),
                        
                        dcc.Loading(
                            type="dot",
                            children=html.Pre(
                                id="code-output", 
                                style={"backgroundColor": "#1e1e1e", "color": "#d4d4d4", "height": "400px", "padding": "15px", "overflowY": "auto"}
                            )
                        )
                    ])
                ]),
                
                # TAB 2: KG Construction & Inspection
                dbc.Tab(label="Graph Management", tab_id="tab-graph-manage", children=[
                    html.Div(className="p-4 border border-top-0", children=[
                        
                        dbc.RadioItems(
                            id="graph-action-radio",
                            options=[
                                {"label": "Inspect Existing Graph", "value": "inspect"},
                                {"label": "Construct New Graph", "value": "construct"}
                            ],
                            value="construct",
                            inline=True,
                            className="mb-4"
                        ),
                        
                        html.Div(id="graph-manage-ui")
                        
                    ])
                ])
            ], id="main-tabs", active_tab="tab-graph-manage")
        ], width=9)
    ])
], fluid=True)


# --- Callbacks ---

@callback(
    Output("graph-selection-container", "style"),
    Input("llm-strategy-radio", "value")
)
def toggle_strategy(strategy):
    return {"display": "block"} if strategy == "graph_rag" else {"display": "none"}

@callback(
    Output("threshold-display", "children"),
    Input("kg-threshold-slider", "value")
)
def update_slider_val(val):
    if val is None: return "0.66"
    return f"{val:.2f}"

@callback(
    Output("graph-manage-ui", "children"),
    Input("graph-action-radio", "value"),
    Input("active-graph-select", "value")
)
def render_graph_ui(action, selected_graph):
    if action == "inspect":
        # Load elements for Cytoscape
        elements = []
        if selected_graph:
            graph_path = KG_INDEX_DIR / selected_graph
            if graph_path.exists():
                G = nx.read_pickle(graph_path)
                for node_id, node_data in G.nodes(data=True):
                    elements.append({'data': {'id': node_id, 'label': node_data.get('label', node_id)}})
                for u, v, edge_data in G.edges(data=True):
                    elements.append({'data': {'source': u, 'target': v, 'label': edge_data.get('role', '')}})

        return html.Div([
            html.H5("Graph Inspector"),
            html.P(f"Currently inspecting: {selected_graph}" if selected_graph else "Select a graph from the sidebar to visualize."),
            cyto.Cytoscape(
                id='kg-inspector-canvas',
                layout={'name': 'cose'},
                style={'width': '100%', 'height': '500px', 'backgroundColor': '#2a2a2a'},
                elements=elements,
                stylesheet=[
                    {'selector': 'node', 'style': {'label': 'data(label)', 'color': 'white', 'background-color': '#007bff'}},
                    {'selector': 'edge', 'style': {'label': 'data(label)', 'color': '#aaa', 'font-size': '10px', 'curve-style': 'bezier', 'target-arrow-shape': 'triangle'}}
                ]
            )
        ])
    else:
        return html.Div([
            html.H5("Knowledge Graph Construction"),
            dbc.Row([
                dbc.Col([
                    dbc.Label("1. Select Extracted Data (JSON):"),
                    dbc.Select(id="kg-source-data", options=[{"label": f, "value": f} for f in get_extracted_jsons()])
                ], width=6),
                dbc.Col([
                    dbc.Label("2. HuggingFace Embedding Model:"),
                    dbc.Input(id="kg-model-input", value="KaLM-Embedding/KaLM-embedding-multilingual-mini-instruct-v2.5")
                ], width=6)
            ], className="mb-3"),
            
            dbc.Label("3. Node Connection Confidence Threshold:"),
            dbc.Row([
                dbc.Col(dcc.Slider(id="kg-threshold-slider", min=0.1, max=1.0, step=0.01, value=0.66, marks={0.1: '0.1', 0.66: '0.66', 1.0: '1.0'}), width=10),
                dbc.Col(html.Div(id="threshold-display", className="fw-bold mt-1"), width=2)
            ], className="mb-4"),
            
            dbc.Button("Build Knowledge Graph", id="btn-build-kg", color="warning", className="w-100"),
            html.Div(id="build-kg-status", className="mt-3")
        ])

@callback(
    Output("build-kg-status", "children"),
    Input("btn-build-kg", "n_clicks"),
    State("kg-source-data", "value"),
    State("kg-model-input", "value"),
    State("kg-threshold-slider", "value"),
    prevent_initial_call=True
)
def execute_graph_build(n_clicks, source_json, model_name, threshold):
    if not source_json:
        return dbc.Alert("Please select extracted data first.", color="danger")
    
    try:
        source_path = OUTPUT_DIR / source_json
        graph_out, db_out = build_graph_from_json(source_path, model_name, float(threshold))
        return dbc.Alert(f"Graph Built! Saved to {Path(graph_out).name} and {Path(db_out).name}. Refresh the page to see them in the sidebar.", color="success")
    except Exception as e:
        return dbc.Alert(f"Error building graph: {str(e)}", color="danger")

@callback(
    Output("code-output", "children"),
    Input("btn-generate-code", "n_clicks"),
    State("code-generation-prompt", "value"),
    State("llm-strategy-radio", "value"),
    State("active-graph-select", "value"),
    prevent_initial_call=True
)
def generate_code_execution(n_clicks, prompt, strategy, selected_graph):
    if not prompt:
        return "Please enter a prompt."
    if not API_KEY:
        return "API Key missing. Please check your config."

    final_prompt = prompt
    context_str = ""

    # Execute GraphRAG Retrieval if selected
    if strategy == "graph_rag":
        if not selected_graph:
            return "Please select a Knowledge Graph from the sidebar for GraphRAG."
        
        graph_path = KG_INDEX_DIR / selected_graph
        db_path = KG_INDEX_DIR / selected_graph.replace("graph_", "vecdb_").replace(".pickle", ".pt")
        
        try:
            # 1. Initialize Engines
            engine = GraphRAGEngine(graph_path)
            vecdb = GraphVecDB()
            vecdb.load(db_path)
            
            # 2. Extract key entities from user prompt to search the DB
            search_res = vecdb.search(prompt, top_k=2)
            if not search_res:
                context_str = "No relevant context found in Graph."
            else:
                # 3. Exhaustive traversal on top matched nodes
                context_str = "--- RETRIEVED GRAPH CONTEXT ---\n"
                for node in search_res:
                    traversal = engine.exhaustive_retrieval(node["id"])
                    context_str += engine.to_llm_context(traversal) + "\n"
                    
            final_prompt = f"System Context:\n{context_str}\n\nUser Task:\n{prompt}"
            
        except Exception as e:
            return f"Error during GraphRAG retrieval: {str(e)}"

    # Send to Gemini
    try:
        model = GeminiClient(key=API_KEY)
        text, _ = model.generate(prompt=final_prompt, model_name="gemini-2.5-pro", google_search=False)
        return f"{context_str}\n\n--- GENERATED CODE ---\n{text}"
    except Exception as e:
        return f"Error generating code: {str(e)}"