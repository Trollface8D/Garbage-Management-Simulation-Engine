import FollowUpGenerationPage from "../../components/follow-up-generation-page";

export default function CausalFollowUpPage() {
  return (
    <div className="min-h-screen bg-[#1e1e1e] text-neutral-100">
      <main className="mx-auto w-full max-w-7xl px-5 py-8 md:px-8 md:py-10 lg:px-12">
        <header className="mb-8">
          <h1 className="text-3xl font-black uppercase tracking-tight text-neutral-100 md:text-5xl lg:text-6xl">
            Garbage Flow Simulation Engine
          </h1>
        </header>

        <FollowUpGenerationPage />
      </main>
    </div>
  );
}
