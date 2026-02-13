import streamlit as st
import pandas as pd
import json
import os
import re

# Get the script's directory to build absolute paths
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(SCRIPT_DIR)  # Goes from engine/ to Causal_extractor/

# Define the base directories (use data_extract output and generation_log as requested)
BASE_DIR = os.path.join(PROJECT_ROOT, "data_extract", "output")
REFERENCE_DIR = os.path.join(PROJECT_ROOT, "data_extract")
FOLLOWUP_FILE_PATH = os.path.join(PROJECT_ROOT, "lib", "experiment_2_output.json")

# Define the score storage path
SCORE_FILE_NAME = "validation_scores_saved.json"
SCORE_FILE_PATH = os.path.join(BASE_DIR, SCORE_FILE_NAME)

# Define column names based on JSON structure
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
REF_COL_NAME = "Source Text"

# ------------------------------------------------------------------
# Helper Functions
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

@st.cache_data
def load_followup_questions():
    """Load follow-up questions keyed by relationship_extraction."""
    if not os.path.exists(FOLLOWUP_FILE_PATH):
        return {}
    try:
        with open(FOLLOWUP_FILE_PATH, 'r', encoding='utf-8') as f:
            data = json.load(f)
        mapping = {}
        if isinstance(data, list):
            for item in data:
                rel = item.get("relationship_extraction")
                questions = item.get("generated_questions", [])
                if rel and isinstance(questions, list):
                    mapping[rel] = questions
        return mapping
    except Exception as e:
        st.error(f"Error loading follow-up questions: {e}")
        return {}

def get_score_and_notes(all_scores, file_name, unique_id):
    """Get scores and notes for a specific row. Handles old format and new 4-matrix format."""
    if file_name not in all_scores:
        return '', '', '', '', ''
    file_scores = all_scores[file_name]
    if unique_id not in file_scores:
        return '', '', '', '', ''
    row_data = file_scores[unique_id]
    
    # New 4-matrix format
    sf = row_data.get('sf', '')
    sa = row_data.get('sa', '')
    ea = row_data.get('ea', '')
    si = row_data.get('si', '')
    notes = row_data.get('notes', '')
    
    return sf, sa, ea, si, notes

def set_score_and_notes(all_scores, file_name, unique_id, sf, sa, ea, si, notes):
    """Set the scores and notes for a specific row using 4-matrix format."""
    if file_name not in all_scores:
        all_scores[file_name] = {}
    all_scores[file_name][unique_id] = {
        'sf': sf,
        'sa': sa,
        'ea': ea,
        'si': si,
        'notes': notes
    }

def get_scores_file_mtime():
    """Get the modification time of the scores file for cache invalidation."""
    if os.path.exists(SCORE_FILE_PATH):
        return os.path.getmtime(SCORE_FILE_PATH)
    return 0

@st.cache_data
def load_json_data(file_path, selected_file_name, scores_mtime):
    """Load JSON data and merge with saved scores. Cache is invalidated when scores file changes."""
    with open(file_path, 'r', encoding='utf-8') as f:
        data = json.load(f)
    
    # Auto-detect schema version
    if isinstance(data, list) and len(data) > 0:
        first_item = data[0]
        if "pattern_type" in first_item or "sentence_type" in first_item:
            schema_version = "v4"
            columns = COLUMNS_V4
            display_columns = DISPLAY_COLUMNS_V4
        else:
            schema_version = "v3"
            columns = COLUMNS_V3
            display_columns = DISPLAY_COLUMNS_V3
    else:
        schema_version = "v4"
        columns = COLUMNS_V4
        display_columns = DISPLAY_COLUMNS_V4
    
    df = pd.DataFrame(data)
    
    # Rename columns for display
    rename_map = {col: display_columns.get(col, col) for col in df.columns if col in display_columns}
    df = df.rename(columns=rename_map)
    
    # Create unique ID
    df['Unique_ID'] = df.index.astype(str)
    
    # Load existing scores
    all_scores = load_scores()
    
    # Add score and notes columns
    sf_list, sa_list, ea_list, si_list, notes_list = [], [], [], [], []
    for idx, row in df.iterrows():
        unique_id = str(idx)
        sf, sa, ea, si, notes = get_score_and_notes(all_scores, selected_file_name, unique_id)
        sf_list.append(sf)
        sa_list.append(sa)
        ea_list.append(ea)
        si_list.append(si)
        notes_list.append(notes)
    
    df['SF'] = sf_list
    df['SA'] = sa_list
    df['EA'] = ea_list
    df['SI'] = si_list
    df['Notes'] = notes_list
    
    return df, schema_version

@st.cache_data
def load_csv_reference(csv_path):
    """Load the reference CSV file."""
    try:
        df_csv = pd.read_csv(csv_path)
        if 'input' in df_csv.columns:
            return df_csv[['input']]
        else:
            st.warning(f"'input' column not found in {csv_path}")
            return pd.DataFrame(columns=['input'])
    except Exception as e:
        st.error(f"Error reading CSV: {e}")
        return pd.DataFrame(columns=['input'])

def highlight_references(row, selected_reference_input):
    style = [''] * len(row)
    if selected_reference_input and selected_reference_input != 'None':
        original_reference_text = str(row[REF_COL_NAME]).strip()
        if original_reference_text == selected_reference_input.strip():
            style = ['background-color: #ffd700; color: #333333'] * len(row)
    return style

# ------------------------------------------------------------------
# Main Visualize Function
# ------------------------------------------------------------------

def show_visualize():
    """Display the visualization and validation page"""
    
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
    df = pd.DataFrame(columns=list(DISPLAY_COLUMNS_V4.values()) + ["SF", "SA", "EA", "SI", "Notes"])
    schema_version = "v4"

    if json_files:
        selected_file_name = st.selectbox("Select JSON", options=json_files)
        
        if selected_file_name:
            full_path = os.path.join(BASE_DIR, selected_file_name)
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

        # Apply filters
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
                'SF', 'SA', 'EA', 'SI',
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
        cols_for_selection = [c for c in cols_for_selection if c in df_filtered.columns]
        
        df_selection_view = df_filtered[cols_for_selection].copy()
        df_selection_view.insert(0, 'Select', False)
        
        # Initialize current_selected_index in session state
        if 'current_selected_index' not in st.session_state:
            st.session_state.current_selected_index = None
        
        # Auto-select row based on session state
        if 'auto_select_index' in st.session_state and st.session_state.auto_select_index is not None:
            st.session_state.current_selected_index = st.session_state.auto_select_index
            st.session_state.auto_select_index = None
        
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
        
        # Update session state based on user selection
        if len(selected_rows) == 1:
            new_selected_idx = selected_rows.iloc[0]['original_index']
            if st.session_state.current_selected_index != new_selected_idx:
                st.session_state.current_selected_index = new_selected_idx
                st.rerun()
            else:
                st.session_state.current_selected_index = new_selected_idx
        elif len(selected_rows) == 0 and st.session_state.current_selected_index is not None:
            st.session_state.current_selected_index = None
        elif len(selected_rows) > 1:
            for _, row in selected_rows.iterrows():
                if row['original_index'] != st.session_state.current_selected_index:
                    st.session_state.current_selected_index = row['original_index']
                    st.rerun()
                    break
        
        if len(selected_rows) >= 1:
            if len(selected_rows) == 1:
                selected_row_data = selected_rows.iloc[0]
                selected_unique_id = str(selected_row_data['Unique_ID'])

                # Get full row data
                unique_id = selected_row_data['Unique_ID']
                full_row = df_filtered[df_filtered['Unique_ID'] == unique_id].iloc[0]
                
                if schema_version == "v4":
                    causal_statement = full_row.get(DISPLAY_COLUMNS_V4['relationship'], '')
                    original_reference_text = str(full_row.get(DISPLAY_COLUMNS_V4['source_text'], '')).strip()
                    pattern_type = full_row.get(DISPLAY_COLUMNS_V4['pattern_type'], '')
                    sentence_type = full_row.get(DISPLAY_COLUMNS_V4['sentence_type'], '')
                    marked_type = full_row.get(DISPLAY_COLUMNS_V4['marked_type'], '')
                    explicit_type = full_row.get(DISPLAY_COLUMNS_V4['explicit_type'], '')
                    marker = full_row.get(DISPLAY_COLUMNS_V4['marker'], '')
                    reasoning = full_row.get(DISPLAY_COLUMNS_V4['reasoning'], '')
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
                
                # Side-by-side layout
                details_col, source_col = st.columns(2)
                
                with details_col:
                    current_idx = selected_row_data['original_index']
                    
                    # Navigation
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
                    
                    # Full Relationship
                    st.markdown("##### 🔗 Full Relationship")
                    st.markdown(f"<p style='font-size:20px; line-height:1.6;'><em>{causal_statement}</em></p>", unsafe_allow_html=True)
                    
                    # Subject and Object
                    st.markdown(f"<p style='font-size:18px;'><strong>{DISPLAY_COLUMNS_V4['subject']}:</strong> <span style='color:#28a745; font-size:20px;'>{subject or '—'}</span></p>", unsafe_allow_html=True)
                    st.markdown(f"<p style='font-size:18px;'><strong>{DISPLAY_COLUMNS_V4['object']}:</strong> <span style='color:#dc3545; font-size:20px;'>{obj or '—'}</span></p>", unsafe_allow_html=True)
                    
                    # Classification Types
                    st.markdown("##### 📋 Classification Types")
                    type_col1, type_col2 = st.columns(2)
                    with type_col1:
                        st.metric("Pattern Type", pattern_type or "—")
                        st.metric("Marked Type", marked_type or "—")
                    with type_col2:
                        st.metric("Sentence Type", sentence_type or "—")
                        st.metric("Explicit Type", explicit_type or "—")
                    
                    # Marker
                    st.markdown("##### 🏷️ Marker")
                    if marker:
                        st.info(f"**\"{marker}\"**")
                    else:
                        st.caption("_No marker (unmarked causal relationship)_")
                    
                    # Reasoning
                    if reasoning:
                        st.markdown("##### 💡 Reasoning")
                        st.caption(reasoning)
                
                with source_col:
                    st.subheader("📄 Source Text Comparison")

                    if df_reference_input is not None and len(df_reference_input) > 0:
                        raw_text = original_reference_text
                        
                        highlight_style = 'background-color: #981ca3; font-weight: bold; color: white; padding: 2px; border-radius: 2px;' 
                        best_csv_match = None
                        matched_segments = []
                        
                        if "..." in raw_text:
                            segments = [seg.strip() for seg in raw_text.split("...") if seg.strip()]
                            
                            for csv_input in df_reference_input['input'].tolist():
                                csv_lower = csv_input.lower()
                                all_found = all(seg.lower() in csv_lower for seg in segments)
                                if all_found:
                                    best_csv_match = csv_input
                                    matched_segments = segments
                                    break
                        else:
                            for csv_input in df_reference_input['input'].tolist():
                                if raw_text.lower() in csv_input.lower():
                                    best_csv_match = csv_input
                                    matched_segments = [raw_text]
                                    break
                        
                        if best_csv_match:
                            final = best_csv_match
                            for segment in matched_segments:
                                pattern = re.compile(re.escape(segment), re.IGNORECASE)
                                match = pattern.search(final)
                                if match:
                                    original_text = match.group()
                                    styled_segment = f"<span style='{highlight_style}'>{original_text}</span>"
                                    final = final[:match.start()] + styled_segment + final[match.end():]
                            
                            st.markdown("**CSV Input (Source Document)**")
                            st.markdown(final, unsafe_allow_html=True)
                            
                            if len(matched_segments) > 1:
                                st.caption(f"ℹ️ Text was shortened with '...'. Matched {len(matched_segments)} segments.")
                        else:
                            st.warning("Original snippet not found inside CSV input text.")
                            st.markdown(f"**Source Text:** {raw_text}")
                    else:
                        st.warning("No CSV Loaded.")
                        st.markdown(f"**Source Text:** {original_reference_text}")

            # Follow-up questions for implicit causal links
            st.markdown("---")
            st.subheader("🔎 Follow-up Questions")

            if schema_version == "v4" and (explicit_type or "").strip().upper() == "I":
                questions_map = load_followup_questions()
                questions = questions_map.get(causal_statement, [])
                if questions:
                    st.markdown("Because this causal link is **implicit**, review these questions:")
                    for q in questions:
                        st.markdown(f"- {q}")
                else:
                    st.caption("⚠️ No follow-up questions found for this relationship in the follow-up questions file.")
            else:
                st.caption("ℹ️ Follow-up questions are only shown for implicit causal relationships.")

        else:
            st.info("Select a row above to view details.")

