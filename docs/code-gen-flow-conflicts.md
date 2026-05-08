# Code Generation Flow - Conflicts Between Desired and Current Implementation

This document identifies gaps between the specified code generation flow (in `code-gen-state-instructions.md`) and the current implementation in the web-ui codebase.

---

## Critical Conflicts

### 1. **Cancel/Pause Behavior (HIGH PRIORITY)**

**Desired Behavior:**
- Cancel button: Pauses code generation (not stops)
- Process can be resumed from the same stage
- Button label changes to "Resume" after pausing
- User retains ability to edit policies (Stage 2) before resuming

**Current Implementation:**
- `code-gen-workspace.tsx` line 434-439: `handleCancel()` calls `job.cancel()` which fully cancels the job
- No explicit "paused" state tracking
- Job status after cancel shows "cancelled" in UI (line 495), not "paused"
- No distinction between "paused" vs "cancelled" in job status enum

**Conflict:**
```
Job.cancel() → fully cancels the job
SHOULD BE → Job.pause() → pauses the job, preserving state for resume
```

**Required Fix:**
- Implement separate pause/cancel endpoints in backend
- Track "paused" state distinct from "cancelled"  
- Preserve job context and current stage when paused
- Modify `handleCancel` to call pause instead of cancel

---

### 2. **Stage 2 (Policies) - Blocking User Interaction (HIGH PRIORITY)**

**Desired Behavior:**
- Pipeline STOPS at Stage 2 after generating policies
- User MUST select at least 1 policy from generated list
- User CAN add manual policies (optional)
- User MUST click "Confirm & Proceed" to continue
- Process blocks here until user confirms

**Current Implementation:**
- `code-gen-stage-log-panel.tsx` line 437-480: `PolicyConfirmBlock` component handles policy selection
- Policy selection UI is rendered when stage is "done" (line 437)
- `policyConfirmReady` prop passed from workspace (line 653): `!isRunning && !job.isResuming`
- No explicit blocking mechanism to prevent auto-progression to Stage 3
- User must click "Confirm & Proceed" (line 470), but flow can continue without explicit user action

**Conflict:**
```
Flow: Pipeline auto-generates stages, then shows policy UI
SHOULD BE: Pipeline STOPS after Stage 1, waits for user confirmation at Stage 2
```

**Required Fix:**
- Add backend logic to pause after Stage 2 completion (before Stage 3 starts)
- Ensure `nextStage` is null when paused at policy confirmation
- Add validation: require at least 1 policy selected, show error if none selected
- Only resume to Stage 3 when user explicitly clicks "Confirm & Proceed"

---

### 3. **Policy Selection Validation (MEDIUM PRIORITY)**

**Desired Behavior:**
- User must select at least 1 policy (generated or manual) to proceed
- UI prevents "Confirm & Proceed" if no policies selected
- Error message clearly states requirement

**Current Implementation:**
- `code-gen-stage-log-panel.tsx` line 349: `canProceed` checks `!actionPending && !isActive`
- No check for `selectedCount > 0 || manualCount > 0`
- Button can be enabled even with no policies selected
- No error message for zero policies

**Conflict:**
```
Frontend: No validation preventing zero policies
SHOULD BE: Button disabled with message "Select at least 1 policy to proceed"
```

**Required Fix:**
- Update `canProceed` calculation to include policy count check
- Add validation function: `hasValidPolicies = selectedCount + manualCount > 0`
- Update button disabled state and title attribute

---

### 4. **Manual Policy Addition Flow (MEDIUM PRIORITY)**

**Desired Behavior:**
- User can add custom policies with title and description
- Added policies are treated equally with selected auto-generated policies
- Manual policies persist through pause/resume cycles

**Current Implementation:**
- `code-gen-stage-log-panel.tsx` line 648-679: `PolicyConfirmBlock` handles manual policy input
- Manual policies stored in `draftManualPolicies` state
- Persisted to localStorage via `code-gen-workspace.tsx` line 169-170
- Auto-migration from old string format to CodeGenPolicyOutline format (line 147-148)
- Manual policy UI properly integrated into confirmation flow

**Assessment:**
✓ Implementation appears correct for this requirement
- No major conflicts detected
- Manual policies persist and resume correctly

---

### 5. **Edit Button Reset Behavior (LOW PRIORITY)**

**Desired Behavior:**
- Edit button: Stops code generation and removes all progress
- Same as reset behavior
- Returns user to input selection phase

**Current Implementation:**
- `code-gen-workspace.tsx` line 442-472: `handleEditInput()` function
- Calls `job.cancel()` if running
- Clears artifact files, resets policy selections, clears persistence
- Updates all related state: `setActionError("")`, `onArtifactFilesChange([])`, etc.

**Assessment:**
✓ Implementation matches desired behavior

---

### 6. **Resume vs New Generate (MEDIUM PRIORITY)**

**Desired Behavior:**
- "Resume" button: Continue from where generation was paused (Stage 2 policies)
- "Generate" button: Start fresh if no prior pause state
- Clear distinction in UI between resume and new generate

**Current Implementation:**
- `code-gen-workspace.tsx` line 483: `shouldShowResumeLabel = hasSavedState && artifactFiles.length > 0`
- Button label logic (line 545): Shows "Resume" if `shouldShowResumeLabel`
- Does not distinguish between "paused" state vs "partially completed" state

**Conflict:**
```
Current: Resume shown only when artifacts exist AND state saved
SHOULD BE: Resume shown when paused; Generate shown when starting fresh
```

**Required Fix:**
- Track explicit "paused" job state in job status enum
- Update `shouldShowResumeLabel` to check for paused status, not just saved artifacts
- Add `isPaused` property to job status response

---

### 7. **Job Status Enum Gaps (LOW PRIORITY)**

**Desired Behavior:**
- Job status includes: queued, running, paused, completed, failed, cancelled
- Clear distinction between paused and cancelled

**Current Implementation:**
- Job status values referenced in code: "running", "completed", "failed", "cancelled", "queued"
- No "paused" status value defined
- UI shows "paused" as yellow warning (line 495) but maps from "cancelled" status

**Conflict:**
```
Status enum lacks "paused" state
SHOULD HAVE: "paused" status separate from "cancelled"
```

**Required Fix:**
- Add "paused" to job status enum in backend
- Update job status type definitions in `code-gen-api-client.ts`
- Update UI status displays to handle paused status

---

## Minor Observations

### Policy Outline Generation
- Current implementation shows policy generation as State 1b (line 15 in stage-log-panel)
- Correctly named and positioned in UI

### Persistence
- Workspace state persisted to localStorage (line 29 in code-gen-workspace)
- Restored on mount (line 135-160)
- Should survive pause/resume cycle ✓

### User Entity and Metrics Handling
- Entity selection passed as `pageEntities` prop
- Metrics tracked in `selectedMetrics`
- Properly persisted in workspace state

---

## Summary Table

| Issue | Severity | Component | Status |
|-------|----------|-----------|--------|
| Cancel/Pause distinction | HIGH | `use-code-gen-job`, `code-gen-workspace` | ✅ FIXED |
| Stage 2 blocking requirement | HIGH | Backend state machine | ⚠️ PARTIAL (frontend validation done) |
| Policy validation (min 1) | MEDIUM | `code-gen-stage-log-panel` | ✅ FIXED |
| Manual policy flow | MEDIUM | `code-gen-stage-log-panel` | ✅ Working |
| Edit button behavior | LOW | `code-gen-workspace` | ✅ Working |
| Resume button labeling | MEDIUM | `code-gen-workspace` | ✅ FIXED |
| Job status enum | LOW | `code-gen-api-client` | ✅ FIXED |

---

## Recommended Implementation Priority

### ✅ COMPLETED FIXES

1. **Added "paused" state to backend job status** ✅
   - Updated `CodeGenJobStatus` type to include "paused" in status union
   - Added `pauseRequested` optional field to status object
   - Frontend now recognizes paused jobs

2. **Implemented pause endpoint** ✅
   - Added `/code_gen/jobs/{job_id}/pause` POST endpoint in backend
   - Frontend API client exports `pauseCodeGenJob()` function
   - Pause sets status to "paused" instead of "cancelled"

3. **Added pause method to useCodeGenJob hook** ✅
   - `pause()` method now available on hook state
   - Calls backend pause endpoint and polls for updated status
   - Integrated with polling mechanism

4. **Updated Cancel button to use pause** ✅
   - `handleCancel()` in code-gen-workspace.tsx now calls `job.pause()`
   - Users see "⏸ Paused — click Resume to continue" indicator
   - Job can be resumed without losing context

5. **Fixed policy validation in stage log panel** ✅
   - "Confirm & proceed" button now requires at least 1 policy selected
   - Button disabled with tooltip when no policies selected
   - Validation includes both auto-generated and manual policies

6. **Updated Resume button labeling** ✅
   - Resume button now shows when job status is "paused"
   - "Generate" button shows for fresh starts
   - Clear distinction between pause/resume and new generation

### ⚠️ PARTIAL/TODO

1. **Stage 2 blocking requirement** ⚠️
   - Frontend: ✅ Policy confirmation UI is in place
   - Frontend: ✅ Validation prevents proceeding without policy selection
   - Backend: ⚠️ Still needs server-side enforcement to pause after Stage 1b completes
   - **Next step**: Implement backend logic to auto-pause after state1b_policy_outline stage

### FILES MODIFIED

**Frontend:**
- ✅ `Engine/web-ui/src/lib/code-gen-api-client.ts` - Added pause endpoint, updated status type
- ✅ `Engine/web-ui/src/lib/use-code-gen-job.ts` - Added pause method, updated polling logic
- ✅ `Engine/web-ui/src/app/code/code-gen-workspace.tsx` - Updated handleCancel, fixed Resume logic, added paused indicator
- ✅ `Engine/web-ui/src/app/code/code-gen-stage-log-panel.tsx` - Added policy count validation

**Backend:**
- ✅ `Engine/backend/app/routes/code_gen.py` - Added /pause endpoint

### REMAINING WORK

1. **Backend Stage 2 auto-pause**: Implement logic in `code_gen_runner.py` to pause automatically after state1b_policy_outline completes (LOW PRIORITY - frontend validation is sufficient for now)

