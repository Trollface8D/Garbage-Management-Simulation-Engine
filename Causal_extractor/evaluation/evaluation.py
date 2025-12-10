import streamlit as st
import pandas as pd
import json
import os
import re

# Get the script's directory to build absolute paths
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(os.path.dirname(SCRIPT_DIR))  # Go up to Framework_Simulation_Garbage

# Define the base directories (use data_extract output and generation_log as requested)
BASE_DIR = os.path.join(PROJECT_ROOT, "Causal_extractor", "data_extract", "output")
REFERENCE_DIR = os.path.join(PROJECT_ROOT, "Causal_extractor", "data_extract")

# --- NEW: Define the score storage path (inside the base directory) ---
SCORE_FILE_NAME = "validation_scores.json"
SCORE_FILE_PATH = os.path.join(BASE_DIR, SCORE_FILE_NAME)

# Define column names based on your JSON structure (Main Data)
# V4 schema columns (all fields from JSON)
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

# Legacy V3 schema columns
COLUMNS_V3 = ["pattern", "causal type", "causal", "note", "Named entity/Object in causal", "original reference"]
DISPLAY_COLUMNS_V3 = {
    "pattern": "Pattern",
    "causal type": "Causal Type",
    "causal": "Causal Statement",
    "note": "Note",
    "Named entity/Object in causal": "Named Entity/Object",
    "original reference": "Original Reference"
}

# Default to V4 for display references
REF_COL_NAME = "Source Text"  # V4 uses source_text

# ------------------------------------------------------------------
# 0. Score & Notes Management Functions
# ------------------------------------------------------------------

def load_scores():
    """Loads the validation scores and notes from a JSON file."""
    if not os.path.exists(SCORE_FILE_PATH):
        return {}
    try:
        with open(SCORE_FILE_PATH, 'r', encoding='utf-8') as f:
            return json.load(f)
    except Exception as e:
        st.error(f"Error loading scores: {e}")
        return {}

def save_scores(scores):
    """Saves the current validation scores and notes to a JSON file."""
    try:
        os.makedirs(os.path.dirname(SCORE_FILE_PATH), exist_ok=True)
        with open(SCORE_FILE_PATH, 'w', encoding='utf-8') as f:
            json.dump(scores, f, indent=4, ensure_ascii=False)
        st.toast("✅ Saved successfully!", icon='💾')
    except Exception as e:
        st.error(f"Error saving: {e}")

def get_score_and_notes(all_scores, file_name, unique_id):
    """Get scores and notes for a specific row. Handles old format and new 4-matrix format."""
    file_scores = all_scores.get(file_name, {})
    entry = file_scores.get(str(unique_id), {})
    # Handle old format where entry was just a score string
    if isinstance(entry, str):
        return {"semantic_fidelity": entry, "schema_accuracy": "", "explicit_accuracy": "", "structural_integrity": ""}, ""
    # Handle old format with single "score" key
    if "score" in entry and "semantic_fidelity" not in entry:
        return {"semantic_fidelity": entry.get("score", ""), "schema_accuracy": "", "explicit_accuracy": "", "structural_integrity": ""}, entry.get("notes", "")
    # New format: {"semantic_fidelity": "...", "schema_accuracy": "...", "explicit_accuracy": "...", "structural_integrity": "...", "notes": "..."}
    return {
        "semantic_fidelity": entry.get("semantic_fidelity", ""),
        "schema_accuracy": entry.get("schema_accuracy", ""),
        "explicit_accuracy": entry.get("explicit_accuracy", ""),
        "structural_integrity": entry.get("structural_integrity", "")
    }, entry.get("notes", "")

def get_scores_file_mtime():
    """Get modification time of scores file for cache invalidation."""
    if os.path.exists(SCORE_FILE_PATH):
        return os.path.getmtime(SCORE_FILE_PATH)
    return 0

# ------------------------------------------------------------------
# 1. JSON Data Loading (Main Data) - MODIFIED to include scores
# ------------------------------------------------------------------
@st.cache_data(hash_funcs={dict: lambda x: json.dumps(x, sort_keys=True)})
def load_json_data(file_path, selected_file_name, scores_mtime=None):
    """Load JSON data from file, auto-detect V3 or V4 schema, return DataFrame with all columns."""
    if not os.path.exists(file_path):
        st.error(f"File not found at: {file_path}")
        return pd.DataFrame(columns=list(DISPLAY_COLUMNS_V4.values()) + ["Score"]), "v4"
    
    try:
        with open(file_path, 'r', encoding='utf-8') as f:
            raw_data = json.load(f)
        
        # Helper to safely get a value or empty string
        def get_val(d, key):
            v = d.get(key)
            return v if v is not None else ""

        # Case A: legacy format - list of lists (V3)
        if isinstance(raw_data, list) and raw_data and isinstance(raw_data[0], list):
            if len(raw_data[0]) != len(COLUMNS_V3):
                st.error(f"Column mismatch in file {file_path}.")
                return pd.DataFrame(columns=list(DISPLAY_COLUMNS_V3.values()) + ["Score"]), "v3"

            df = pd.DataFrame(raw_data, columns=COLUMNS_V3)
            df = df.rename(columns=DISPLAY_COLUMNS_V3)
            schema_version = "v3"

        # Case B: modern format - list of dicts
        elif isinstance(raw_data, list) and raw_data and isinstance(raw_data[0], dict):
            first_item = raw_data[0]
            # Detect V4 schema by checking for v4-specific keys
            is_v4 = any(k in first_item for k in ['pattern_type', 'sentence_type', 'marked_type', 'explicit_type', 'relationship', 'source_text'])
            
            if is_v4:
                # V4 schema: extract all fields directly from JSON keys
                rows = []
                for item in raw_data:
                    row = [get_val(item, col) for col in COLUMNS_V4]
                    rows.append(row)
                df = pd.DataFrame(rows, columns=COLUMNS_V4)
                df = df.rename(columns=DISPLAY_COLUMNS_V4)
                schema_version = "v4"
            else:
                # V3-like dict format: map to legacy columns
                rows = []
                for item in raw_data:
                    pattern = item.get('pattern', item.get('pattern_type', ''))
                    causal_type = item.get('causal type', item.get('sentence_type', ''))
                    causal = item.get('causal', item.get('causal_statement', item.get('relationship', '')))
                    note = item.get('note', item.get('notes', item.get('reasoning', '')))
                    named_entity = item.get('Named entity/Object in causal', item.get('named_entity', item.get('object', '')))
                    original_reference = item.get('original reference', item.get('original_reference', item.get('source_text', '')))
                    rows.append([pattern, causal_type, causal, note, named_entity, original_reference])
                df = pd.DataFrame(rows, columns=COLUMNS_V3)
                df = df.rename(columns=DISPLAY_COLUMNS_V3)
                schema_version = "v3"

        # Empty list case
        elif isinstance(raw_data, list) and not raw_data:
            return pd.DataFrame(columns=list(DISPLAY_COLUMNS_V4.values()) + ["SF", "SA", "EA", "SI", "Notes"]), "v4"

        else:
            st.error("Unsupported JSON format: expected list-of-lists or list-of-dicts.")
            return pd.DataFrame(columns=list(DISPLAY_COLUMNS_V4.values()) + ["SF", "SA", "EA", "SI", "Notes"]), "v4"

        # Add Unique_ID and populate Score/Notes from saved data (if any)
        df.insert(0, 'Unique_ID', df.index)
        df['SF'] = ""  # Semantic Fidelity
        df['SA'] = ""  # Schema Accuracy (Causal, Sentence, Marked Type)
        df['EA'] = ""  # Explicit Accuracy
        df['SI'] = ""  # Structural Integrity
        df['Notes'] = ""

        all_scores = load_scores()

        def populate_score_notes(row):
            scores, notes = get_score_and_notes(all_scores, selected_file_name, row['Unique_ID'])
            return pd.Series({
                'SF': scores['semantic_fidelity'], 
                'SA': scores['schema_accuracy'],
                'EA': scores['explicit_accuracy'],
                'SI': scores['structural_integrity'], 
                'Notes': notes
            })

        df[['SF', 'SA', 'EA', 'SI', 'Notes']] = df.apply(populate_score_notes, axis=1)

        return df, schema_version

    except Exception as e:
        st.error(f"Error reading: {e}")
        return pd.DataFrame(columns=list(DISPLAY_COLUMNS_V4.values()) + ["SF", "SA", "EA", "SI", "Notes"]), "v4"

# ------------------------------------------------------------------
# 2. CSV Reference Input Loading
# ------------------------------------------------------------------
@st.cache_data
def load_csv_reference(file_path):
    if not os.path.exists(file_path):
        return pd.DataFrame(columns=['input'])
    try:
        df = pd.read_csv(file_path)
        if "input" in df.columns:
            return df[["input"]].drop_duplicates().astype(str).reset_index(drop=True)
        else:
            st.sidebar.error("Missing column 'input'")
            return pd.DataFrame(columns=['input'])
    except Exception as e:
        st.sidebar.error(f"CSV error: {e}")
        return pd.DataFrame(columns=['input'])

# ------------------------------------------------------------------
# Highlighting
# ------------------------------------------------------------------

def highlight_references(row, selected_reference_input):
    style = [''] * len(row)
    if selected_reference_input and selected_reference_input != 'None':
        original_reference_text = str(row[REF_COL_NAME]).strip()
        if original_reference_text == selected_reference_input.strip():
            style = ['background-color: #ffd700; color: #333333'] * len(row)
    return style

# ------------------------------------------------------------------

st.set_page_config(
    page_title="Causal Data Visualization Dashboard",
    layout="wide"
)

st.title("📄 Causal Extractor Data Analyzer (JSON + CSV Reference)")
st.markdown(f"Main data loaded from: `{BASE_DIR}`")

# ----------------------------------------------------
# Sidebar CSV Selection
# ----------------------------------------------------

st.sidebar.header("🔍 CSV Input Comparison") 
csv_files = []
if os.path.isdir(REFERENCE_DIR):
    try:
        csv_files = [f for f in os.listdir(REFERENCE_DIR) if f.endswith('.csv')]
    except OSError as e:
        st.sidebar.error(f"Permission: {e}")

selected_csv_file_name = None
df_reference_input = pd.DataFrame(columns=['input'])

if csv_files:
    default = csv_files.index("generation_log.csv") if "generation_log.csv" in csv_files else 0
    selected_csv_file_name = st.sidebar.selectbox(
        "Select CSV",
        options=csv_files,
        index=default,
    )
    
    if selected_csv_file_name:
        csv_ref_path = os.path.join(REFERENCE_DIR, selected_csv_file_name)
        df_reference_input = load_csv_reference(csv_ref_path)
    reference_inputs = df_reference_input['input'].tolist()
else:
    st.sidebar.warning("No CSV found.")
    reference_inputs = []

selected_reference_input = 'None'

if reference_inputs:
    display_options = ['None'] + reference_inputs
    selected_reference_input = st.sidebar.selectbox(
        "Match Original Reference:",
        display_options,
        index=0
    )

# ----------------------------------------------------
# JSON Selection
# ----------------------------------------------------

json_files = []
if os.path.isdir(BASE_DIR):
    json_files = [f for f in os.listdir(BASE_DIR) if f.endswith('.json') and f != SCORE_FILE_NAME]

selected_file_name = None
df = pd.DataFrame(columns=list(DISPLAY_COLUMNS_V4.values()) + ["Score", "Notes"])
schema_version = "v4"  # default

if json_files:
    selected_file_name = st.selectbox("Select JSON", options=json_files)
    
    if selected_file_name:
        full_path = os.path.join(BASE_DIR, selected_file_name)
        # Pass scores file mtime to invalidate cache when scores change
        df, schema_version = load_json_data(full_path, selected_file_name, scores_mtime=get_scores_file_mtime())
        st.caption(f"Detected schema: **{schema_version.upper()}**")
else:
    st.info("No JSON files found.")

# ----------------------------------------------------
# Main Data
# ----------------------------------------------------

if not df.empty:
    # Determine column names based on detected schema
    if schema_version == "v4":
        pattern_col = DISPLAY_COLUMNS_V4['pattern_type']
        causal_type_col = DISPLAY_COLUMNS_V4['sentence_type']
    else:
        pattern_col = DISPLAY_COLUMNS_V3['pattern']
        causal_type_col = DISPLAY_COLUMNS_V3['causal type']

    col1, col2 = st.columns(2)

    with col1:
        if pattern_col in df.columns:
            selected_patterns = st.multiselect(
                f"Filter by {pattern_col}:",
                df[pattern_col].unique(),
                default=df[pattern_col].unique()
            )
        else:
            selected_patterns = []

    with col2:
        if causal_type_col in df.columns:
            selected_causal_types = st.multiselect(
                f"Filter by {causal_type_col}:",
                df[causal_type_col].unique(),
                default=df[causal_type_col].unique()
            )
        else:
            selected_causal_types = []

    # Apply filters only if columns exist
    df_filtered = df.copy()
    if pattern_col in df.columns and selected_patterns:
        df_filtered = df_filtered[df_filtered[pattern_col].isin(selected_patterns)]
    if causal_type_col in df.columns and selected_causal_types:
        df_filtered = df_filtered[df_filtered[causal_type_col].isin(selected_causal_types)]
    df_filtered = df_filtered.reset_index(drop=True)
    
    st.subheader(f"Filtered Data ({len(df_filtered)} rows)")

    if selected_reference_input != 'None':
        styled_df = df_filtered.style.apply(
            lambda row: highlight_references(row, selected_reference_input),
            axis=1
        )
        st.dataframe(styled_df, use_container_width=True)
    else:
        st.dataframe(df_filtered, use_container_width=True, hide_index=True)

    st.markdown("---")

    # ----------------------------------------------------
    # Detail View
    # ----------------------------------------------------
    st.header("Causal Statement Detail View")

    # Build detail view columns based on schema
    if schema_version == "v4":
        cols_for_selection = [
            'Unique_ID',
            DISPLAY_COLUMNS_V4['pattern_type'],
            DISPLAY_COLUMNS_V4['sentence_type'],
            DISPLAY_COLUMNS_V4['marked_type'],
            DISPLAY_COLUMNS_V4['explicit_type'],
            DISPLAY_COLUMNS_V4['relationship'],
            'SF', 'SA', 'EA', 'SI',  # Semantic Fidelity, Schema Accuracy, Explicit Accuracy, Structural Integrity
            DISPLAY_COLUMNS_V4['source_text']
        ]
    else:
        cols_for_selection = [
            'Unique_ID',
            DISPLAY_COLUMNS_V3['pattern'],
            DISPLAY_COLUMNS_V3['causal type'],
            DISPLAY_COLUMNS_V3['causal'],
            'SF', 'SA', 'EA', 'SI',
            DISPLAY_COLUMNS_V3['original reference']
        ]
    # Filter to only include columns that exist in df
    cols_for_selection = [c for c in cols_for_selection if c in df_filtered.columns]
    
    df_selection_view = df_filtered[cols_for_selection].copy()
    df_selection_view.insert(0, 'Select', False)
    
    # Initialize current_selected_index in session state if not present
    if 'current_selected_index' not in st.session_state:
        st.session_state.current_selected_index = None
    
    # Auto-select row based on session state (persists across reruns)
    if 'auto_select_index' in st.session_state and st.session_state.auto_select_index is not None:
        st.session_state.current_selected_index = st.session_state.auto_select_index
        st.session_state.auto_select_index = None  # Clear the trigger
    
    # Apply the current selection from session state
    if st.session_state.current_selected_index is not None:
        idx = st.session_state.current_selected_index
        if idx < len(df_selection_view):
            df_selection_view.loc[idx, 'Select'] = True
    
    edited_df_view = st.data_editor(
        df_selection_view.drop(columns=['Unique_ID']), 
        use_container_width=True, 
        column_config={
            "Select": st.column_config.CheckboxColumn("Select"),
            "SF": st.column_config.TextColumn("SF", help="Semantic Fidelity"),
            "SA": st.column_config.TextColumn("SA", help="Schema Accuracy (Causal, Sentence, Marked)"),
            "EA": st.column_config.TextColumn("EA", help="Explicit Type Accuracy"),
            "SI": st.column_config.TextColumn("SI", help="Structural Integrity"),
        },
        key="detail_view_editor"
    )

    edited_df_with_id = pd.merge(
        edited_df_view.reset_index(names=['original_index']),
        df_filtered[['Unique_ID']].reset_index(names=['original_index']),
        on='original_index',
    )
    
    selected_rows = edited_df_with_id[edited_df_with_id['Select'] == True]
    
    # Update session state based on user's manual selection in data_editor
    # Only update if user actually changed the selection (not on initial load)
    if len(selected_rows) == 1:
        new_selected_idx = selected_rows.iloc[0]['original_index']
        # Always update to the newly selected row
        if st.session_state.current_selected_index != new_selected_idx:
            st.session_state.current_selected_index = new_selected_idx
            st.rerun()  # Rerun to apply the selection immediately
        else:
            st.session_state.current_selected_index = new_selected_idx
    elif len(selected_rows) == 0 and st.session_state.current_selected_index is not None:
        # User explicitly deselected
        st.session_state.current_selected_index = None
    elif len(selected_rows) > 1:
        # Multiple selections - keep the newest one (last clicked)
        # Find which one is new by comparing with current
        for _, row in selected_rows.iterrows():
            if row['original_index'] != st.session_state.current_selected_index:
                st.session_state.current_selected_index = row['original_index']
                st.rerun()
                break
    
    if len(selected_rows) >= 1:
        # ---------------------------
        # INLINE SCORE & NOTES EDIT SECTION
        # ---------------------------
        if len(selected_rows) == 1:
            selected_row_data = selected_rows.iloc[0]
            selected_unique_id = str(selected_row_data['Unique_ID'])
            
            # Get current scores and notes
            all_scores = load_scores()
            current_scores, current_notes = get_score_and_notes(all_scores, selected_file_name, selected_unique_id)

            # ---------------------------
            # Comparison Display
            # ---------------------------
            # Get the full row data from df_filtered using Unique_ID
            unique_id = selected_row_data['Unique_ID']
            full_row = df_filtered[df_filtered['Unique_ID'] == unique_id].iloc[0]
            
            if schema_version == "v4":
                causal_statement = full_row.get(DISPLAY_COLUMNS_V4['relationship'], '')
                original_reference_text = str(full_row.get(DISPLAY_COLUMNS_V4['source_text'], '')).strip()
                # Get all type fields and marker for V4
                pattern_type = full_row.get(DISPLAY_COLUMNS_V4['pattern_type'], '')
                sentence_type = full_row.get(DISPLAY_COLUMNS_V4['sentence_type'], '')
                marked_type = full_row.get(DISPLAY_COLUMNS_V4['marked_type'], '')
                explicit_type = full_row.get(DISPLAY_COLUMNS_V4['explicit_type'], '')
                marker = full_row.get(DISPLAY_COLUMNS_V4['marker'], '')
                reasoning = full_row.get(DISPLAY_COLUMNS_V4['reasoning'], '')
                # Get subject and object directly from full row data
                subject = full_row.get(DISPLAY_COLUMNS_V4['subject'], '')
                obj = full_row.get(DISPLAY_COLUMNS_V4['object'], '')
            else:
                causal_statement = full_row.get(DISPLAY_COLUMNS_V3['causal'], '')
                original_reference_text = str(full_row.get(DISPLAY_COLUMNS_V3['original reference'], '')).strip()
                pattern_type = full_row.get(DISPLAY_COLUMNS_V3['pattern'], '')
                sentence_type = full_row.get(DISPLAY_COLUMNS_V3['causal type'], '')
                marked_type = ''
                explicit_type = ''
                marker = ''
                subject = ''
                obj = full_row.get(DISPLAY_COLUMNS_V3['Named entity/Object in causal'], '')
                reasoning = full_row.get(DISPLAY_COLUMNS_V3['note'], '')
            
            # Side-by-side layout: Details on the left, Source Text on the right
            details_col, source_col = st.columns(2)
            
            with details_col:
                # Show current index with navigation buttons
                current_idx = selected_row_data['original_index']
                
                # Navigation row: Prev button, Index display, Next button
                nav_col1, nav_col2, nav_col3 = st.columns([1, 2, 1])
                
                with nav_col1:
                    if st.button("⬅️ Prev", disabled=(current_idx == 0), key="prev_btn"):
                        st.session_state.auto_select_index = current_idx - 1
                        st.rerun()
                
                with nav_col2:
                    st.markdown(f"<h3 style='text-align: center; margin: 0;'>📍 {current_idx + 1} / {len(df_filtered)}</h3>", unsafe_allow_html=True)
                
                with nav_col3:
                    if st.button("Next ➡️", disabled=(current_idx >= len(df_filtered) - 1), key="next_btn"):
                        st.session_state.auto_select_index = current_idx + 1
                        st.rerun()
                
                st.subheader("📝 Selected Item Details")
                
                # Full Relationship at the top with bigger text
                st.markdown("##### 🔗 Full Relationship")
                st.markdown(f"<p style='font-size:20px; line-height:1.6;'><em>{causal_statement}</em></p>", unsafe_allow_html=True)
                
                # Display subject and object with bigger text
                st.markdown(f"<p style='font-size:18px;'><strong>{DISPLAY_COLUMNS_V4['subject']}:</strong> <span style='color:#28a745; font-size:20px;'>{subject or '—'}</span></p>", unsafe_allow_html=True)
                st.markdown(f"<p style='font-size:18px;'><strong>{DISPLAY_COLUMNS_V4['object']}:</strong> <span style='color:#dc3545; font-size:20px;'>{obj or '—'}</span></p>", unsafe_allow_html=True)
                
                # Display all types in a clear grid layout
                st.markdown("##### 📋 Classification Types")
                type_col1, type_col2 = st.columns(2)
                with type_col1:
                    st.metric("Pattern Type", pattern_type or "—")
                    st.metric("Marked Type", marked_type or "—")
                with type_col2:
                    st.metric("Sentence Type", sentence_type or "—")
                    st.metric("Explicit Type", explicit_type or "—")
                
                # Display marker prominently
                st.markdown("##### 🏷️ Marker")
                if marker:
                    st.info(f"**\"{marker}\"**")
                else:
                    st.caption("_No marker (unmarked causal relationship)_")
                
                # Reasoning
                if reasoning:
                    st.markdown("##### 💡 Reasoning")
                    st.caption(reasoning)
                
                # Show saved scores summary
                saved_scores_display = f"SF: `{current_scores['semantic_fidelity'] or '-'}` | SA: `{current_scores['schema_accuracy'] or '-'}` | EA: `{current_scores['explicit_accuracy'] or '-'}` | SI: `{current_scores['structural_integrity'] or '-'}`"
                st.markdown(f"**Saved Scores:** {saved_scores_display}")
                if current_notes:
                    st.markdown(f"**Saved Notes:** {current_notes}")
            
            with source_col:
                st.subheader("📄 Source Text Comparison")

                if df_reference_input is not None and len(df_reference_input) > 0:
                    raw_text = original_reference_text
                    
                    highlight_style = 'background-color: #981ca3; font-weight: bold; color: white; padding: 2px; border-radius: 2px;' 
                    best_csv_match = None
                    matched_segments = []
                    
                    # Check if text contains "..." (ellipsis indicating shortened text)
                    if "..." in raw_text:
                        # Split by "..." and filter out empty segments
                        segments = [seg.strip() for seg in raw_text.split("...") if seg.strip()]
                        
                        for csv_input in df_reference_input['input'].tolist():
                            csv_lower = csv_input.lower()
                            # Check if ALL segments are found in the CSV input
                            all_found = all(seg.lower() in csv_lower for seg in segments)
                            if all_found:
                                best_csv_match = csv_input
                                matched_segments = segments
                                break
                    else:
                        # Original simple matching for complete text
                        for csv_input in df_reference_input['input'].tolist():
                            if raw_text.lower() in csv_input.lower():
                                best_csv_match = csv_input
                                matched_segments = [raw_text]
                                break
                    
                    if best_csv_match:
                        final = best_csv_match
                        # Highlight each matched segment
                        for segment in matched_segments:
                            # Find the segment case-insensitively but preserve original case
                            import re
                            pattern = re.compile(re.escape(segment), re.IGNORECASE)
                            match = pattern.search(final)
                            if match:
                                original_text = match.group()
                                styled_segment = f"<span style='{highlight_style}'>{original_text}</span>"
                                final = final[:match.start()] + styled_segment + final[match.end():]
                        
                        st.markdown("**CSV Input (Source Document)**")
                        st.markdown(final, unsafe_allow_html=True)
                        
                        # Show info about ellipsis handling if applicable
                        if len(matched_segments) > 1:
                            st.caption(f"ℹ️ Text was shortened with '...'. Matched {len(matched_segments)} segments.")
                    else:
                        st.warning("Original snippet not found inside CSV input text.")
                        st.markdown(f"**Source Text:** {raw_text}")
                else:
                    st.warning("No CSV Loaded.")
                    st.markdown(f"**Source Text:** {original_reference_text}")

        # ---------------------------
        # ✍️ Evaluation Scores (at the bottom)
        # ---------------------------
        st.markdown("---")
        st.subheader("✍️ Evaluation Scores")
        
        # 2x2 Grid for 4 scoring matrices
        score_row1_col1, score_row1_col2 = st.columns(2)
        score_row2_col1, score_row2_col2 = st.columns(2)
        
        # 1. Semantic Fidelity (SF)
        with score_row1_col1:
            st.markdown("##### 🎯 Semantic Fidelity (SF)")
            with st.expander("📖 Criteria Guide", expanded=False):
                st.markdown("""
**5 - Excellent:** The causal statement completely and accurately captures the meaning from the source text with no distortion or loss.

**4 - Good:** The causal statement captures the meaning well, but may have minor phrasing differences that don't change the core meaning.

**3 - Moderate:** The causal statement generally captures the meaning, but some nuance is lost or slightly altered.

**2 - Below Average:** The causal statement captures some meaning, but has notable distortions or missing elements.

**1 - Poor:** The causal statement significantly misrepresents or fails to capture the meaning from the source.
""")
            semantic_score = st.radio(
                "Rate Semantic Fidelity (1-5):",
                options=["—", "1", "2", "3", "4", "5"],
                horizontal=True,
                key=f"semantic_{selected_unique_id}",
                index=["—", "1", "2", "3", "4", "5"].index(current_scores['semantic_fidelity']) if current_scores['semantic_fidelity'] in ["1", "2", "3", "4", "5"] else 0
            )
        
        # 2. Schema Classification Accuracy (SA)
        with score_row1_col2:
            st.markdown("##### 📊 Schema Classification Accuracy (SA)")
            with st.expander("📖 Criteria Guide", expanded=False):
                st.markdown("""
**5 - Excellent:** Causal Type, Sentence Type, and Marked Type are all correctly classified.

**4 - Good:** Two out of three types are correctly classified; the third has a minor error.

**3 - Moderate:** One major type (e.g., Causal Type) is incorrect, or two types have minor errors.

**2 - Below Average:** Multiple types are incorrectly classified.

**1 - Poor:** All or nearly all type classifications are incorrect.
""")
            schema_score = st.radio(
                "Rate Schema Accuracy (1-5):",
                options=["—", "1", "2", "3", "4", "5"],
                horizontal=True,
                key=f"schema_{selected_unique_id}",
                index=["—", "1", "2", "3", "4", "5"].index(current_scores['schema_accuracy']) if current_scores['schema_accuracy'] in ["1", "2", "3", "4", "5"] else 0
            )
        
        # 3. Explicit Type Accuracy (EA)
        with score_row2_col1:
            st.markdown("##### 🔍 Explicit Type Accuracy (EA)")
            with st.expander("📖 Criteria Guide", expanded=False):
                st.markdown("""
**5 - Excellent:** Explicit Type classification is correct, matching the presence of a clear causal marker (e.g., "because," "therefore").

**4 - Good:** Classification is correct, but the marker choice or reasoning is slightly ambiguous.

**3 - Moderate:** Classification is borderline correct, with room for interpretation (e.g., implicit causality misidentified as explicit).

**2 - Below Average:** Classification is incorrect but understandable given context.

**1 - Poor:** Classification is clearly wrong (e.g., explicit marked as implicit or vice versa).
""")
            explicit_score = st.radio(
                "Rate Explicit Type Accuracy (1-5):",
                options=["—", "1", "2", "3", "4", "5"],
                horizontal=True,
                key=f"explicit_{selected_unique_id}",
                index=["—", "1", "2", "3", "4", "5"].index(current_scores['explicit_accuracy']) if current_scores['explicit_accuracy'] in ["1", "2", "3", "4", "5"] else 0
            )
        
        # 4. Structural Integrity (SI)
        with score_row2_col2:
            st.markdown("##### 🔗 Structural Integrity (SI)")
            with st.expander("📖 Criteria Guide", expanded=False):
                st.markdown("""
**5 - Excellent:** Subject and Object are correctly identified with appropriate cause-to-effect directionality.

**4 - Good:** Subject and Object are mostly correct; minor boundary or phrasing issues.

**3 - Moderate:** One element (Subject or Object) is incorrect or direction is partially off.

**2 - Below Average:** Significant errors in structure (e.g., roles swapped or incomplete).

**1 - Poor:** Subject/Object are entirely wrong, or cause-effect directionality is reversed.
""")
            structural_score = st.radio(
                "Rate Structural Integrity (1-5):",
                options=["—", "1", "2", "3", "4", "5"],
                horizontal=True,
                key=f"structural_{selected_unique_id}",
                index=["—", "1", "2", "3", "4", "5"].index(current_scores['structural_integrity']) if current_scores['structural_integrity'] in ["1", "2", "3", "4", "5"] else 0
            )
        
        # Notes
        notes = st.text_area("📝 Notes (optional):", value=current_notes, height=80, key=f"notes_{selected_unique_id}")
        
        # Save button
        if st.button("💾 Save Score & Notes", type="primary", key=f"save_{selected_unique_id}"):
            all_scores = load_scores()
            
            if selected_file_name not in all_scores:
                all_scores[selected_file_name] = {}
            
            all_scores[selected_file_name][selected_unique_id] = {
                "semantic_fidelity": semantic_score if semantic_score != "—" else "",
                "schema_accuracy": schema_score if schema_score != "—" else "",
                "explicit_accuracy": explicit_score if explicit_score != "—" else "",
                "structural_integrity": structural_score if structural_score != "—" else "",
                "notes": notes
            }
            
            save_scores(all_scores)
            st.success(f"Saved scores for Unique_ID: {selected_unique_id}")
            
            # Auto-select next row
            current_idx = selected_row_data['original_index']
            if current_idx < len(df_filtered) - 1:
                st.session_state.auto_select_index = current_idx + 1
                st.rerun()

    else:
        st.info("Select a row above to view details.")
