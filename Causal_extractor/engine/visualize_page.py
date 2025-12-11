import streamlit as st
import pandas as pd
import json
import os
import re

# --- Constants - Using script-relative paths (works from anywhere) ---
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(SCRIPT_DIR)  # Goes from engine/ to Causal_extractor/

# Define the base directories
BASE_DIR = os.path.join(PROJECT_ROOT, "data_extract", "output")
REFERENCE_DIR = os.path.join(PROJECT_ROOT, "data_extract")
FOLLOWUP_FILE_PATH = os.path.join(PROJECT_ROOT, "lib", "experiment_2_output.json")
SCORE_FILE_PATH = os.path.join(BASE_DIR, "validation_scores.json")

# Define column names
COLUMNS_V4 = [
    "pattern_type", "sentence_type", "marked_type", "explicit_type",
    "relationship", "marker", "subject", "object", "source_text", "reasoning"
]
DISPLAY_COLUMNS_V4 = {
    "pattern_type": "Pattern Type",
    "sentence_type": "Sentence Type",
    "marked_type": "Marked Type",
    "explicit_type": "Explicit Type",
    "relationship": "Relationship",
    "marker": "Marker",
    "subject": "Subject",
    "object": "Object",
    "source_text": "Source Text",
    "reasoning": "Reasoning"
}

# --- Helper Functions ---
def load_scores():
    """Loads validation scores from JSON file"""
    if not os.path.exists(SCORE_FILE_PATH):
        return {}
    try:
        with open(SCORE_FILE_PATH, 'r', encoding='utf-8') as f:
            return json.load(f)
    except Exception as e:
        st.error(f"Error loading scores: {e}")
        return {}

def save_scores(scores):
    """Saves validation scores to JSON file"""
    try:
        os.makedirs(os.path.dirname(SCORE_FILE_PATH), exist_ok=True)
        with open(SCORE_FILE_PATH, 'w', encoding='utf-8') as f:
            json.dump(scores, f, indent=4, ensure_ascii=False)
        st.toast("✅ Saved successfully!", icon='💾')
    except Exception as e:
        st.error(f"Error saving: {e}")

def show_visualize():
    """Display the visualization and validation page"""
    st.markdown("""
    ### 📊 Visualization & Validation Interface
    
    Review and validate extracted causal relationships from your data.
    """)
    
    # Check if output directory exists
    if not os.path.exists(BASE_DIR):
        st.warning("📁 No output directory found. Please generate some data in the Extraction page first.")
        return
    
    # Get list of JSON files
    json_files = [f for f in os.listdir(BASE_DIR) if f.endswith('.json') and f != 'validation_scores.json']
    
    if not json_files:
        st.info("📋 No generated JSON files found. Please generate some data in the Extraction page first.")
        return
    
    # File selection
    selected_file = st.selectbox("Select a JSON file to review:", json_files)
    
    if selected_file:
        filepath = os.path.join(BASE_DIR, selected_file)
        
        try:
            with open(filepath, 'r', encoding='utf-8') as f:
                data = json.load(f)
            
            # Display the data
            st.subheader(f"📄 {selected_file}")
            
            col1, col2 = st.columns([2, 1])
            
            with col1:
                st.markdown("**Data Preview:**")
                st.json(data)
            
            with col2:
                st.markdown("**Actions:**")
                if st.button("💾 Save Validation", key="save_validation"):
                    save_scores({selected_file: {"status": "validated", "timestamp": pd.Timestamp.now().isoformat()}})
                
                if st.button("🔄 Back to Extraction", key="back_to_extraction"):
                    st.session_state.current_page = "extractor"
                    st.rerun()
        
        except Exception as e:
            st.error(f"Error loading file: {e}")
