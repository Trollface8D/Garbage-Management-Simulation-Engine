# Component Architecture Diagram

## Overview: File Dependencies and Component Usage

This document visualizes how components, hooks, and utilities are connected in the code-gen workspace.

---

## 1. High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                        page.tsx (Main Orchestrator)                 │
│                          (~1000 lines)                              │
└──────────────┬──────────────────────────────────────────────────────┘
               │
        ┌──────┴──────────────────────────────────────┐
        │                                              │
   ┌────▼──────────────────┐        ┌────────────────▼──────┐
   │   Custom Hooks (695L) │        │   UI Components (1050L)│
   └────┬──────────────────┘        └──┬─────────────────────┘
        │                              │
        ├─ use-entity-extraction      ├─ EntityExtractionPanel
        ├─ use-metrics-management     ├─ MetricsSelectionPanel
        ├─ use-source-selection       ├─ CodeGenWorkspace
        ├─ use-archive-manager        ├─ SimulationViewer
        └─ use-workspace-persistence  ├─ FloatingWorkspaceToolbar
                                      └─ ProjectPageHeader
```

---

## 2. Detailed Component Dependency Tree

```
page.tsx (Main Component)
│
├─── CUSTOM HOOKS (State Management)
│    │
│    ├─► use-entity-extraction.ts (260 lines)
│    │   ├─► groupEntitiesWithGemini (API)
│    │   └─► GeneratedEntity (type from entity-extraction-panel)
│    │
│    ├─► use-metrics-management.ts (170 lines)
│    │   ├─► suggestMetrics (API)
│    │   └─► WorkspaceMetric (type from metrics-selection-panel)
│    │
│    ├─► use-source-selection.ts (50 lines)
│    │   ├─► softDeleteComponent (storage)
│    │   └─► SimulationComponent (type)
│    │
│    ├─► use-archive-manager.ts (170 lines)
│    │   ├─► exportWorkspaceArchive (API)
│    │   ├─► importWorkspaceArchive (API)
│    │   └─► ArtifactFile (type)
│    │
│    └─► use-workspace-persistence.ts (65 lines)
│        └─► localStorage (browser API)
│
├─── PRESENTATION COMPONENTS (UI)
│    │
│    ├─► EntityExtractionPanel.tsx (450 lines)
│    │   ├─► GeneratedEntity (type export)
│    │   ├─► ModelPicker
│    │   └─► react-wordcloud
│    │
│    ├─► MetricsSelectionPanel.tsx (280 lines)
│    │   ├─► WorkspaceMetric (type export)
│    │   └─► SuggestedMetric (type from API)
│    │
│    ├─► CodeGenWorkspace.tsx
│    │   └─► ArtifactFile (type export)
│    │
│    ├─► SimulationViewer.tsx
│    │
│    ├─► FloatingWorkspaceToolbar.tsx
│    │
│    ├─► UsedItemsSection.tsx
│    │
│    └─► ProjectPageHeader.tsx
│
├─── UTILITY & DATA HANDLING
│    │
│    ├─► json-import-handler.tsx (220 lines)
│    │   ├─► JsonImportPayload (type export)
│    │   ├─► JsonImportItem (type export)
│    │   ├─► normalizeImportPayload
│    │   └─► normalizeExtractionPayload
│    │
│    └─► utils-entity-metric.ts (45 lines)
│        ├─► makeSlug
│        ├─► makeUniqueId
│        ├─► buildChunkTextsFromRawExtraction
│        └─► extractRawExtractionFromItem
│
├─── EXTERNAL APIs (code-gen-api-client)
│    │
│    ├─► groupEntitiesWithGemini()
│    ├─► suggestMetrics()
│    ├─► exportWorkspaceArchive()
│    └─► importWorkspaceArchive()
│
├─── DATA STORAGE (pm-storage)
│    │
│    ├─► loadProjects()
│    ├─► loadComponents()
│    ├─► createProject()
│    ├─► createComponent()
│    ├─► softDeleteComponent()
│    ├─► loadCausalSourceItems()
│    ├─► loadCausalArtifactsForItem()
│    ├─► saveCausalSourceItem()
│    ├─► saveCausalArtifactsForItem()
│    └─► saveTextChunksForItem()
│
└─── TYPE DEFINITIONS (simulation-components)
     │
     ├─► SimulationProject
     ├─► SimulationComponent
     ├─► ExtractionPayloadRecord
     └─► categoryPath
```

---

## 3. Data Flow Diagram

```
┌──────────────────────────────────────────────────────────────────┐
│                    USER INTERACTIONS                              │
│  (Select source, Extract, Group, Suggest, Export, Import)        │
└────────────────────────┬─────────────────────────────────────────┘
                         │
                         ▼
            ┌────────────────────────────┐
            │    page.tsx Handlers       │
            │ (Validation & Coordination)│
            └──────────┬─────────────────┘
                       │
        ┌──────────────┼──────────────┐
        │              │              │
        ▼              ▼              ▼
   ┌─────────┐  ┌──────────┐  ┌────────────┐
   │ Hooks   │  │ Storage  │  │ External   │
   │ Update  │  │ Layer    │  │ APIs       │
   │ State   │  │(pm-stor)│  │(Gemini)    │
   └────┬────┘  └────┬─────┘  └─────┬──────┘
        │            │              │
        │            ▼              │
        │      ┌──────────────┐     │
        │      │ Database     │     │
        │      │ (project,    │     │
        │      │ components,  │     │
        │      │ artifacts)   │     │
        │      └──────────────┘     │
        │                           │
        └───────────────┬───────────┘
                        │
                        ▼
            ┌────────────────────────┐
            │  State (Hooks + Local) │
            │  - entities            │
            │  - metrics             │
            │  - selectedCausalIds   │
            │  - archiveFiles        │
            │  - etc                 │
            └───────────┬────────────┘
                        │
                        ▼
            ┌────────────────────────┐
            │  Browser Storage       │
            │  (localStorage)        │
            │  - Snapshot Persistence│
            └────────────────────────┘
```

---

## 4. File Dependency Matrix

| File | Imports From | Exports | Purpose |
|------|--------------|---------|---------|
| **page.tsx** | All below | None | Main orchestrator, routing, coordination |
| **use-entity-extraction** | entity-extraction-panel, code-gen-api-client | Hook function | Entity state management |
| **use-metrics-management** | metrics-selection-panel, code-gen-api-client | Hook function | Metrics state management |
| **use-source-selection** | pm-storage | Hook function | Source selection state |
| **use-archive-manager** | code-gen-api-client | Hook function | Archive export/import |
| **use-workspace-persistence** | None (browser API) | Hook function | LocalStorage persistence |
| **entity-extraction-panel** | None (exports types) | GeneratedEntity type | UI rendering, types |
| **metrics-selection-panel** | None (exports types) | WorkspaceMetric type | UI rendering, types |
| **json-import-handler** | pm-storage | Types + functions | JSON import utilities |
| **utils-entity-metric** | None | Utility functions | String processing, ID generation |

---

## 5. Component-to-Component Communication

```
                    page.tsx
                       │
        ┌──────────────┼──────────────┐
        │              │              │
        ▼              ▼              ▼
    ┌──────────────────────────────────────────┐
    │ State Props → Child Components (Props)   │
    │ ↓                                        │
    │ - entities → EntityExtractionPanel      │
    │ - metrics → MetricsSelectionPanel       │
    │ - selectedCausalIds → UsedItemsSection  │
    │ - jobId → CodeGenWorkspace              │
    │ - etc.                                   │
    └──────────────────────────────────────────┘
        │
        ▼
    ┌──────────────────────────────────────────┐
    │ Callback Props ← Child Components        │
    │ (Events flow back up)                    │
    │                                          │
    │ - onExtract()                            │
    │ - onGroupWithGemini()                    │
    │ - onToggleEntity()                       │
    │ - onSuggestMetrics()                     │
    │ - onAddManualMetric()                    │
    │ - onExport()                             │
    │ - onImport()                             │
    │ - etc.                                   │
    └──────────────────────────────────────────┘
```

---

## 6. Data State Organization (By Hook)

```
useEntityExtraction Hook
├─ entities: GeneratedEntity[]
├─ isExtracted: boolean
├─ isExtracting: boolean
├─ extractError: string
├─ isGroupingEntities: boolean
├─ groupError: string
├─ collapsedParentIds: Set<string>
└─ groupLog: LogEntry[]

useMetricsManagement Hook
├─ metrics: WorkspaceMetric[]
├─ metricsExtracted: boolean
├─ isSuggestingMetrics: boolean
├─ metricsError: string
└─ metricsLog: LogEntry[]

useSourceSelection Hook
├─ selectedCausalIds: Set<string>
└─ selectedMapId: string | null

useArchiveManager Hook
├─ archiveBusy: "idle" | "exporting" | "importing"
├─ archiveMessage: string
└─ archiveError: string

useWorkspacePersistence Hook
├─ hydrated: boolean
└─ (localStorage snapshot management)

Local page.tsx State
├─ projects: SimulationProject[]
├─ components: SimulationComponent[]
├─ selectedModel: string
├─ currentJobId: string | null
├─ isCodeGenRunning: boolean
└─ (UI input fields)
```

---

## 7. API Interaction Points

```
page.tsx ↔ code-gen-api-client
│
├─► groupEntitiesWithGemini()
│   └─ Input: entity counts, model
│   └─ Output: grouped entities
│
├─► suggestMetrics()
│   └─ Input: entities, model
│   └─ Output: suggested metrics
│
├─► exportWorkspaceArchive()
│   └─ Input: workspace snapshot
│   └─ Output: ZIP file blob
│
└─► importWorkspaceArchive()
    └─ Input: ZIP file
    └─ Output: metadata + artifacts

page.tsx ↔ pm-storage (Database Layer)
│
├─► loadProjects() → SimulationProject[]
├─► loadComponents() → SimulationComponent[]
├─► createProject(data) → SimulationProject
├─► createComponent(data) → SimulationComponent
├─► softDeleteComponent(id) → void
├─► loadCausalSourceItems(projectId, componentId) → SourceItem[]
├─► loadCausalArtifactsForItem(itemId) → Artifact
├─► saveCausalSourceItem(data) → void
├─► saveCausalArtifactsForItem(data) → void
└─► saveTextChunksForItem(data) → void
```

---

## 8. Team Parallelization Map

```
Team Structure for Parallel Development:

┌─────────────────────────────────────────────────────────────┐
│ TEAM 1: Entity Extraction & Grouping                       │
│ ├─ Owner: use-entity-extraction.ts                         │
│ ├─ Related: entity-extraction-panel.tsx                    │
│ └─ Focus: Entity extraction, semantic grouping, display   │
├─────────────────────────────────────────────────────────────┤
│ TEAM 2: Metrics Management                                │
│ ├─ Owner: use-metrics-management.ts                        │
│ ├─ Related: metrics-selection-panel.tsx                    │
│ └─ Focus: Metric suggestion, selection, display           │
├─────────────────────────────────────────────────────────────┤
│ TEAM 3: Source Management & Deletion                      │
│ ├─ Owner: use-source-selection.ts                          │
│ ├─ Related: UsedItemsSection.tsx                           │
│ └─ Focus: Causal/Map selection, component management      │
├─────────────────────────────────────────────────────────────┤
│ TEAM 4: Persistence & Archive                             │
│ ├─ Owners: use-archive-manager.ts                          │
│ │           use-workspace-persistence.ts                   │
│ ├─ Related: FloatingWorkspaceToolbar.tsx                   │
│ └─ Focus: Export/import, localStorage, snapshots          │
├─────────────────────────────────────────────────────────────┤
│ TEAM 5: Code Generation & Simulation Viewer               │
│ ├─ Owner: CodeGenWorkspace.tsx                             │
│ ├─ Related: SimulationViewer.tsx                           │
│ └─ Focus: Job execution, artifact generation              │
└─────────────────────────────────────────────────────────────┘
```

---

## 9. Merge Conflict Prevention Strategy

```
Key Design Principles:

1. Isolated State (Per Hook)
   ✓ Each hook manages its own state
   ✓ Modifications to entity state won't affect metrics state
   ✓ Teams edit different files

2. Minimal Props Drilling
   ✓ Custom hooks return everything needed
   ✓ Reduced prop interface changes
   ✓ Less dependency between components

3. Clear File Ownership
   ✓ One hook per team
   ✓ Minimal cross-file imports
   ✓ Self-contained logic

4. UI Component Isolation
   ✓ Presentation logic separated from state
   ✓ Component props well-defined
   ✓ Limited intercomponent communication

5. API Layer Abstraction
   ✓ All API calls go through code-gen-api-client
   ✓ Storage goes through pm-storage
   ✓ Browser APIs isolated in persistence hook
```

---

## 10. File Size & Complexity Summary

| Layer | File | Lines | Complexity | Maintained By |
|-------|------|-------|-----------|---------------|
| **Orchestration** | page.tsx | ~1000 | High | Team Lead |
| **State** | use-entity-extraction | 260 | Medium | Team 1 |
| | use-metrics-management | 170 | Medium | Team 2 |
| | use-source-selection | 50 | Low | Team 3 |
| | use-archive-manager | 170 | Medium | Team 4 |
| | use-workspace-persistence | 65 | Low | Team 4 |
| **UI Components** | entity-extraction-panel | 450 | Medium | Team 1 |
| | metrics-selection-panel | 280 | Medium | Team 2 |
| | code-gen-workspace | ~300 | High | Team 5 |
| | simulation-viewer | ~200 | Medium | Team 5 |
| **Utilities** | json-import-handler | 220 | Low | Shared |
| | utils-entity-metric | 45 | Low | Shared |
| **Total** | | **2850** | Medium | **5 Teams** |

---

## 11. Import Chain Example

```
page.tsx imports from:
│
├─► ./use-entity-extraction
│   └─► ./entity-extraction-panel (type: GeneratedEntity)
│   └─► @/lib/code-gen-api-client (function: groupEntitiesWithGemini)
│
├─► ./use-metrics-management
│   └─► ./metrics-selection-panel (type: WorkspaceMetric)
│   └─► @/lib/code-gen-api-client (function: suggestMetrics)
│
├─► ./use-source-selection
│   └─► @/lib/pm-storage (function: softDeleteComponent)
│
├─► ./use-archive-manager
│   └─► @/lib/code-gen-api-client (functions: export/import)
│
├─► ./use-workspace-persistence
│   └─► (no external imports - uses browser localStorage)
│
└─► ./entity-extraction-panel, metrics-selection-panel, etc. (UI components)
```

---

## Summary

- **5 Custom Hooks**: ~715 lines of state management
- **6 UI Components**: ~1,050 lines of presentation
- **2 Utility Files**: ~265 lines of helpers
- **Main Orchestrator**: ~1,000 lines (page.tsx)
- **Total**: ~3,030 lines of focused, parallel-development-friendly code

**Merge Conflict Reduction**: Team members working on different hooks/components rarely edit the same file, significantly reducing git conflicts during parallel development.
