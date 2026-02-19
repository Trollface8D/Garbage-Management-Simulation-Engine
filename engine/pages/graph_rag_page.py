import dash
from dash import html, dcc, callback, Input, Output, State, ALL
import dash_cytoscape as cyto
import dash_bootstrap_components as dbc

dash.register_page(__name__, path='/graph-rag')

layout = dbc.Row([
    # Left Sidebar: Controls
    dbc.Col([
        html.H4("GraphRAG Controls"),
        dbc.Label("Top-K Initial Nodes"),
        dbc.Input(id="top-k-input", type="number", value=5),
        dbc.Button("Retrieve Initial Nodes", id="btn-retrieve", color="info", className="w-100 mt-2"),
        
        html.Hr(),
        html.Div(id="initial-node-checklist-container"), # Dynamic Checkboxes
        
        dbc.Button("Run Traversal", id="btn-traverse", color="success", className="w-100 mt-3"),
    ], width=3),

    # Center: KG Visualization
    dbc.Col([
        cyto.Cytoscape(
            id='kg-inspector',
            layout={'name': 'cose'},
            style={'width': '100%', 'height': '70vh', 'background-color': '#1e1e1e'},
            elements=[], # Loaded from Cache
            stylesheet=[
                {'selector': 'node', 'style': {'label': 'data(label)', 'color': 'white'}},
                {'selector': '.initial', 'style': {'background-color': 'gold', 'shape': 'star'}},
                {'selector': '.traversed', 'style': {'line-color': '#00ffcc'}}
            ]
        )
    ], width=9),
])

# Callback to handle the "Top-K" retrieval and checkbox generation
@callback(
    Output("initial-node-checklist-container", "children"),
    Input("btn-retrieve", "n_clicks"),
    State("top-k-input", "value"),
    prevent_initial_call=True
)
def get_initial_nodes(n_clicks, k):
    # Logic: Search your KG Vector index for top K
    # dummy_results = [{"id": "n1", "label": "Entity A"}, ...]
    nodes = [{"id": f"node_{i}", "label": f"Entity {i}"} for i in range(k)]
    
    return dbc.Checklist(
        options=[{"label": n["label"], "value": n["id"]} for n in nodes],
        id="initial-node-selection",
        switch=True
    )