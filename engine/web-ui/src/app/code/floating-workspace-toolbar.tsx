"use client";

import { useRef, useState, type ChangeEvent } from "react";

type Props = {
  archiveBusy: "idle" | "exporting" | "importing";
  archiveError: string;
  archiveMessage: string;
  importError: string;
  importMessage: string;
  isImporting: boolean;
  inputsLocked: boolean;
  onExport: () => void;
  onArchiveFileChange: (e: ChangeEvent<HTMLInputElement>) => void;
  onJsonFileChange: (e: ChangeEvent<HTMLInputElement>) => void;
};

export default function FloatingWorkspaceToolbar({
  archiveBusy,
  archiveError,
  archiveMessage,
  importError,
  importMessage,
  isImporting,
  inputsLocked,
  onExport,
  onArchiveFileChange,
  onJsonFileChange,
}: Props) {
  const [open, setOpen] = useState(false);
  const archiveInputRef = useRef<HTMLInputElement | null>(null);
  const jsonInputRef = useRef<HTMLInputElement | null>(null);

  const busy = archiveBusy !== "idle";
  const hasStatus = archiveError || archiveMessage || importError || importMessage;

  return (
    <div className="fixed bottom-4 right-4 z-50 flex flex-col items-end gap-2">
      {open ? (
        <div className="w-72 rounded-xl border border-neutral-700 bg-neutral-900 p-4 shadow-2xl">
          <p className="mb-3 text-xs font-semibold uppercase tracking-wider text-neutral-400">
            Workspace archive
          </p>

          <input
            ref={archiveInputRef}
            type="file"
            accept=".zip,application/zip"
            className="hidden"
            onChange={onArchiveFileChange}
          />
          <input
            ref={jsonInputRef}
            type="file"
            accept="application/json,.json"
            className="hidden"
            onChange={onJsonFileChange}
          />

          <div className="flex flex-col gap-2">
            <button
              type="button"
              onClick={onExport}
              disabled={busy || inputsLocked}
              title="Export workspace state + generated artifacts as ZIP"
              className="rounded-md border border-neutral-600 bg-neutral-800/40 px-3 py-2 text-xs font-semibold text-neutral-200 transition hover:bg-neutral-700/40 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {archiveBusy === "exporting" ? "Exporting…" : "Export workspace"}
            </button>

            <button
              type="button"
              onClick={() => archiveInputRef.current?.click()}
              disabled={busy || inputsLocked}
              title="Restore workspace from a previously exported ZIP"
              className="rounded-md border border-neutral-600 bg-neutral-800/40 px-3 py-2 text-xs font-semibold text-neutral-200 transition hover:bg-neutral-700/40 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {archiveBusy === "importing" ? "Importing…" : "Import workspace"}
            </button>

            <div className="my-0.5 border-t border-neutral-800" />

            <button
              type="button"
              onClick={() => jsonInputRef.current?.click()}
              disabled={isImporting || inputsLocked}
              title="Import causal/map components from a JSON file"
              className="rounded-md border border-emerald-700 bg-emerald-500/10 px-3 py-2 text-xs font-semibold text-emerald-200 transition hover:bg-emerald-500/20 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {isImporting ? "Importing JSON…" : "Import JSON (Causal/Map)"}
            </button>
          </div>

          {hasStatus ? (
            <div className="mt-3 space-y-1.5">
              {archiveError ? (
                <p className="rounded-md border border-red-800/70 bg-red-500/10 px-2 py-1.5 text-[11px] text-red-200">
                  {archiveError}
                </p>
              ) : null}
              {archiveMessage && !archiveError ? (
                <p className="rounded-md border border-emerald-700/60 bg-emerald-500/10 px-2 py-1.5 text-[11px] text-emerald-200">
                  {archiveMessage}
                </p>
              ) : null}
              {importError ? (
                <p className="rounded-md border border-red-800/70 bg-red-500/10 px-2 py-1.5 text-[11px] text-red-200">
                  Import failed: {importError}
                </p>
              ) : null}
              {importMessage && !importError ? (
                <p className="rounded-md border border-emerald-700/60 bg-emerald-500/10 px-2 py-1.5 text-[11px] text-emerald-200">
                  {importMessage}
                </p>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}

      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        title={open ? "Close workspace tools" : "Open workspace tools (export / import)"}
        aria-label={open ? "Close workspace tools" : "Open workspace tools"}
        className="flex h-11 w-11 items-center justify-center rounded-full border border-neutral-600 bg-neutral-800 text-neutral-300 shadow-lg transition hover:bg-neutral-700 hover:text-neutral-100"
      >
        <svg
          viewBox="0 0 24 24"
          className="h-5 w-5"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.75"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <rect x="2" y="4" width="20" height="5" rx="1" />
          <path d="M4 9v10a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1V9" />
          <path d="M10 13h4" />
        </svg>
      </button>
    </div>
  );
}
