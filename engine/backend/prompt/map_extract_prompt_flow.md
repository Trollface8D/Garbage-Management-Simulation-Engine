# Map Extract Prompt Flow

This document summarizes how map-extraction prompts are assembled stage by stage from:

- `engine/backend/prompt/map_extarct.json`
- `engine/backend/app/services/map_extract_runner.py`

## Mermaid Flow

```mermaid
flowchart TD
    A[Load map_extarct.json] --> B[Read runtime_prompts + stage prompts]
    B --> C[Stage 1: extractmap_symbol]
    C --> D[Stage 2: extractmap_text]
    D --> E[Stage 3: tabular_extraction]
    E --> F[Stage 4: support enrichment and normalize]
    F --> G[Stage 5: edge_extraction]
    G --> H[Filter and dedupe nodes and edges]
    H --> I[Return graph plus token and cost metadata]

    C --> C1[Prompt = extractmap_symbol.prompt + extractmap_symbol_output_hint]
    D --> D1[Prompt = extractmap_text.prompt + schema + dedup + exclusion + compact]
    E --> E1[Prompt = tabular_extraction.prompt + csv hint + no-support hint when needed]
    F --> F1[Prompt = support_joint or fallback or delta + normalize context]
    G --> G1[Prompt = edge_extraction.prompt + edge schema + edge dedup + compact + csv fallback]
```

## Stage Details

1. `extractmap_symbol`
- Purpose: detect legend symbols and notation.
- Assembled prompt includes the base stage prompt and concise markdown-table output hint.

2. `extractmap_text`
- Purpose: produce normalized node JSON from map text and support cues.
- Assembled prompt includes JSON schema, dedup policy, exclusion policy, and compact output policy.

3. `tabular_extraction`
- Purpose: extract support table content.
- Assembled prompt includes CSV-only output hint.
- If no support image exists, adds no-support hint.

4. Support enrichment and normalization
- Purpose: add missing node metadata from support artifacts and normalize shape.
- Uses joint/fallback/delta runtime prompts and normalize context guidance.

5. `edge_extraction`
- Purpose: build traversal edges using map plus extracted node set.
- Assembled prompt includes edge JSON schema, edge dedup policy, compact output policy, and CSV fallback hint.

## Reproduce Prompt Bodies Locally

Run the helper script at the repository root:

`python map_extract_prompt_replay.py`

Optional values can be provided to simulate runtime input text:

`python map_extract_prompt_replay.py --ocr-map "..." --symbol-table "..." --support-csv "..." --node-json '{"nodes":[]}'`
