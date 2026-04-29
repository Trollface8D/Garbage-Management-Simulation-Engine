import BackToHome from "./back-to-home";

type CategoryPageShellProps = {
  title: string;
  description: string;
  children?: React.ReactNode;
};

export default function CategoryPageShell({ title, description, children }: CategoryPageShellProps) {
  return (
    <div className="min-h-screen bg-[var(--surface-0)] text-[var(--text-1)]">
      <main className="mx-auto w-full max-w-7xl px-5 py-8 md:px-8 md:py-10 lg:px-12">
        <header className="mb-8">
          <h1 className="text-3xl font-black uppercase tracking-tight text-neutral-100 md:text-5xl">{title}</h1>
          <p className="mt-3 max-w-3xl text-sm text-neutral-300 md:text-base">{description}</p>
        </header>

        <section className="rounded-2xl border border-neutral-800 bg-neutral-900/60 p-5 backdrop-blur-sm md:p-6">
          {children}
        </section>

        <BackToHome />
      </main>
    </div>
  );
}
