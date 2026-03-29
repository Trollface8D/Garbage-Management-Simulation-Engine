import Link from "next/link";
import CategoryPageShell from "../components/category-page-shell";

export default function CausalPage() {
  return (
    <CategoryPageShell
      title="Causal Category"
      description="Explore causal modules and open the follow-up generation flow for implicit causal statements."
    >
      <div className="grid gap-4 md:grid-cols-2">
        <article className="rounded-xl border border-neutral-700 bg-neutral-950/70 p-4">
          <p className="text-sm font-semibold text-neutral-100">Causal Extraction</p>
          <p className="mt-2 text-sm text-neutral-300">
            Review extracted head-relationship-tail tuples from source transcripts.
          </p>
        </article>

        <article className="rounded-xl border border-sky-700/40 bg-sky-950/15 p-4">
          <p className="text-sm font-semibold text-sky-200">Follow-up Generation</p>
          <p className="mt-2 text-sm text-neutral-300">
            Generate analytical follow-up questions from implicit causal content.
          </p>
          <Link
            href="/causal/follow_up"
            className="mt-4 inline-flex rounded-lg border border-sky-500 bg-sky-500/20 px-3 py-2 text-sm font-semibold text-sky-200 transition hover:bg-sky-500/30"
          >
            Open Follow-up Page
          </Link>
        </article>
      </div>
    </CategoryPageShell>
  );
}
