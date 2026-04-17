"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import BackToHome from "@/app/components/back-to-home";
import { editMapGraph, extractMapGraph } from "@/lib/map-api-client";
import type {
  GraphSelection,
  MapEdge,
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
  selectedModel: string;
  overviewAdditionalInfo: string;
  binAdditionalInfo: string;
  overviewFileNames: string[];
  binFileNames: string[];
  changeLog: string[];
  editStatus: string;
  selection: SelectionRef;
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

const MAP_MODEL_FALLBACK_OPTIONS = [
  "gemini-2.5-flash",
  "gemini-2.5-flash-lite",
  "gemini-2.5-pro",
  "gemini-3-flash-preview",
  "gemini-3.1-flash-lite-preview",
  "gemini-3.1-pro-preview",
];

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

function SaveIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M5 3h12l4 4v14H3V3h2z" />
      <path d="M7 3v6h10V3" />
      <path d="M8 21v-7h8v7" />
    </svg>
  );
}

function ExportIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M12 3v12" />
      <path d="M8 11l4 4 4-4" />
      <path d="M4 21h16" />
    </svg>
  );
}

function ImportIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M12 21V9" />
      <path d="M8 13l4-4 4 4" />
      <path d="M4 3h16" />
    </svg>
  );
}

function TrashIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M3 6h18" />
      <path d="M8 6V4h8v2" />
      <path d="M19 6l-1 14H6L5 6" />
      <path d="M10 11v6" />
      <path d="M14 11v6" />
    </svg>
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

  const metadataSummary = (vertex: MapVertex): string => {
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
                fill={vertex.type === "Bin" ? "#f97316" : "#0ea5e9"}
                stroke={isSelected ? "#fde68a" : "#e5e7eb"}
                strokeWidth={isSelected ? 4 : 2}
                className="pointer-events-auto cursor-pointer"
                onClick={() => onSelect({ kind: "vertex", data: vertex })}
              />
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
            <span>{verticesOpen ? "-" : "+"}</span>
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
            <span>{edgesOpen ? "-" : "+"}</span>
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
            <span>{metadataOpen ? "-" : "+"}</span>
          </button>
          {metadataOpen ? (
            <div className="border-t border-neutral-700 p-2">
              <pre className="overflow-auto whitespace-pre-wrap wrap-break-word rounded bg-neutral-900 p-2 text-xs text-neutral-300">
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

  const [overviewFiles, setOverviewFiles] = useState<LocalUploadFile[]>([]);
  const [binFiles, setBinFiles] = useState<LocalUploadFile[]>([]);
  const [overviewStoredFileNames, setOverviewStoredFileNames] = useState<string[]>([]);
  const [binStoredFileNames, setBinStoredFileNames] = useState<string[]>([]);
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
  const [extractStatus, setExtractStatus] = useState("");

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

  const modelOptions = useMemo(() => {
    const envOptions = (process.env.NEXT_PUBLIC_MAP_EXTRACT_MODEL_OPTIONS || "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);

    return dedupeNames([...envOptions, ...MAP_MODEL_FALLBACK_OPTIONS]);
  }, []);

  const usageStats = useMemo(() => {
    const meta = graphData?.metadata;
    const tokenUsage = meta?.tokenUsage;
    const costEstimate = meta?.costEstimate;
    return {
      promptTokens: Number(tokenUsage?.promptTokens || 0),
      outputTokens: Number(tokenUsage?.outputTokens || 0),
      totalTokens: Number(tokenUsage?.totalTokens || 0),
      callCount: Number(tokenUsage?.callCount || 0),
      estimatedCost:
        typeof costEstimate?.estimatedCost === "number" ? costEstimate.estimatedCost : null,
      currency: String(costEstimate?.currency || "USD"),
      costSource: String(costEstimate?.source || "unknown"),
    };
  }, [graphData]);

  useEffect(() => {
    const saved = window.localStorage.getItem(snapshotKey);

    if (!saved) {
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

      if (parsed?.graph) {
        setExtractStatus("Loaded previous map extraction details.");
      }
    } catch {
      // Ignore corrupted local snapshot.
    }
  }, [snapshotKey]);

  useEffect(() => {
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

    window.localStorage.setItem(snapshotKey, JSON.stringify(snapshot));
  }, [
    overviewAdditionalInfo,
    binAdditionalInfo,
    binDisplayNames,
    changeLog,
    editStatus,
    graphData,
    jobId,
    selectedModel,
    overviewDisplayNames,
    selection,
    snapshotKey,
  ]);

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

      setExtractStatus("Map extraction completed.");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Map extraction failed.";
      setExtractStatus(message);
    } finally {
      setIsExtracting(false);
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
      <main className="mx-auto w-full max-w-7xl px-5 py-8 md:px-8 md:py-10 lg:px-12">
        <header className="mb-6 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={handleSaveLocally}
              aria-label="Save map workspace"
              title="Save"
              className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-neutral-700 bg-neutral-900 text-neutral-100 transition hover:border-sky-500"
            >
              <SaveIcon className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={handleExportArtifacts}
              aria-label="Export map artifacts"
              title="Export artifacts (.json)"
              className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-neutral-700 bg-neutral-900 text-neutral-100 transition hover:border-sky-500"
            >
              <ExportIcon className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={() => artifactImportInputRef.current?.click()}
              aria-label="Import map artifacts"
              title="Import artifacts (.json)"
              className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-neutral-700 bg-neutral-900 text-neutral-100 transition hover:border-sky-500"
            >
              <ImportIcon className="h-4 w-4" />
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
            <BackToHome
              href={backHref}
              label="Back to project"
              useHistoryBack
              containerClassName=""
              className="rounded-md px-3 py-2"
            />
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <div className="rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-xs text-neutral-300">
              <div className="mb-1 text-[10px] uppercase tracking-wide text-neutral-400">model</div>
              <input
                list="map-extract-model-options"
                value={selectedModel}
                onChange={(event) => setSelectedModel(event.target.value)}
                placeholder="default from .env"
                className="w-52 rounded border border-neutral-700 bg-neutral-800 px-2 py-1 text-xs text-neutral-100 outline-none transition focus:border-sky-500"
              />
              <datalist id="map-extract-model-options">
                {modelOptions.map((modelName) => (
                  <option key={modelName} value={modelName} />
                ))}
              </datalist>
            </div>
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
          </div>
        </header>

        <section className="grid gap-6 lg:grid-cols-[320px_1fr]">
          <aside className="space-y-4">
            <article className="rounded-xl border border-neutral-800 bg-neutral-900/60 p-4">
              <button
                type="button"
                onClick={() => setIsOverviewCollapsed((prev) => !prev)}
                className="flex w-full items-center justify-between gap-2 text-left"
              >
                <span className="text-lg font-bold text-neutral-100">overview map images</span>
                <div className="flex items-center gap-2">
                  <span
                    className={`inline-flex h-6 min-w-6 items-center justify-center rounded-full px-2 text-xs font-bold ${sectionHeaderClassName(
                      overviewDisplayNames.length > 0,
                    )}`}
                  >
                    {String(overviewDisplayNames.length)}
                  </span>
                  <span className="text-neutral-300">{isOverviewCollapsed ? "v" : "^"}</span>
                </div>
              </button>

              {!isOverviewCollapsed ? (
                <div className="mt-4 space-y-3 rounded-lg border border-dashed border-neutral-700 p-3">
                  <p className="text-sm font-semibold text-neutral-200">Upload source files</p>
                  <p className="text-xs text-neutral-400">Add map image files used for graph placement.</p>
                  <button
                    type="button"
                    onClick={() => overviewInputRef.current?.click()}
                    className="inline-flex w-full items-center justify-center gap-2 rounded-lg border border-neutral-600 bg-neutral-800 px-4 py-3 text-sm font-semibold text-neutral-100 transition hover:border-sky-500"
                  >
                    + Choose files
                  </button>
                  <input
                    ref={overviewInputRef}
                    type="file"
                    multiple
                    accept="image/*"
                    className="hidden"
                    onChange={(event) => {
                      onPickOverviewFiles(event.target.files);
                      event.currentTarget.value = "";
                    }}
                  />
                  <div className="space-y-2">
                    <p className="text-xs text-neutral-500">
                      {overviewDisplayNames.length > 0 ? `${String(overviewDisplayNames.length)} file(s)` : "No files selected yet"}
                    </p>
                    {overviewFiles.length === 0 && overviewStoredFileNames.length > 0 ? (
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
                              aria-label={`Remove ${name}`}
                              title="Remove file"
                              className="inline-flex h-6 w-6 items-center justify-center rounded border border-red-800 bg-red-500/10 text-red-200 transition hover:bg-red-500/20"
                            >
                              <TrashIcon className="h-3.5 w-3.5" />
                            </button>
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </div>

                  <p className="text-sm font-semibold text-neutral-200">additional information</p>
                  <label htmlFor="map-additional-info" className="text-xs text-neutral-400">
                    Text document
                  </label>
                  <textarea
                    id="map-additional-info"
                    value={overviewAdditionalInfo}
                    onChange={(event) => setOverviewAdditionalInfo(event.target.value)}
                    placeholder="input text here"
                    className="min-h-24 w-full rounded-md border border-neutral-700 bg-neutral-800 p-3 text-sm text-neutral-100 outline-none transition focus:border-sky-500"
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
                <span className="text-lg font-bold text-neutral-100">bin location images / any files</span>
                <div className="flex items-center gap-2">
                  <span
                    className={`inline-flex h-6 min-w-6 items-center justify-center rounded-full px-2 text-xs font-bold ${sectionHeaderClassName(
                      binDisplayNames.length > 0,
                    )}`}
                  >
                    {String(binDisplayNames.length)}
                  </span>
                  <span className="text-neutral-300">{isBinCollapsed ? "v" : "^"}</span>
                </div>
              </button>

              {!isBinCollapsed ? (
                <div className="mt-4 space-y-3 rounded-lg border border-dashed border-neutral-700 p-3">
                  <p className="text-sm font-semibold text-neutral-200">Upload source files</p>
                  <p className="text-xs text-neutral-400">Add bin location images or any supporting files.</p>
                  <button
                    type="button"
                    onClick={() => binInputRef.current?.click()}
                    className="inline-flex w-full items-center justify-center gap-2 rounded-lg border border-neutral-600 bg-neutral-800 px-4 py-3 text-sm font-semibold text-neutral-100 transition hover:border-sky-500"
                  >
                    + Choose files
                  </button>
                  <input
                    ref={binInputRef}
                    type="file"
                    multiple
                    className="hidden"
                    onChange={(event) => {
                      onPickBinFiles(event.target.files);
                      event.currentTarget.value = "";
                    }}
                  />

                  <div className="space-y-2">
                    <p className="text-xs text-neutral-500">
                      {binDisplayNames.length > 0 ? `${String(binDisplayNames.length)} file(s)` : "No files selected yet"}
                    </p>
                    {binFiles.length === 0 && binStoredFileNames.length > 0 ? (
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
                              aria-label={`Remove ${name}`}
                              title="Remove file"
                              className="inline-flex h-6 w-6 items-center justify-center rounded border border-red-800 bg-red-500/10 text-red-200 transition hover:bg-red-500/20"
                            >
                              <TrashIcon className="h-3.5 w-3.5" />
                            </button>
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </div>

                  <p className="text-sm font-semibold text-neutral-200">additional information</p>
                  <label htmlFor="map-additional-info-bin" className="text-xs text-neutral-400">
                    Text document
                  </label>
                  <textarea
                    id="map-additional-info-bin"
                    value={binAdditionalInfo}
                    onChange={(event) => setBinAdditionalInfo(event.target.value)}
                    placeholder="input text here"
                    className="min-h-24 w-full rounded-md border border-neutral-700 bg-neutral-800 p-3 text-sm text-neutral-100 outline-none transition focus:border-sky-500"
                  />
                </div>
              ) : null}
            </article>

            <article className="rounded-xl border border-neutral-800 bg-neutral-900/60 p-4">
              <button
                type="button"
                onClick={() => setIsSymbolCollapsed((prev) => !prev)}
                className="flex w-full items-center justify-between text-left"
              >
                <span className="text-lg font-bold text-neutral-100">selection details</span>
                <span className="text-neutral-300">{isSymbolCollapsed ? "v" : "^"}</span>
              </button>

              {!isSymbolCollapsed ? (
                <div className="mt-4">
                  <SelectionDetails selection={selection} />
                </div>
              ) : null}
            </article>

            <article className="rounded-xl border border-neutral-800 bg-neutral-900/60 p-4">
              <p className="text-lg font-bold text-neutral-100">change details</p>
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
                    disabled={isExtracting}
                    className="rounded-lg border border-neutral-700 bg-neutral-800 px-8 py-3 text-base font-semibold text-neutral-100 transition hover:border-sky-500 disabled:cursor-not-allowed disabled:opacity-70"
                  >
                    {isExtracting ? "Extracting..." : "Extract"}
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
                <div className="text-xs text-neutral-400">{extractStatus}</div>
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
              <p className="mt-2 text-xs text-neutral-400">{editStatus}</p>
            </div>
          </section>
        </section>
      </main>
    </div>
  );
}
