# Background Job Pipeline — Architecture & Implementation Notes

Reference doc for building future multi-stage, long-running, resumable background jobs with a polling web UI. Extracted from the map_extract pipeline in this repo. Keep this next to any prompt asking Claude to build something similar — it is the shortest path to the same design without rediscovering every gotcha.

---

## 1. What this architecture solves

A job that:

- Runs for **minutes to tens of minutes** (LLM calls, heavy compute).
- Has **multiple sequential stages**, each with its own output worth checkpointing.
- Must **survive the client closing the browser / reloading the page / switching tabs**.
- Must **survive a backend process restart** (cold start).
- Must be **cancellable mid-run, including mid-HTTP-request**, fast enough that the user trusts the button.
- Must be **resumable from the last successful stage** and **restartable after failure**.
- Surfaces **retries / transient errors / rate limits** so the UI never looks frozen.
- Preserves **user-uploaded binary inputs** so reload doesn't force a re-upload.
- Returns a **structured result** (graph, CSV, whatever) for visualization at the end.

If you only need one of these, pick something simpler. If you need all of them, this doc is the recipe.

---

## 2. Design choices (and why)

| Decision | Why |
|---|---|
| **Polling, not SSE/WebSocket** | SSE is fragile across reverse proxies, and its main win (push latency) doesn't matter for a job that emits a stage event every several seconds. `/status` polled every 1.2–1.5s is simple, survives reconnects for free, and reuses one code path for both "locally started" and "already running on backend" jobs. |
| **Daemon thread per job**, not asyncio | Most LLM/compute SDKs are sync-first and don't expose cancel tokens. A daemon thread runs independently of the HTTP handler, and the handler returns `{jobId}` immediately. Asyncio would be cleaner but forces everything downstream to be async-aware. |
| **Per-stage JSON checkpoints on disk** | The single source of truth for "where are we." Survives process crashes. Lets `/resume` skip work cheaply. Makes rollback a `unlink()`. |
| **In-memory `JOBS` dict is a cache, disk is canonical** | Cold start hydrates `JOBS` from disk. Never write code that assumes `JOBS[jobId]` exists without a disk fallback. |
| **Cancel = flag + polled checks**, not thread kill | Python threads can't be safely killed. Set `cancel_requested=True`; worker polls it at stage boundaries, before every LLM attempt, during backoff sleep, and every 0.5s during in-flight LLM calls (via a sub-daemon-thread wrapper). |
| **localStorage on the client stores only `jobId` + UI state snapshot** | Never the result; always refetch from backend. This makes the UI resilient to stale snapshots and backend restarts. |
| **Inputs stored on disk with a manifest**, not re-uploaded on reload | A manifest JSON plus raw bytes per file. The frontend fetches the manifest on mount and rebuilds `File` objects via blob downloads. |

---

## 3. Component map

```
┌─────────────────────────────────────────────────────────────────┐
│ Frontend (Next.js App Router, React 19)                         │
│                                                                 │
│  workspace.tsx                                                  │
│   ├─ localStorage: jobId + snapshot                             │
│   ├─ mount effect #1: refreshJobStatus() once                   │
│   ├─ mount effect #2: rehydrate uploaded files from manifest    │
│   ├─ mount effect #3: REMOTE WATCHER — poll status→result       │
│   │                   when status∈{running,queued} and no local │
│   │                   Extract/Resume loop is running            │
│   ├─ handleExtract  ─┐                                          │
│   ├─ handleResume   ─┤  each owns a polling loop that updates   │
│   │                  │  the same state fields as the watcher    │
│   │                  │                                          │
│   └─ isJobActive = isExtracting || isResuming || isRemoteWatching│
│                                                                 │
│  stage-log-panel.tsx                                            │
│   ├─ Resume button (becomes "Restart" when status=failed)       │
│   ├─ Terminate button (disabled unless isJobActive)             │
│   └─ Checkpoint poll every 3s while isActive                    │
│                                                                 │
│  api/map/extract/*/route.ts — thin Next.js proxies to FastAPI   │
└─────────────────────────────────────────────────────────────────┘
                              │  HTTP (polling)
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│ Backend (FastAPI)                                               │
│                                                                 │
│  routes/map_extract.py                                          │
│   ├─ POST /jobs             → save_inputs(disk) + spawn daemon  │
│   ├─ GET  /jobs/{id}/status → serialize_job + hydrate from disk │
│   │                           if not in JOBS (cold start)       │
│   ├─ GET  /jobs/{id}/result → JSONResponse from JOBS or disk    │
│   ├─ POST /jobs/{id}/cancel → request_cancel flag               │
│   ├─ POST /jobs/{id}/rollback → delete_after(stage)             │
│   ├─ POST /jobs/{id}/resume → preflight canResume; spawn daemon │
│   ├─ GET  /jobs/{id}/inputs → manifest JSON                     │
│   └─ GET  /jobs/{id}/inputs/{kind}/{i} → raw file bytes         │
│                                                                 │
│  services/job_store.py                                          │
│   ├─ JOBS: dict[str, JobRecord]  (in-memory cache)              │
│   ├─ JOBS_LOCK: threading.Lock                                  │
│   ├─ JobRecord (dataclass): status, stage_history, token_usage,│
│   │                         cancel_requested, completed_stages..│
│   ├─ request_cancel / is_cancel_requested / mark_cancelled      │
│   ├─ emit_job_event(event∈{stage,error,result,done}, payload)   │
│   └─ serialize_job() → dict for wire                            │
│                                                                 │
│  services/map_extract_checkpoints.py                            │
│   ├─ STAGE_ORDER: tuple of stage names (source of truth)        │
│   ├─ save_stage / load_stage / list_stages                      │
│   ├─ delete_from (inclusive — used by cancel rollback)          │
│   ├─ delete_after (exclusive — used by user rollback-to-N)      │
│   ├─ save_inputs / load_inputs (inputs.json + raw files)        │
│   └─ latest_usage_totals (scans back through checkpoints for UI)│
│                                                                 │
│  services/map_extract_runner.py                                 │
│   ├─ daemon-thread entry point                                  │
│   ├─ stage loop: load_stage → skip if cached; else run+save     │
│   ├─ _raise_if_cancelled at every stage boundary                │
│   └─ _run_stage_json / _run_stage_text helpers that pass        │
│      on_retry + cancel_check callbacks into the LLM gateway     │
│                                                                 │
│  infra/gemini_client.py (or your LLM gateway)                   │
│   ├─ retry loop with exponential backoff + jitter               │
│   ├─ on_retry callback surfaces transient errors to the job     │
│   ├─ cancel_check polled before every attempt                   │
│   ├─ _interruptible_sleep during backoff (polls cancel q 0.5s)  │
│   └─ _call_with_cancel: runs generate_content on a sub-daemon   │
│      thread so cancel during in-flight HTTP aborts within 0.5s  │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
                    data/map_extract_jobs/<jobId>/
                      ├─ inputs.json
                      ├─ inputs/overview-1.bin ...
                      ├─ extractmap_symbol.json
                      ├─ extractmap_text.json
                      ├─ tabular_extraction.json
                      ├─ support_enrichment.json
                      ├─ edge_extraction.json
                      └─ finalize_graph.json
```

---

## 4. Data contracts

### 4.1 JobRecord (in-memory + serialized)

```python
@dataclass
class JobRecord:
    job_id: str
    status: str                 # queued | running | completed | failed | cancelled
    created_at: str
    updated_at: str
    current_stage: str | None   # e.g. "map_extract/extractmap_symbol"
    stage_message: str          # human-readable, shown in UI
    stage_history: list[dict]   # append-only
    token_usage: dict[str, int]
    cost_estimate: dict
    error: str | None
    result: dict | None
    cancel_requested: bool
    completed_stages: list[str]
    event_queue: queue.Queue    # optional, for SSE if you add it later
```

### 4.2 Wire format for `/status` (MINIMUM fields the frontend needs)

```ts
type JobStatus = {
  jobId: string;
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  currentStage: string | null;
  stageMessage: string;
  completedStages: string[];          // for the stage-log checklist
  // Resume/restart UX:
  canResume: boolean;                 // backend preflight; frontend uses this + !isActive
  remainingStages: number;            // if 0, show "No stages left" or "Restart"
  nextStage: string | null;           // for the tooltip
  resumeDisabledReason: string | null;
  // Cancel UX:
  cancelRequested: boolean;           // shows the "cancel requested" badge
  // Progress:
  tokenUsage: {promptTokens, outputTokens, totalTokens, callCount};
  costEstimate: {currency, amount};
  error: string | null;
};
```

### 4.3 Inputs manifest

```json
{
  "componentId": "...",
  "overviewAdditionalInformation": "...",
  "supportAdditionalInformation": "...",
  "modelName": "gemini-2.5-pro",
  "useEnvModelOverrides": false,
  "overviewFiles": [{"filename": "...", "mime_type": "...", "path": "overview-1.bin"}],
  "supportFiles":  [{"filename": "...", "mime_type": "...", "path": "support-1.bin"}]
}
```

Raw bytes live in `inputs/<path>` next to the manifest. The frontend reconstructs `File` objects via `new File([blob], filename, {type: mimeType})`.

---

## 5. State machine

```
           ┌─────────┐
start ───▶│ queued  │
           └────┬────┘
                │ worker picks up
                ▼
           ┌─────────┐ ──cancel──▶ ┌───────────┐
           │ running │              │ cancelled │
           └────┬────┘              └───────────┘
                │
      ┌─────────┴──────────┐
      │                    │
      ▼                    ▼
┌───────────┐         ┌────────┐
│ completed │         │ failed │ ──restart──▶ running
└───────────┘         └────────┘

resume: any terminal state (failed, cancelled, or even completed if
remainingStages>0) → running, skipping cached stages.
rollback: completed | failed | cancelled → same status but with the
  post-target stage checkpoints deleted.
```

**Invariant:** the pipeline worker always re-derives `completed_stages` from disk on start. Never trust the in-memory list alone after a restart.

---

## 6. Cancellation — the hard part

The UX requirement was: **clicking Terminate stops the worker within ~0.5s, and no further tokens are wasted on retries or downstream stages.**

Four layered checks, from cheapest to hardest:

1. **Stage boundaries** — `_raise_if_cancelled(job)` at the top of each stage. Cheap.
2. **Before every LLM attempt** — `if cancel_check(): raise CancelledError`.
3. **During exponential backoff sleep** — `_interruptible_sleep(total)` wakes up every 0.5s to poll `cancel_check`.
4. **During the in-flight HTTP call** — this is the one that everyone gets wrong. The sync SDK's `generate_content()` blocks the thread for tens of seconds; `cancel_check` never runs. **Fix:** wrap the call on a *sub-daemon-thread*, then `.join(timeout=0.5)` in a loop from the worker, checking `cancel_check` each tick. On cancel, raise and let the sub-thread finish on its own (daemon=True; Python won't block shutdown on it). The tokens for that request are already spent — that's unavoidable without async — but no further work runs.

Post-response race check: after the sub-thread returns, check cancel one more time *before* parsing/using the response, so a cancel that landed in the last 0.5s window still discards the result.

**What NOT to do:** use `concurrent.futures.ThreadPoolExecutor` and rely on `shutdown(wait=False)` — that still waits on exit of the `with` block in some CPython versions. Raw `threading.Thread(daemon=True)` with a dict result-box is simpler and predictable.

**If you need to kill the in-flight HTTP itself** (save tokens too), migrate to the async client (`client.aio.models.generate_content`) and use `asyncio.Task.cancel()` — asyncio cancellation propagates through httpx and aborts the TCP connection. This is a bigger refactor touching every call site.

---

## 7. Retry visibility — never silent

Transient errors (503, RESOURCE_EXHAUSTED, UNAVAILABLE, timeouts) hit LLM APIs constantly. The user must not see a frozen UI.

Pattern: the gateway's retry loop accepts an `on_retry` callback with `{attempt, maxAttempts, delaySeconds, error, errorClass}`. The runner binds a callback that emits a lightweight stage event:

```
"Gemini transient error — retrying attempt 2/4 in 3.75s (503 UNAVAILABLE ...)"
```

The existing polling path carries this into `stageMessage` and it appears inline on the running stage row. No new endpoint, no schema change.

---

## 8. Cold-start recovery

On every `/status` request, if `JOBS[jobId]` is missing, reconstruct a job dict from disk:

```python
stages = checkpoints.list_stages(job_id)
if not stages:
    return 404
return {
    "jobId": job_id,
    "status": "completed" if len(stages) == len(STAGE_ORDER) else "partial",
    "completedStages": [s["stage"] for s in stages],
    "tokenUsage": checkpoints.latest_usage_totals(job_id) or {},
    ...
}
```

`latest_usage_totals` scans checkpoints in reverse order for a `_usageTotalsAtCompletion` snapshot — every stage save embeds one — so the UI counter doesn't collapse to zero after a backend restart.

---

## 9. Frontend recovery on page revisit

Three mount effects, in this order:

1. **Hydrate from localStorage.** Restores `jobId`, UI prefs, cached form inputs.
2. **`refreshJobStatus()` once.** Pulls authoritative state from backend. This is where `completedStages`, `canResume`, `cancelRequested` come from — never trust localStorage for these.
3. **Rehydrate uploaded files.** `fetchMapExtractInputs(jobId)` → manifest → `fetchMapExtractInputFile` per entry → `new File(...)`. Idempotent (gated by `inputsRehydrated` flag).
4. **Remote watcher.** If `status ∈ {running, queued}` and neither `isExtracting` nor `isResuming` is true, start a polling loop (1500ms) that mirrors all fields, and on terminal state calls `fetchMapExtractResult` and sets `graphData`. **Without this, revisiting a running job leaves the UI frozen on whatever status was saved at snapshot time.**

`isJobActive = isExtracting || isResuming || isRemoteWatching` — the stage-log panel's activity-driven polling, the Terminate button enable, and the input locks all key off this single flag.

---

## 10. Rollback semantics (the bit everyone gets wrong)

Two functions, pick the right one:

- `delete_from(stage)` — **inclusive**. Deletes `stage` itself *and* everything after. Used by the cancel handler to wipe a mid-flight stage.
- `delete_after(stage)` — **exclusive**. Keeps `stage` completed, deletes only what comes after. This is what the user means by "rollback to stage N." Resume will then start at N+1.

Do NOT use `delete_from` for user-facing rollback. The user said "rollback to state 1" — they mean "state 1 is still done, re-run state 2."

Also: **reject rollback with 409 if the job is `running` or `queued`**. Otherwise you race the worker writing a checkpoint you just deleted.

---

## 11. Restart on failure

When `status === "failed"`, the Resume button should:

- Be **clickable** even if backend's `canResume` hint says no (the user explicitly wants to retry).
- Render as **"Restart"**.
- Tooltip: "Restart from the stage that failed" or "from the last successful checkpoint."

The underlying POST is the same `/resume` endpoint. Backend accepts failed jobs as long as `remaining > 0`. If not, backend 409s and the UI surfaces it.

---

## 12. Files & lines to copy first (reading order)

If starting a new similar pipeline:

1. `engine/backend/app/models/job_models.py` — the `JobRecord` dataclass. Copy wholesale.
2. `engine/backend/app/services/job_store.py` — `JOBS` dict, lock, cancel flag, `emit_job_event`, `serialize_job`. Copy and adapt event types.
3. `engine/backend/app/services/map_extract_checkpoints.py` — disk layout, save/load/delete_from/delete_after/save_inputs/load_inputs. Copy and rename `STAGE_ORDER`.
4. `engine/backend/infra/gemini_client.py` — retry loop with `on_retry` + `cancel_check`, sub-thread wrapper. Copy.
5. `engine/backend/app/routes/map_extract.py` — the route shapes. Copy the HTTP contract, rewrite the pipeline-specific bits.
6. `engine/backend/app/services/map_extract_runner.py` — the stage loop pattern. Copy the skeleton: `for stage in STAGE_ORDER: _raise_if_cancelled; cached = load_stage; if cached: skip; else run+save`.
7. `engine/web-ui/src/lib/map-api-client.ts` — the polling client. Copy `extractMapGraph` (polling loop) and the helpers.
8. `engine/web-ui/src/app/api/map/extract/*/route.ts` — thin Next.js proxies to FastAPI. Copy one, pattern-match the rest.
9. `engine/web-ui/src/app/components/map-extraction-workspace.tsx` — the mount effects, remote watcher, state fields. Copy the effect structure, not the domain fields.
10. `engine/web-ui/src/app/components/stage-log-panel.tsx` — the stage checklist UI + Terminate/Resume/Restart buttons + rollback.

---

## 13. Gotchas I hit (save yourself the debugging)

- **`JOBS[jobId]` missing after restart.** Always fall back to disk. Don't 404 just because memory is empty.
- **localStorage can go stale.** Always re-call `/status` on mount before trusting `completedStages` / `cancelRequested`.
- **Polling loop owned by `handleExtract` doesn't restart on revisit.** Separate "remote watcher" effect is necessary.
- **`isJobActive` built only from local flags.** Must include a flag that flips true whenever *any* polling loop is active, local or remote.
- **Stage 4 (metadata enrichment) can return `"UNKNOWN"` for everything.** Have a deterministic overlay that fills empty slots from the prior stage's structured output as a safety net. Don't rely on the LLM being good at correlation.
- **`_apply_symbol_metadata` overwriting valid values with `"UNKNOWN"`.** Guard every merge step: `if existing is not empty: skip incoming empty`.
- **Thread pool executors with `shutdown(wait=False)` still block.** Use raw `daemon=True` threads with a result-box dict.
- **Peer-dependency hell (`react-wordcloud` vs React 19).** Workspace-level `.npmrc` with `legacy-peer-deps=true` is the pragmatic unblock; plan to replace legacy packages later.
- **React 19 + Next 16 have breaking changes.** The `engine/web-ui/AGENTS.md` points at `node_modules/next/dist/docs/` — check it before writing new route patterns.
- **`git add -A` swept `.claude/settings.local.json` into a commit.** Always stage by explicit path. Keep `.claude/` in `.gitignore`.

---

## 14. Rules of thumb for Claude (self-note)

- **Stage files explicitly.** Never `git add -A` or `git add .`. Run `git status` first; stage by path. See `~/.claude/projects/<project>/memory/feedback_git_staging.md`.
- **Follow branch discipline.** One branch + one PR per session, base is `dev-best`, never `main`. Don't `git checkout -b` mid-session.
- **Stay in the session worktree.** `.claude/worktrees/<name>/` is its own checkout of a dedicated branch. Don't try to sync filesystem changes with the main checkout — sync via git (fetch + checkout).
- **When the user says "continue Codex's work,"** capture the uncommitted diff from the main checkout (`git diff > /tmp/x.patch`), then `git apply` in the worktree.
- **Verify before committing.** `python3 -c "import ast; ast.parse(open(p).read())"` on Python, node bracket-balance scan on TSX (JSX text causes false parens mismatch — ignore `parens=1`).
- **Never commit `.claude/` or `data/`.** Keep them gitignored.
- **Prompt size.** When reading large files, read targeted ranges (`offset`, `limit`). Don't dump 2000-line components into context.
- **Agents over direct tools** when the question is open-ended. Grep/Read for known paths.

---

## 15. What a good prompt for "build this again" looks like

Copy-paste into a new Claude session:

> I want to build a background job pipeline with the same design as `docs/background-job-pipeline.md` in this repo. The domain is {X}. The stages are {A → B → C → D}. Each stage consumes {inputs} and produces {outputs}. Constraints: must survive page reload, must support mid-run cancel within ~0.5s, must surface LLM retries, must persist uploaded files.
>
> Start by reading `docs/background-job-pipeline.md` section by section, then:
>
> 1. Copy the skeleton files listed in §12 into the new pipeline's namespace.
> 2. Adapt `STAGE_ORDER`, `JobRecord` fields, and the stage loop body.
> 3. Wire the Next.js API proxy routes and the workspace component using the same three mount effects (§9).
> 4. Before writing any UI, confirm the status wire format matches §4.2.
>
> Do not skip §6 (cancellation) or §10 (rollback). Those two sections encode behaviors that are easy to botch.

That's the minimum viable prompt. The doc does the rest.
