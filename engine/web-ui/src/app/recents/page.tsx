"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { RecentArtifact } from "@/lib/pm-storage";
import { loadRecentArtifacts } from "@/lib/pm-storage";

export default function RecentsPage() {
  const [items, setItems] = useState<RecentArtifact[]>([]);

  useEffect(() => {
    setItems(loadRecentArtifacts());
  }, []);

  return (
    <div className="mx-auto w-full max-w-7xl px-5 py-8 md:px-8 md:py-10 lg:px-12">
      <header className="mb-8">
        <h1 className="text-3xl font-black uppercase tracking-tight text-neutral-100 md:text-5xl">Recent Opened Artifact</h1>
        <p className="mt-2 text-sm text-neutral-400">Recently opened artifacts across projects.</p>
      </header>

      {items.length === 0 ? (
        <div className="rounded-xl border border-neutral-800 bg-neutral-900/60 p-5 text-sm text-neutral-400">
          No recent artifacts yet.
        </div>
      ) : (
        <section className="grid grid-cols-1 gap-3">
          {items.map((item) => (
            <Link
              key={item.componentId}
              href={item.href}
              className="rounded-xl border border-neutral-800 bg-neutral-900/60 p-4 transition hover:border-sky-500/70"
            >
              <p className="text-sm font-semibold text-neutral-100">{item.title}</p>
              <p className="mt-1 text-xs text-neutral-400">
                {item.category} • Opened {new Date(item.openedAt).toLocaleString()}
              </p>
            </Link>
          ))}
        </section>
      )}
    </div>
  );
}
