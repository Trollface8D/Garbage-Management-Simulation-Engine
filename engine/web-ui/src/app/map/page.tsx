import CategoryPageShell from "../components/category-page-shell";

export default function MapPage() {
  return (
    <CategoryPageShell
      title="Map Category"
      description="Inspect map-level transfer layouts, path constraints, and district-level collection topology."
    >
      <div className="rounded-xl border border-neutral-700 bg-neutral-950/70 p-4 text-sm text-neutral-200">
        Map analysis modules are now separated into this dedicated page.
      </div>
    </CategoryPageShell>
  );
}
