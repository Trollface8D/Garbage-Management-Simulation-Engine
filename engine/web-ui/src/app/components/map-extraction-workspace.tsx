"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import BackToHome from "@/app/components/back-to-home";
import ModelPicker from "@/app/components/model-picker";
import ProjectPageHeader from "@/app/components/project-page-header";
import StageLogPanel from "@/app/components/stage-log-panel";
import {
  editMapGraph,
  extractMapGraph,
  fetchMapExtractInputFile,
  fetchMapExtractInputs,
  fetchMapExtractResult,
  fetchMapExtractStatusOnce,
  resumeMapExtractJob,
} from "@/lib/map-api-client";
import { CaretIcon, ExportIcon, ImportIcon, SaveIcon, TrashIcon } from "@/app/components/icons/common-icons";
import type {
  GraphSelection,
  MapEdge,
  MapExtractionProgress,
  MapGraphPayload,
  MapVertex,
} from "@/lib/map-types";

type MapExtractionWorkspaceProps = {
  componentId: string;
  title: string;
  projectName: string;
  backHref: string;
};

type LocalUploadFile = {
  id: string;
  file: File;
  previewUrl: string | null;
};

type SelectionRef = {
  kind: "vertex" | "edge";
  id: string;
} | null;

type MapWorkspaceSnapshot = {
  graph: MapGraphPayload | null;
  jobId: string;
  jobStatus?: string;
  completedStages?: string[];
  selectedModel: string;
  overviewAdditionalInfo: string;
  binAdditionalInfo: string;
  overviewFileNames: string[];
  binFileNames: string[];
  changeLog: string[];
  editStatus: string;
  selection: SelectionRef;
  lastTokenUsage?: Record<string, unknown> | null;
  lastCostEstimate?: Record<string, unknown> | null;
};

type MapArtifactBundle = {
  artifactType: "map_extract_workspace";
  artifactVersion: 1;
  exportedAt: string;
  componentId: string;
  title: string;
  projectName: string;
  snapshot: MapWorkspaceSnapshot;
};

type ViewMode = "graph" | "code";

type ExplorerEntry = {
  id: string;
  label: string;
  payload: unknown;
};

function createLocalId(prefix: string): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `${prefix}-${crypto.randomUUID()}`;
  }

  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function toUploadEntry(file: File): LocalUploadFile {
  const previewUrl = file.type.startsWith("image/") ? URL.createObjectURL(file) : null;

  return {
    id: createLocalId("upload"),
    file,
    previewUrl,
  };
}

function revokeFilePreview(file: LocalUploadFile): void {
  if (file.previewUrl) {
    URL.revokeObjectURL(file.previewUrl);
  }
}

function sectionHeaderClassName(isFilled: boolean): string {
  return isFilled ? "bg-emerald-500 text-neutral-900" : "bg-red-500 text-neutral-50";
}

function dedupeNames(names: string[]): string[] {
  return Array.from(new Set(names.filter(Boolean)));
}

function dedupeUploadFiles(files: LocalUploadFile[]): LocalUploadFile[] {
  const seen = new Set<string>();
  const deduped: LocalUploadFile[] = [];

  for (const fileEntry of files) {
    const key = `${fileEntry.file.name}:${String(fileEntry.file.size)}:${String(fileEntry.file.lastModified)}`;
    if (seen.has(key)) {
      revokeFilePreview(fileEntry);
      continue;
    }

    seen.add(key);
    deduped.push(fileEntry);
  }

  return deduped;
}

function selectionToRef(selection: GraphSelection): SelectionRef {
  if (selection.kind === "none") {
    return null;
  }

  return {
    kind: selection.kind,
    id: selection.data.id,
  };
}

function selectionFromRef(graph: MapGraphPayload, ref: SelectionRef): GraphSelection {
  if (!ref) {
    return { kind: "none" };
  }

  if (ref.kind === "vertex") {
    const vertex = graph.vertices.find((item) => item.id === ref.id);
    if (!vertex) {
      return { kind: "none" };
    }

    return { kind: "vertex", data: vertex };
  }

  const edge = graph.edges.find((item) => item.id === ref.id);
  if (!edge) {
    return { kind: "none" };
  }

  return { kind: "edge", data: edge };
}

function SelectionDetails({ selection }: { selection: GraphSelection }) {
  if (selection.kind === "none") {
    return (
      <p className="text-sm text-neutral-400">
        Select a vertex or an edge from Graph view or Code view to inspect details.
      </p>
    );
  }

  const title = selection.kind === "vertex" ? `Vertex ${selection.data.id}` : `Edge ${selection.data.id}`;

  return (
    <div className="space-y-3">
      <p className="text-sm font-semibold text-neutral-100">{title}</p>
      <pre className="max-h-56 overflow-auto rounded-md border border-neutral-700 bg-neutral-950/80 p-3 text-xs text-neutral-200">
        {JSON.stringify(selection.data, null, 2)}
      </pre>
    </div>
  );
}

function GraphCanvas({
  graph,
  selected,
  onSelect,
  mapImageSrc,
}: {
  graph: MapGraphPayload;
  selected: GraphSelection;
  onSelect: (selection: GraphSelection) => void;
  mapImageSrc: string | null;
}) {
  const viewportWidth = 1000;
  const viewportHeight = 700;

  const verticesById = useMemo(() => {
    return new Map(graph.vertices.map((vertex) => [vertex.id, vertex]));
  }, [graph.vertices]);

  const coordinateSystem = graph.metadata?.coordinateSystem ?? "normalized";

  const toCanvasPoint = (vertex: MapVertex) => {
    if (coordinateSystem === "normalized") {
      return {
        x: vertex.x * viewportWidth,
        y: vertex.y * viewportHeight,
      };
    }

    return {
      x: vertex.x,
      y: vertex.y,
    };
  };

  const [failedImageSrc, setFailedImageSrc] = useState<string | null>(null);
  const imageLoadFailed = !!mapImageSrc && failedImageSrc === mapImageSrc;

  const symbolColorMap: Record<string, string> = {
    RED: "#ef4444",
    GREEN: "#22c55e",
    BLUE: "#3b82f6",
    YELLOW: "#f59e0b",
    ORANGE: "#f97316",
    BLACK: "#111827",
    WHITE: "#e5e7eb",
    HAZARDOUS: "#dc2626",
    RECYCLABLE: "#16a34a",
    ORGANIC: "#65a30d",
    GENERAL: "#0ea5e9",
    UNKNOWN: "#6b7280",
  };

  const getVertexSymbols = (vertex: MapVertex): string[] => {
    const meta = vertex.metadata;
    if (!meta || typeof meta !== "object") {
      return [];
    }

    const record = meta as Record<string, unknown>;
    const source = record.symbols ?? record.symbol ?? record.primarySymbol;
    if (source == null) {
      return [];
    }

    const rawValues = Array.isArray(source) ? source : [source];
    const normalized: string[] = [];
    for (const raw of rawValues) {
      if (raw == null) {
        continue;
      }
      const token = String(raw).trim().toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/_+/g, "_").replace(/^_+|_+$/g, "");
      if (token && !normalized.includes(token)) {
        normalized.push(token);
      }
    }

    return normalized;
  };

  const nodeFillColor = (vertex: MapVertex): string => {
    const symbols = getVertexSymbols(vertex);
    if (symbols.length > 0) {
      return symbolColorMap[symbols[0]] ?? "#6b7280";
    }
    return vertex.type === "Bin" ? "#f97316" : "#0ea5e9";
  };

  const nodeTooltipText = (vertex: MapVertex): string => {
    const symbols = getVertexSymbols(vertex);
    if (symbols.length === 0) {
      return `${vertex.id} (${vertex.label})`;
    }
    return `${vertex.id} (${vertex.label})\nSymbols: ${symbols.join(", ")}`;
  };

  const metadataSummary = (vertex: MapVertex): string => {
    const symbols = getVertexSymbols(vertex);
    if (symbols.length > 0) {
      return `symbols: ${symbols.join("/")}`;
    }

    const meta = vertex.metadata;
    if (!meta || typeof meta !== "object") {
      return vertex.type || "node";
    }

    const record = meta as Record<string, unknown>;
    const candidates = [
      record.type,
      record.category,
      record.zone,
      record.location,
      record.floor,
      record.building,
    ]
      .map((value) => (typeof value === "string" ? value.trim() : ""))
      .filter(Boolean);

    if (candidates.length > 0) {
      return candidates.slice(0, 2).join(" | ");
    }

    return vertex.type || "node";
  };

  return (
    <div className="relative h-135 overflow-hidden rounded-xl border border-neutral-700 bg-neutral-900">
      {mapImageSrc && !imageLoadFailed ? (
        <img
          src={mapImageSrc}
          alt="Uploaded overview map"
          className="absolute inset-0 z-0 h-full w-full object-contain"
          onLoad={() => setFailedImageSrc((prev) => (prev === mapImageSrc ? null : prev))}
          onError={() => setFailedImageSrc(mapImageSrc)}
        />
      ) : (
        <div className="flex h-full items-center justify-center text-sm text-neutral-500">
          No map image selected. Graph overlay is still available.
        </div>
      )}

      <svg
        className="absolute inset-0 z-10 h-full w-full"
        viewBox={`0 0 ${String(viewportWidth)} ${String(viewportHeight)}`}
        preserveAspectRatio="xMidYMid meet"
      >
        {graph.edges.map((edge) => {
          const source = verticesById.get(edge.source);
          const target = verticesById.get(edge.target);

          if (!source || !target) {
            return null;
          }

          const start = toCanvasPoint(source);
          const end = toCanvasPoint(target);
          const isSelected = selected.kind === "edge" && selected.data.id === edge.id;

          return (
            <g key={edge.id}>
              <line
                x1={start.x}
                y1={start.y}
                x2={end.x}
                y2={end.y}
                stroke={isSelected ? "#f59e0b" : "#c4b5fd"}
                strokeWidth={isSelected ? 4 : 2}
                strokeLinecap="round"
                className="pointer-events-auto cursor-pointer"
                onClick={() => onSelect({ kind: "edge", data: edge })}
              />
              <text
                x={(start.x + end.x) / 2}
                y={(start.y + end.y) / 2 - 6}
                fill="#f5f5f5"
                fontSize="12"
                textAnchor="middle"
                className="pointer-events-none"
              >
                {edge.label || edge.id}
              </text>
            </g>
          );
        })}

        {graph.vertices.map((vertex) => {
          const point = toCanvasPoint(vertex);
          const isSelected = selected.kind === "vertex" && selected.data.id === vertex.id;

          return (
            <g key={vertex.id}>
              <circle
                cx={point.x}
                cy={point.y}
                r={isSelected ? 24 : 18}
                fill={nodeFillColor(vertex)}
                stroke={isSelected ? "#fde68a" : "#e5e7eb"}
                strokeWidth={isSelected ? 4 : 2}
                className="pointer-events-auto cursor-pointer"
                onClick={() => onSelect({ kind: "vertex", data: vertex })}
              >
                <title>{nodeTooltipText(vertex)}</title>
              </circle>
              <text
                x={point.x}
                y={point.y + 4}
                textAnchor="middle"
                fill="#0a0a0a"
                fontSize="14"
                fontWeight="bold"
                className="pointer-events-none"
              >
                {vertex.label}
              </text>
              <text
                x={point.x}
                y={point.y + 34}
                textAnchor="middle"
                fill="#f5f5f5"
                fontSize="11"
                className="pointer-events-none"
              >
                {metadataSummary(vertex)}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

function CodeExplorer({
  graph,
  onPick,
}: {
  graph: MapGraphPayload;
  onPick: (selection: GraphSelection) => void;
}) {
  const [verticesOpen, setVerticesOpen] = useState(true);
  const [edgesOpen, setEdgesOpen] = useState(true);
  const [metadataOpen, setMetadataOpen] = useState(true);

  const vertexEntries: ExplorerEntry[] = graph.vertices.map((vertex) => ({
    id: vertex.id,
    label: `${vertex.id} (${vertex.label})`,
    payload: vertex,
  }));

  const edgeEntries: ExplorerEntry[] = graph.edges.map((edge) => ({
    id: edge.id,
    label: `${edge.id}: ${edge.source} -> ${edge.target}`,
    payload: edge,
  }));

  return (
    <div className="h-135 min-w-0 overflow-auto rounded-xl border border-neutral-700 bg-neutral-900/80 p-3">
      <div className="space-y-2">
        <div className="rounded-md border border-neutral-700 bg-neutral-950/70">
          <button
            type="button"
            onClick={() => setVerticesOpen((prev) => !prev)}
            className="flex w-full items-center justify-between px-3 py-2 text-left text-sm font-semibold text-neutral-100"
          >
            <span>vertices ({String(vertexEntries.length)})</span>
            <CaretIcon direction={verticesOpen ? "up" : "down"} className="h-4 w-4 text-neutral-300" />
          </button>
          {verticesOpen ? (
            <div className="border-t border-neutral-700 px-2 py-2">
              {vertexEntries.map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  onClick={() => onPick({ kind: "vertex", data: entry.payload as MapVertex })}
                  className="mb-1 w-full rounded px-2 py-1 text-left text-xs text-neutral-300 transition hover:bg-neutral-800 hover:text-neutral-100"
                >
                  {entry.label}
                </button>
              ))}
            </div>
          ) : null}
        </div>

        <div className="rounded-md border border-neutral-700 bg-neutral-950/70">
          <button
            type="button"
            onClick={() => setEdgesOpen((prev) => !prev)}
            className="flex w-full items-center justify-between px-3 py-2 text-left text-sm font-semibold text-neutral-100"
          >
            <span>edges ({String(edgeEntries.length)})</span>
            <CaretIcon direction={edgesOpen ? "up" : "down"} className="h-4 w-4 text-neutral-300" />
          </button>
          {edgesOpen ? (
            <div className="border-t border-neutral-700 px-2 py-2">
              {edgeEntries.map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  onClick={() => onPick({ kind: "edge", data: entry.payload as MapEdge })}
                  className="mb-1 w-full truncate rounded px-2 py-1 text-left text-xs text-neutral-300 transition hover:bg-neutral-800 hover:text-neutral-100"
                >
                  {entry.label}
                </button>
              ))}
            </div>
          ) : null}
        </div>

        <div className="rounded-md border border-neutral-700 bg-neutral-950/70">
          <button
            type="button"
            onClick={() => setMetadataOpen((prev) => !prev)}
            className="flex w-full items-center justify-between px-3 py-2 text-left text-sm font-semibold text-neutral-100"
          >
            <span>metadata</span>
            <CaretIcon direction={metadataOpen ? "up" : "down"} className="h-4 w-4 text-neutral-300" />
          </button>
          {metadataOpen ? (
            <div className="border-t border-neutral-700 p-2">
              <pre className="overflow-auto whitespace-pre-wrap break-words rounded bg-neutral-900 p-2 text-xs text-neutral-300">
                {JSON.stringify(graph.metadata || {}, null, 2)}
              </pre>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export default function MapExtractionWorkspace({
  componentId,
  title,
  projectName,
  backHref,
}: MapExtractionWorkspaceProps) {
  const overviewInputRef = useRef<HTMLInputElement | null>(null);
  const binInputRef = useRef<HTMLInputElement | null>(null);
  const artifactImportInputRef = useRef<HTMLInputElement | null>(null);
  const snapshotKey = useMemo(() => `map-workspace:${componentId}`, [componentId]);

  // Prevents the save-effect from overwriting the persisted snapshot with
  // default (empty) state before the load-effect has hydrated the component.
  const [hydrated, setHydrated] = useState(false);

  const [overviewFiles, setOverviewFiles] = useState<LocalUploadFile[]>([]);
  const [binFiles, setBinFiles] = useState<LocalUploadFile[]>([]);
  const [overviewStoredFileNames, setOverviewStoredFileNames] = useState<string[]>([]);
  const [binStoredFileNames, setBinStoredFileNames] = useState<string[]>([]);
  // Set to true once saved inputs have been pulled back from the
  // backend, so the "please re-upload" banner can stop pestering the
  // user on reload.
  const [inputsRehydrated, setInputsRehydrated] = useState(false);
  const [overviewAdditionalInfo, setOverviewAdditionalInfo] = useState("");
  const [binAdditionalInfo, setBinAdditionalInfo] = useState("");

  const [isOverviewCollapsed, setIsOverviewCollapsed] = useState(false);
  const [isBinCollapsed, setIsBinCollapsed] = useState(false);
  const [isSymbolCollapsed, setIsSymbolCollapsed] = useState(false);

  const [graphData, setGraphData] = useState<MapGraphPayload | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>("graph");
  const [selection, setSelection] = useState<GraphSelection>({ kind: "none" });
  const [jobId, setJobId] = useState<string>("");
  const [selectedModel, setSelectedModel] = useState<string>("");

  const [isExtracting, setIsExtracting] = useState(false);
  const [isResuming, setIsResuming] = useState(false);
  // True when the page finds a remote job that is already running/queued on
  // the backend (started in a previous session or another tab) and is
  // watching it to completion. Kept separate from isExtracting/isResuming
  // because those flags are owned by local user actions in this session.
  const [isRemoteWatching, setIsRemoteWatching] = useState(false);
  // A single "activity" gate that disables inputs and flips the stage-log
  // panel + terminate/extract buttons into the correct state regardless of
  // whether the user started a fresh extract, resumed an existing job, or
  // reopened the page while a prior job is still running on the backend.
  const isJobActive = isExtracting || isResuming || isRemoteWatching;
  const [extractStatus, setExtractStatus] = useState("");
  const [liveUsage, setLiveUsage] = useState<{
    tokenUsage?: Record<string, unknown>;
    costEstimate?: Record<string, unknown>;
  } | null>(null);

  // Stage-log / checkpoint-aware state.
  const [jobStatus, setJobStatus] = useState<string>("");
  const [currentStage, setCurrentStage] = useState<string | null>(null);
  const [stageMessage, setStageMessage] = useState<string>("");
  const [completedStages, setCompletedStages] = useState<string[]>([]);
  const [canResume, setCanResume] = useState<boolean>(false);
  const [remainingStages, setRemainingStages] = useState<number | null>(null);
  const [nextStage, setNextStage] = useState<string | null>(null);
  const [resumeDisabledReason, setResumeDisabledReason] = useState<string>("");
  const [cancelRequested, setCancelRequested] = useState<boolean>(false);
  const [latestProgress, setLatestProgress] = useState<MapExtractionProgress | null>(null);

  // Layout collapse state for the 3-zone grid (left rail / right rail).
  const [isLeftPanelCollapsed, setIsLeftPanelCollapsed] = useState(false);
  // Right rail (stage log) starts collapsed and expands automatically when a
  // run becomes active or completed-stage history is known.  The user can
  // still override this manually via the header toggle.
  const [isRightPanelCollapsed, setIsRightPanelCollapsed] = useState(true);
  const [rightPanelUserToggled, setRightPanelUserToggled] = useState(false);

  const [chatPrompt, setChatPrompt] = useState("");
  const [isApplyingEdit, setIsApplyingEdit] = useState(false);
  const [editStatus, setEditStatus] = useState("");
  const [changeLog, setChangeLog] = useState<string[]>([]);

  const [history, setHistory] = useState<MapGraphPayload[]>([]);

  const latestOverviewFilesRef = useRef<LocalUploadFile[]>([]);
  const latestBinFilesRef = useRef<LocalUploadFile[]>([]);

  useEffect(() => {
    latestOverviewFilesRef.current = overviewFiles;
  }, [overviewFiles]);

  useEffect(() => {
    latestBinFilesRef.current = binFiles;
  }, [binFiles]);

  const mainMapPreview = useMemo(() => {
    return overviewFiles.find((entry) => entry.previewUrl)?.previewUrl ?? null;
  }, [overviewFiles]);

  useEffect(() => {
    return () => {
      latestOverviewFilesRef.current.forEach(revokeFilePreview);
      latestBinFilesRef.current.forEach(revokeFilePreview);
    };
  }, []);

  const overviewDisplayNames = useMemo(
    () => dedupeNames([...overviewStoredFileNames, ...overviewFiles.map((entry) => entry.file.name)]),
    [overviewFiles, overviewStoredFileNames],
  );

  const binDisplayNames = useMemo(
    () => dedupeNames([...binStoredFileNames, ...binFiles.map((entry) => entry.file.name)]),
    [binFiles, binStoredFileNames],
  );

  const usageStats = useMemo(() => {
    const meta = graphData?.metadata;
    // Any in-flight run (extract OR resume) should surface live usage from
    // the worker's incremental updates instead of the persisted graph's
    // snapshot totals.
    const inFlight = isExtracting || isResuming;
    const inFlightTokenUsage = inFlight ? (liveUsage?.tokenUsage || {}) : undefined;
    const inFlightCostEstimate = inFlight ? liveUsage?.costEstimate : undefined;
    // When the run is not in-flight, prefer the persisted graph's usage
    // (if the job completed) but fall back to the last-known liveUsage
    // so a rollback/reload keeps the counter instead of collapsing to 0.
    const persistedTokenUsage = !inFlight
      ? (liveUsage?.tokenUsage as Record<string, unknown> | undefined)
      : undefined;
    const persistedCostEstimate = !inFlight
      ? (liveUsage?.costEstimate as Record<string, unknown> | undefined)
      : undefined;
    const tokenUsageRaw =
      inFlightTokenUsage ||
      (meta?.tokenUsage as Record<string, unknown> | undefined) ||
      (meta?.token_usage as Record<string, unknown> | undefined) ||
      (meta?.usage as Record<string, unknown> | undefined) ||
      persistedTokenUsage ||
      undefined;
    const costEstimate = inFlightCostEstimate || meta?.costEstimate || persistedCostEstimate;

    const num = (value: unknown): number => {
      if (typeof value === "number" && Number.isFinite(value)) {
        return value;
      }
      if (typeof value === "string") {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : 0;
      }
      return 0;
    };

    const promptTokens = num(tokenUsageRaw?.promptTokens ?? tokenUsageRaw?.prompt_tokens);
    const outputTokens = num(tokenUsageRaw?.outputTokens ?? tokenUsageRaw?.output_tokens);
    const totalTokens = num(tokenUsageRaw?.totalTokens ?? tokenUsageRaw?.total_tokens);
    const callCount = num(tokenUsageRaw?.callCount ?? tokenUsageRaw?.call_count);

    return {
      promptTokens,
      outputTokens,
      totalTokens: totalTokens || promptTokens + outputTokens,
      callCount,
      estimatedCost:
        typeof costEstimate?.estimatedCost === "number" ? costEstimate.estimatedCost : null,
      currency: String(costEstimate?.currency || "USD"),
      costSource: String(costEstimate?.source || "unknown"),
    };
  }, [graphData, isExtracting, isResuming, liveUsage]);

  // Whether there is anything worth showing in the stage-log rail.  This is
  // used both to auto-expand it when a prior run's history is restored from
  // the snapshot and to lock upload/extract controls below.
  const hasStageHistory = completedStages.length > 0 || Boolean(jobStatus);
  // True once the user has *anything* tracked on this component: completed
  // stages, a live job, or a persisted graph.  When true, input + Extract
  // controls lock so the user cannot accidentally mutate inputs mid-session
  // or launch a duplicate run; they must explicitly Reset to start over.
  const hasAnyActivity = hasStageHistory || isJobActive || Boolean(graphData);
  const inputsLocked = hasAnyActivity;
  const inputsLockReason = isJobActive
    ? "Inputs are locked while the job is running."
    : "Inputs are locked — click Reset to start a new extraction.";

  useEffect(() => {
    if (rightPanelUserToggled) return;
    if (isJobActive || hasStageHistory) {
      setIsRightPanelCollapsed(false);
    } else {
      setIsRightPanelCollapsed(true);
    }
  }, [isJobActive, hasStageHistory, rightPanelUserToggled]);

  const symbolLegend = useMemo(() => {
    const raw = graphData?.metadata?.symbolLegend;
    if (!Array.isArray(raw)) {
      return [] as Array<{ symbol: string; notation: string; description: string; color: string }>;
    }

    return raw
      .filter((item) => item && typeof item === "object")
      .map((item) => {
        const record = item as Record<string, unknown>;
        return {
          symbol: String(record.symbol || "").trim(),
          notation: String(record.notation || "").trim(),
          description: String(record.description || "").trim(),
          color: String(record.color || "").trim(),
        };
      })
      .filter((item) => item.symbol.length > 0);
  }, [graphData]);

  useEffect(() => {
    const saved = window.localStorage.getItem(snapshotKey);

    if (!saved) {
      // No prior snapshot — mark hydrated so the save-effect can start
      // persisting changes from a clean slate.
      setHydrated(true);
      return;
    }

    try {
      const parsed = JSON.parse(saved) as MapWorkspaceSnapshot;

      if (parsed?.graph && Array.isArray(parsed.graph.vertices) && Array.isArray(parsed.graph.edges)) {
        setGraphData(parsed.graph);
        setSelection(selectionFromRef(parsed.graph, parsed.selection ?? null));
      }

      if (Array.isArray(parsed?.overviewFileNames)) {
        setOverviewStoredFileNames(dedupeNames(parsed.overviewFileNames));
      }

      if (Array.isArray(parsed?.binFileNames)) {
        setBinStoredFileNames(dedupeNames(parsed.binFileNames));
      }

      if (typeof parsed?.overviewAdditionalInfo === "string") {
        setOverviewAdditionalInfo(parsed.overviewAdditionalInfo);
      }

      if (typeof parsed?.binAdditionalInfo === "string") {
        setBinAdditionalInfo(parsed.binAdditionalInfo);
      }

      if (typeof parsed?.jobId === "string") {
        setJobId(parsed.jobId);
      }

      if (typeof parsed?.selectedModel === "string") {
        setSelectedModel(parsed.selectedModel.trim());
      }

      if (Array.isArray(parsed?.changeLog)) {
        setChangeLog(parsed.changeLog);
      }

      if (typeof parsed?.editStatus === "string") {
        setEditStatus(parsed.editStatus);
      }

      if (typeof parsed?.jobStatus === "string" && parsed.jobStatus) {
        setJobStatus(parsed.jobStatus);
      }

      if (Array.isArray(parsed?.completedStages)) {
        setCompletedStages(parsed.completedStages);
      }

      if (parsed?.lastTokenUsage && typeof parsed.lastTokenUsage === "object") {
        setLiveUsage({
          tokenUsage: parsed.lastTokenUsage as Record<string, unknown>,
          costEstimate:
            (parsed.lastCostEstimate as Record<string, unknown> | undefined) || undefined,
        });
      }

      if (parsed?.graph) {
        setExtractStatus("Loaded previous map extraction details.");
      }
    } catch {
      // Ignore corrupted local snapshot.
    } finally {
      // Always mark hydrated regardless of snapshot validity so the
      // save-effect is unblocked and future interactions are persisted.
      setHydrated(true);
    }
  }, [snapshotKey]);

  useEffect(() => {
    // Do not save until the load-effect has finished hydrating state.
    // Without this guard, the save-effect fires during the first render
    // with all-default (empty) values and wipes the persisted snapshot
    // before the restored state can propagate from the load-effect.
    if (!hydrated) {
      return;
    }

    const snapshot: MapWorkspaceSnapshot = {
      graph: graphData,
      jobId,
      jobStatus,
      completedStages,
      selectedModel,
      overviewAdditionalInfo,
      binAdditionalInfo,
      overviewFileNames: overviewDisplayNames,
      binFileNames: binDisplayNames,
      changeLog,
      editStatus,
      selection: graphData ? selectionToRef(selection) : null,
      lastTokenUsage: liveUsage?.tokenUsage ?? null,
      lastCostEstimate: liveUsage?.costEstimate ?? null,
    };

    window.localStorage.setItem(snapshotKey, JSON.stringify(snapshot));
  }, [
    hydrated,
    overviewAdditionalInfo,
    binAdditionalInfo,
    binDisplayNames,
    changeLog,
    completedStages,
    editStatus,
    graphData,
    jobId,
    jobStatus,
    liveUsage,
    selectedModel,
    overviewDisplayNames,
    selection,
    snapshotKey,
  ]);

  // After hydration, ask the backend for the authoritative job state so
  // the UI can reflect actual checkpoints / token usage / cancel state
  // (protecting against stale localStorage and surviving backend restarts).
  useEffect(() => {
    if (!hydrated || !jobId) {
      return;
    }
    void refreshJobStatus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated, jobId]);

  // Remote-job watcher: if the page reopens while a prior job is still
  // running/queued on the backend (worker is a detached daemon thread so it
  // survives page navigation and backend restarts that re-hydrate from disk
  // checkpoints), poll status until a terminal state, then pull the final
  // result.  Without this, the UI would freeze on whatever snapshot mount
  // saw and never show live progress or the final graph.
  //
  // Guards against overlapping with a locally-triggered run (Extract /
  // Resume) because those paths already own their own polling loop — we
  // only watch when neither local flag is set.
  useEffect(() => {
    if (!hydrated || !jobId) {
      return;
    }
    if (isExtracting || isResuming) {
      return;
    }
    const watchable = jobStatus === "running" || jobStatus === "queued";
    if (!watchable) {
      return;
    }
    let cancelled = false;
    setIsRemoteWatching(true);
    const startedAt = Date.now();
    let attempt = 0;
    const pollIntervalMs = 1500;

    const pumpOnce = async (): Promise<boolean> => {
      if (cancelled) return true;
      attempt += 1;
      try {
        const status = await fetchMapExtractStatusOnce(jobId);
        if (cancelled) return true;
        setJobStatus(status.status);
        setCurrentStage(status.currentStage ?? null);
        setStageMessage(status.stageMessage ?? "");
        setCompletedStages(status.completedStages ?? []);
        setCanResume(Boolean(status.canResume));
        setRemainingStages(
          typeof status.remainingStages === "number" ? status.remainingStages : null,
        );
        setNextStage(status.nextStage ?? null);
        setResumeDisabledReason(status.resumeDisabledReason ?? "");
        setCancelRequested(Boolean(status.cancelRequested));
        const statusTokenUsage = (status as { tokenUsage?: Record<string, unknown> | null })
          .tokenUsage;
        const statusCostEstimate = (status as {
          costEstimate?: Record<string, unknown> | null;
        }).costEstimate;
        if (statusTokenUsage || statusCostEstimate) {
          setLiveUsage((prev) => ({
            tokenUsage:
              (statusTokenUsage as Record<string, unknown> | undefined) ||
              prev?.tokenUsage,
            costEstimate:
              (statusCostEstimate as Record<string, unknown> | undefined) ||
              prev?.costEstimate,
          }));
        }
        setLatestProgress({
          jobId,
          attempt,
          elapsedMs: Date.now() - startedAt,
          status: status.status,
          stage: status.currentStage,
          message: status.stageMessage,
          tokenUsage: status.tokenUsage,
          costEstimate: status.costEstimate,
          canResume: status.canResume,
          remainingStages: status.remainingStages,
          nextStage: status.nextStage,
          resumeDisabledReason: status.resumeDisabledReason,
        });

        if (status.status === "completed") {
          try {
            const result = await fetchMapExtractResult(jobId);
            if (cancelled) return true;
            if (result.graph) {
              setGraphData(result.graph);
            }
            setExtractStatus("Job completed.");
          } catch {
            // Result fetch will retry on the next page visit.
          }
          return true;
        }
        if (status.status === "failed" || status.status === "cancelled") {
          return true;
        }
      } catch {
        // Transient; keep polling.
      }
      return false;
    };

    let handle: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      const done = await pumpOnce();
      if (done || cancelled) {
        setIsRemoteWatching(false);
        return;
      }
      handle = setTimeout(() => void tick(), pollIntervalMs);
    };
    void tick();

    return () => {
      cancelled = true;
      if (handle) clearTimeout(handle);
      setIsRemoteWatching(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated, jobId, jobStatus, isExtracting, isResuming]);

  // Reset rehydration guard when the job identity changes so the next
  // jobId can pull its own inputs.
  useEffect(() => {
    setInputsRehydrated(false);
  }, [jobId]);

  // Pull the previously-uploaded files back from the backend so a
  // reload keeps the upload section populated (problem #1: snapshots
  // only persisted filenames; the blobs lived server-side on disk but
  // were never exposed).  Runs once per jobId after hydrate.
  useEffect(() => {
    if (!hydrated || !jobId || inputsRehydrated) {
      return;
    }
    let cancelled = false;
    const run = async () => {
      try {
        const manifest = await fetchMapExtractInputs(jobId);
        if (!manifest || cancelled) {
          return;
        }

        const hydrate = async (
          entries: typeof manifest.overviewFiles,
          kind: "overview" | "support",
        ) => {
          const files: File[] = [];
          for (const entry of entries) {
            try {
              const file = await fetchMapExtractInputFile(
                jobId,
                kind,
                entry.index,
                entry.filename,
                entry.mimeType,
              );
              if (file) {
                files.push(file);
              }
            } catch {
              // Ignore individual file failures — keep hydrating others.
            }
            if (cancelled) {
              return files;
            }
          }
          return files;
        };

        const overviewHydrated = await hydrate(manifest.overviewFiles, "overview");
        const supportHydrated = await hydrate(manifest.supportFiles, "support");
        if (cancelled) {
          return;
        }
        if (overviewHydrated.length > 0) {
          setOverviewFiles((prev) => {
            const existingNames = new Set(prev.map((entry) => entry.file.name));
            const incoming = overviewHydrated
              .filter((file) => !existingNames.has(file.name))
              .map(toUploadEntry);
            return [...prev, ...incoming];
          });
          setOverviewStoredFileNames((prev) =>
            dedupeNames([...prev, ...overviewHydrated.map((file) => file.name)]),
          );
        }
        if (supportHydrated.length > 0) {
          setBinFiles((prev) => {
            const existingNames = new Set(prev.map((entry) => entry.file.name));
            const incoming = supportHydrated
              .filter((file) => !existingNames.has(file.name))
              .map(toUploadEntry);
            return [...prev, ...incoming];
          });
          setBinStoredFileNames((prev) =>
            dedupeNames([...prev, ...supportHydrated.map((file) => file.name)]),
          );
        }
        if (typeof manifest.overviewAdditionalInformation === "string") {
          setOverviewAdditionalInfo((prev) =>
            prev || (manifest.overviewAdditionalInformation as string),
          );
        }
        if (typeof manifest.supportAdditionalInformation === "string") {
          setBinAdditionalInfo((prev) =>
            prev || (manifest.supportAdditionalInformation as string),
          );
        }
        setInputsRehydrated(true);
      } catch {
        // Silently ignore — the user can re-upload if needed.
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated, jobId]);

  const onPickOverviewFiles = (files: FileList | null) => {
    const picked = Array.from(files || []);
    if (picked.length === 0) {
      return;
    }

    setOverviewFiles((prev) => {
      return dedupeUploadFiles([...prev, ...picked.map(toUploadEntry)]);
    });
    setOverviewStoredFileNames((prev) => dedupeNames([...prev, ...picked.map((item) => item.name)]));
  };

  const onPickBinFiles = (files: FileList | null) => {
    const picked = Array.from(files || []);
    if (picked.length === 0) {
      return;
    }

    setBinFiles((prev) => {
      return dedupeUploadFiles([...prev, ...picked.map(toUploadEntry)]);
    });
    setBinStoredFileNames((prev) => dedupeNames([...prev, ...picked.map((item) => item.name)]));
  };

  const handleRemoveOverviewFile = (fileName: string) => {
    setOverviewFiles((prev) => {
      const remaining: LocalUploadFile[] = [];

      for (const entry of prev) {
        if (entry.file.name === fileName) {
          revokeFilePreview(entry);
          continue;
        }
        remaining.push(entry);
      }

      return remaining;
    });

    setOverviewStoredFileNames((prev) => prev.filter((name) => name !== fileName));
  };

  const handleRemoveBinFile = (fileName: string) => {
    setBinFiles((prev) => {
      const remaining: LocalUploadFile[] = [];

      for (const entry of prev) {
        if (entry.file.name === fileName) {
          revokeFilePreview(entry);
          continue;
        }
        remaining.push(entry);
      }

      return remaining;
    });

    setBinStoredFileNames((prev) => prev.filter((name) => name !== fileName));
  };

  const handleExtract = async () => {
    if (overviewFiles.length === 0) {
      setExtractStatus("Upload at least one overview map file before extraction.");
      return;
    }

    setIsExtracting(true);
    setExtractStatus("Running map extraction...");
    setEditStatus("");
    setJobStatus("running");
    setCurrentStage(null);
    setStageMessage("");
    setCompletedStages([]);
    setCanResume(false);
    setRemainingStages(null);
    setNextStage(null);
    setResumeDisabledReason("");
    setCancelRequested(false);
    setLatestProgress(null);
    setLiveUsage({
      tokenUsage: {
        promptTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        callCount: 0,
      },
      costEstimate: {
        currency: "USD",
        estimatedCost: 0,
        source: "unknown",
      },
    });

    try {
      const result = await extractMapGraph({
        componentId,
        overviewAdditionalInformation: overviewAdditionalInfo,
        binAdditionalInformation: binAdditionalInfo,
        overviewMapFiles: overviewFiles.map((entry) => entry.file),
        binLocationFiles: binFiles.map((entry) => entry.file),
        model: selectedModel,
      }, {
        onProgress: (progress) => {
          const stage = progress.stage || "waiting";
          const message = progress.message || progress.status;
          const seconds = Math.max(0, Math.floor(progress.elapsedMs / 1000));
          setExtractStatus(`Running ${stage}: ${message} (${String(seconds)}s)`);
          setJobId(progress.jobId);
          setJobStatus(progress.status);
          setCurrentStage(progress.stage ?? null);
          setStageMessage(progress.message ?? "");
          setLatestProgress(progress);
          if (typeof progress.canResume === "boolean") {
            setCanResume(progress.canResume);
          }
          if (typeof progress.remainingStages === "number") {
            setRemainingStages(progress.remainingStages);
          }
          if (typeof progress.nextStage === "string") {
            setNextStage(progress.nextStage);
          } else if (progress.nextStage === null) {
            setNextStage(null);
          }
          if (typeof progress.resumeDisabledReason === "string") {
            setResumeDisabledReason(progress.resumeDisabledReason);
          } else if (progress.resumeDisabledReason === null) {
            setResumeDisabledReason("");
          }
          if (progress.tokenUsage || progress.costEstimate) {
            setLiveUsage((prev) => ({
              tokenUsage: (progress.tokenUsage as Record<string, unknown> | undefined) || prev?.tokenUsage,
              costEstimate: (progress.costEstimate as Record<string, unknown> | undefined) || prev?.costEstimate,
            }));
          }
        },
      });

      setGraphData(result.graph);
      setJobId(result.jobId);
      setSelection({ kind: "none" });
      setViewMode("graph");
      setHistory([]);
      setOverviewStoredFileNames(dedupeNames(overviewFiles.map((entry) => entry.file.name)));
      setBinStoredFileNames(dedupeNames(binFiles.map((entry) => entry.file.name)));

      // Required UX from wireframe: collapse all left fields after extraction starts/completes.
      setIsOverviewCollapsed(true);
      setIsBinCollapsed(true);
      setIsSymbolCollapsed(false);

      setJobStatus("completed");
      setCurrentStage(null);
      setStageMessage("");
      setCanResume(false);
      setRemainingStages(0);
      setNextStage(null);
      setResumeDisabledReason("No stages left to run.");
      setExtractStatus("Map extraction completed.");
      setLiveUsage(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Map extraction failed.";
      setExtractStatus(message);
      setJobStatus((prev) => (prev === "cancelled" ? "cancelled" : "failed"));
    } finally {
      setIsExtracting(false);
    }
  };

  const refreshJobStatus = async () => {
    if (!jobId) {
      return;
    }
    try {
      const status = await fetchMapExtractStatusOnce(jobId);
      setJobStatus(status.status);
      setCurrentStage(status.currentStage ?? null);
      setStageMessage(status.stageMessage ?? "");
      setCompletedStages(status.completedStages ?? []);
      setCanResume(Boolean(status.canResume));
      setRemainingStages(
        typeof status.remainingStages === "number" ? status.remainingStages : null,
      );
      setNextStage(status.nextStage ?? null);
      setResumeDisabledReason(status.resumeDisabledReason ?? "");
      setCancelRequested(Boolean(status.cancelRequested));
      // Surface backend-known usage totals so a rollback/reload keeps
      // the counter accurate without a running worker.
      const statusTokenUsage = (status as { tokenUsage?: Record<string, unknown> | null })
        .tokenUsage;
      const statusCostEstimate = (status as { costEstimate?: Record<string, unknown> | null })
        .costEstimate;
      if (statusTokenUsage || statusCostEstimate) {
        setLiveUsage((prev) => ({
          tokenUsage: (statusTokenUsage as Record<string, unknown> | undefined) || prev?.tokenUsage,
          costEstimate:
            (statusCostEstimate as Record<string, unknown> | undefined) || prev?.costEstimate,
        }));
      }
    } catch {
      // Ignore stale jobs etc.
    }
  };

  const handleResume = async () => {
    if (!jobId) {
      setExtractStatus("No job to resume.");
      return;
    }
    if (isJobActive) {
      return;
    }

    setIsResuming(true);
    setExtractStatus("Resuming map extraction...");
    setEditStatus("");
    setJobStatus("running");
    setCancelRequested(false);
    setLatestProgress(null);
    // Seed a zero'd live usage so the bottom counters go "live" immediately
    // instead of showing stale totals from the persisted graph metadata.
    setLiveUsage({
      tokenUsage: {
        promptTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        callCount: 0,
      },
      costEstimate: {
        currency: "USD",
        estimatedCost: 0,
        source: "unknown",
      },
    });

    try {
      const result = await resumeMapExtractJob(jobId, {
        onProgress: (progress) => {
          const stage = progress.stage || "waiting";
          const message = progress.message || progress.status;
          const seconds = Math.max(0, Math.floor(progress.elapsedMs / 1000));
          setExtractStatus(`Resume ${stage}: ${message} (${String(seconds)}s)`);
          setJobId(progress.jobId);
          setJobStatus(progress.status);
          setCurrentStage(progress.stage ?? null);
          setStageMessage(progress.message ?? "");
          setLatestProgress(progress);
          if (typeof progress.canResume === "boolean") {
            setCanResume(progress.canResume);
          }
          if (typeof progress.remainingStages === "number") {
            setRemainingStages(progress.remainingStages);
          }
          if (typeof progress.nextStage === "string") {
            setNextStage(progress.nextStage);
          } else if (progress.nextStage === null) {
            setNextStage(null);
          }
          if (typeof progress.resumeDisabledReason === "string") {
            setResumeDisabledReason(progress.resumeDisabledReason);
          } else if (progress.resumeDisabledReason === null) {
            setResumeDisabledReason("");
          }
          if (progress.tokenUsage || progress.costEstimate) {
            setLiveUsage((prev) => ({
              tokenUsage:
                (progress.tokenUsage as Record<string, unknown> | undefined) || prev?.tokenUsage,
              costEstimate:
                (progress.costEstimate as Record<string, unknown> | undefined) ||
                prev?.costEstimate,
            }));
          }
        },
      });

      setGraphData(result.graph);
      setJobId(result.jobId);
      setSelection({ kind: "none" });
      setViewMode("graph");
      setHistory([]);
      setJobStatus("completed");
      setCurrentStage(null);
      setStageMessage("");
      setCanResume(false);
      setRemainingStages(0);
      setNextStage(null);
      setResumeDisabledReason("No stages left to run.");
      setExtractStatus("Resume completed.");
      setLiveUsage(null);
      // Refresh stage history from backend (remote checkpoints) so the
      // stage-log panel shows the full set of completed stages.
      await refreshJobStatus();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Map resume failed.";
      setExtractStatus(message);
      setJobStatus((prev) => (prev === "cancelled" ? "cancelled" : "failed"));
    } finally {
      setIsResuming(false);
    }
  };

  const handleApplyEdit = async () => {
    if (!graphData) {
      setEditStatus("Extract a graph first before editing.");
      return;
    }

    const prompt = chatPrompt.trim();
    if (!prompt) {
      setEditStatus("Prompt is empty.");
      return;
    }

    setIsApplyingEdit(true);
    setEditStatus("Applying edit...");

    try {
      const result = await editMapGraph({
        componentId,
        prompt,
        graph: graphData,
      });

      setHistory((prev) => [...prev, graphData]);
      setGraphData(result.graph);
      setEditStatus(result.changeSummary);
      setChangeLog((prev) => {
        const next = [`${new Date().toLocaleString()} - ${result.changeSummary}`, ...prev];
        return next.slice(0, 15);
      });
      setChatPrompt("");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to apply edit.";
      setEditStatus(message);
    } finally {
      setIsApplyingEdit(false);
    }
  };

  /**
   * Wipe everything tied to the current (or prior) extraction so the user can
   * start fresh.  Only clears *client-side* state; backend checkpoints under
   * `jobId` remain on disk so nothing becomes irrecoverable — the user can
   * still Resume via the stage log if they change their mind before running a
   * new job.  The persisted localStorage snapshot is also cleared.
   */
  const handleReset = () => {
    if (isJobActive) {
      setEditStatus("Cannot reset while a job is running. Terminate first.");
      return;
    }

    setOverviewFiles((prev) => {
      prev.forEach(revokeFilePreview);
      return [];
    });
    setBinFiles((prev) => {
      prev.forEach(revokeFilePreview);
      return [];
    });
    setOverviewStoredFileNames([]);
    setBinStoredFileNames([]);
    setOverviewAdditionalInfo("");
    setBinAdditionalInfo("");
    setGraphData(null);
    setSelection({ kind: "none" });
    setJobId("");
    setJobStatus("");
    setCurrentStage(null);
    setStageMessage("");
    setCompletedStages([]);
    setCanResume(false);
    setRemainingStages(null);
    setNextStage(null);
    setResumeDisabledReason("");
    setCancelRequested(false);
    setLatestProgress(null);
    setLiveUsage(null);
    setInputsRehydrated(false);
    setHistory([]);
    setChangeLog([]);
    setEditStatus("");
    setChatPrompt("");
    setViewMode("graph");
    setExtractStatus("Workspace reset. Ready for a new extraction.");
    setIsOverviewCollapsed(false);
    setIsBinCollapsed(false);
    setRightPanelUserToggled(false);
    try {
      window.localStorage.removeItem(snapshotKey);
    } catch {
      // ignore storage errors
    }
  };

  const handleUndo = () => {
    if (history.length === 0) {
      setEditStatus("No previous edit to undo.");
      return;
    }

    const nextHistory = [...history];
    const previousGraph = nextHistory.pop();

    if (!previousGraph) {
      setEditStatus("No previous edit to undo.");
      return;
    }

    setHistory(nextHistory);
    setGraphData(previousGraph);
    setEditStatus("Undo successful.");
    setSelection({ kind: "none" });
  };

  const handleSaveLocally = () => {
    if (!graphData) {
      setEditStatus("No graph to save yet.");
      return;
    }

    // TODO(db): persist map extraction snapshots into SQLite when map tables are finalized.
    window.localStorage.setItem(
      snapshotKey,
      JSON.stringify({
        graph: graphData,
        jobId,
        selectedModel,
        overviewAdditionalInfo,
        binAdditionalInfo,
        overviewFileNames: overviewDisplayNames,
        binFileNames: binDisplayNames,
        changeLog,
        editStatus,
        selection: selectionToRef(selection),
      } satisfies MapWorkspaceSnapshot),
    );
    setEditStatus("Saved current map workspace snapshot locally.");
  };

  const handleExportArtifacts = () => {
    const snapshot: MapWorkspaceSnapshot = {
      graph: graphData,
      jobId,
      selectedModel,
      overviewAdditionalInfo,
      binAdditionalInfo,
      overviewFileNames: overviewDisplayNames,
      binFileNames: binDisplayNames,
      changeLog,
      editStatus,
      selection: graphData ? selectionToRef(selection) : null,
    };

    const bundle: MapArtifactBundle = {
      artifactType: "map_extract_workspace",
      artifactVersion: 1,
      exportedAt: new Date().toISOString(),
      componentId,
      title,
      projectName,
      snapshot,
    };

    const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: "application/json" });
    const objectUrl = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    const safeComponentId = componentId.replace(/[^a-zA-Z0-9_-]+/g, "_");
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    anchor.href = objectUrl;
    anchor.download = `map_extract_artifacts_${safeComponentId}_${timestamp}.json`;
    anchor.click();
    URL.revokeObjectURL(objectUrl);

    setEditStatus("Exported map extraction artifacts as JSON.");
  };

  const resolveImportedSnapshot = (payload: unknown): MapWorkspaceSnapshot | null => {
    if (!payload || typeof payload !== "object") {
      return null;
    }

    const asRecord = payload as Record<string, unknown>;
    if (asRecord.snapshot && typeof asRecord.snapshot === "object") {
      return asRecord.snapshot as MapWorkspaceSnapshot;
    }

    return payload as MapWorkspaceSnapshot;
  };

  const handleImportArtifacts = async (file: File) => {
    try {
      const raw = await file.text();
      const parsed = JSON.parse(raw) as unknown;
      const snapshot = resolveImportedSnapshot(parsed);

      if (!snapshot) {
        setEditStatus("Invalid artifact file format.");
        return;
      }

      if (snapshot.graph && (!Array.isArray(snapshot.graph.vertices) || !Array.isArray(snapshot.graph.edges))) {
        setEditStatus("Invalid graph payload in artifact file.");
        return;
      }

      setOverviewFiles((prev) => {
        prev.forEach(revokeFilePreview);
        return [];
      });
      setBinFiles((prev) => {
        prev.forEach(revokeFilePreview);
        return [];
      });

      setGraphData(snapshot.graph ?? null);
      setJobId(typeof snapshot.jobId === "string" ? snapshot.jobId : "");
      setSelectedModel(typeof snapshot.selectedModel === "string" ? snapshot.selectedModel.trim() : "");
      setOverviewAdditionalInfo(typeof snapshot.overviewAdditionalInfo === "string" ? snapshot.overviewAdditionalInfo : "");
      setBinAdditionalInfo(typeof snapshot.binAdditionalInfo === "string" ? snapshot.binAdditionalInfo : "");
      setOverviewStoredFileNames(dedupeNames(Array.isArray(snapshot.overviewFileNames) ? snapshot.overviewFileNames : []));
      setBinStoredFileNames(dedupeNames(Array.isArray(snapshot.binFileNames) ? snapshot.binFileNames : []));
      setChangeLog(Array.isArray(snapshot.changeLog) ? snapshot.changeLog : []);
      setEditStatus(typeof snapshot.editStatus === "string" ? snapshot.editStatus : "Imported map extraction artifacts.");
      setHistory([]);
      setViewMode("graph");

      if (snapshot.graph) {
        setSelection(selectionFromRef(snapshot.graph, snapshot.selection ?? null));
        setExtractStatus("Imported map extraction artifacts. Re-upload source files to run extraction again.");
      } else {
        setSelection({ kind: "none" });
        setExtractStatus("Imported artifact bundle without graph data.");
      }
    } catch {
      setEditStatus("Failed to import artifact JSON. Ensure the file is valid.");
    }
  };

  return (
    <div className="min-h-screen bg-[#1e1e1e] text-neutral-100">
      <main className="mx-auto w-full max-w-[1600px] px-4 py-6 md:px-6 md:py-8 lg:px-8">
        <ProjectPageHeader
          title="Map Extraction Section"
          projectName={projectName}
          titleClassName="text-3xl font-black uppercase tracking-tight text-neutral-100 md:text-4xl"
          subtitle={
            <>
              Selected component: <span className="font-semibold text-neutral-100">{title}</span>
            </>
          }
          actions={(
            <div className="flex flex-wrap items-center gap-3">
              <ModelPicker value={selectedModel} onChange={setSelectedModel} />
              <BackToHome
                href={backHref}
                label="Back to project"
                useHistoryBack
                containerClassName=""
                className="rounded-md px-3 py-2"
              />
            </div>
          )}
        />

        <header className="mb-5 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={handleSaveLocally}
              aria-label="Save map workspace"
              title="Save"
              className="inline-flex items-center gap-2 rounded-md border border-emerald-700 bg-emerald-500/10 px-3 py-2 text-sm font-semibold text-emerald-200 transition hover:bg-emerald-500/20"
            >
              <SaveIcon className="h-4 w-4" />
              <span>Save</span>
            </button>
            <button
              type="button"
              onClick={handleExportArtifacts}
              aria-label="Export map artifacts"
              title="Export artifacts (.json)"
              className="inline-flex items-center gap-2 rounded-md border border-sky-700 bg-sky-500/10 px-3 py-2 text-sm font-semibold text-sky-200 transition hover:bg-sky-500/20"
            >
              <ExportIcon className="h-4 w-4" />
              <span>Export</span>
            </button>
            <button
              type="button"
              onClick={() => artifactImportInputRef.current?.click()}
              aria-label="Import map artifacts"
              title="Import artifacts (.json)"
              className="inline-flex items-center gap-2 rounded-md border border-sky-700 bg-sky-500/10 px-3 py-2 text-sm font-semibold text-sky-200 transition hover:bg-sky-500/20"
            >
              <ImportIcon className="h-4 w-4" />
              <span>Import</span>
            </button>
            <input
              ref={artifactImportInputRef}
              type="file"
              accept="application/json,.json"
              className="hidden"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) {
                  void handleImportArtifacts(file);
                }
                event.currentTarget.value = "";
              }}
            />
            <button
              type="button"
              onClick={handleReset}
              disabled={isJobActive || !hasAnyActivity}
              aria-label="Reset workspace"
              title={
                isJobActive
                  ? "Terminate the running job before resetting."
                  : !hasAnyActivity
                  ? "Nothing to reset yet."
                  : "Reset workspace: clear graph, inputs, and local snapshot."
              }
              className="inline-flex items-center gap-2 rounded-md border border-amber-700 bg-amber-500/10 px-3 py-2 text-sm font-semibold text-amber-200 transition hover:bg-amber-500/20 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <TrashIcon className="h-4 w-4" />
              <span>Reset</span>
            </button>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <span className="rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2 text-xs text-neutral-300">
              component: {title}
            </span>
            <span className="rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2 text-xs text-neutral-300">
              project: {projectName}
            </span>
            {jobId ? (
              <span className="rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2 text-xs text-neutral-300">
                job: {jobId}
              </span>
            ) : null}
            <button
              type="button"
              onClick={() => setIsLeftPanelCollapsed((prev) => !prev)}
              aria-label={isLeftPanelCollapsed ? "Expand sidebar" : "Collapse sidebar"}
              title={isLeftPanelCollapsed ? "Expand sidebar" : "Collapse sidebar"}
              className="inline-flex items-center gap-1 rounded-lg border border-neutral-700 bg-neutral-900 px-2 py-2 text-xs text-neutral-300 transition hover:border-sky-500"
            >
              {isLeftPanelCollapsed ? "⟩ Left" : "⟨ Left"}
            </button>
            <button
              type="button"
              onClick={() => {
                setRightPanelUserToggled(true);
                setIsRightPanelCollapsed((prev) => !prev);
              }}
              aria-label={isRightPanelCollapsed ? "Expand stage log" : "Collapse stage log"}
              title={isRightPanelCollapsed ? "Expand stage log" : "Collapse stage log"}
              className="inline-flex items-center gap-1 rounded-lg border border-neutral-700 bg-neutral-900 px-2 py-2 text-xs text-neutral-300 transition hover:border-sky-500"
            >
              {isRightPanelCollapsed ? "⟨ Log" : "⟩ Log"}
            </button>
          </div>
        </header>

        <section
          className="grid gap-4"
          style={{
            gridTemplateColumns: `${isLeftPanelCollapsed ? "48px" : "320px"} minmax(0, 1fr) ${
              isRightPanelCollapsed ? "40px" : "360px"
            }`,
          }}
        >
          <aside className="flex min-w-0 flex-col gap-3">
            {isLeftPanelCollapsed ? (
              <div className="flex flex-col items-center gap-2 rounded-xl border border-neutral-800 bg-neutral-900/60 p-2">
                <button
                  type="button"
                  onClick={() => setIsLeftPanelCollapsed(false)}
                  title="Expand sidebar"
                  aria-label="Expand sidebar"
                  className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-neutral-700 bg-neutral-900 text-neutral-200 transition hover:border-sky-500"
                >
                  ⟩
                </button>
                <span className="[writing-mode:vertical-rl] rotate-180 text-[10px] uppercase tracking-widest text-neutral-500">
                  files · inspector
                </span>
              </div>
            ) : (
            <>
            <article className="rounded-xl border border-neutral-800 bg-neutral-900/60 p-4">
              <button
                type="button"
                onClick={() => setIsOverviewCollapsed((prev) => !prev)}
                className="flex w-full items-center justify-between gap-2 text-left"
              >
                <span className="text-lg font-bold text-neutral-100">Overview map images</span>
                <div className="flex items-center gap-2">
                  <span
                    className={`inline-flex h-6 min-w-6 items-center justify-center rounded-full px-2 text-xs font-bold ${sectionHeaderClassName(
                      overviewDisplayNames.length > 0,
                    )}`}
                  >
                    {String(overviewDisplayNames.length)}
                  </span>
                  <CaretIcon direction={isOverviewCollapsed ? "down" : "up"} className="h-4 w-4 text-neutral-300" />
                </div>
              </button>

              {!isOverviewCollapsed ? (
                <div className="mt-4 space-y-3 rounded-lg border border-dashed border-neutral-700 p-3">
                  <p className="text-sm font-semibold text-neutral-200">Upload source files</p>
                  <p className="text-xs text-neutral-400">Add map image files used for graph placement.</p>
                  <button
                    type="button"
                    onClick={() => overviewInputRef.current?.click()}
                    disabled={inputsLocked}
                    title={inputsLocked ? inputsLockReason : "Choose files"}
                    className="inline-flex w-full items-center justify-center gap-2 rounded-lg border border-neutral-600 bg-neutral-800 px-4 py-3 text-sm font-semibold text-neutral-100 transition hover:border-sky-500 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    + Choose files
                  </button>
                  <input
                    ref={overviewInputRef}
                    type="file"
                    multiple
                    accept="image/*"
                    className="hidden"
                    disabled={inputsLocked}
                    onChange={(event) => {
                      onPickOverviewFiles(event.target.files);
                      event.currentTarget.value = "";
                    }}
                  />
                  <div className="space-y-2">
                    <p className="text-xs text-neutral-500">
                      {overviewDisplayNames.length > 0 ? `${String(overviewDisplayNames.length)} file(s)` : "No files selected yet"}
                    </p>
                    {overviewFiles.length === 0 &&
                    overviewStoredFileNames.length > 0 &&
                    !inputsRehydrated ? (
                      <p className="text-xs text-amber-300">
                        Previous file names restored. Re-upload files to run extraction again.
                      </p>
                    ) : null}
                    {overviewDisplayNames.length > 0 ? (
                      <ul className="max-h-28 space-y-1 overflow-auto rounded-md border border-neutral-700 bg-neutral-900/70 p-2 text-xs text-neutral-300">
                        {overviewDisplayNames.map((name) => (
                          <li key={`overview-${name}`} className="flex items-center justify-between gap-2">
                            <span className="truncate">{name}</span>
                            <button
                              type="button"
                              onClick={() => handleRemoveOverviewFile(name)}
                              disabled={inputsLocked}
                              aria-label={`Remove ${name}`}
                              title={inputsLocked ? inputsLockReason : "Remove file"}
                              className="inline-flex h-6 w-6 items-center justify-center rounded border border-red-800 bg-red-500/10 text-red-200 transition hover:bg-red-500/20 disabled:cursor-not-allowed disabled:opacity-50"
                            >
                              <TrashIcon className="h-3.5 w-3.5" />
                            </button>
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </div>

                  <p className="text-sm font-semibold text-neutral-200">Additional information</p>
                  <label htmlFor="map-additional-info" className="text-xs text-neutral-400">
                    Text document
                  </label>
                  <textarea
                    id="map-additional-info"
                    value={overviewAdditionalInfo}
                    onChange={(event) => setOverviewAdditionalInfo(event.target.value)}
                    placeholder="input text here"
                    disabled={inputsLocked}
                    className="min-h-24 w-full rounded-md border border-neutral-700 bg-neutral-800 p-3 text-sm text-neutral-100 outline-none transition focus:border-sky-500 disabled:cursor-not-allowed disabled:opacity-60"
                  />
                </div>
              ) : null}
            </article>

            <article className="rounded-xl border border-neutral-800 bg-neutral-900/60 p-4">
              <button
                type="button"
                onClick={() => setIsBinCollapsed((prev) => !prev)}
                className="flex w-full items-center justify-between gap-2 text-left"
              >
                <span className="text-lg font-bold text-neutral-100">Bin location images / any files</span>
                <div className="flex items-center gap-2">
                  <span
                    className={`inline-flex h-6 min-w-6 items-center justify-center rounded-full px-2 text-xs font-bold ${sectionHeaderClassName(
                      binDisplayNames.length > 0,
                    )}`}
                  >
                    {String(binDisplayNames.length)}
                  </span>
                  <CaretIcon direction={isBinCollapsed ? "down" : "up"} className="h-4 w-4 text-neutral-300" />
                </div>
              </button>

              {!isBinCollapsed ? (
                <div className="mt-4 space-y-3 rounded-lg border border-dashed border-neutral-700 p-3">
                  <p className="text-sm font-semibold text-neutral-200">Upload source files</p>
                  <p className="text-xs text-neutral-400">Add bin location images or any supporting files.</p>
                  <button
                    type="button"
                    onClick={() => binInputRef.current?.click()}
                    disabled={inputsLocked}
                    title={inputsLocked ? inputsLockReason : "Choose files"}
                    className="inline-flex w-full items-center justify-center gap-2 rounded-lg border border-neutral-600 bg-neutral-800 px-4 py-3 text-sm font-semibold text-neutral-100 transition hover:border-sky-500 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    + Choose files
                  </button>
                  <input
                    ref={binInputRef}
                    type="file"
                    multiple
                    className="hidden"
                    disabled={inputsLocked}
                    onChange={(event) => {
                      onPickBinFiles(event.target.files);
                      event.currentTarget.value = "";
                    }}
                  />

                  <div className="space-y-2">
                    <p className="text-xs text-neutral-500">
                      {binDisplayNames.length > 0 ? `${String(binDisplayNames.length)} file(s)` : "No files selected yet"}
                    </p>
                    {binFiles.length === 0 &&
                    binStoredFileNames.length > 0 &&
                    !inputsRehydrated ? (
                      <p className="text-xs text-amber-300">
                        Previous file names restored. Re-upload files to run extraction again.
                      </p>
                    ) : null}
                    {binDisplayNames.length > 0 ? (
                      <ul className="max-h-28 space-y-1 overflow-auto rounded-md border border-neutral-700 bg-neutral-900/70 p-2 text-xs text-neutral-300">
                        {binDisplayNames.map((name) => (
                          <li key={`bin-${name}`} className="flex items-center justify-between gap-2">
                            <span className="truncate">{name}</span>
                            <button
                              type="button"
                              onClick={() => handleRemoveBinFile(name)}
                              disabled={inputsLocked}
                              aria-label={`Remove ${name}`}
                              title={inputsLocked ? inputsLockReason : "Remove file"}
                              className="inline-flex h-6 w-6 items-center justify-center rounded border border-red-800 bg-red-500/10 text-red-200 transition hover:bg-red-500/20 disabled:cursor-not-allowed disabled:opacity-50"
                            >
                              <TrashIcon className="h-3.5 w-3.5" />
                            </button>
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </div>

                  <p className="text-sm font-semibold text-neutral-200">Additional information</p>
                  <label htmlFor="map-additional-info-bin" className="text-xs text-neutral-400">
                    Text document
                  </label>
                  <textarea
                    id="map-additional-info-bin"
                    value={binAdditionalInfo}
                    onChange={(event) => setBinAdditionalInfo(event.target.value)}
                    placeholder="input text here"
                    disabled={inputsLocked}
                    className="min-h-24 w-full rounded-md border border-neutral-700 bg-neutral-800 p-3 text-sm text-neutral-100 outline-none transition focus:border-sky-500 disabled:cursor-not-allowed disabled:opacity-60"
                  />
                </div>
              ) : null}
            </article>

            <div className="mt-auto space-y-3 border-t border-neutral-800 pt-3">
              <p className="text-[10px] font-semibold uppercase tracking-widest text-neutral-500">
                Session details
              </p>
            <article className="rounded-xl border border-neutral-800 bg-neutral-900/60 p-4">
              <button
                type="button"
                onClick={() => setIsSymbolCollapsed((prev) => !prev)}
                className="flex w-full items-center justify-between text-left"
              >
                <span className="text-lg font-bold text-neutral-100">Selection details</span>
                <CaretIcon direction={isSymbolCollapsed ? "down" : "up"} className="h-4 w-4 text-neutral-300" />
              </button>

              {!isSymbolCollapsed ? (
                <div className="mt-4">
                  <SelectionDetails selection={selection} />
                </div>
              ) : null}
            </article>

            <article className="rounded-xl border border-neutral-800 bg-neutral-900/60 p-4">
              <p className="text-lg font-bold text-neutral-100">Change details</p>
              {changeLog.length === 0 ? (
                <p className="mt-2 text-sm text-neutral-400">No edits yet.</p>
              ) : (
                <ul className="mt-3 max-h-40 space-y-2 overflow-auto rounded-md border border-neutral-700 bg-neutral-900/70 p-2 text-xs text-neutral-300">
                  {changeLog.map((line, index) => (
                    <li key={`change-${String(index)}-${line}`}>{line}</li>
                  ))}
                </ul>
              )}
            </article>
            </div>
            </>
            )}
          </aside>

          <section className="min-w-0 space-y-4">
            <div className="rounded-xl border border-neutral-800 bg-neutral-900/60 p-4">
              <div className="mb-3 flex items-center justify-end">
                <div className="inline-flex rounded-full border border-neutral-700 bg-neutral-800 p-1 text-sm">
                  <button
                    type="button"
                    onClick={() => setViewMode("graph")}
                    className={`rounded-full px-6 py-1 font-semibold transition ${
                      viewMode === "graph" ? "bg-sky-600 text-neutral-100" : "text-neutral-300"
                    }`}
                  >
                    Graph
                  </button>
                  <button
                    type="button"
                    onClick={() => setViewMode("code")}
                    className={`rounded-full px-6 py-1 font-semibold transition ${
                      viewMode === "code" ? "bg-sky-600 text-neutral-100" : "text-neutral-300"
                    }`}
                  >
                    Code
                  </button>
                </div>
              </div>

              {!graphData ? (
                <div className="flex h-135 items-center justify-center rounded-xl border border-neutral-800 bg-neutral-900/60">
                  <button
                    type="button"
                    onClick={() => void handleExtract()}
                    disabled={isJobActive || hasStageHistory}
                    title={
                      hasStageHistory && !isJobActive
                        ? "A previous extraction is still in state. Resume it from the stage log or click Reset to start over."
                        : undefined
                    }
                    className="rounded-lg border border-neutral-700 bg-neutral-800 px-8 py-3 text-base font-semibold text-neutral-100 transition hover:border-sky-500 disabled:cursor-not-allowed disabled:opacity-70"
                  >
                    {isExtracting ? "Extracting..." : isResuming ? "Resuming..." : "Extract"}
                  </button>
                </div>
              ) : viewMode === "graph" ? (
                <div className="space-y-3">
                  <GraphCanvas
                    graph={graphData}
                    selected={selection}
                    onSelect={setSelection}
                    mapImageSrc={mainMapPreview}
                  />
                  {symbolLegend.length > 0 ? (
                    <div className="rounded-xl border border-neutral-700 bg-neutral-900/70 p-3">
                      <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-neutral-300">
                        Symbol Legend
                      </p>
                      <div className="max-h-40 space-y-2 overflow-auto pr-1">
                        {symbolLegend.map((entry) => (
                          <div
                            key={`legend-${entry.symbol}`}
                            className="grid grid-cols-[1fr_1fr_2fr] gap-2 rounded border border-neutral-700 bg-neutral-950/70 px-2 py-1 text-xs text-neutral-300"
                            title={entry.description || entry.notation || entry.symbol}
                          >
                            <span className="font-semibold text-neutral-100">{entry.symbol}</span>
                            <span className="text-neutral-400">{entry.notation || "-"}</span>
                            <span className="truncate">{entry.description || "-"}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : null}
                  <div className="rounded-xl border border-neutral-700 bg-neutral-900/70 p-3">
                    <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-neutral-300">
                      Node Metadata (fallback view)
                    </p>
                    <div className="max-h-56 space-y-2 overflow-auto pr-1">
                      {graphData.vertices.map((vertex) => (
                        <div key={`meta-${vertex.id}`} className="rounded-md border border-neutral-700 bg-neutral-950/70 p-2">
                          <div className="mb-1 flex items-center justify-between gap-2">
                            <span className="text-xs font-semibold text-neutral-100">{vertex.id} ({vertex.label})</span>
                            <span className="text-[11px] text-neutral-400">{vertex.type || "node"}</span>
                          </div>
                          <pre className="overflow-auto whitespace-pre-wrap rounded bg-neutral-900 p-2 text-[11px] text-neutral-300">
                            {JSON.stringify(vertex.metadata || {}, null, 2)}
                          </pre>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              ) : (
                <CodeExplorer graph={graphData} onPick={setSelection} />
              )}

              <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0 flex-1 break-words text-xs text-neutral-400">{extractStatus}</div>
                <div className="ml-auto flex items-end gap-3">
                  <div className="text-right text-[11px] text-neutral-400">
                    <div>
                      tokens: in {usageStats.promptTokens.toLocaleString()} / out {usageStats.outputTokens.toLocaleString()} / total {usageStats.totalTokens.toLocaleString()}
                    </div>
                    <div>
                      model calls: {usageStats.callCount.toLocaleString()} | est. cost: {usageStats.estimatedCost == null ? "n/a" : `${usageStats.currency} ${usageStats.estimatedCost.toFixed(6)}`} ({usageStats.costSource})
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={handleUndo}
                    disabled={history.length === 0}
                    className="rounded-md border border-neutral-700 bg-neutral-800 px-3 py-1.5 text-xs text-neutral-200 transition hover:border-sky-500 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    undo last edit
                  </button>
                </div>
              </div>
            </div>

            <div className="rounded-xl border border-neutral-800 bg-neutral-900/60 p-4">
              <div className="rounded-xl border border-neutral-700 bg-neutral-900 p-2">
                <div className="flex items-center gap-2">
                  <input
                    value={chatPrompt}
                    onChange={(event) => setChatPrompt(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && !event.shiftKey) {
                        event.preventDefault();
                        void handleApplyEdit();
                      }
                    }}
                    placeholder="What would you like to edit more?"
                    className="flex-1 rounded-md border border-neutral-700 bg-neutral-800 px-3 py-2 text-sm text-neutral-100 outline-none transition focus:border-sky-500"
                  />
                  <button
                    type="button"
                    onClick={() => void handleApplyEdit()}
                    disabled={isApplyingEdit || !graphData}
                    className="rounded-md border border-neutral-700 bg-neutral-800 px-4 py-2 text-xs font-semibold text-neutral-200 transition hover:border-sky-500 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {isApplyingEdit ? "Applying" : "Send"}
                  </button>
                </div>
              </div>
              <p className="mt-2 break-words text-xs text-neutral-400">{editStatus}</p>
            </div>
          </section>

          <aside className="flex min-w-0 flex-col gap-3">
            {!isRightPanelCollapsed ? (
              <article className="rounded-xl border border-neutral-800 bg-neutral-900/60 p-4">
                <button
                  type="button"
                  onClick={() => setIsSymbolCollapsed((prev) => !prev)}
                  className="flex w-full items-center justify-between text-left"
                >
                  <span className="text-base font-bold text-neutral-100">Selection details</span>
                  <span className="text-neutral-300">{isSymbolCollapsed ? "▼" : "▲"}</span>
                </button>
                {!isSymbolCollapsed ? (
                  <div className="mt-3 max-h-[40vh] overflow-auto">
                    <SelectionDetails selection={selection} />
                  </div>
                ) : null}
              </article>
            ) : null}
            {isRightPanelCollapsed ? (
              <div className="flex flex-col items-center gap-2 rounded-xl border border-neutral-800 bg-neutral-900/60 p-2">
                <button
                  type="button"
                  onClick={() => {
                    setRightPanelUserToggled(true);
                    setIsRightPanelCollapsed(false);
                  }}
                  title="Expand stage log"
                  aria-label="Expand stage log"
                  className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-neutral-700 bg-neutral-900 text-neutral-200 transition hover:border-sky-500"
                >
                  ⟨
                </button>
                <span className="[writing-mode:vertical-rl] rotate-180 text-[10px] uppercase tracking-widest text-neutral-500">
                  stage log
                </span>
                {isExtracting ? (
                  <span className="inline-flex h-2 w-2 animate-pulse rounded-full bg-sky-500" />
                ) : null}
              </div>
            ) : (
              <StageLogPanel
                jobId={jobId}
                jobStatus={jobStatus}
                currentStage={currentStage}
                stageMessage={stageMessage}
                completedStages={completedStages}
                canResume={canResume}
                remainingStages={remainingStages ?? undefined}
                nextStage={nextStage}
                resumeDisabledReason={resumeDisabledReason || undefined}
                cancelRequested={cancelRequested}
                latestProgress={latestProgress}
                isActive={isJobActive}
                onResumeRequested={() => void handleResume()}
                onExtractRequested={() => void handleExtract()}
                extractDisabled={isJobActive || overviewFiles.length === 0}
                extractDisabledReason={
                  overviewFiles.length === 0
                    ? "Upload at least one overview map image first."
                    : "Extraction is already running."
                }
                onStatusUpdate={(message) => setExtractStatus(message)}
              />
            )}
          </aside>
        </section>
      </main>
    </div>
  );
}
