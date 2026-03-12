import streamlit as st
import sys
import os

# Try to import the project's GeminiClient using a few fallbacks so the
# script can be run as a module or directly via `streamlit run`.
try:
    # Preferred: when running as part of the package (rare in local dev)
    from Framework_Simulation_Garbage.Causal_extractor.utils.gemini import GeminiClient
except Exception:
    try:
        # Try importing using package-relative path if Causal_extractor is on sys.path
        from Causal_extractor.utils.gemini import GeminiClient
    except Exception:
        # Fallback: insert the Causal_extractor package directory into sys.path
        this_dir = os.path.dirname(__file__)
        causal_pkg_dir = os.path.abspath(os.path.join(this_dir, '..'))
        if causal_pkg_dir not in sys.path:
            sys.path.insert(0, causal_pkg_dir)
        try:
            from utils.gemini import GeminiClient
        except Exception as inner_exc:
            raise

from config import API_KEY, out_as_json
import pandas as pd
import os

from datetime import datetime
import json
import re

# --- Page Configuration ---
st.set_page_config(
    page_title="Gemini JSON Generator",
    page_icon="🤖",
    layout="wide"
)

# --- Constants ---
# Use project-relative paths for output and log inside the data_extract folder
OUTPUT_DIR = os.path.join("Causal_extractor", "data_extract", "output")
LOG_FILE = os.path.join("Causal_extractor", "data_extract", "generation_log.csv")

# --- Load API Key and Configure Gemini ---

try:
    if not API_KEY:
        st.error("🚨 GOOGLE_API_KEY not found. Please set it in your .env file.")
        st.stop()
    model = GeminiClient(key=API_KEY)
except Exception as e:
    st.error(f"🚨 Error configuring Gemini: {e}")
    st.stop()


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

# --- Streamlit App UI ---
st.title("📄✨ Gemini JSON Generator")
st.markdown("Provide a prompt template and an input to generate a structured JSON response.")

# Create output directory if it doesn't exist
os.makedirs(OUTPUT_DIR, exist_ok=True)
initialize_log_file()

# --- Input Fields ---
with st.form("prompt_form"):
    st.subheader("1. Define Your Prompt")
    
    # Use a two-column layout for inputs
    col1, col2 = st.columns(2)
    
    with col1:
        prompt_template = st.text_area(
            "**Prompt Template**",
            height=200,
            value="Generate a JSON object for a user profile. The user's name is {name}. The JSON should include fields for 'fullName', 'username', 'email', and 'isActive'. The username should be a lowercase version of the name without spaces.",
            help="Use curly braces `{}` for your input variable, e.g., `{name}`."
        )

    with col2:
        user_input = st.text_area(
            "**Input Value**",
            height=200,
            value="John Doe",
            help="This value will replace the placeholder in your template."
        )

    submitted = st.form_submit_button("🚀 Generate JSON", type="primary", use_container_width=True)

# --- Generation Logic ---
if submitted:
    if not prompt_template or not user_input:
        st.warning("⚠️ Please provide both a prompt template and an input value.")
    else:
        with st.spinner("🧠 Gemini is thinking..."):
            try:
                # Dynamically find the placeholder key (e.g., 'name' from '{name}')
                # placeholder = prompt_template.split('{')[1].split('}')[0]
                # Safely substitute user input into the template without invoking
                # Python's str.format on the whole prompt (which errors if the
                # prompt contains other braces). Strategies used in order:
                # 1) Replace literal `{}`
                # 2) Replace `{input}` specifically
                # 3) Replace the first simple `{word}` placeholder
                # 4) Fallback: append the input to the end of the prompt
                if '{}' in prompt_template:
                    final_prompt = prompt_template.replace('{}', str(user_input))
                elif '{input}' in prompt_template:
                    final_prompt = prompt_template.replace('{input}', str(user_input))
                else:
                    m = re.search(r"\{([A-Za-z0-9_]+)\}", prompt_template)
                    if m:
                        placeholder = m.group(0)
                        final_prompt = prompt_template.replace(placeholder, str(user_input), 1)
                    else:
                        final_prompt = prompt_template + "\n\nInput: " + str(user_input)

                # --- Call Gemini API ---
                text, response = model.generate(prompt=final_prompt, generation_config=out_as_json, model_name="gemini-2.5-pro", google_search=False)
                
                # Clean the response to extract only the JSON part
                raw = (response.text or "").strip()
                # Remove common markdown fences
                raw = raw.replace("```json", "").replace("```", "").strip()

                parsed_json = None
                # Strategy 1: try to parse the entire cleaned raw
                try:
                    parsed_json = json.loads(raw)
                except Exception:
                    # Strategy 2: extract likely JSON substring ([ ... ] or { ... })
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

                    # Remove simple JS-style comments and trailing commas
                    candidate_no_comments = re.sub(r'//.*(?=\n)|/\*.*?\*/', '', candidate, flags=re.S)
                    candidate_no_comments = re.sub(r',\s*([}\]])', r'\1', candidate_no_comments)

                    try:
                        parsed_json = json.loads(candidate_no_comments)
                    except Exception:
                        # Raise a JSONDecodeError to be handled by the outer except
                        raise json.JSONDecodeError("Failed to decode JSON after cleaning", candidate_no_comments, 0)
                
                # Generate a unique filename
                timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
                filename = f"response_{timestamp}.json"
                filepath = os.path.join(OUTPUT_DIR, filename)

                with open(filepath, 'w') as f:
                    json.dump(parsed_json, f, indent=4)
                
                # --- Log and Show Success ---
                append_to_log(prompt_template, user_input, filename)
                st.success(f"✅ Success! Response saved to: `{filepath}`")
                
                # Display the generated JSON in the app
                st.subheader("Generated JSON Output")
                st.json(parsed_json)

            except json.JSONDecodeError:
                st.error("🚨 Failed to decode JSON from Gemini's response. The model might not have returned valid JSON.")
                st.code(response.text, language="text")
            except Exception as e:
                st.error(f"An unexpected error occurred: {e}")

# --- Display Log File ---
st.divider()
st.subheader("📜 Generation History")
if os.path.exists(LOG_FILE):
    log_df = pd.read_csv(LOG_FILE)
    st.dataframe(log_df.tail(10), use_container_width=True)
else:
    st.info("No logs found yet. Generate a response to start logging.")