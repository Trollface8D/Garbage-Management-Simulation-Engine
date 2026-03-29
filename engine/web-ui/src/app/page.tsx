"use client";

import Link from "next/link";
import { useMemo, useState } from "react";

type Category = "Causal" | "Follow_up" | "Map" | "Code" | "Policy_testing" ;
type FilterOption = "All" | Category;

type Collaborator = {
  name: string;
  initial: string;
  colorClass: string;
};

type SimulationComponent = {
  id: string;
  title: string;
  category: Category;
  lastEdited: string;
  collaborators: Collaborator[];
};

const filterOptions: FilterOption[] = ["All", "Causal", "Follow_up", "Map", "Code", "Policy_testing"];

const simulationComponents: SimulationComponent[] = [
  {
    id: "landfill-route-dynamics",
    title: "Landfill Route Dynamics",
    category: "Causal",
    lastEdited: "2 hours ago",
    collaborators: [
      { name: "Ploy", initial: "P", colorClass: "bg-pink-500" },
      { name: "Keen", initial: "K", colorClass: "bg-violet-500" },
      { name: "Boss", initial: "B", colorClass: "bg-sky-500" },
    ],
  },
  {
    id: "district-transfer-overview",
    title: "District Transfer Overview",
    category: "Map",
    lastEdited: "5 hours ago",
    collaborators: [
      { name: "Mint", initial: "M", colorClass: "bg-emerald-500" },
      { name: "Jai", initial: "J", colorClass: "bg-amber-500" },
      { name: "Ploy", initial: "P", colorClass: "bg-pink-500" },
    ],
  },
  {
    id: "optimization-engine-v2",
    title: "Optimization Engine v2",
    category: "Code",
    lastEdited: "8 hours ago",
    collaborators: [
      { name: "Keen", initial: "K", colorClass: "bg-violet-500" },
      { name: "Ball", initial: "L", colorClass: "bg-cyan-500" },
      { name: "Boss", initial: "B", colorClass: "bg-sky-500" },
    ],
  },
  {
    id: "cost-vs-time-benchmark",
    title: "Cost vs Time Benchmark",
    category: "Policy_testing",
    lastEdited: "10 hours ago",
    collaborators: [
      { name: "Nim", initial: "N", colorClass: "bg-orange-500" },
      { name: "Jai", initial: "J", colorClass: "bg-amber-500" },
      { name: "Keen", initial: "K", colorClass: "bg-violet-500" },
    ],
  },
  {
    id: "waste-source-feedback",
    title: "Waste Source Feedback",
    category: "Causal",
    lastEdited: "14 hours ago",
    collaborators: [
      { name: "Ploy", initial: "P", colorClass: "bg-pink-500" },
      { name: "Nim", initial: "N", colorClass: "bg-orange-500" },
      { name: "Boss", initial: "B", colorClass: "bg-sky-500" },
    ],
  },
  {
    id: "satellite-drop-map",
    title: "Satellite Drop Map",
    category: "Map",
    lastEdited: "16 hours ago",
    collaborators: [
      { name: "Mint", initial: "M", colorClass: "bg-emerald-500" },
      { name: "Boss", initial: "B", colorClass: "bg-sky-500" },
      { name: "Ploy", initial: "P", colorClass: "bg-pink-500" },
    ],
  },
  {
    id: "dispatcher-ruleset",
    title: "Dispatcher Ruleset",
    category: "Code",
    lastEdited: "20 hours ago",
    collaborators: [
      { name: "Ball", initial: "L", colorClass: "bg-cyan-500" },
      { name: "Jai", initial: "J", colorClass: "bg-amber-500" },
      { name: "Nim", initial: "N", colorClass: "bg-orange-500" },
    ],
  },
  {
    id: "fuel-and-delay-analysis",
    title: "Fuel and Delay Analysis",
    category: "Policy_testing",
    lastEdited: "24 hours ago",
    collaborators: [
      { name: "Keen", initial: "K", colorClass: "bg-violet-500" },
      { name: "Mint", initial: "M", colorClass: "bg-emerald-500" },
      { name: "Ploy", initial: "P", colorClass: "bg-pink-500" },
    ],
  },
  {
    id: "follow-up-qa-batch",
    title: "Follow-up Q&A Batch",
    category: "Follow_up",
    lastEdited: "1 hour ago",
    collaborators: [
      { name: "Ploy", initial: "P", colorClass: "bg-pink-500" },
      { name: "Keen", initial: "K", colorClass: "bg-violet-500" },
      { name: "Boss", initial: "B", colorClass: "bg-sky-500" },
    ],
  },
];

const categoryPath: Record<Category, string> = {
  Causal: "causal",
  Follow_up: "causal/follow_up",
  Map: "map",
  Code: "code",
  Policy_testing: "policy_testing",
};

function FileThumbPlaceholder() {
  return (
    <div className="relative h-40 w-full overflow-hidden rounded-t-xl border-b border-neutral-700 bg-neutral-800 p-3">
      <div className="mb-2 h-3 w-24 rounded bg-neutral-600/80" />
      <div className="grid h-[calc(100%-1.25rem)] grid-cols-3 gap-2">
        <div className="rounded bg-neutral-700/90 p-2">
          <div className="mb-1 h-1.5 w-8 rounded bg-neutral-500" />
          <div className="h-1.5 w-12 rounded bg-neutral-500" />
        </div>
        <div className="rounded bg-neutral-700/90 p-2">
          <div className="mb-1 h-1.5 w-9 rounded bg-neutral-500" />
          <div className="mb-1 h-1.5 w-11 rounded bg-neutral-500" />
          <div className="h-1.5 w-8 rounded bg-neutral-500" />
        </div>
        <div className="rounded bg-neutral-700/90 p-2">
          <div className="mb-1 h-1.5 w-10 rounded bg-neutral-500" />
          <div className="h-6 w-full rounded bg-neutral-600/80" />
        </div>
      </div>
    </div>
  );
}

function FileTypeIcon() {
  return (
    <span className="inline-flex h-5 w-5 items-center justify-center rounded bg-sky-600/20 text-xs font-semibold text-sky-300">
      F
    </span>
  );
}

export default function Home() {
  const [activeFilter, setActiveFilter] = useState<FilterOption>("All");

  const filteredComponents = useMemo(() => {
    if (activeFilter === "All") {
      return simulationComponents;
    }
    return simulationComponents.filter((component) => component.category === activeFilter);
  }, [activeFilter]);

  return (
    <div className="min-h-screen bg-[#1e1e1e] text-neutral-100">
      <main className="mx-auto w-full max-w-7xl px-5 py-8 md:px-8 md:py-10 lg:px-12">
        <header className="mb-10">
          <h1 className="text-left text-3xl font-black uppercase tracking-tight text-neutral-100 md:text-5xl lg:text-6xl">
            Garbage Flow Simulation Engine
          </h1>
        </header>

        <section className="mb-8 flex flex-col gap-4 rounded-2xl border border-neutral-800 bg-neutral-900/60 p-4 backdrop-blur-sm md:flex-row md:items-center md:justify-between">
          <div className="flex items-center gap-3">
            <label htmlFor="team-project" className="text-sm font-medium text-neutral-300">
              Team project
            </label>
            <select
              id="team-project"
              className="rounded-lg border border-neutral-700 bg-neutral-800 px-3 py-2 text-sm text-neutral-100 outline-none ring-offset-0 transition focus:border-sky-500"
              defaultValue="Garbage Management"
            >
              <option>Garbage Management</option>
              <option>Urban Waste Dynamics</option>
              <option>Regional Routing Lab</option>
            </select>
          </div>

          <nav className="flex flex-wrap items-center gap-2" aria-label="Category filters">
            {filterOptions.map((option) => {
              const isActive = option === activeFilter;

              return (
                <button
                  key={option}
                  type="button"
                  onClick={() => setActiveFilter(option)}
                  className={`rounded-md border px-3 py-1.5 text-sm font-semibold transition ${
                    isActive
                      ? "border-sky-500 bg-sky-500/20 text-sky-200"
                      : "border-neutral-700 bg-neutral-800 text-neutral-300 hover:border-neutral-500 hover:text-neutral-100"
                  }`}
                >
                  {option}
                </button>
              );
            })}
          </nav>
        </section>

        <section className="grid grid-cols-1 gap-5 md:grid-cols-3 lg:grid-cols-4 lg:gap-8">
          {filteredComponents.map((component) => {
            const targetPath = `/${categoryPath[component.category]}`;

            return (
              <Link
                key={component.id}
                href={targetPath}
                className="group overflow-hidden rounded-xl border border-neutral-700 bg-neutral-900/60 shadow-[0_0_0_1px_rgba(255,255,255,0.01)] transition duration-200 hover:scale-[1.02] hover:border-sky-500 hover:shadow-[0_0_0_2px_rgba(14,165,233,0.35)]"
              >
                <FileThumbPlaceholder />

                <div className="flex items-end justify-between gap-3 bg-neutral-900 px-4 py-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <FileTypeIcon />
                      <p className="truncate text-sm font-semibold text-neutral-100">{component.title}</p>
                    </div>
                    <p className="mt-1 text-xs text-neutral-400">Edited {component.lastEdited}</p>
                  </div>

                  <div className="flex items-center justify-end">
                    {component.collaborators.map((collaborator, index) => (
                      <span
                        key={collaborator.name}
                        className={`${collaborator.colorClass} ${index === 0 ? "" : "-ml-2"} inline-flex h-6 w-6 items-center justify-center rounded-full border border-neutral-900 text-[10px] font-bold text-white`}
                        title={collaborator.name}
                      >
                        {collaborator.initial}
                      </span>
                    ))}
                  </div>
                </div>
              </Link>
            );
          })}
        </section>
      </main>
    </div>
  );
}
