import CategoryPageShell from "../components/category-page-shell";

export default function CodePage() {
  return (
    <CategoryPageShell
      title="Code Category"
      description="Manage simulation logic, dispatcher rules, and optimization behavior from the code workspace."
    >
      <div className="rounded-xl border border-neutral-700 bg-neutral-950/70 p-4 text-sm text-neutral-200">
        Code generation and rule-engine tasks are now grouped in this route.
      </div>
    </CategoryPageShell>
  );
}
