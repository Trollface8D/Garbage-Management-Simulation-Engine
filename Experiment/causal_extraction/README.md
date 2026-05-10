# Causal Extraction — Experiment

Evaluation workspace for the causal extraction pipeline. Use this to iterate on prompts, label outputs, and assess extraction quality before patching `engine/backend/`.

> **Source of truth for schema and evaluation methodology:** `docs/Final_report__VIP_.pdf` §4.4 (p. 45–47) and §5.1 (p. 56–61)

---

## Extraction Schema

Each source sentence produces one **ExtractionClassRecord** containing classification metadata and one or more atomic **ExtractedRelation** triples.

### ExtractionClassRecord

```json
{
  "pattern_type":  "C | A | F",
  "sentence_type": "SB | ES | OT | SP | D | NR",
  "marked_type":   "M | U | N/A",
  "explicit_type": "E | I",
  "marker":        "string | null",
  "source_text":   "string (original language)",
  "extracted": [ ...ExtractedRelation ]
}
```

#### `pattern_type` — Event Nature

| Code | Name | Meaning | Simulation use |
|---|---|---|---|
| `C` | Causal | Direct cause-and-effect (X leads to Y) | Core: becomes a Policy class |
| `A` | Action | Entity performs action, no explicit effect | Behaviour hint for entity methods |
| `F` | Fact/Behavior | Static state or recurring behavior | Initial state / default parameter |

**Why three types:** Pure facts (`F`) and actions (`A`) do not map to causal policies. Keeping them separate allows the code-gen stage to ignore non-causal records and prevents spurious Policy classes from being generated.

---

#### `sentence_type` — Context Category

| Code | Name | Meaning |
|---|---|---|
| `SB` | System Behavior | Technical process or mechanical operation |
| `ES` | Environment Setting | Context, background, static conditions |
| `OT` | Optimization Target | Metric or goal the system should optimise |
| `SP` | Suggest Policy | Proposed rule or course of action |
| `D`  | Define | Definition of a term or concept |
| `NR` | Not Related | Chitchat or out-of-scope content |

**Why classify sentences:** Downstream stages filter by `sentence_type`. `OT` entries feed the metric contract draft (`state1d_metrics_draft`). `SP` entries surface as policy candidates in `state1b_policy_outline`. `NR` and `D` entries are discarded before code generation.

---

#### `marked_type` — Causation Marker (C only)

| Code | Meaning |
|---|---|
| `M` | Marked — a specific linguistic connector appears ("because", "causes", "results in") |
| `U` | Unmarked — causality inferred from punctuation, sequence, or context |
| `N/A` | Not applicable (pattern_type is A or F) |

**Why track markedness:** Unmarked causal relations are more ambiguous and may need follow-up questions. The follow-up module prioritises `U` + `I` records for clarification.

---

#### `explicit_type` — Explicitness

| Code | Meaning |
|---|---|
| `E` | Explicit — text directly states the causal direction |
| `I` | Implicit — causality inferred via world knowledge or sequence |

Applies to all pattern types. Implicit records (`I`) receive lower confidence scores in evaluation and are flagged as follow-up candidates.

---

#### `marker` — Connector Word

The exact linguistic marker (e.g., `"because"`, `"causes"`, `"results in"`). Required when `marked_type = M`; `null` otherwise.

---

#### `source_text` — Original Language Text

Always stored in the **original language** (Thai or English). The translated/extracted values go into `head`, `relationship`, `tail`, `detail` in English. This ensures the extraction is traceable back to the raw interview text.

---

### ExtractedRelation

```json
{
  "head":         "string",
  "relationship": "string",
  "tail":         "string",
  "detail":       "string | null"
}
```

| Field | Role | Rule |
|---|---|---|
| `head` | Agent / Cause / Subject | **Single noun phrase only.** Compound subjects split into separate records. |
| `relationship` | Predicate / Verb clause | The link or action connecting head → tail. |
| `tail` | Effect / Target / Object | **Single noun phrase only.** Compound objects split into separate records. |
| `detail` | Adverbial context | Modifiers, prepositions, conditions not captured in head/tail (e.g., `"when bins are full"`). `null` if none. |

**Atomicity rule (critical):** one noun phrase per `head`, one per `tail`. Compound entities like _"students and staff"_ produce two separate records via Cartesian product: `{students → tail}` and `{staff → tail}`. This enforces that each entity in simulation has a distinct causal role.

**Reification rule:** when an event is itself the subject of another causal chain ("A caused B, which led to C"), decompose into `{A → B}` and `{B → C}`. The second triple's head is the reified event.

**Inspiration:** the `{head, relationship, tail}` core is a standard binary KG triple. The `detail` field extends it to an N-ary structure [ref: Wei et al. 2025, "A Survey of Link Prediction in N-ary Knowledge Graphs"], capturing multi-argument context that binary triples discard.

---

## Full Example Record

```json
[
  {
    "pattern_type": "C",
    "sentence_type": "SB",
    "marked_type": "M",
    "explicit_type": "E",
    "marker": "results in",
    "source_text": "เมื่อถังขยะเต็ม จะส่งผลให้พนักงานทำความสะอาดต้องมาเก็บ",
    "extracted": [
      {
        "head": "trash bin overflow",
        "relationship": "results in",
        "tail": "cleaning staff",
        "detail": "must come to collect waste"
      }
    ]
  }
]
```

---

## Folder Structure

```
Experiment/causal_extraction/
├── README.md                  # This file
├── config.py                  # Experiment config (model, paths)
├── prompt.json                # Prompt versions under test
├── requirement.txt            # Python deps for experiment scripts
├── data_extract/              # Raw extraction outputs (JSON)
├── extracted_evaluation/      # Labelled evaluation CSVs
├── page/                      # Per-page source text files
├── utils/                     # Shared experiment utilities
└── visualize/                 # Streamlit evaluator UI
    └── visualize.py           # run: streamlit run visualize.py
```

The production prompt (v6) is at `engine/backend/prompt/causal_extract.txt`. This folder holds earlier prompt versions and the tooling to compare them.

---

## Evaluator UI

```bash
streamlit run Experiment/causal_extraction/visualize/visualize.py
```

- Input prompt + source text → calls Gemini → saves output JSON
- Select output file from dropdown → see source/output pairs
- Label each extraction with a 1–5 completeness score:
  - 5: flawless
  - 4: small missing points
  - 3: noticeable missing detail
  - 2: critical missing part
  - 1: completely wrong
- Click to auto-save labelled output as CSV

---

## Evaluation Results (§5.1 — causal extraction)

| Metric | Score | N |
|---|---|---|
| Semantic Fidelity | 4.22 / 5 | 18 test cases |
| Schema Classification Accuracy | 4.89 / 5 | 18 test cases |

> Source: `docs/Final_report__VIP_.pdf` p. 56–61
