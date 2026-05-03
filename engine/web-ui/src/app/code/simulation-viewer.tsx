"use client";

/* eslint-disable @typescript-eslint/no-explicit-any */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  cancelSimulation,
  fetchSimulation,
  fetchSimulationLog,
  startSimulation,
  type SimulationRunInfo,
  type SimulationStatus,
  type SuggestedMetric,
} from "@/lib/code-gen-api-client";

type Props = {
  jobId: string | null;
  selectedMetrics: SuggestedMetric[];
};

type MetricHeader = {
  name: string;
  label?: string;
  unit?: string;
  agg?: string;
  viz?: string;
  chart_group?: string | null;
  grounding?: string | null;
};

type Sample = {
  t: number;
  value: number;
  metric: string;
};

const POLL_MS = 1500;
const PALETTE = [
  "#38bdf8",
  "#a855f7",
  "#34d399",
  "#f59e0b",
  "#f472b6",
  "#22d3ee",
  "#fb7185",
  "#facc15",
];

function formatHM(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  return hours > 0 ? `${hours}h${minutes.toString().padStart(2, "0")}` : `${minutes}m`;
}

type ChartSeries = { metric: MetricHeader; samples: Sample[]; color: string };

type ChartPanel = {
  key: string;
  title: string;
  series: ChartSeries[];
};

function buildPanels(
  headers: MetricHeader[],
  samples: Sample[],
): ChartPanel[] {
  const groupBuckets = new Map<string | null, MetricHeader[]>();
  headers.forEach((h) => {
    const k = h.chart_group?.trim() || null;
    if (!groupBuckets.has(k)) groupBuckets.set(k, []);
    groupBuckets.get(k)?.push(h);
  });

  const samplesByMetric = new Map<string, Sample[]>();
  samples.forEach((s) => {
    if (!samplesByMetric.has(s.metric)) samplesByMetric.set(s.metric, []);
    samplesByMetric.get(s.metric)?.push(s);
  });

  const panels: ChartPanel[] = [];
  let colorIdx = 0;
  for (const [group, members] of groupBuckets.entries()) {
    if (group === null) {
      // ungrouped: one panel per metric
      members.forEach((h) => {
        const series: ChartSeries = {
          metric: h,
          samples: samplesByMetric.get(h.name) || [],
          color: PALETTE[colorIdx % PALETTE.length],
        };
        colorIdx += 1;
        panels.push({
          key: `solo-${h.name}`,
          title: h.label || h.name,
          series: [series],
        });
      });
      continue;
    }
    const series = members.map((h) => {
      const c = PALETTE[colorIdx % PALETTE.length];
      colorIdx += 1;
      return {
        metric: h,
        samples: samplesByMetric.get(h.name) || [],
        color: c,
      } as ChartSeries;
    });
    panels.push({ key: `group-${group}`, title: group, series });
  }
  return panels;
}

function LineChart({ panel }: { panel: ChartPanel }) {
  const W = 480;
  const H = 180;
  const PAD_L = 40;
  const PAD_R = 12;
  const PAD_T = 8;
  const PAD_B = 22;

  const allSamples = panel.series.flatMap((s) => s.samples);
  if (allSamples.length === 0) {
    return (
      <div className="rounded-md border border-neutral-800 bg-neutral-950/50 p-3">
        <p className="mb-2 text-sm font-semibold text-neutral-200">{panel.title}</p>
        <div className="flex h-40 items-center justify-center text-xs text-neutral-500">
          waiting for samples…
        </div>
      </div>
    );
  }
  const tMin = Math.min(...allSamples.map((s) => s.t));
  const tMax = Math.max(...allSamples.map((s) => s.t));
  const vMin = Math.min(...allSamples.map((s) => s.value));
  const vMax = Math.max(...allSamples.map((s) => s.value));
  const tSpan = Math.max(1, tMax - tMin);
  const vSpan = Math.max(1e-9, vMax - vMin);

  const xOf = (t: number) =>
    PAD_L + ((t - tMin) / tSpan) * (W - PAD_L - PAD_R);
  const yOf = (v: number) =>
    H - PAD_B - ((v - vMin) / vSpan) * (H - PAD_T - PAD_B);

  return (
    <div className="rounded-md border border-neutral-800 bg-neutral-950/50 p-3">
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <p className="text-sm font-semibold text-neutral-200">{panel.title}</p>
        <p className="text-[10px] text-neutral-500">
          {tMin === tMax ? formatHM(tMin) : `${formatHM(tMin)} → ${formatHM(tMax)}`}
        </p>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="h-44 w-full">
        <line
          x1={PAD_L}
          x2={W - PAD_R}
          y1={H - PAD_B}
          y2={H - PAD_B}
          stroke="#404040"
          strokeWidth="1"
        />
        <line
          x1={PAD_L}
          x2={PAD_L}
          y1={PAD_T}
          y2={H - PAD_B}
          stroke="#404040"
          strokeWidth="1"
        />
        <text
          x={PAD_L - 4}
          y={PAD_T + 8}
          fill="#737373"
          fontSize="9"
          textAnchor="end"
        >
          {vMax.toFixed(1)}
        </text>
        <text
          x={PAD_L - 4}
          y={H - PAD_B}
          fill="#737373"
          fontSize="9"
          textAnchor="end"
        >
          {vMin.toFixed(1)}
        </text>
        <text
          x={PAD_L}
          y={H - 4}
          fill="#737373"
          fontSize="9"
          textAnchor="start"
        >
          {formatHM(tMin)}
        </text>
        <text
          x={W - PAD_R}
          y={H - 4}
          fill="#737373"
          fontSize="9"
          textAnchor="end"
        >
          {formatHM(tMax)}
        </text>
        {panel.series.map((s, i) => {
          if (s.samples.length === 0) return null;
          const sorted = [...s.samples].sort((a, b) => a.t - b.t);
          const points = sorted.map((p) => `${xOf(p.t)},${yOf(p.value)}`).join(" ");
          const last = sorted[sorted.length - 1];
          return (
            <g key={`${s.metric.name}-${String(i)}`}>
              <polyline
                fill="none"
                stroke={s.color}
                strokeWidth="1.5"
                points={points}
              />
              <circle cx={xOf(last.t)} cy={yOf(last.value)} r={2.5} fill={s.color} />
            </g>
          );
        })}
      </svg>
      {panel.series.length > 1 ? (
        <div className="mt-1 flex flex-wrap gap-3">
          {panel.series.map((s) => (
            <div key={s.metric.name} className="flex items-center gap-1.5 text-[10px] text-neutral-400">
              <span
                className="inline-block h-2 w-3 rounded-sm"
                style={{ backgroundColor: s.color }}
              />
              <span className="font-mono text-neutral-300">
                {s.metric.label || s.metric.name}
              </span>
              {s.metric.unit ? <span>[{s.metric.unit}]</span> : null}
            </div>
          ))}
        </div>
      ) : (
        <div className="mt-1 flex items-center gap-2 text-[10px] text-neutral-500">
          {panel.series[0]?.metric.unit ? (
            <span>unit: {panel.series[0].metric.unit}</span>
          ) : null}
          {panel.series[0]?.metric.agg ? (
            <span>agg: {panel.series[0].metric.agg}</span>
          ) : null}
        </div>
      )}
    </div>
  );
}

export default function SimulationViewer({ jobId, selectedMetrics }: Props) {
  const [run, setRun] = useState<SimulationRunInfo | null>(null);
  const [status, setStatus] = useState<SimulationStatus | "idle">("idle");
  const [headers, setHeaders] = useState<MetricHeader[]>([]);
  const [samples, setSamples] = useState<Sample[]>([]);
  const [error, setError] = useState<string>("");
  const [ticks, setTicks] = useState<number>(100);
  const [tickSeconds, setTickSeconds] = useState<number>(300);
  const offsetRef = useRef<number>(0);
  const pollTimerRef = useRef<number | null>(null);

  const stopPolling = useCallback(() => {
    if (pollTimerRef.current !== null) {
      window.clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    return () => stopPolling();
  }, [stopPolling]);

  const handleStart = async () => {
    if (!jobId) {
      setError("Run code generation first — no job id available.");
      return;
    }
    setError("");
    setHeaders([]);
    setSamples([]);
    offsetRef.current = 0;
    try {
      const info = await startSimulation(jobId, ticks, tickSeconds);
      setRun(info);
      setStatus(info.status);
      pollTimerRef.current = window.setInterval(() => {
        void poll(info.simRunId);
      }, POLL_MS);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start simulation.");
    }
  };

  const poll = useCallback(
    async (simRunId: string) => {
      if (!jobId) return;
      try {
        const chunk = await fetchSimulationLog(jobId, simRunId, offsetRef.current);
        offsetRef.current = chunk.nextOffset;
        if (chunk.lines.length > 0) {
          const newSamples: Sample[] = [];
          let nextHeaders: MetricHeader[] | null = null;
          for (const line of chunk.lines) {
            try {
              const obj = JSON.parse(line) as Record<string, unknown>;
              if (obj._ === "header") {
                const arr = obj.metrics;
                if (Array.isArray(arr)) {
                  nextHeaders = arr as unknown as MetricHeader[];
                }
                continue;
              }
              if (
                typeof obj.metric === "string" &&
                typeof obj.t === "number" &&
                typeof obj.value === "number"
              ) {
                newSamples.push({
                  t: obj.t,
                  value: obj.value,
                  metric: obj.metric,
                });
              }
            } catch {
              // skip malformed line
            }
          }
          if (nextHeaders) setHeaders(nextHeaders);
          if (newSamples.length > 0) {
            setSamples((prev) => [...prev, ...newSamples]);
          }
        }
        setStatus(chunk.status);
        if (chunk.status !== "running") {
          stopPolling();
          if (chunk.status === "failed" && chunk.error) {
            setError(chunk.error);
          }
          try {
            const refreshed = await fetchSimulation(jobId, simRunId);
            setRun(refreshed);
          } catch {
            // ignore
          }
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "Polling failed.");
        stopPolling();
      }
    },
    [jobId, stopPolling],
  );

  const handleCancel = async () => {
    if (!run || !jobId) return;
    try {
      await cancelSimulation(jobId, run.simRunId);
      stopPolling();
      setStatus("cancelled");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Cancel failed.");
    }
  };

  // If we have selectedMetrics from page state but no header yet, show
  // placeholder panels so the layout doesn't pop in.
  const effectiveHeaders: MetricHeader[] =
    headers.length > 0
      ? headers
      : selectedMetrics.map((m) => ({
          name: m.name,
          label: m.label,
          unit: m.unit,
          agg: m.agg,
          viz: m.viz,
          chart_group: m.chart_group,
          grounding: m.grounding,
        }));

  const panels = useMemo(
    () => buildPanels(effectiveHeaders, samples),
    [effectiveHeaders, samples],
  );

  const isIdle = status === "idle";
  const isRunning = status === "running";
  const sampleCount = samples.length;

  return (
    <section className="rounded-xl border border-neutral-700 bg-neutral-900/60 p-4 md:p-6">
      <header className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-xl font-bold text-neutral-100 md:text-2xl">
          Run simulation &amp; visualize
        </h2>
        <p className="text-xs text-neutral-400">
          {run ? `Sim: ${run.simRunId} · ${status}` : "no run yet"}
          {sampleCount > 0 ? ` · ${String(sampleCount)} samples` : ""}
        </p>
      </header>

      <div className="mb-4 flex flex-wrap items-center gap-3 rounded-md border border-neutral-800 bg-neutral-950/40 px-3 py-2">
        <label className="flex items-center gap-2 text-xs text-neutral-300">
          <span>Ticks</span>
          <input
            type="number"
            min={1}
            max={100000}
            value={ticks}
            onChange={(e) => setTicks(Math.max(1, Number(e.target.value) || 1))}
            disabled={isRunning}
            className="w-24 rounded-md border border-neutral-700 bg-neutral-900 px-2 py-1 font-mono text-xs text-neutral-100 disabled:cursor-not-allowed disabled:opacity-60"
          />
        </label>
        <label className="flex items-center gap-2 text-xs text-neutral-300">
          <span>1 tick =</span>
          <input
            type="number"
            min={1}
            max={86400}
            value={tickSeconds}
            onChange={(e) => setTickSeconds(Math.max(1, Number(e.target.value) || 1))}
            disabled={isRunning}
            className="w-24 rounded-md border border-neutral-700 bg-neutral-900 px-2 py-1 font-mono text-xs text-neutral-100 disabled:cursor-not-allowed disabled:opacity-60"
          />
          <span>sec</span>
        </label>

        <button
          type="button"
          onClick={() => void handleStart()}
          disabled={!jobId || isRunning}
          title={!jobId ? "Run code generation first" : undefined}
          className="rounded-md border border-emerald-700 bg-emerald-500/10 px-4 py-2 text-sm font-semibold text-emerald-200 transition hover:bg-emerald-500/20 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {isRunning ? "Running…" : isIdle ? "Run simulation" : "Run again"}
        </button>
        {isRunning ? (
          <button
            type="button"
            onClick={() => void handleCancel()}
            className="rounded-md border border-red-700 bg-red-500/10 px-3 py-2 text-xs font-semibold text-red-300 transition hover:bg-red-500/20"
          >
            Cancel
          </button>
        ) : null}
      </div>

      {error ? (
        <p className="mb-3 whitespace-pre-line rounded-md border border-red-800/70 bg-red-500/10 px-3 py-2 text-xs text-red-200">
          {error}
        </p>
      ) : null}

      {panels.length === 0 ? (
        <div className="flex h-32 items-center justify-center text-sm text-neutral-400">
          {jobId
            ? "No metrics defined yet — pick metrics in the section above before running."
            : "Generate code first; the run + chart panel becomes available afterwards."}
        </div>
      ) : (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {panels.map((panel) => (
            <LineChart key={panel.key} panel={panel} />
          ))}
        </div>
      )}
    </section>
  );
}
