import dash
from dash import html, dcc, callback, Input, Output, State, dash_table, no_update
import dash_bootstrap_components as dbc
import os
import json
import re
import base64
import pandas as pd
from datetime import datetime

# Import your Gemini Client (adjust path if necessary)
try:
    from utils.gemini import GeminiClient
    from config import API_KEY, out_as_json
except ImportError:
    API_KEY = None
    out_as_json = None

# Register this page as the Home Page ("/")
dash.register_page(__name__, path='/extraction', name='Extraction')

# --- Constants & Paths ---
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(SCRIPT_DIR) # Assumes engine/pages structure

OUTPUT_DIR = os.path.join(PROJECT_ROOT, "data_extract", "output")
LOG_FILE = os.path.join(PROJECT_ROOT, "data_extract", "generation_log.csv")
DEFAULT_PROMPT_FILE = os.path.join(PROJECT_ROOT, "data_extract", "prompt", "causal_extract", "v4.txt")

# Ensure directories and log file exist
os.makedirs(OUTPUT_DIR, exist_ok=True)
if not os.path.exists(LOG_FILE):
    pd.DataFrame(columns=["prompt_template", "input", "output_filename", "timestamp"]).to_csv(LOG_FILE, index=False)

try:
    with open(DEFAULT_PROMPT_FILE, 'r') as f:
        default_prompt_template = f.read()
except FileNotFoundError:
    default_prompt_template = "Generate a JSON object based on the following input:\n{input}"

def load_history():
    if os.path.exists(LOG_FILE):
        df = pd.read_csv(LOG_FILE)
        return df.tail(10).to_dict('records')
    return []

# --- Layout: Two-Column Structure ---
layout = dbc.Container([
    html.H2("📄 Data Extraction", className="mt-3 mb-4"),
    
    dbc.Row([
        # ============ LEFT COLUMN: EXTRACTION PROMPT ============
        dbc.Col([
            html.H4("📝 Extraction Prompt"),
            html.P("Define your prompt template and how data should be processed."),
            
            dbc.Label("Prompt Template", className="fw-bold"),
            dbc.Textarea(
                id="prompt-template-input",
                value=default_prompt_template,
                style={"height": "300px"},
                className="mb-3"
            ),
            
            dbc.Accordion([
                dbc.AccordionItem(
                    html.Ul([
                        html.Li("Enforce Active Voice: Restructure text into active voice, direct 'Subject-Verb-Object' patterns..."),
                        html.Li("Resolve Pronouns: Replace pronouns (e.g., 'it', 'they') with entity names...")
                    ]),
                    title="📋 Input Data Format Guidelines"
                )
            ], start_collapsed=True, className="mb-4"),
            
            dbc.Button("🚀 Generate JSON", id="generate-btn", color="primary", className="w-100", n_clicks=0)
        ], width=12, lg=5, className="border-end pe-4"),
        
        # ============ RIGHT COLUMN: SYSTEM DATA ============
        dbc.Col([
            html.H4("🔧 System Data"),
            html.P("Upload files and provide input data for processing."),
            
            dbc.Label("📁 Upload Files", className="fw-bold"),
            dcc.Upload(
                id='file-upload',
                children=html.Div(['Drag and Drop or ', html.A('Select Files')]),
                style={
                    'width': '100%', 'height': '60px', 'lineHeight': '60px',
                    'borderWidth': '1px', 'borderStyle': 'dashed',
                    'borderRadius': '5px', 'textAlign': 'center', 'marginBottom': '20px'
                },
                multiple=True
            ),
            html.Div(id="upload-status", className="text-muted mb-3"),
            
            dbc.Label("💬 Input Data as text (optional)", className="fw-bold"),
            dbc.Textarea(
                id="user-input-data",
                placeholder="Enter your input data here...",
                style={"height": "200px"},
                className="mb-3"
            ),
            
            # Next button links to your Graph RAG / Visualization page
            dbc.Button("Inspect Extracted Data ➜", href="/visualize", color="info", className="w-100 mt-4")
        ], width=12, lg=7, className="ps-4")
    ]),
    
    html.Hr(),
    
    # ============ BOTTOM SECTION: RESULTS & HISTORY ============
    html.H4("📊 Generated Output"),
    
    # Wrap the output in a Loading component (replaces st.spinner)
    dcc.Loading(
        id="loading-spinner",
        type="circle",
        children=[
            html.Div(id="status-alert"),
            html.Pre(id="json-output-display", style={"backgroundColor": "#222", "color": "#0f0", "padding": "15px", "borderRadius": "5px", "minHeight": "100px"})
        ]
    ),
    
    html.Hr(),
    html.H4("📜 Generation History"),
    dash_table.DataTable(
        id='history-table',
        columns=[{"name": i, "id": i} for i in ["timestamp", "output_filename", "input", "prompt_template"]],
        data=load_history(),
        style_table={'overflowX': 'auto'},
        style_cell={'textAlign': 'left', 'padding': '10px'},
        style_header={'backgroundColor': '#333', 'color': 'white', 'fontWeight': 'bold'},
        page_size=10
    )
], fluid=True)


# --- Callbacks (The Logic) ---

@callback(
    Output("upload-status", "children"),
    Input("file-upload", "filename")
)
def update_upload_status(filenames):
    if filenames:
        return f"✓ {len(filenames)} file(s) ready: {', '.join(filenames)}"
    return "No files uploaded yet."

@callback(
    Output("json-output-display", "children"),
    Output("status-alert", "children"),
    Output("history-table", "data"),
    Input("generate-btn", "n_clicks"),
    State("prompt-template-input", "value"),
    State("user-input-data", "value"),
    State("file-upload", "contents"),
    State("file-upload", "filename"),
    prevent_initial_call=True
)
def process_extraction(n_clicks, prompt_template, user_input, file_contents, file_names):
    if not prompt_template or not user_input:
        return no_update, dbc.Alert("⚠️ Please provide both a prompt template and an input value.", color="warning"), dash.no_update
        
    if not API_KEY:
        return no_update, dbc.Alert("🚨 Gemini API Key missing in config.py!", color="danger"), dash.no_update

    try:
        # 1. Format the Prompt (matching your logic)
        if '{}' in prompt_template:
            final_prompt = prompt_template.replace('{}', str(user_input))
        elif '{input}' in prompt_template:
            final_prompt = prompt_template.replace('{input}', str(user_input))
        else:
            m = re.search(r"\{([A-Za-z0-9_]+)\}", prompt_template)
            if m:
                final_prompt = prompt_template.replace(m.group(0), str(user_input), 1)
            else:
                final_prompt = prompt_template + "\n\nInput: " + str(user_input)

        # 2. Handle File Uploads (Dash provides Base64 strings, we must decode them to bytes)
        pdf_bytes_list = []
        if file_contents:
            for contents in file_contents:
                content_type, content_string = contents.split(',')
                decoded_bytes = base64.b64decode(content_string)
                pdf_bytes_list.append(decoded_bytes)

        # 3. Call Gemini
        model = GeminiClient(key=API_KEY)
        text, response = model.generate(
            prompt=final_prompt,
            generation_config=out_as_json,
            pdf_bytes=pdf_bytes_list if pdf_bytes_list else None,
            model_name="gemini-2.5-flash",
            google_search=False
        )

        # 4. Clean & Parse JSON
        raw = (text or "").strip().replace("```json", "").replace("```", "").strip()
        
        # Regex to strip JS comments to prevent JSONDecodeErrors
        candidate_no_comments = re.sub(r'//.*(?=\n)|/\*.*?\*/', '', raw, flags=re.S)
        candidate_no_comments = re.sub(r',\s*([}\]])', r'\1', candidate_no_comments)
        
        parsed_json = json.loads(candidate_no_comments)

        # 5. Save Output
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        filename = f"response_{timestamp}.json"
        filepath = os.path.join(OUTPUT_DIR, filename)

        with open(filepath, 'w') as f:
            json.dump(parsed_json, f, indent=4)

        # 6. Log to CSV
        new_log = pd.DataFrame([{
            "prompt_template": prompt_template,
            "input": user_input,
            "output_filename": filename,
            "timestamp": datetime.now().isoformat()
        }])
        new_log.to_csv(LOG_FILE, mode='a', header=False, index=False)

        # 7. Return Data to UI
        alert = dbc.Alert(f"✅ Success! Response saved to: {filepath}", color="success", duration=5000)
        formatted_json = json.dumps(parsed_json, indent=4)
        
        return formatted_json, alert, load_history()

    except json.JSONDecodeError as e:
        return (raw, dbc.Alert("🚨 Failed to decode JSON from Gemini's response.", color="danger"), dash.no_update)
    except Exception as e:
        return ("", dbc.Alert(f"❌ An unexpected error occurred: {str(e)}", color="danger"), dash.no_update)