import dash
from dash import html, dcc, callback, Input, Output, State, dash_table, no_update
import dash_bootstrap_components as dbc
import pandas as pd
import json
import os
import re

# Register Page
dash.register_page(__name__, path='/visualize', name='Visualization')

# --- Paths & Constants (Migrated from Streamlit) ---
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(SCRIPT_DIR) 

BASE_DIR = os.path.join(PROJECT_ROOT, "data_extract", "output")
REFERENCE_DIR = os.path.join(PROJECT_ROOT, "data_extract")
FOLLOWUP_FILE_PATH = os.path.join(PROJECT_ROOT, "lib", "experiment_2_output.json")
SCORE_FILE_PATH = os.path.join(BASE_DIR, "validation_scores_saved.json")

DISPLAY_COLUMNS_V4 = {
    "pattern_type": "Pattern Type", "sentence_type": "Sentence Type",
    "marked_type": "Marked Type", "explicit_type": "Explicit Type",
    "relationship": "Relationship", "marker": "Marker",
    "subject": "Subject", "object": "Object",
    "source_text": "Source Text", "reasoning": "Reasoning"
}

# --- Helper Functions ---
def get_json_files():
    if os.path.isdir(BASE_DIR):
        return [f for f in os.listdir(BASE_DIR) if f.endswith('.json') and f != "validation_scores_saved.json"]
    return []

def get_csv_files():
    if os.path.isdir(REFERENCE_DIR):
        return [f for f in os.listdir(REFERENCE_DIR) if f.endswith('.csv')]
    return []

def load_scores():
    if not os.path.exists(SCORE_FILE_PATH): return {}
    with open(SCORE_FILE_PATH, 'r', encoding='utf-8') as f: return json.load(f)

def save_scores(scores):
    os.makedirs(os.path.dirname(SCORE_FILE_PATH), exist_ok=True)
    with open(SCORE_FILE_PATH, 'w', encoding='utf-8') as f:
        json.dump(scores, f, indent=4, ensure_ascii=False)

# --- Layout ---
layout = dbc.Container([
    html.H2("📊 Visualization & Validation", className="mt-3 mb-4"),
    
    # Top Controls
    dbc.Row([
        dbc.Col([
            dbc.Label("Select JSON Extract:", className="fw-bold"),
            dbc.Select(id="json-file-select", options=[{"label": f, "value": f} for f in get_json_files()], className="mb-3")
        ], width=4),
        dbc.Col([
            dbc.Label("Select CSV Reference:", className="fw-bold"),
            dbc.Select(id="csv-file-select", options=[{"label": f, "value": f} for f in get_csv_files()], className="mb-3")
        ], width=4),
    ]),

    html.Hr(),
    html.H4("Extracted Data Table"),
    html.P("Select a row via the radio button on the left to view details. Edit scores directly in the table."),
    
    # Main Interactive Table
    dash_table.DataTable(
        id='visualize-table',
        row_selectable="single", # Equivalent to Streamlit's checkbox selection
        editable=True,           # Allows editing SF, SA, EA, SI, Notes
        style_table={'overflowX': 'auto'},
        style_cell={'textAlign': 'left', 'padding': '10px', 'minWidth': '100px'},
        style_header={'backgroundColor': '#333', 'color': 'white', 'fontWeight': 'bold'},
        page_size=10,
        style_data_conditional=[
            {'if': {'state': 'selected'}, 'backgroundColor': 'rgba(0, 116, 217, 0.3)', 'border': '1px solid blue'}
        ]
    ),
    html.Div(id="save-status-alert", className="mt-2"),

    html.Hr(),
    
    # Detail View Container
    html.Div(id="detail-view-container"),

    html.Hr(),
    
    # Next Step to GraphRAG
    dbc.Row([
        dbc.Col([
            dbc.Button("Next ➜ Proceed to Code Generation (GraphRAG)", href="/graph-rag", color="primary", size="lg", className="w-100 mb-5 mt-3")
        ], width={"size": 6, "offset": 3})
    ]),

    dbc.Row([
        dbc.Col(dbc.Button("↶ Back to Extraction", href="/extraction", color="secondary", className="w-100 mt-3"), width=3),
        dbc.Col(dbc.Button("Proceed to Code Generation ➜", href="/code-generation", color="primary", className="w-100 mt-3"), width={"size": 4, "offset": 5})
        ], className="mb-5")

], fluid=True)


# --- Callbacks ---

@callback(
    Output('visualize-table', 'data'),
    Output('visualize-table', 'columns'),
    Input('json-file-select', 'value')
)
def load_table_data(selected_json):
    if not selected_json:
        return [], []
    
    file_path = os.path.join(BASE_DIR, selected_json)
    if not os.path.exists(file_path):
        return [], []

    with open(file_path, 'r', encoding='utf-8') as f:
        data = json.load(f)
    
    df = pd.DataFrame(data)
    rename_map = {col: DISPLAY_COLUMNS_V4.get(col, col) for col in df.columns}
    df = df.rename(columns=rename_map)
    df['Unique_ID'] = df.index.astype(str)

    # Load Scores
    all_scores = load_scores()
    file_scores = all_scores.get(selected_json, {})
    
    df['SF'] = df['Unique_ID'].apply(lambda x: file_scores.get(x, {}).get('sf', ''))
    df['SA'] = df['Unique_ID'].apply(lambda x: file_scores.get(x, {}).get('sa', ''))
    df['EA'] = df['Unique_ID'].apply(lambda x: file_scores.get(x, {}).get('ea', ''))
    df['SI'] = df['Unique_ID'].apply(lambda x: file_scores.get(x, {}).get('si', ''))
    df['Notes'] = df['Unique_ID'].apply(lambda x: file_scores.get(x, {}).get('notes', ''))

    # Define columns, making only scoring columns editable
    columns = []
    for col in df.columns:
        if col in ['SF', 'SA', 'EA', 'SI', 'Notes']:
            columns.append({"name": col, "id": col, "editable": True})
        elif col != 'Unique_ID':
            columns.append({"name": col, "id": col, "editable": False})

    return df.to_dict('records'), columns


@callback(
    Output('save-status-alert', 'children'),
    Input('visualize-table', 'data_timestamp'),
    State('visualize-table', 'data'),
    State('json-file-select', 'value'),
    prevent_initial_call=True
)
def save_edited_scores(timestamp, table_data, selected_json):
    """Saves scores automatically when the user edits the DataTable."""
    if not table_data or not selected_json:
        return no_update

    all_scores = load_scores()
    if selected_json not in all_scores:
        all_scores[selected_json] = {}

    for row in table_data:
        uid = row.get('Unique_ID')
        all_scores[selected_json][uid] = {
            'sf': row.get('SF', ''),
            'sa': row.get('SA', ''),
            'ea': row.get('EA', ''),
            'si': row.get('SI', ''),
            'notes': row.get('Notes', '')
        }
    
    save_scores(all_scores)
    return dbc.Alert("✅ Scores auto-saved.", color="success", duration=2000)


@callback(
    Output('detail-view-container', 'children'),
    Input('visualize-table', 'derived_virtual_data'),
    Input('visualize-table', 'derived_virtual_selected_rows')
)
def update_detail_view(rows, selected_row_indices):
    """Populates the detail view below the table based on the selected row."""
    if not rows or not selected_row_indices:
        return html.Div("Select a row above to view details.", className="text-muted fst-italic")
    
    selected_row = rows[selected_row_indices[0]]

    # Extract Data safely
    causal_statement = selected_row.get("Relationship", "")
    subject = selected_row.get("Subject", "")
    obj = selected_row.get("Object", "")
    source_text = selected_row.get("Source Text", "")
    reasoning = selected_row.get("Reasoning", "")

    # Build the Detail View UI
    detail_ui = dbc.Row([
        dbc.Col([
            html.H4("📝 Selected Item Details"),
            html.H6("🔗 Full Relationship"),
            html.P(html.Em(causal_statement), style={"fontSize": "18px"}),
            
            html.P([html.Strong("Subject: "), html.Span(subject, style={"color": "#28a745", "fontSize": "18px"})]),
            html.P([html.Strong("Object: "), html.Span(obj, style={"color": "#dc3545", "fontSize": "18px"})]),

            html.H6("📋 Classification Types", className="mt-3"),
            dbc.Row([
                dbc.Col([html.Strong("Pattern Type:"), html.Div(selected_row.get("Pattern Type", "—"))]),
                dbc.Col([html.Strong("Marked Type:"), html.Div(selected_row.get("Marked Type", "—"))])
            ]),
            dbc.Row([
                dbc.Col([html.Strong("Sentence Type:"), html.Div(selected_row.get("Sentence Type", "—"))]),
                dbc.Col([html.Strong("Explicit Type:"), html.Div(selected_row.get("Explicit Type", "—"))])
            ], className="mt-2"),

            html.H6("🏷️ Marker", className="mt-3"),
            dbc.Alert(selected_row.get("Marker", "No marker"), color="info", className="p-2"),
            
            html.H6("💡 Reasoning", className="mt-3"),
            html.P(reasoning, className="text-muted")

        ], width=6, className="border-end pe-4"),
        
        dbc.Col([
            html.H4("📄 Source Text"),
            dbc.Card(dbc.CardBody(source_text), className="bg-dark text-light mt-3")
        ], width=6, className="ps-4")
    ])

    return detail_ui