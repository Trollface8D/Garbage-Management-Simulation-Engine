import Link from "next/link";

export default function CausalExtractPage() {
  return (
    <div className="min-h-screen bg-[#1e1e1e] text-neutral-100">
      <main className="mx-auto w-full max-w-7xl px-5 py-8 md:px-8 md:py-10 lg:px-12">
        <header className="mb-8">
          <h1 className="text-3xl font-black uppercase tracking-tight text-neutral-100 md:text-5xl lg:text-6xl">
            Garbage Flow Simulation Engine
          </h1>
        </header>

        <section className="rounded-2xl border border-neutral-800 bg-neutral-900/60 p-5 backdrop-blur-sm md:p-6">
          <h2 className="text-2xl font-bold text-neutral-100">Extract</h2>
          <p className="mt-2 max-w-3xl text-sm text-neutral-300">
            This workspace is for extracting causal data from chunked inputs.
          </p>

          <div className="mt-6 rounded-xl border border-neutral-700 bg-neutral-900/70 p-4 text-sm text-neutral-300">
            Extraction panel placeholder. The /causal_extract home page already filters experiment items so only chunked and extracted data appear for this feature.
          </div>
        </section>

        <div className="mt-6">
          <Link
            href="/causal_extract"
            className="inline-flex items-center rounded-lg border border-neutral-700 bg-neutral-900 px-4 py-2 text-sm font-semibold text-neutral-200 transition hover:border-sky-500 hover:text-sky-200"
          >
            Back to causal extraction home
          </Link>
        </div>
      </main>
    </div>
  );
}
