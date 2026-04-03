"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import {
  loadDeletedComponents,
  loadDeletedProjects,
  loadRecentArtifacts,
} from "@/lib/pm-storage";

type NavItem = {
  href: string;
  label: string;
  badge?: number;
};

function NavLink({ href, label, badge, isActive }: NavItem & { isActive: boolean }) {
  return (
    <Link
      href={href}
      className={`flex items-center justify-between rounded-lg border px-3 py-2 text-sm transition ${
        isActive
          ? "border-sky-500/70 bg-sky-500/15 text-sky-200"
          : "border-neutral-800 bg-neutral-900/60 text-neutral-300 hover:border-neutral-700 hover:text-neutral-100"
      }`}
    >
      <span>{label}</span>
      {typeof badge === "number" && badge > 0 ? (
        <span className="rounded-full bg-neutral-800 px-2 py-0.5 text-xs text-neutral-300">{badge}</span>
      ) : null}
    </Link>
  );
}

export function PMSidebar() {
  const pathname = usePathname();
  const [recentCount, setRecentCount] = useState(0);
  const [trashCount, setTrashCount] = useState(0);
  const [isCollapsed, setIsCollapsed] = useState(false);

  useEffect(() => {
    const refresh = async () => {
      const [recent, deletedProjects, deletedComponents] = await Promise.all([
        loadRecentArtifacts(),
        loadDeletedProjects(),
        loadDeletedComponents(),
      ]);

      setRecentCount(recent.length);
      setTrashCount(deletedProjects.length + deletedComponents.length);
    };

    const handleRefresh = () => {
      void refresh();
    };

    void refresh();
    window.addEventListener("storage", handleRefresh);
    window.addEventListener("pm-storage-changed", handleRefresh);

    return () => {
      window.removeEventListener("storage", handleRefresh);
      window.removeEventListener("pm-storage-changed", handleRefresh);
    };
  }, []);

  const navItems = useMemo<NavItem[]>(
    () => [
      { href: "/", label: "All Projects" },
      { href: "/recents", label: "Recent Opened Artifact", badge: recentCount },
      { href: "/trash", label: "Trash Can", badge: trashCount },
    ],
    [recentCount, trashCount],
  );

  return (
    <aside
      className={`w-full border-b border-neutral-800 bg-neutral-950/90 p-4 transition-all duration-300 md:h-screen md:border-b-0 md:border-r ${
        isCollapsed ? "md:w-16 md:p-3" : "md:w-72 md:p-5"
      }`}
    >
      <div
        className={`mb-4 hidden items-center md:flex ${
          isCollapsed ? "justify-center" : "justify-between"
        }`}
      >
        <div className={isCollapsed ? "hidden" : "block"}>
          <p className="text-xs uppercase tracking-[0.2em] text-neutral-500">PM Navigation</p>
          <h2 className="mt-1 text-lg font-semibold text-neutral-100">Garbage Flow</h2>
        </div>
        <button
          type="button"
          aria-label={isCollapsed ? "Open sidebar" : "Close sidebar"}
          onClick={() => setIsCollapsed((prev) => !prev)}
          className={`rounded-md border border-neutral-700 bg-neutral-900/70 px-2 py-1 text-sm text-neutral-200 transition hover:border-neutral-500 hover:text-neutral-100 ${
            isCollapsed ? "mx-auto" : ""
          }`}
        >
          {isCollapsed ? ">" : "<"}
        </button>
      </div>

      <nav
        className={`grid grid-cols-1 gap-2 sm:grid-cols-3 md:grid-cols-1 ${isCollapsed ? "md:hidden" : ""}`}
        aria-label="Primary"
      >
        {navItems.map((item) => (
          <NavLink
            key={item.href}
            href={item.href}
            label={item.label}
            badge={item.badge}
            isActive={pathname === item.href}
          />
        ))}
      </nav>

      <div
        className={`mt-5 rounded-lg border border-neutral-800 bg-neutral-900/60 p-3 text-xs text-neutral-400 ${
          isCollapsed ? "md:hidden" : ""
        }`}
      >
        Delete actions from project and dashboard pages are soft deletes. Permanent delete is only available in Trash Can.
      </div>
    </aside>
  );
}
