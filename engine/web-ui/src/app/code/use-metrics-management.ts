import { useRef, useState, useCallback } from "react";
import { suggestMetrics, type SuggestedMetric } from "@/lib/code-gen-api-client";
import { type WorkspaceMetric } from "./metrics-selection-panel";

/**
 * Custom hook for managing metrics suggestion and selection.
 * Keeps all metrics-related logic separate from the main page component.
 */
export function useMetricsManagement() {
    const [metrics, setMetrics] = useState<WorkspaceMetric[]>([]);
    const [metricsExtracted, setMetricsExtracted] = useState<boolean>(false);
    const [isSuggestingMetrics, setIsSuggestingMetrics] = useState<boolean>(false);
    const [metricsError, setMetricsError] = useState<string>("");
    const [metricsLog, setMetricsLog] = useState<
        Array<{ id: number; ts: number; level: "info" | "warn" | "error"; message: string }>
    >([]);

    const metricsAbortRef = useRef<AbortController | null>(null);
    const metricsLogIdRef = useRef<number>(0);
    const metricsStartRef = useRef<number>(0);

    const appendMetricsLog = useCallback(
        (level: "info" | "warn" | "error", message: string) => {
            metricsLogIdRef.current += 1;
            const id = metricsLogIdRef.current;
            setMetricsLog((prev) => [...prev, { id, ts: Date.now(), level, message }]);
        },
        [],
    );

    const handleCancelMetricsSuggest = useCallback(() => {
        const controller = metricsAbortRef.current;
        if (!controller) return;
        controller.abort();
        appendMetricsLog("warn", "Cancel requested — aborting request");
    }, [appendMetricsLog]);

    const handleSuggestMetrics = useCallback(
        (
            sourceEntities: Array<{ name: string }>,
            selectedModel: string,
            isSuggestingMetrics: boolean,
            inputsLocked: boolean,
        ) => {
            if (isSuggestingMetrics || inputsLocked) return;

            if (sourceEntities.length === 0) {
                setMetricsError(
                    "Extract or add at least one entity above before suggesting metrics.",
                );
                return;
            }

            setMetricsError("");
            setMetricsLog([]);
            setIsSuggestingMetrics(true);

            const controller = new AbortController();
            metricsAbortRef.current = controller;
            metricsStartRef.current = Date.now();
            const modelLabel = selectedModel.trim() || "(env default)";

            appendMetricsLog(
                "info",
                `Posting ${String(sourceEntities.length)} entities to ${modelLabel}…`,
            );

            (async () => {
                try {
                    const suggestions = await suggestMetrics(
                        sourceEntities,
                        undefined,
                        selectedModel,
                        controller.signal,
                    );

                    const elapsed = Math.round((Date.now() - metricsStartRef.current) / 100) / 10;
                    appendMetricsLog(
                        "info",
                        `Received ${String(suggestions.length)} metric suggestions in ${String(elapsed)}s`,
                    );

                    if (suggestions.length === 0) {
                        appendMetricsLog("warn", "Gemini returned no metric suggestions");
                        setMetricsError("Gemini returned no metric suggestions.");
                        return;
                    }

                    const next: WorkspaceMetric[] = suggestions.map((m, idx) => ({
                        ...m,
                        id: `metric-${String(idx)}-${m.name.replace(/[^a-z0-9_]+/gi, "_")}`,
                        selected: true,
                    }));

                    setMetrics(next);
                    setMetricsExtracted(true);
                } catch (err) {
                    if (
                        (err instanceof DOMException && err.name === "AbortError") ||
                        (err instanceof Error && err.name === "AbortError")
                    ) {
                        appendMetricsLog("warn", "Request cancelled");
                        setMetricsError("Metric suggestion cancelled.");
                    } else {
                        const message =
                            err instanceof Error ? err.message : "Metric suggestion failed.";
                        appendMetricsLog("error", message);
                        setMetricsError(message);
                    }
                } finally {
                    metricsAbortRef.current = null;
                    setIsSuggestingMetrics(false);
                }
            })();
        },
        [appendMetricsLog],
    );

    const handleToggleMetric = useCallback((id: string) => {
        setMetrics((prev) =>
            prev.map((m) => (m.id === id ? { ...m, selected: !m.selected } : m)),
        );
    }, []);

    const handleAddManualMetric = useCallback(
        (name: string, inputsLocked: boolean) => {
            if (inputsLocked) return { error: "Inputs are locked" };

            const trimmed = name.trim();
            if (!trimmed) {
                return { error: "Type a metric name first." };
            }

            const result = setMetrics((prev) => {
                const exists = prev.some(
                    (m) => m.name.toLowerCase() === trimmed.toLowerCase(),
                );
                if (exists) {
                    return prev;
                }

                const slug = trimmed.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
                const id = `metric-manual-${String(Date.now())}-${slug || "metric"}`;
                const newMetric: WorkspaceMetric = {
                    id,
                    name: slug || `metric_${String(Date.now())}`,
                    label: trimmed,
                    unit: "",
                    agg: "count",
                    entities: [],
                    viz: "line",
                    rationale: "(manual)",
                    selected: true,
                };
                return [...prev, newMetric];
            });

            setMetricsExtracted(true);
            return { success: true };
        },
        [],
    );

    return {
        // State
        metrics,
        setMetrics,
        metricsExtracted,
        setMetricsExtracted,
        isSuggestingMetrics,
        metricsError,
        setMetricsError,
        metricsLog,
        setMetricsLog,

        // Handlers
        handleSuggestMetrics,
        handleCancelMetricsSuggest,
        handleToggleMetric,
        handleAddManualMetric,
        appendMetricsLog,
    };
}
