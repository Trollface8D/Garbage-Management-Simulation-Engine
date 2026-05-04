import { type KeyboardEvent, useRef, useState } from "react";

type UsedItemCardProps = {
  title: string;
  project: string;
  lastEdited: string;
  onDelete: () => void;
  typeLabel: "Causal" | "Map";
  selected?: boolean;
  onSelect?: () => void;
  onRename?: (newTitle: string) => void;
};

function FileThumbPlaceholder() {
  return (
    <div className="relative h-40 w-full overflow-hidden rounded-t-xl border-b border-neutral-700 bg-neutral-800 p-3">
      <div className="mb-2 h-3 w-24 rounded bg-neutral-600/80" />
      <div className="grid h-[calc(100%-1.25rem)] grid-cols-3 gap-2">
        <div className="rounded bg-neutral-700/90 p-2">
          <div className="mb-1 h-1.5 w-8 rounded bg-neutral-500" />
          <div className="h-1.5 w-12 rounded bg-neutral-500" />
        </div>
        <div className="rounded bg-neutral-700/90 p-2">
          <div className="mb-1 h-1.5 w-9 rounded bg-neutral-500" />
          <div className="mb-1 h-1.5 w-11 rounded bg-neutral-500" />
          <div className="h-1.5 w-8 rounded bg-neutral-500" />
        </div>
        <div className="rounded bg-neutral-700/90 p-2">
          <div className="mb-1 h-1.5 w-10 rounded bg-neutral-500" />
          <div className="h-6 w-full rounded bg-neutral-600/80" />
        </div>
      </div>
    </div>
  );
}

function FileTypeIcon() {
  return (
    <span className="inline-flex h-5 w-5 items-center justify-center rounded bg-sky-600/20 text-xs font-semibold text-sky-300">
      F
    </span>
  );
}

function UsedItemCard({
  title,
  project,
  lastEdited,
  onDelete,
  selected,
  onSelect,
  onRename,
}: UsedItemCardProps) {
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(title);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const interactive = typeof onSelect === "function";

  const startRename = (e: React.MouseEvent) => {
    e.stopPropagation();
    setRenameValue(title);
    setRenaming(true);
    setTimeout(() => renameInputRef.current?.select(), 0);
  };

  const commitRename = () => {
    const trimmed = renameValue.trim();
    if (trimmed && trimmed !== title) {
      onRename?.(trimmed);
    }
    setRenaming(false);
  };
  const baseClasses =
    "group overflow-hidden rounded-xl border bg-neutral-900/60 shadow-[0_0_0_1px_rgba(255,255,255,0.01)] transition duration-200 hover:scale-[1.02]";
  const selectedClasses = selected
    ? "border-emerald-500 shadow-[0_0_0_2px_rgba(16,185,129,0.45)]"
    : "border-neutral-700 hover:border-sky-500 hover:shadow-[0_0_0_2px_rgba(14,165,233,0.35)]";
  const cursorClass = interactive ? "cursor-pointer" : "";

  const handleClick = () => {
    if (onSelect) onSelect();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (!onSelect) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onSelect();
    }
  };

  return (
    <article
      role={interactive ? "button" : undefined}
      tabIndex={interactive ? 0 : undefined}
      aria-pressed={interactive ? Boolean(selected) : undefined}
      onClick={interactive ? handleClick : undefined}
      onKeyDown={interactive ? handleKeyDown : undefined}
      className={`${baseClasses} ${selectedClasses} ${cursorClass}`.trim()}
    >
      <FileThumbPlaceholder />

      <div className="flex items-end justify-between gap-3 bg-neutral-900 px-4 py-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <FileTypeIcon />
            {renaming ? (
              <input
                ref={renameInputRef}
                type="text"
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
                onBlur={commitRename}
                onKeyDown={(e) => {
                  if (e.key === "Enter") { e.preventDefault(); commitRename(); }
                  if (e.key === "Escape") { setRenaming(false); }
                }}
                onClick={(e) => e.stopPropagation()}
                className="flex-1 min-w-0 rounded border border-sky-600 bg-neutral-800 px-1.5 py-0.5 text-sm font-semibold text-neutral-100 focus:outline-none"
              />
            ) : (
              <p className="truncate text-sm font-semibold text-neutral-100">{title}</p>
            )}
            {onRename && !renaming && (
              <button
                type="button"
                onClick={startRename}
                title="Rename"
                className="shrink-0 rounded p-0.5 text-neutral-500 hover:text-neutral-200"
                aria-label={`Rename ${title}`}
              >
                <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="currentColor" aria-hidden="true">
                  <path d="M11.013 1.427a1.75 1.75 0 0 1 2.475 2.474L5.91 11.48a2.25 2.25 0 0 1-.99.578l-2.68.728a.75.75 0 0 1-.912-.912l.727-2.68a2.25 2.25 0 0 1 .58-.99l7.378-7.377Zm1.414 1.06a.25.25 0 0 0-.354 0L4.695 9.865l-.55 2.024 2.025-.55 7.378-7.378a.25.25 0 0 0 0-.354l-1.12-1.12Z"/>
                </svg>
              </button>
            )}
          </div>
          <p className="mt-1 text-xs text-neutral-400">Edited {lastEdited}</p>
          <p className="mt-1 text-xs text-neutral-500">Project: {project}</p>
        </div>

        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onDelete();
          }}
          className="shrink-0 rounded-md border border-neutral-700 px-2 py-1 text-xs text-neutral-300 hover:border-red-500/70 hover:text-red-200"
          aria-label={`Delete ${title}`}
        >
          Delete
        </button>
      </div>
    </article>
  );
}

export function CausalUsedCard(props: Omit<UsedItemCardProps, "typeLabel">) {
  return <UsedItemCard {...props} typeLabel="Causal" />;
}

export function MapUsedCard(props: Omit<UsedItemCardProps, "typeLabel">) {
  return <UsedItemCard {...props} typeLabel="Map" />;
}

export type { UsedItemCardProps };
