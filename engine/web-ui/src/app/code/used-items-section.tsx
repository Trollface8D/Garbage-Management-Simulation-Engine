"use client";

import { CausalUsedCard, MapUsedCard } from "../causal_extract/used-item-cards";

export type UsedItem = {
  id: string;
  title: string;
  project: string;
  lastEdited: string;
};

type UsedItemsSectionProps = {
  title: string;
  category: "Causal" | "Map";
  items: UsedItem[];
  onDelete: (componentId: string) => void;
  onCreate: (category: "Causal" | "Map") => void;
  selectedIds?: ReadonlySet<string>;
  onToggleSelect?: (id: string) => void;
  onRename?: (id: string, newTitle: string) => void;
};

export default function UsedItemsSection({
  title,
  category,
  items,
  onDelete,
  onCreate,
  selectedIds,
  onToggleSelect,
  onRename,
}: UsedItemsSectionProps) {
  const isCausal = category === "Causal";
  const actionLabel = isCausal ? "Create Causal Extraction" : "Create Map Extraction";
  const actionDescription = isCausal
    ? "Create your first causal artifact and open it immediately."
    : "Create your first map artifact and open it immediately.";

  return (
    <div>
      <h2 className="mb-4 text-xl font-bold text-neutral-100 md:text-2xl">{title} <span className="text-red-400" aria-label="required">
                        *
                    </span></h2>
      {items.length === 0 ? (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <button
            type="button"
            onClick={() => onCreate(category)}
            className="group overflow-hidden rounded-xl border border-dashed border-neutral-600 bg-neutral-900/40 shadow-[0_0_0_1px_rgba(255,255,255,0.01)] transition duration-200 hover:scale-[1.02] hover:border-sky-500"
          >
            <div className="relative flex h-40 w-full items-center justify-center overflow-hidden rounded-t-xl border-b border-neutral-700 bg-neutral-800 p-3">
              <span className="inline-flex h-12 min-w-12 items-center justify-center rounded-full bg-sky-500 px-3 text-lg font-black text-white">
                +
              </span>
            </div>
            <div className="bg-neutral-900 px-4 py-3">
              <p className="text-sm font-semibold text-neutral-100">{actionLabel}</p>
              <p className="mt-1 text-xs text-neutral-400">{actionDescription}</p>
            </div>
          </button>
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {items.map((item) => {
            const isSelected = selectedIds?.has(item.id) ?? false;
            const handleSelect = onToggleSelect
              ? () => onToggleSelect(item.id)
              : undefined;
            return isCausal ? (
              <CausalUsedCard
                key={item.id}
                title={item.title}
                project={item.project}
                lastEdited={item.lastEdited}
                onDelete={() => onDelete(item.id)}
                selected={isSelected}
                onSelect={handleSelect}
                onRename={onRename ? (newTitle) => onRename(item.id, newTitle) : undefined}
              />
            ) : (
              <MapUsedCard
                key={item.id}
                title={item.title}
                project={item.project}
                lastEdited={item.lastEdited}
                onDelete={() => onDelete(item.id)}
                selected={isSelected}
                onSelect={handleSelect}
                onRename={onRename ? (newTitle) => onRename(item.id, newTitle) : undefined}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}
