import CategoryPageShell from "../components/category-page-shell";

export default function PolicyTestingPage() {
  return (
    <CategoryPageShell
      title="Policy Testing Category"
      description="Compare policy scenarios, benchmark trade-offs, and validate intervention assumptions."
    >
      <div className="rounded-xl border border-neutral-700 bg-neutral-950/70 p-4 text-sm text-neutral-200">
        Policy testing views have been separated into this dedicated page.
      </div>
    </CategoryPageShell>
  );
}
