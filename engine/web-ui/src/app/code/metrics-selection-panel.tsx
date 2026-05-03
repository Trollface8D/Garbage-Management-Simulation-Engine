"use client";

import { type SuggestedMetric } from "@/lib/code-gen-api-client";
import ModelPicker from "@/app/components/model-picker";

export type WorkspaceMetric = SuggestedMetric & {
    id: string;
    selected: boolean;
};

type MetricsSelectionPanelProps = {
    metrics: WorkspaceMetric[];
    isExtracted: boolean;
    isSuggestingMetrics: boolean;
    metricsError: string;
    metricsLog: Array<{ id: number; ts: number; level: "info" | "warn" | "error"; message: string }>;
    inputsLocked: boolean;
    manualMetricName: string;
    manualMetricError: string;
    selectedEntityCount: number;
    selectedModel: string;
    onModelChange: (model: string) => void;

    onSuggestMetrics: () => void;
    onCancelMetricsSuggest: () => void;
    onToggleMetric: (id: string) => void;
    onAddManualMetric: () => void;
    onUpdateManualMetricName: (name: string) => void;
    onClearMetricsLog: () => void;
};

export default function MetricsSelectionPanel({
    metrics,
    isExtracted,
    isSuggestingMetrics,
    metricsError,
    metricsLog,
    inputsLocked,
    manualMetricName,
    manualMetricError,
    selectedEntityCount,
    selectedModel,
    onModelChange,
    onSuggestMetrics,
    onCancelMetricsSuggest,
    onToggleMetric,
    onAddManualMetric,
    onUpdateManualMetricName,
    onClearMetricsLog,
}: MetricsSelectionPanelProps) {
    const selectedMetrics = metrics.filter((m) => m.selected);

    if (!isExtracted) {
        return null;
    }

    return (
        <div className="mt-6">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                <div>
                    <h2 className="text-xl font-bold text-neutral-100 md:text-2xl">
                        Metric to be tracked{" "}
                        <span className="text-red-400" aria-label="required">
                            *
                        </span>
                    </h2>
                    <p className="mt-1 text-xs text-neutral-400">
                        Pick at least one metric before code generation can start; selections lock once a job runs.
                    </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                    <ModelPicker value={selectedModel} onChange={onModelChange} />
                    <button
                        type="button"
                        onClick={onSuggestMetrics}
                        disabled={
                            isSuggestingMetrics ||
                            inputsLocked ||
                            selectedEntityCount === 0
                        }
                        title="Ask Gemini to suggest metrics for the selected entities"
                        aria-label="Suggest metrics with Gemini"
                        className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-purple-600/70 bg-purple-500/10 text-purple-200 transition hover:bg-purple-500/20 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                        {isSuggestingMetrics ? (
                            <svg
                                className="h-4 w-4 animate-spin"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="2"
                            >
                                <path
                                    d="M21 12a9 9 0 1 1-6.2-8.55"
                                    strokeLinecap="round"
                                />
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
                    {isSuggestingMetrics ? (
                        <button
                            type="button"
                            onClick={onCancelMetricsSuggest}
                            title="Cancel the in-flight suggestion request"
                            className="rounded-md border border-red-700 bg-red-500/10 px-3 py-2 text-xs font-semibold text-red-300 transition hover:bg-red-500/20"
                        >
                            Cancel suggestion
                        </button>
                    ) : null}
                </div>
            </div>

            {metricsError ? (
                <div className="mb-3 rounded-md border border-red-800/70 bg-red-500/10 px-3 py-2 text-xs text-red-200">
                    {metricsError}
                </div>
            ) : null}
            {metricsLog.length > 0 ? (
                <div className="mb-3 rounded-md border border-neutral-800 bg-neutral-950/60 p-3">
                    <div className="mb-2 flex items-center justify-between gap-2">
                        <p className="text-xs font-semibold uppercase tracking-wider text-neutral-300">
                            Metric suggestion log
                        </p>
                        <button
                            type="button"
                            onClick={onClearMetricsLog}
                            className="text-[10px] uppercase tracking-wider text-neutral-500 transition hover:text-neutral-200"
                        >
                            Clear
                        </button>
                    </div>
                    <ul className="max-h-32 overflow-y-auto font-mono text-xs">
                        {metricsLog.map((entry) => {
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
                <p className="text-sm font-semibold text-neutral-100">
                    {selectedMetrics.length === 0
                        ? "No metrics selected — pick at least one to enable code generation."
                        : `${String(selectedMetrics.length)} of ${String(metrics.length)} metric${metrics.length === 1 ? "" : "s"} selected`}
                </p>

                <div className="mt-3 flex flex-wrap items-center gap-2">
                    <input
                        type="text"
                        value={manualMetricName}
                        onChange={(event) => {
                            onUpdateManualMetricName(event.target.value);
                        }}
                        onKeyDown={(event) => {
                            if (event.key === "Enter") {
                                event.preventDefault();
                                onAddManualMetric();
                            }
                        }}
                        placeholder="Add a metric the suggester missed…"
                        disabled={inputsLocked}
                        className="flex-1 min-w-0 rounded-md border border-neutral-700 bg-neutral-950 px-3 py-1.5 text-xs text-neutral-100 placeholder:text-neutral-500 focus:outline-none focus:ring-1 focus:ring-sky-600 disabled:cursor-not-allowed disabled:opacity-60"
                    />
                    <button
                        type="button"
                        onClick={onAddManualMetric}
                        disabled={inputsLocked || manualMetricName.trim().length === 0}
                        className="rounded-md border border-emerald-600 bg-emerald-500/10 px-3 py-1.5 text-xs font-semibold text-emerald-200 transition hover:bg-emerald-500/20 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                        Add metric
                    </button>
                </div>
                {manualMetricError ? (
                    <p className="mt-1 text-[11px] text-red-300">{manualMetricError}</p>
                ) : null}

                {metrics.length === 0 ? (
                    <div className="mt-4 rounded-md border border-dashed border-neutral-700 bg-neutral-900/40 p-6 text-center">
                        <p className="text-sm text-neutral-400">
                            Click the sparkle to ask Gemini for metric suggestions, or add one manually above.
                        </p>
                    </div>
                ) : (
                    <div className="mt-4 max-h-130 overflow-y-auto rounded-md border border-neutral-800 bg-neutral-900/70">
                        {metrics.map((metric) => (
                            <div
                                key={metric.id}
                                className="flex items-start justify-between gap-3 border-b border-neutral-800 px-3 py-2 last:border-b-0"
                            >
                                <div className="flex min-w-0 items-start gap-2">
                                    <input
                                        type="checkbox"
                                        checked={metric.selected}
                                        onChange={() => onToggleMetric(metric.id)}
                                        disabled={inputsLocked}
                                        className="mt-0.5 h-4 w-4 accent-sky-500 disabled:cursor-not-allowed disabled:opacity-60"
                                    />
                                    <div className="min-w-0">
                                        <div className="flex flex-wrap items-center gap-2">
                                            <span className="text-sm font-semibold text-neutral-100">
                                                {metric.label || metric.name}
                                            </span>
                                            <span className="font-mono text-[10px] text-neutral-500">
                                                {metric.name}
                                            </span>
                                            <span className="rounded bg-sky-500/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-sky-200">
                                                {metric.agg}
                                            </span>
                                            <span className="rounded bg-neutral-800 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-neutral-300">
                                                {metric.viz}
                                            </span>
                                            {metric.chart_group ? (
                                                <span
                                                    title="Metrics in the same chart group render on one combined panel."
                                                    className="rounded bg-indigo-500/15 px-1.5 py-0.5 text-[10px] font-semibold tracking-wider text-indigo-200"
                                                >
                                                    group: {metric.chart_group}
                                                </span>
                                            ) : null}
                                            {metric.grounding ? (
                                                <span
                                                    title={
                                                        metric.grounding === "causal_explicit"
                                                            ? "Named directly in the causal text."
                                                            : metric.grounding === "causal_implicit"
                                                              ? "Causal relations imply this metric."
                                                              : "Domain knowledge from the LLM — not stated in the causal text."
                                                    }
                                                    className={`rounded px-1.5 py-0.5 text-[10px] font-semibold tracking-wider ${
                                                        metric.grounding === "causal_explicit"
                                                            ? "bg-emerald-500/15 text-emerald-200"
                                                            : metric.grounding === "causal_implicit"
                                                              ? "bg-amber-500/15 text-amber-200"
                                                              : "bg-rose-500/15 text-rose-200"
                                                    }`}
                                                >
                                                    {metric.grounding === "causal_explicit"
                                                        ? "explicit"
                                                        : metric.grounding === "causal_implicit"
                                                          ? "implicit"
                                                          : "inferred"}
                                                </span>
                                            ) : null}
                                            {metric.unit ? (
                                                <span className="text-[10px] text-neutral-500">
                                                    [{metric.unit}]
                                                </span>
                                            ) : null}
                                        </div>
                                        {metric.rationale ? (
                                            <p className="mt-1 text-xs text-neutral-400">
                                                {metric.rationale}
                                            </p>
                                        ) : null}
                                        {metric.entities.length > 0 ? (
                                            <p className="mt-1 text-[11px] text-neutral-500">
                                                from: {metric.entities.join(", ")}
                                            </p>
                                        ) : null}
                                        {metric.required_attrs && metric.required_attrs.length > 0 ? (
                                            <p
                                                className="mt-1 font-mono text-[10px] text-neutral-500"
                                                title="Attributes the Reporter will sample from each entity instance."
                                            >
                                                samples:{" "}
                                                {metric.required_attrs
                                                    .map((dep) => `${dep.entity}.${dep.attr}`)
                                                    .join(", ")}
                                            </p>
                                        ) : null}
                                    </div>
                                </div>
                            </div>
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
}
