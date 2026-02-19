kg_studio/
├── app.py                 # Core App & State Config
├── registry.py            # Centralized Disk Cache config
├── pages/
│   ├── extraction_page.py # UI for PDF/MP4 -> Gemini
│   ├── graph_rag_page.py  # The "Inspector" & Selection UI
│   └── generation_page.py # Generation Log & Output
├── utils/
│   ├── graph_engine.py    # BFS Traversal & NetworkX logic
│   ├── vector_db.py       # GraphVecDB Class (Cleaned up)
│   └── schemas.py         # Pydantic & Enum definitions
└── assets/                # Custom CSS for "Window App" look

