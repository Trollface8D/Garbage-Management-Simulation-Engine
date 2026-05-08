"use client";

import dynamic from "next/dynamic";
import { type ComponentType, memo, useEffect, useMemo, useRef } from "react";
import ModelPicker from "@/app/components/model-picker";

type WordCloudWord = {
    text: string;
    value: number;
};

type WordCloudProps = {
    words: WordCloudWord[];
    options?: Record<string, unknown>;
    minSize?: [number, number];
    size?: [number, number];
};

const ReactWordcloud = dynamic(
    () => import("react-wordcloud").then((mod) => (mod && (mod.default ?? mod))),
    { ssr: false },
) as unknown as ComponentType<WordCloudProps>;

export type GeneratedEntity = {
    id: string;
    name: string;
    count: number;
    selected: boolean;
    parentId?: string;
    memberIds?: string[];
};

type EntityExtractionPanelProps = {
    entities: GeneratedEntity[];
    isExtracted: boolean;
    isExtracting: boolean;
    isGroupingEntities: boolean;
    extractError: string;
    groupError: string;
    groupLog: Array<{ id: number; ts: number; level: "info" | "warn" | "error"; message: string }>;
    inputsLocked: boolean;
    selectedCausalIds: ReadonlySet<string>;
    selectedModel: string;
    manualEntityName: string;
    manualEntityError: string;
    collapsedParentIds: ReadonlySet<string>;

    onExtract: () => void;
    onGroupWithGemini: () => void;
    onCancelGrouping: () => void;
    onToggleEntity: (id: string) => void;
    onAddManualEntity: () => void;
    onUpdateManualEntityName: (name: string) => void;
    onClearGroupLog: () => void;
    onToggleCollapse: (parentId: string) => void;
    onModelChange: (model: string) => void;
};

const EntityExtractionPanel = memo(function EntityExtractionPanel({
    entities,
    isExtracted,
    isExtracting,
    isGroupingEntities,
    extractError,
    groupError,
    groupLog,
    inputsLocked,
    selectedCausalIds,
    selectedModel,
    manualEntityName,
    manualEntityError,
    collapsedParentIds,
    onExtract,
    onGroupWithGemini,
    onCancelGrouping,
    onToggleEntity,
    onAddManualEntity,
    onUpdateManualEntityName,
    onClearGroupLog,
    onToggleCollapse,
    onModelChange,
}: EntityExtractionPanelProps) {
    const wordCloudHostRef = useRef<HTMLDivElement | null>(null);

    const selectedEntities = useMemo(
        () => entities.filter((entity) => entity.selected),
        [entities],
    );

    const wordCloudWords = useMemo(
        () =>
            selectedEntities.map((entity) => ({
                text: entity.name,
                value: entity.count,
            })),
        [selectedEntities],
    );

    const wordCloudOptions = useMemo(
        () => ({
            colors: ["#34d399", "#60a5fa", "#f59e0b", "#22d3ee", "#f472b6"],
            enableTooltip: false,
            fontFamily: "Georgia, serif",
            fontSizes: [18, 48] as [number, number],
            padding: 2,
            rotations: 1,
            rotationAngles: [0, 0] as [number, number],
            scale: "sqrt" as const,
            spiral: "archimedean" as const,
            transitionDuration: 500,
        }),
        [],
    );

    const totalEntityCount = useMemo(() => selectedEntities.length, [selectedEntities]);

    useEffect(() => {
        if (!isExtracted || wordCloudWords.length === 0) {
            return;
        }

        const recenterWordCloud = () => {
            const host = wordCloudHostRef.current;
            if (!host) return;

            const svgs = host.querySelectorAll("svg");
            if (svgs.length === 0) return;

            const svg = svgs[0];
            const box = svg.getBBox?.();
            if (!box) return;

            const viewBox = `${box.x} ${box.y} ${box.width} ${box.height}`;
            svg.setAttribute("viewBox", viewBox);
            svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
        };

        const frameId = window.requestAnimationFrame(() => {
            recenterWordCloud();
        });

        const timeoutId = window.setTimeout(recenterWordCloud, 620);

        return () => {
            window.cancelAnimationFrame(frameId);
            window.clearTimeout(timeoutId);
        };
    }, [isExtracted, wordCloudWords]);

    return (
        <div>
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                <h2 className="text-xl font-bold text-neutral-100 md:text-2xl">
                    Entity that will be generated{" "}
                    <span className="text-red-400" aria-label="required">
                        *
                    </span>
                </h2>
                <div className="flex flex-wrap items-center gap-2">
                    <ModelPicker value={selectedModel} onChange={onModelChange} />
                    <button
                        type="button"
                        onClick={onGroupWithGemini}
                        disabled={
                            isGroupingEntities ||
                            inputsLocked ||
                            !isExtracted ||
                            entities.length === 0
                        }
                        title="Semantic grouping with Gemini — merges related names and sums counts"
                        aria-label="Group entities with Gemini"
                        className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-purple-600/70 bg-purple-500/10 text-purple-200 transition hover:bg-purple-500/20 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                        {isGroupingEntities ? (
                            <svg
                                className="h-4 w-4 animate-spin"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="2"
                            >
                                <path d="M21 12a9 9 0 1 1-6.2-8.55" strokeLinecap="round" />
                            </svg>
                        ) : (
                            <svg
                                className="h-4 w-4"
                                viewBox="0 0 24 24"
                                fill="currentColor"
                                aria-hidden="true"
                            >
                                <path d="M12 2 L13.8 8.2 L20 10 L13.8 11.8 L12 18 L10.2 11.8 L4 10 L10.2 8.2 Z" />
                                <path d="M19 16 L19.7 18.3 L22 19 L19.7 19.7 L19 22 L18.3 19.7 L16 19 L18.3 18.3 Z" />
                            </svg>
                        )}
                    </button>
                    {isGroupingEntities ? (
                        <button
                            type="button"
                            onClick={onCancelGrouping}
                            title="Cancel the in-flight grouping request"
                            className="rounded-md border border-red-700 bg-red-500/10 px-3 py-2 text-xs font-semibold text-red-300 transition hover:bg-red-500/20"
                        >
                            Cancel grouping
                        </button>
                    ) : null}
                    <button
                        type="button"
                        onClick={onExtract}
                        disabled={isExtracting || inputsLocked}
                        className="rounded-md border border-sky-600 bg-sky-500/10 px-4 py-2 text-sm font-semibold text-sky-200 transition hover:bg-sky-500/20 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                        {isExtracting
                            ? "Extracting..."
                            : isExtracted
                              ? "Re-extract from causal"
                              : "Extract from causal"}
                    </button>
                </div>
            </div>

            {extractError ? (
                <div className="mb-3 whitespace-pre-line rounded-md border border-red-800/70 bg-red-500/10 px-3 py-2 text-xs text-red-200">
                    {extractError}
                </div>
            ) : null}
            {groupError ? (
                <div className="mb-3 rounded-md border border-red-800/70 bg-red-500/10 px-3 py-2 text-xs text-red-200">
                    {groupError}
                </div>
            ) : null}
            {groupLog.length > 0 ? (
                <div className="mb-3 rounded-md border border-neutral-800 bg-neutral-950/60 p-3">
                    <div className="mb-2 flex items-center justify-between gap-2">
                        <p className="text-xs font-semibold uppercase tracking-wider text-neutral-300">
                            Grouping log
                        </p>
                        <button
                            type="button"
                            onClick={onClearGroupLog}
                            className="text-[10px] uppercase tracking-wider text-neutral-500 transition hover:text-neutral-200"
                        >
                            Clear
                        </button>
                    </div>
                    <ul className="max-h-32 overflow-y-auto font-mono text-xs">
                        {groupLog.map((entry) => {
                            const time = new Date(entry.ts).toLocaleTimeString();
                            const tone =
                                entry.level === "error"
                                    ? "text-red-300"
                                    : entry.level === "warn"
                                      ? "text-amber-300"
                                      : "text-neutral-300";
                            return (
                                <li key={entry.id} className={`py-0.5 ${tone}`}>
                                    <span className="mr-2 text-neutral-500">
                                        [{time}]
                                    </span>
                                    {entry.message}
                                </li>
                            );
                        })}
                    </ul>
                </div>
            ) : null}

            <div className="rounded-xl border border-neutral-700 bg-neutral-900/60 p-4 md:p-6">
                {!isExtracted ? (
                    <div className="relative min-h-90 rounded-lg border border-dashed border-neutral-700 bg-neutral-900/60 p-6">
                        <div className="flex h-full min-h-75 flex-col items-center justify-center gap-3 text-center">
                            <p className="max-w-md text-sm text-neutral-400">
                                {selectedCausalIds.size === 0
                                    ? "Click one or more causal cards above to select them, then run extraction."
                                    : `Selected ${String(selectedCausalIds.size)} causal source(s). Click "Extract from causal" to aggregate entities.`}
                            </p>
                        </div>
                    </div>
                ) : (
                    <div className="grid min-h-180 gap-4 lg:grid-cols-2">
                        <div className="flex min-h-150 items-stretch justify-center rounded-lg border border-neutral-700 bg-linear-to-br from-neutral-900 to-neutral-800 p-4">
                            <div className="flex w-full flex-col rounded-lg border border-neutral-700 bg-neutral-950/70 p-3">
                                {wordCloudWords.length > 0 ? (
                                    <div
                                        aria-label="Generated entity word cloud"
                                        className="flex w-full flex-1 items-center justify-center"
                                    >
                                        <div ref={wordCloudHostRef} className="h-full w-full">
                                            <ReactWordcloud
                                                minSize={[200, 200]}
                                                options={wordCloudOptions}
                                                words={wordCloudWords}
                                            />
                                        </div>
                                    </div>
                                ) : (
                                    <div className="flex flex-1 items-center justify-center text-center">
                                        <p className="text-sm font-semibold text-neutral-300">
                                            Select at least one entity to render the word cloud.
                                        </p>
                                    </div>
                                )}
                            </div>
                        </div>

                        <div className="flex flex-col rounded-lg border border-neutral-700 bg-neutral-900/70 p-4">
                            <p className="text-sm font-semibold text-neutral-100">
                                system will create {String(totalEntityCount)} entity
                            </p>

                            <div className="mt-3 flex flex-wrap items-center gap-2">
                                <input
                                    type="text"
                                    value={manualEntityName}
                                    onChange={(event) => {
                                        onUpdateManualEntityName(event.target.value);
                                    }}
                                    onKeyDown={(event) => {
                                        if (event.key === "Enter") {
                                            event.preventDefault();
                                            onAddManualEntity();
                                        }
                                    }}
                                    placeholder="Add an entity the extractor missed…"
                                    disabled={inputsLocked}
                                    className="flex-1 min-w-0 rounded-md border border-neutral-700 bg-neutral-950 px-3 py-1.5 text-xs text-neutral-100 placeholder:text-neutral-500 focus:outline-none focus:ring-1 focus:ring-sky-600 disabled:cursor-not-allowed disabled:opacity-60"
                                />
                                <button
                                    type="button"
                                    onClick={onAddManualEntity}
                                    disabled={
                                        inputsLocked || manualEntityName.trim().length === 0
                                    }
                                    className="rounded-md border border-emerald-600 bg-emerald-500/10 px-3 py-1.5 text-xs font-semibold text-emerald-200 transition hover:bg-emerald-500/20 disabled:cursor-not-allowed disabled:opacity-60"
                                >
                                    Add entity
                                </button>
                            </div>
                            {manualEntityError ? (
                                <p className="mt-1 text-[11px] text-red-300">
                                    {manualEntityError}
                                </p>
                            ) : null}

                            <div className="mt-3 max-h-130 flex-1 overflow-y-auto rounded-md border border-neutral-800 bg-neutral-900/70">
                                {entities.map((entity) => {
                                    const isParent =
                                        !!entity.memberIds && entity.memberIds.length > 0;
                                    const isChild = !!entity.parentId;
                                    if (
                                        isChild &&
                                        entity.parentId &&
                                        collapsedParentIds.has(entity.parentId)
                                    ) {
                                        return null;
                                    }
                                    const isCollapsed =
                                        isParent && collapsedParentIds.has(entity.id);
                                    return (
                                        <div
                                            key={entity.id}
                                            className={`flex items-center justify-between gap-3 border-b border-neutral-800 px-3 py-2 last:border-b-0 ${isChild ? "pl-9 bg-neutral-950/30" : ""}`}
                                        >
                                            <div className="flex min-w-0 items-center gap-2">
                                                {isParent ? (
                                                    <button
                                                        type="button"
                                                        onClick={() =>
                                                            onToggleCollapse(entity.id)
                                                        }
                                                        aria-label={
                                                            isCollapsed
                                                                ? `Expand ${entity.name}`
                                                                : `Collapse ${entity.name}`
                                                        }
                                                        className="inline-flex h-5 w-5 items-center justify-center rounded text-purple-300 hover:bg-purple-500/10"
                                                    >
                                                        <svg
                                                            viewBox="0 0 12 12"
                                                            className={`h-3 w-3 transition-transform ${isCollapsed ? "" : "rotate-90"}`}
                                                            fill="currentColor"
                                                            aria-hidden="true"
                                                        >
                                                            <path d="M3 2 L9 6 L3 10 Z" />
                                                        </svg>
                                                    </button>
                                                ) : (
                                                    <span
                                                        className="inline-block h-5 w-5"
                                                        aria-hidden="true"
                                                    />
                                                )}
                                                <input
                                                    type="checkbox"
                                                    checked={entity.selected}
                                                    onChange={() => onToggleEntity(entity.id)}
                                                    disabled={inputsLocked}
                                                    className="h-4 w-4 accent-sky-500 disabled:cursor-not-allowed disabled:opacity-60"
                                                />
                                                <span
                                                    className={`truncate ${
                                                        isParent
                                                            ? "text-sm font-semibold text-purple-200"
                                                            : isChild
                                                              ? "text-xs text-neutral-400"
                                                              : "text-sm text-neutral-200"
                                                    }`}
                                                >
                                                    {entity.name}
                                                </span>
                                                {isParent ? (
                                                    <span className="rounded bg-purple-500/20 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-purple-200">
                                                        group · {String(entity.memberIds?.length ?? 0)}
                                                    </span>
                                                ) : null}
                                            </div>

                                            <span
                                                className={`text-xs font-semibold ${isChild ? "text-neutral-500" : "text-neutral-400"}`}
                                                title="Frequency in the source extraction"
                                            >
                                                freq: {String(entity.count)}
                                            </span>
                                        </div>
                                    );
                                })}
                            </div>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
});

export default EntityExtractionPanel;
