import streamlit as st
import sys
import os
import json
import re
import pandas as pd
from datetime import datetime
# Try to import the project's GeminiClient
try:
    from utils.gemini import GeminiClient
except Exception:
    try:
        this_dir = os.path.dirname(__file__)
        causal_pkg_dir = os.path.abspath(os.path.join(this_dir, '..'))
        if causal_pkg_dir not in sys.path:
            sys.path.insert(0, causal_pkg_dir)
        from utils.gemini import GeminiClient
    except Exception as inner_exc:
        st.error(f"Could not import GeminiClient: {inner_exc}")
        st.stop()

try:
    from config import API_KEY, out_as_json
except Exception:
    API_KEY = None
    out_as_json = None

# --- Constants - Using script-relative paths (works from anywhere) ---
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(SCRIPT_DIR)  # Goes from engine/ to Causal_extractor/

OUTPUT_DIR = os.path.join(PROJECT_ROOT, "data_extract", "output")
LOG_FILE = os.path.join(PROJECT_ROOT, "data_extract", "generation_log.csv")

# Load default prompt template with fallback
DEFAULT_PROMPT_FILE = os.path.join(PROJECT_ROOT, "data_extract", "prompt", "causal_extract", "v4.txt")
try:
    with open(DEFAULT_PROMPT_FILE, 'r') as f:
        default_prompt_template = f.read()
except FileNotFoundError:
    default_prompt_template = "Generate a JSON object based on the following input:\n{input}"

# --- Initialize Gemini ---
@st.cache_resource
def get_gemini_client():
    """Initialize and cache the Gemini client"""
    try:
        if not API_KEY:
            return None
        return GeminiClient(key=API_KEY)
    except Exception:
        return None

# --- Helper Functions ---
def initialize_log_file():
    """Creates the log file with headers if it doesn't exist."""
    if not os.path.exists(LOG_FILE):
        df = pd.DataFrame(columns=["prompt_template", "input", "output_filename", "timestamp"])
        df.to_csv(LOG_FILE, index=False)

def append_to_log(template, user_input, filename):
    """Appends a new record to the CSV log file."""
    new_log_entry = pd.DataFrame([{
        "prompt_template": template,
        "input": user_input,
        "output_filename": filename,
        "timestamp": datetime.now().isoformat()
    }])
    new_log_entry.to_csv(LOG_FILE, mode='a', header=False, index=False)

def show_extractor():
    """Main extractor page with two-column layout"""
    
    # Create output directory if it doesn't exist
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    initialize_log_file()
    
    # Get Gemini client
    model = get_gemini_client()
    if not model:
        st.error("🚨 Could not initialize Gemini. Please check your API_KEY in config.py")
        return
    
    # --- Main Content Layout: Two Columns (Matching Low-Fidelity Prototype) ---
    left_col, right_col = st.columns([1, 2], gap="large")
    
    # ============ LEFT COLUMN: EXTRACTION PROMPT ============
    with left_col:
        st.subheader("📝 Extraction Prompt")
        st.markdown("Define your prompt template and how data should be processed.")
        
        with st.form("extraction_form"):
            # Prompt Template
            prompt_template = st.text_area(
                "**Prompt Template**",
                height=300,
                value=default_prompt_template,
                help="Use curly braces {} for your input variable, e.g., {name}.",
                key="prompt_template_input"
            )
            
            st.markdown("---")
            
            # Input Format Guidelines
            st.markdown("**📋 Input Data Format Guidelines**")
            with st.expander("View guidelines"):
                st.markdown("""
               1. **Enforce Active Voice**: Restructure text into active voice, direct "Subject-Verb-Object" patterns, to eliminate directionally errors caused by passive constructions.

                2. **Resolve Pronouns**: Replace pronouns (e.g., "it," "they") with entity names (Noun-Clause Expansion) to guarantee accurate context tracking and subject-object linkage.
                """)
            
            form_submitted = st.form_submit_button(
                "🚀 Generate JSON",
                type="primary",
                use_container_width=True
            )
    
    # ============ RIGHT COLUMN: SYSTEM DATA ============
    with right_col:
        st.subheader("🔧 System Data")
        st.markdown("Upload files and provide input data for processing.")
        
        # --- File Upload Section ---
        st.markdown("**📁 Upload Files**")
        uploaded_files = st.file_uploader(
            "Drag and drop files here",
            type=["csv", "txt", "pdf", "json"],
            accept_multiple_files=True,
            label_visibility="collapsed"
        )
        
        if uploaded_files:
            st.markdown(f"**Uploaded Data** ({len(uploaded_files)} file(s))")
            for uploaded_file in uploaded_files:
                st.write(f"✓ {uploaded_file.name}")
        
        st.markdown("---")
        
        # --- Input Data Section ---
        st.markdown("**💬 Input Data as text (optional)**")
        user_input = st.text_area(
            "Enter your input data here...",
            height=200,
            placeholder="John Doe",
            label_visibility="collapsed",
            key="input_data_textarea"
        )
        
        st.markdown("---")
        
        # --- Raw Input Display ---
        if user_input:
            st.markdown("**Raw Input Preview**")
            with st.container(border=True):
                st.code(user_input, language="text")
        
        # --- Next Button to Visualization ---
        if st.button("Next ➜", key="next_button", use_container_width=True, type="primary"):
            st.session_state.current_page = "visualize"
            st.rerun()
    
    # ============ BOTTOM SECTION: GENERATION RESULTS ============
    st.divider()
    
    # --- Generation Logic ---
    if form_submitted:
        prompt_template_val = prompt_template
        user_input_val = user_input
        
        if not prompt_template_val or not user_input_val:
            st.warning("⚠️ Please provide both a prompt template and an input value.")
        else:
            with st.spinner("🧠 Gemini is thinking..."):
                try:
                    # Substitute user input into template
                    if '{}' in prompt_template_val:
                        final_prompt = prompt_template_val.replace('{}', str(user_input_val))
                    elif '{input}' in prompt_template_val:
                        final_prompt = prompt_template_val.replace('{input}', str(user_input_val))
                    else:
                        m = re.search(r"\{([A-Za-z0-9_]+)\}", prompt_template_val)
                        if m:
                            placeholder = m.group(0)
                            final_prompt = prompt_template_val.replace(placeholder, str(user_input_val), 1)
                        else:
                            final_prompt = prompt_template_val + "\n\nInput: " + str(user_input_val)

                    # --- Call Gemini API ---
                    text, response = model.generate(
                        prompt=final_prompt,
                        generation_config=out_as_json,
                        pdf_bytes=[f.read() for f in uploaded_files] if uploaded_files else None,
                        model_name="gemini-2.5-flash",
                        google_search=False
                    )

                    print(response)
                    
                    # Clean the response
                    raw = (text or "").strip()
                    raw = raw.replace("```json", "").replace("```", "").strip()

                    parsed_json = None
                    try:
                        parsed_json = json.loads(raw)
                    except Exception:
                        start = raw.find('[')
                        end = raw.rfind(']')
                        if start != -1 and end != -1 and end > start:
                            candidate = raw[start:end+1]
                        else:
                            start = raw.find('{')
                            end = raw.rfind('}')
                            if start != -1 and end != -1 and end > start:
                                candidate = raw[start:end+1]
                            else:
                                candidate = raw

                        candidate_no_comments = re.sub(r'//.*(?=\n)|/\*.*?\*/', '', candidate, flags=re.S)
                        candidate_no_comments = re.sub(r',\s*([}\]])', r'\1', candidate_no_comments)

                        try:
                            parsed_json = json.loads(candidate_no_comments)
                        except Exception:
                            raise json.JSONDecodeError("Failed to decode JSON", candidate_no_comments, 0)
                    
                    # Save output
                    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
                    filename = f"response_{timestamp}.json"
                    filepath = os.path.join(OUTPUT_DIR, filename)

                    with open(filepath, 'w') as f:
                        json.dump(parsed_json, f, indent=4)
                    
                    # Log and display
                    append_to_log(prompt_template_val, user_input_val, filename)
                    st.success(f"✅ Success! Response saved to: `{filepath}`")
                    
                    st.subheader("📊 Generated Output")
                    st.json(parsed_json)

                except json.JSONDecodeError:
                    st.error("🚨 Failed to decode JSON from Gemini's response.")
                    st.code(response.text, language="text")
                except Exception as e:
                    st.error(f"❌ An unexpected error occurred: {e}")
    
    # ============ GENERATION HISTORY ============
    st.divider()
    st.subheader("📜 Generation History")
    
    if os.path.exists(LOG_FILE):
        log_df = pd.read_csv(LOG_FILE)
        if len(log_df) > 0:
            st.dataframe(log_df.tail(10), use_container_width=True)
        else:
            st.info("No logs found yet. Generate a response to start logging.")
    else:
        st.info("No logs found yet. Generate a response to start logging.")
