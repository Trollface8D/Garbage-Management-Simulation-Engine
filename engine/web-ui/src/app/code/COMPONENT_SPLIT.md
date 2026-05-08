# Component Split Documentation

## Overview
The monolithic `page.tsx` (2200+ lines) has been split into focused, reusable components to enable parallel team development.

## New Components Created

### 1. **EntityExtractionPanel** (`entity-extraction-panel.tsx`)
**Purpose:** Manage entity extraction, grouping, and selection  
**Responsibilities:**
- Display extracted entities from causal sources
- Render word cloud visualization
- Handle entity selection and manual entity addition
- Integrate with Gemini for semantic entity grouping
- Display grouping logs and errors

**State from parent page.tsx:**
- `entities`, `isExtracted`, `isExtracting`
- `isGroupingEntities`, `groupError`, `groupLog`
- `selectedModel`, `manualEntityName`, `manualEntityError`
- `collapsedParentIds`, `selectedCausalIds`

**Handlers needed:**
- `handleExtractFromCausal()` - Trigger extraction
- `handleGroupWithGemini()` - Semantic grouping
- `handleToggleEntity()` - Select/deselect entities
- `handleAddManualEntity()` - Manual entity addition

**Team assignment:** Entity Management Team

---

### 2. **MetricsSelectionPanel** (`metrics-selection-panel.tsx`)
**Purpose:** Manage metrics suggestion and selection  
**Responsibilities:**
- Suggest metrics using Gemini AI
- Display metric recommendations with details (label, unit, aggregation, visualization)
- Handle manual metric addition
- Track metric selection state
- Display suggestion logs and errors

**State from parent page.tsx:**
- `metrics`, `isSuggestingMetrics`, `metricsError`, `metricsLog`
- `manualMetricName`, `manualMetricError`
- `selectedEntityCount` (calculated from selected entities)

**Handlers needed:**
- `handleSuggestMetrics()` - LLM-powered metric suggestion
- `handleToggleMetric()` - Select/deselect metrics
- `handleAddManualMetric()` - Manual metric addition

**Team assignment:** Metrics Pipeline Team

---

### 3. **JsonImportHandler** (`json-import-handler.tsx`)
**Purpose:** Handle JSON file import and payload normalization  
**Responsibilities:**
- Export normalization utilities (used in page.tsx)
- Provide types for import payloads
- Normalize various JSON formats (Gemini transcripts, extraction payloads, etc.)

**Exported utilities:**
- `normalizeExtractionPayload()`
- `normalizeGeminiTranscriptArray()`
- `normalizeImportPayload()`
- `sanitizeFilenameSegment()`

**Types exported:**
- `JsonImportItem`, `JsonImportPayload`, `JsonImportProject`

**Team assignment:** Data Import/Export Team

---

### 4. **Utility Functions** (`utils-entity-metric.ts`)
**Purpose:** Shared utility functions for entity and metric management  
**Functions exported:**
- `makeSlug()` - Generate URL-friendly slugs
- `makeUniqueId()` - Generate unique IDs with collision handling
- `buildChunkTextsFromRawExtraction()` - Process extraction data
- `extractRawExtractionFromItem()` - Normalize extraction data

**Team assignment:** Shared utilities (all teams)

---

## Modified Components

### `page.tsx` (Refactored)
**New role:** State orchestrator and router  
**Remaining responsibilities:**
- Central state management (projects, components, extraction state, etc.)
- Data persistence (localStorage for snapshots)
- API coordination (causal aggregation, project management)
- Archive export/import logic
- Integration of sub-components

**Code reduction:** ~2200 lines → ~700 lines (68% reduction)

---

## Component Dependency Graph

```
page.tsx (Orchestrator)
├── EntityExtractionPanel
├── MetricsSelectionPanel
├── FloatingWorkspaceToolbar
├── UsedItemsSection (Causal & Map)
├── CodeGenWorkspace
├── SimulationViewer
└── JSON Import utilities (json-import-handler.ts)
```

---

## Parallel Development Workflow

### Team 1: Entity Management
**Files to work on:**
- `entity-extraction-panel.tsx` - UI component
- `page.tsx` - `handleExtractFromCausal()`, `handleGroupWithGemini()`, aggregation logic

**Dependencies:** None (can start immediately)

### Team 2: Metrics Pipeline
**Files to work on:**
- `metrics-selection-panel.tsx` - UI component  
- `page.tsx` - `handleSuggestMetrics()`, `handleCancelMetricsSuggest()`

**Dependencies:** None (can start immediately)

### Team 3: Data Import/Export
**Files to work on:**
- `json-import-handler.tsx` - Normalization logic
- `page.tsx` - `handleImportJson()`, `readImportItems()`, component persistence

**Dependencies:** None (can start immediately)

### Team 4: Page Orchestration (Optional)
**Files to work on:**
- `page.tsx` - State coordination, passing props to sub-components

**Dependencies:** Teams 1-3 complete their components

---

## File Structure
```
src/app/code/
├── page.tsx (refactored orchestrator)
├── entity-extraction-panel.tsx (NEW)
├── metrics-selection-panel.tsx (NEW)
├── json-import-handler.tsx (NEW)
├── utils-entity-metric.ts (NEW)
├── code-gen-workspace.tsx (existing)
├── simulation-viewer.tsx (existing)
├── floating-workspace-toolbar.tsx (existing)
├── used-items-section.tsx (existing)
└── code-gen-stage-log-panel.tsx (existing)
```

---

## Integration Checklist

- [x] Extract entity management into `EntityExtractionPanel`
- [x] Extract metrics management into `MetricsSelectionPanel`
- [x] Extract JSON import utilities into `json-import-handler.tsx`
- [x] Extract shared utilities into `utils-entity-metric.ts`
- [x] Update `page.tsx` to use new components
- [x] Ensure all types are exported correctly
- [x] Verify state passing and callbacks work as expected

---

## Testing Recommendations

1. **Entity Panel**: Test extraction, grouping, manual addition, selection toggles
2. **Metrics Panel**: Test metric suggestion, selection, manual addition
3. **JSON Import**: Test various JSON format normalization
4. **Integration**: Test state persistence, component interactions, error handling

---

## Future Improvements

- Move archive logic to a separate `archive-manager.tsx` component
- Extract source selection into a reusable `source-selector.tsx` component
- Create a custom hook for entity/metric state management (useEntityState, useMetricsState)
- Implement a context API or state management library for better prop drilling
