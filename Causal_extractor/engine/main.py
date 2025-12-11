import streamlit as st
import os
import sys

# --- Page Configuration ---
st.set_page_config(
    page_title="Causal Extractor Pipeline",
    page_icon="🔗",
    layout="wide",
    initial_sidebar_state="collapsed"
)

# --- Initialize session state for page navigation ---
if "current_page" not in st.session_state:
    st.session_state.current_page = "extractor"

def set_page(page_name):
    """Set the current page"""
    st.session_state.current_page = page_name

# --- Top Navigation Bar ---
col1, col2, col3 = st.columns([1, 1, 1])

with col1:
    if st.button("📄 Extraction", key="btn_extractor", use_container_width=True):
        set_page("extractor")

with col2:
    if st.button("📊 Visualization", key="btn_visualize", use_container_width=True):
        set_page("visualize")

with col3:
    if st.button("ℹ️ About", key="btn_about", use_container_width=True):
        set_page("about")

st.divider()

# --- Page Routing ---
if st.session_state.current_page == "extractor":
    st.markdown("## 📄 Data Extraction")
    try:
        from extractor_page import show_extractor
        show_extractor()
    except ImportError as e:
        st.error(f"Could not load the extraction page: {e}")

elif st.session_state.current_page == "visualize":
    st.markdown("## 📊 Visualization & Validation")
    try:
        from visualize_page import show_visualize
        show_visualize()
    except ImportError as e:
        st.error(f"Could not load the visualization page: {e}")

elif st.session_state.current_page == "about":
    st.markdown("## ℹ️ About This Application")
    st.write("""
    ### Causal Extractor Pipeline
    
    This application is designed to extract and validate causal relationships from text data.
    
    **Features:**
    - 📄 **Extraction**: Upload data and use AI-powered extraction to identify causal patterns
    - 📊 **Visualization**: Review, validate, and score extracted relationships
    - 💾 **Logging**: Automatic tracking of all extraction and validation activities
    
    **How to use:**
    1. Go to the **Extraction** page to define prompts and upload data
    2. Click the "Next" button to proceed to visualization
    3. Review results in the **Visualization** page
    4. Score and validate the extracted relationships
    """)
