# Framework_Simulation_Garbage

This repository is an LLM-driven framework for building and testing waste-management simulations.
It helps transform qualitative inputs (documents, transcripts, domain notes) into structured causal knowledge and simulation-ready artifacts, then supports policy testing to evaluate potential interventions.

## Project Purpose

- Build a simulation workflow for garbage management using LLM-based extraction and code generation.
- Convert raw source material into chunks, causal relations, follow-up questions, and generated entity logic.
- Support policy experimentation (for example: infrastructure changes, collection schedule changes, staffing changes).

## Repository Hierarchy

At a high level, the repository is split into two major parts:

- Experiment: R&D and prototyping area.
- Engine: application/runtime area (including desktop and web components).

```text
Framework_Simulation_Garbage/
├── Engine/                        # Product/runtime side (window app + services + web UI)
│   ├── app.py
│   ├── pipeline_engine.py
│   ├── backend/                   # API + pipeline orchestration
│   ├── desktop/                   # Desktop shell
│   ├── web-ui/                    # Next.js UI (causal extract workflow)
│   ├── pages/
│   ├── utils/
│   └── README.md
├── Experiment/                    # R&D, experiments, legacy prototypes
│   ├── causal_extraction/
│   ├── code_generation/
│   ├── follow-up_question/
│   └── legacy/
├── AImodels/                      # Local model assets/checkpoints
├── .env.example
└── README.md
```

## How To Navigate

- If you are developing or running the current app flow, start from Engine.
- If you are validating ideas, prompt variants, or extraction quality studies, use Experiment.
- If you need implementation details for each module, open the module-level README files:
  - Engine/README.md
  - Engine/web-ui/README.md
  - Experiment/causal_extraction/README.md

## Suggestions

1. Add a single "Quick Start" section at the root with exact commands for local setup, backend start, and web UI start.
2. Add a "Current Stable Flow" section (input -> chunking -> extraction -> follow-up -> policy test) so new contributors understand the intended path.
3. Add a small architecture diagram image in docs to show how Engine and Experiment connect.
4. Standardize naming of prompt/output folders across Experiment modules to reduce onboarding time.
5. Add a short glossary (chunk, causal artifact, follow-up artifact, policy scenario) to reduce ambiguity.

## Notes

- Some subfolders contain additional local files such as prompt templates, outputs, requirements files, and design sketches.
- Module-specific details and commands should stay in each module README, while this root README stays high-level.