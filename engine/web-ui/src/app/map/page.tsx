import CategoryPageShell from "../components/category-page-shell";

export default function MapPage() {
  return (
    <CategoryPageShell
      title="Map Extraction Section"
      description="Open a map artifact from PM dashboard to use the map extraction workspace."
    >
      <div className="space-y-3 rounded-xl border border-neutral-700 bg-neutral-950/70 p-4 text-sm text-neutral-200">
        <p>
          This route is a landing page. The interactive extraction workspace is available under
          <span className="font-semibold"> /map/{`{componentId}`}</span>.
        </p>
        <p className="text-neutral-400">
          The workspace uses placeholder extract and edit endpoints for now and is designed to be
          backend-configurable with minimal UI changes.
        </p>
      </div>
    </CategoryPageShell>
  );
}
