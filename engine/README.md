kg_studio/
├── app.py                 # Core App & State Config
├── registry.py            # Centralized Disk Cache config
├── pipeline_engine.py     # End-to-end C4 pipeline (mp3/text -> entities)
├── pipeline/              # Modular pipeline package
│   ├── cli.py             # Argument parsing and entrypoint logic
│   ├── engine.py          # Pipeline orchestration class
│   ├── steps.py           # Chunking/transcription/prompt processing helpers
│   ├── llm_client.py      # Gemini gateway and robust JSON parsing
│   ├── io_utils.py        # File and naming utilities
│   ├── constants.py       # Paths, defaults, supported audio MIME map
│   └── types.py           # Shared dataclasses
├── pages/
│   ├── extraction_page.py # UI for PDF/MP4 -> Gemini
│   ├── graph_rag_page.py  # The "Inspector" & Selection UI
│   └── generation_page.py # Generation Log & Output
├── utils/
│   ├── graph_engine.py    # BFS Traversal & NetworkX logic
│   ├── vector_db.py       # GraphVecDB Class (Cleaned up)
│   └── schemas.py         # Pydantic & Enum definitions
└── assets/                # Custom CSS for "Window App" look

## C4 pipeline engine

Run from workspace root:

```powershell
python Engine/pipeline_engine.py --input-path path/to/interview.mp3 --input-type mp3
```

or with text input:

```powershell
python Engine/pipeline_engine.py --input-path path/to/interview.txt --input-type text
```

Optional inline text mode:

```powershell
python Engine/pipeline_engine.py --input-text "your interview text" --input-type text
```

Artifacts are written to `Engine/output/pipeline_runs/run_YYYYMMDD_HHMMSS/`:

- `transcript.txt`
- `chunks.json`
- `causal_by_chunk.json`
- `causal_combined.json`
- `follow_up_questions.json`
- `entities.json`
- `generated_entities/*.py`
- `generated_entity_files.json`
- `generation_log.csv`
- `summary.json`

