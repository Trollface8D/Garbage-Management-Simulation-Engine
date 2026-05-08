# Component Architecture - Mermaid Diagrams

## Diagram 1: High-Level Component Dependencies

```mermaid
graph TB
    page["page.tsx<br/>(Main Orchestrator)"]
    
    hooks["Custom Hooks<br/>(State Management)"]
    hook1["use-entity-extraction"]
    hook2["use-metrics-management"]
    hook3["use-source-selection"]
    hook4["use-archive-manager"]
    hook5["use-workspace-persistence"]
    
    ui["UI Components"]
    comp1["EntityExtractionPanel"]
    comp2["MetricsSelectionPanel"]
    comp3["CodeGenWorkspace"]
    comp4["SimulationViewer"]
    comp5["FloatingWorkspaceToolbar"]
    
    utils["Utilities"]
    util1["json-import-handler"]
    util2["utils-entity-metric"]
    
    api["External APIs"]
    api1["code-gen-api-client"]
    api2["pm-storage"]
    
    page --> hooks
    page --> ui
    page --> utils
    page --> api
    
    hooks --> hook1
    hooks --> hook2
    hooks --> hook3
    hooks --> hook4
    hooks --> hook5
    
    ui --> comp1
    ui --> comp2
    ui --> comp3
    ui --> comp4
    ui --> comp5
    
    utils --> util1
    utils --> util2
    
    api --> api1
    api --> api2
    
    hook1 --> api1
    hook2 --> api1
    hook4 --> api1
    hook3 --> api2
    
    util1 --> api2
    comp1 -.->|exports| hook1
    comp2 -.->|exports| hook2
```

## Diagram 2: State Flow Architecture

```mermaid
graph LR
    User["👤 User<br/>Interaction"]
    page["page.tsx<br/>Handlers"]
    
    e_hook["useEntityExtraction<br/>Hook"]
    m_hook["useMetricsManagement<br/>Hook"]
    s_hook["useSourceSelection<br/>Hook"]
    a_hook["useArchiveManager<br/>Hook"]
    p_hook["useWorkspacePersistence<br/>Hook"]
    
    storage["Storage Layer<br/>pm-storage"]
    api["External APIs<br/>Gemini/Archive"]
    db["Database<br/>Projects, Components"]
    
    User -->|clicks, inputs| page
    page -->|updates| e_hook
    page -->|updates| m_hook
    page -->|updates| s_hook
    page -->|updates| a_hook
    page -->|persists| p_hook
    
    e_hook -->|calls| api
    m_hook -->|calls| api
    a_hook -->|calls| api
    
    s_hook -->|calls| storage
    storage -->|manages| db
    p_hook -->|reads/writes| db
    
    style User fill:#4ade80
    style page fill:#60a5fa
    style api fill:#f59e0b
    style db fill:#a78bfa
```

## Diagram 3: File Dependency Graph

```mermaid
graph TB
    page["📄 page.tsx"]
    
    h1["⚙️ use-entity-extraction.ts"]
    h2["⚙️ use-metrics-management.ts"]
    h3["⚙️ use-source-selection.ts"]
    h4["⚙️ use-archive-manager.ts"]
    h5["⚙️ use-workspace-persistence.ts"]
    
    c1["🎨 entity-extraction-panel.tsx"]
    c2["🎨 metrics-selection-panel.tsx"]
    c3["🎨 code-gen-workspace.tsx"]
    c4["🎨 simulation-viewer.tsx"]
    
    u1["🔧 json-import-handler.tsx"]
    u2["🔧 utils-entity-metric.ts"]
    
    api["📡 code-gen-api-client"]
    storage["💾 pm-storage"]
    
    page --> h1
    page --> h2
    page --> h3
    page --> h4
    page --> h5
    
    page --> c1
    page --> c2
    page --> c3
    page --> c4
    
    page --> u1
    page --> u2
    
    h1 --> api
    h1 -.types.-> c1
    
    h2 --> api
    h2 -.types.-> c2
    
    h3 --> storage
    
    h4 --> api
    
    h5 -.localStorage.-> page
    
    u1 --> storage
    
    style page fill:#60a5fa,color:#fff
    style h1 fill:#34d399
    style h2 fill:#34d399
    style h3 fill:#34d399
    style h4 fill:#34d399
    style h5 fill:#34d399
    style c1 fill:#f59e0b
    style c2 fill:#f59e0b
    style c3 fill:#f59e0b
    style c4 fill:#f59e0b
    style api fill:#ec4899
    style storage fill:#8b5cf6
```

## Diagram 4: Data Flow Pipeline

```mermaid
sequenceDiagram
    actor User
    participant Page as page.tsx
    participant Hooks as Custom Hooks
    participant UI as UI Components
    participant API as External APIs
    participant DB as Database
    
    User->>Page: Select causal sources
    Page->>Hooks: Update selectedCausalIds
    Hooks->>UI: Pass state via props
    
    User->>Page: Click "Extract"
    Page->>DB: Load causal artifacts
    DB->>Page: Return raw extraction
    Page->>Hooks: setEntities()
    Hooks->>UI: Render entities
    
    User->>Page: Click "Group with Gemini"
    Page->>Hooks: Trigger handleGroupWithGemini
    Hooks->>API: Call groupEntitiesWithGemini()
    API->>Hooks: Return grouped entities
    Hooks->>Page: Update entities state
    Page->>UI: Re-render with groups
    
    User->>Page: Click "Export Archive"
    Page->>Hooks: Build workspace snapshot
    Hooks->>API: Call exportWorkspaceArchive()
    API->>User: Download .zip file
```

## Diagram 5: Team Ownership Map

```mermaid
graph TB
    subgraph Team1["🔷 Team 1: Entity Extraction"]
        t1h["use-entity-extraction.ts"]
        t1c["entity-extraction-panel.tsx"]
        t1u["utils-entity-metric.ts (shared)"]
    end
    
    subgraph Team2["🟠 Team 2: Metrics Management"]
        t2h["use-metrics-management.ts"]
        t2c["metrics-selection-panel.tsx"]
    end
    
    subgraph Team3["🟣 Team 3: Source Selection"]
        t3h["use-source-selection.ts"]
        t3u["UsedItemsSection.tsx"]
    end
    
    subgraph Team4["🟢 Team 4: Persistence & Archive"]
        t4h1["use-archive-manager.ts"]
        t4h2["use-workspace-persistence.ts"]
        t4u["FloatingWorkspaceToolbar.tsx"]
    end
    
    subgraph Team5["🔵 Team 5: Code Generation"]
        t5c1["code-gen-workspace.tsx"]
        t5c2["simulation-viewer.tsx"]
    end
    
    subgraph Shared["⚪ Shared Infrastructure"]
        page["page.tsx"]
        api["APIs & Storage"]
    end
    
    Team1 -.->|minimal conflicts| Team2
    Team2 -.->|minimal conflicts| Team3
    Team3 -.->|minimal conflicts| Team4
    Team4 -.->|minimal conflicts| Team5
    
    Team1 --> page
    Team2 --> page
    Team3 --> page
    Team4 --> page
    Team5 --> page
    
    page --> Shared
    
    style Team1 fill:#60a5fa,color:#fff
    style Team2 fill:#f59e0b,color:#000
    style Team3 fill:#8b5cf6,color:#fff
    style Team4 fill:#34d399,color:#000
    style Team5 fill:#3b82f6,color:#fff
    style Shared fill:#e5e7eb,color:#000
```

## Diagram 6: Hook State Organization

```mermaid
graph TB
    subgraph Hook1["useEntityExtraction"]
        h1s1["entities: GeneratedEntity[]"]
        h1s2["isExtracted: boolean"]
        h1s3["isExtracting: boolean"]
        h1s4["extractError: string"]
        h1s5["isGroupingEntities: boolean"]
        h1s6["groupError: string"]
        h1s7["collapsedParentIds: Set"]
        h1s8["groupLog: LogEntry[]"]
    end
    
    subgraph Hook2["useMetricsManagement"]
        h2s1["metrics: WorkspaceMetric[]"]
        h2s2["metricsExtracted: boolean"]
        h2s3["isSuggestingMetrics: boolean"]
        h2s4["metricsError: string"]
        h2s5["metricsLog: LogEntry[]"]
    end
    
    subgraph Hook3["useSourceSelection"]
        h3s1["selectedCausalIds: Set"]
        h3s2["selectedMapId: string"]
    end
    
    subgraph Hook4["useArchiveManager"]
        h4s1["archiveBusy: status"]
        h4s2["archiveMessage: string"]
        h4s3["archiveError: string"]
    end
    
    subgraph Hook5["useWorkspacePersistence"]
        h5s1["hydrated: boolean"]
        h5s2["localStorage functions"]
    end
    
    subgraph Page["page.tsx Local State"]
        ps1["projects: SimulationProject[]"]
        ps2["components: SimulationComponent[]"]
        ps3["selectedModel: string"]
        ps4["currentJobId: string"]
        ps5["isCodeGenRunning: boolean"]
        ps6["UI input fields"]
    end
    
    style Hook1 fill:#60a5fa,color:#fff
    style Hook2 fill:#f59e0b,color:#000
    style Hook3 fill:#8b5cf6,color:#fff
    style Hook4 fill:#34d399,color:#000
    style Hook5 fill:#3b82f6,color:#fff
    style Page fill:#e5e7eb,color:#000
```

## Diagram 7: API & Storage Integration

```mermaid
graph LR
    page["page.tsx"]
    
    subgraph APILayer["External APIs"]
        api1["groupEntitiesWithGemini"]
        api2["suggestMetrics"]
        api3["exportWorkspaceArchive"]
        api4["importWorkspaceArchive"]
    end
    
    subgraph StorageLayer["Database Layer (pm-storage)"]
        db1["loadProjects"]
        db2["loadComponents"]
        db3["createProject"]
        db4["createComponent"]
        db5["softDeleteComponent"]
        db6["loadCausalSourceItems"]
        db7["loadCausalArtifactsForItem"]
        db8["saveCausalSourceItem"]
        db9["saveCausalArtifactsForItem"]
        db10["saveTextChunksForItem"]
    end
    
    subgraph BrowserAPI["Browser APIs"]
        bapi1["localStorage"]
        bapi2["requestAnimationFrame"]
        bapi3["fetch"]
    end
    
    h1["useEntityExtraction"]
    h2["useMetricsManagement"]
    h3["useSourceSelection"]
    h4["useArchiveManager"]
    h5["useWorkspacePersistence"]
    
    page --> h1
    page --> h2
    page --> h3
    page --> h4
    page --> h5
    
    h1 --> api1
    h2 --> api2
    h4 --> api3
    h4 --> api4
    
    h3 --> db5
    h5 --> bapi1
    
    page --> db1
    page --> db2
    page --> db3
    page --> db4
    page --> db6
    page --> db7
    page --> db8
    page --> db9
    page --> db10
    
    style page fill:#60a5fa,color:#fff
    style APILayer fill:#ec4899,color:#fff
    style StorageLayer fill:#8b5cf6,color:#fff
    style BrowserAPI fill:#10b981,color:#fff
```

---

## Summary Statistics

- **Total Components**: 11 (1 main + 5 hooks + 5 UI)
- **Utility Files**: 2 (json-import-handler, utils-entity-metric)
- **Total Lines of Code**: ~3,030
- **State Management Lines**: ~715 (in hooks)
- **UI Component Lines**: ~1,050
- **Orchestration Lines**: ~1,000 (page.tsx)
- **API Integration Points**: 4 main APIs
- **Database Operations**: 10+ operations
- **Teams**: 5 (parallel development friendly)
