import { type KeyboardEvent } from "react";

type UsedItemCardProps = {
  title: string;
  project: string;
  lastEdited: string;
  onDelete: () => void;
  typeLabel: "Causal" | "Map";
  selected?: boolean;
  onSelect?: () => void;
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
}: UsedItemCardProps) {
  const interactive = typeof onSelect === "function";
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
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <FileTypeIcon />
            <p className="truncate text-sm font-semibold text-neutral-100">{title}</p>
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
          className="rounded-md border border-neutral-700 px-2 py-1 text-xs text-neutral-300 hover:border-red-500/70 hover:text-red-200"
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
