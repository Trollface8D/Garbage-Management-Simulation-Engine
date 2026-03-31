"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useMemo, useRef, useState } from "react";
import BackToHome from "../components/back-to-home";
import {
    findComponentById,
    getProjectIdForComponent,
    simulationProjects,
    type SimulationProject,
} from "@/lib/simulation-components";

type FeatureTab = "chunking" | "extract" | "follow_up";
type DataStatus = "raw_text" | "chunked" | "extracted";
type SourceType = "text" | "audio";

type ExperimentItem = {
    id: string;
    label: string;
    fileName: string;
    sourceType: SourceType;
    status: DataStatus;
    tags: string[];
};

const STATUS_RANK: Record<DataStatus, number> = {
    raw_text: 0,
    chunked: 1,
    extracted: 2,
};

const FEATURE_MIN_STATUS: Record<FeatureTab, DataStatus> = {
    chunking: "raw_text",
    extract: "chunked",
    follow_up: "extracted",
};

const STATUS_LABEL: Record<DataStatus, string> = {
    raw_text: "raw_text",
    chunked: "chunked",
    extracted: "extracted",
};

const FEATURE_PATH: Record<FeatureTab, string> = {
    chunking: "/causal_extract/chunking",
    extract: "/causal_extract/extract",
    follow_up: "/causal_extract/follow_up",
};

function buildExperimentItems(componentTitle: string): ExperimentItem[] {
    const baseFile = `${componentTitle.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "plan"}.txt`;

    return [
        {
            id: "text-raw-1",
            label: "text upload",
            fileName: baseFile,
            sourceType: "text",
            status: "raw_text",
            tags: ["raw input"],
        },
        {
            id: "audio-raw-1",
            label: "audio upload",
            fileName: "meeting-note.m4a",
            sourceType: "audio",
            status: "raw_text",
            tags: ["raw transcript"],
        },
        {
            id: "chunked-1",
            label: "chunk output",
            fileName: baseFile,
            sourceType: "text",
            status: "chunked",
            tags: ["chunk 1-8", "ready for extract"],
        },
        {
            id: "extracted-1",
            label: "causal",
            fileName: baseFile,
            sourceType: "text",
            status: "extracted",
            tags: ["extracted", "implicit"],
        },
        {
            id: "extracted-2",
            label: "causal",
            fileName: baseFile,
            sourceType: "text",
            status: "extracted",
            tags: ["extracted", "explicit"],
        },
    ];
}

function CausalExtractHomeContent() {
    const searchParams = useSearchParams();

    const componentId = searchParams.get("componentId");
    const queryTitle = searchParams.get("title");
    const queryProjectId = searchParams.get("projectId");

    const selectedComponent = useMemo(() => findComponentById(componentId), [componentId]);
    const selectedTitle = queryTitle ?? selectedComponent?.title ?? "Causal Experiment";
    const defaultProjectId = queryProjectId ?? getProjectIdForComponent(componentId) ?? simulationProjects[0]?.id ?? "";

    const [projects, setProjects] = useState<SimulationProject[]>(simulationProjects);
    const [selectedProjectId, setSelectedProjectId] = useState<string>(defaultProjectId);
    const [activeFeature, setActiveFeature] = useState<FeatureTab>("chunking");
    const [includeImplicit, setIncludeImplicit] = useState<boolean>(true);
    const [inputText, setInputText] = useState<string>("");
    const [uploadedFiles, setUploadedFiles] = useState<File[]>([]);
    const filePickerRef = useRef<HTMLInputElement | null>(null);

    const selectedProjectName =
        projects.find((project) => project.id === selectedProjectId)?.name ?? "Unselected project";

    const experimentItems = useMemo(() => buildExperimentItems(selectedTitle), [selectedTitle]);

    const visibleItems = useMemo(() => {
        const minStatus = FEATURE_MIN_STATUS[activeFeature];

        return experimentItems.filter((item) => {
            if (STATUS_RANK[item.status] < STATUS_RANK[minStatus]) {
                return false;
            }

            if (activeFeature === "follow_up" && !includeImplicit && item.tags.includes("implicit")) {
                return false;
            }

            return true;
        });
    }, [activeFeature, experimentItems, includeImplicit]);

    const handleOpenFilePicker = () => {
        filePickerRef.current?.click();
    };

    const handleFilesSelected = (event: React.ChangeEvent<HTMLInputElement>) => {
        const picked = Array.from(event.target.files ?? []);
        if (picked.length === 0) {
            return;
        }

        setUploadedFiles((prev) => [...prev, ...picked]);
        event.currentTarget.value = "";
    };

    const handleRemoveFile = (targetIndex: number) => {
        setUploadedFiles((prev) => prev.filter((_, index) => index !== targetIndex));
    };

    const handleProjectChange = (value: string) => {
        if (value !== "__add_new__") {
            setSelectedProjectId(value);
            return;
        }

        const nextNameRaw = window.prompt("Enter new project name:");
        const nextName = nextNameRaw?.trim();
        if (!nextName) {
            return;
        }

        const existingByName = projects.find((project) => project.name.toLowerCase() === nextName.toLowerCase());
        if (existingByName) {
            setSelectedProjectId(existingByName.id);
            return;
        }

        const slugBase = nextName
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-+|-+$/g, "");

        let nextId = slugBase || `project-${String(projects.length + 1)}`;
        let index = 2;
        while (projects.some((project) => project.id === nextId)) {
            nextId = `${slugBase || "project"}-${String(index)}`;
            index += 1;
        }

        const nextProject: SimulationProject = { id: nextId, name: nextName };
        setProjects((prev) => [nextProject, ...prev]);
        setSelectedProjectId(nextProject.id);
    };

    const activeFeaturePath = FEATURE_PATH[activeFeature];

    return (
        <div className="min-h-screen bg-[#1e1e1e] text-neutral-100">
            <main className="mx-auto w-full max-w-7xl px-5 py-8 md:px-8 md:py-10 lg:px-12">
                <header className="mb-6 flex flex-wrap items-center justify-between gap-3">
                    <h1 className="text-left text-3xl font-black uppercase tracking-tight text-neutral-100 md:text-5xl lg:text-6xl">
                        Garbage Flow Simulation Engine
                    </h1>
                    <div className="mt-5 flex flex-wrap items-center gap-3">
                        <label htmlFor="causal-project-picker" className="text-sm font-semibold text-neutral-300">
                            Project
                        </label>
                        <select
                            id="causal-project-picker"
                            value={selectedProjectId}
                            onChange={(event) => handleProjectChange(event.target.value)}
                            className="rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-100 outline-none transition focus:border-sky-500"
                        >
                            <option value="__add_new__">+ Add new project</option>
                            {projects.map((project) => (
                                <option key={project.id} value={project.id}>
                                    {project.name}
                                </option>
                            ))}
                        </select>
                        <span className="text-xs text-neutral-400">{selectedProjectName}</span>
                    </div>
                    <BackToHome
                        containerClassName=""
                        className="rounded-md px-3 py-2"
                    />
                </header>

                <section className="grid gap-6 lg:grid-cols-[280px_1fr]">
                    <aside className="rounded-xl border border-neutral-800 bg-neutral-900/60 p-4">
                        <h2 className="text-2xl font-bold text-neutral-100">Input section</h2>
                        <label htmlFor="causal-input" className="mt-5 block text-sm text-neutral-300">
                            Text document
                        </label>
                        <textarea
                            id="causal-input"
                            value={inputText}
                            onChange={(event) => setInputText(event.target.value)}
                            placeholder="input text here"
                            className="mt-2 min-h-28 w-full rounded-md border border-neutral-700 bg-neutral-800 p-3 text-sm text-neutral-100 outline-none transition focus:border-sky-500"
                        />

                        <div className="mt-4 flex flex-wrap items-center gap-2">
                            <button
                                type="button"
                                onClick={handleOpenFilePicker}
                                className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-neutral-600 bg-neutral-800 text-xl leading-none text-neutral-200 transition hover:border-sky-500"
                                aria-label="Add files"
                            >
                                +
                            </button>
                            <input
                                ref={filePickerRef}
                                type="file"
                                multiple
                                onChange={handleFilesSelected}
                                className="hidden"
                            />
                            {uploadedFiles.map((file, index) => (
                                <span
                                    key={`${file.name}-${String(file.size)}-${String(file.lastModified)}-${String(index)}`}
                                    className="inline-flex items-center gap-2 rounded-md border border-neutral-700 bg-neutral-800 px-2 py-1 text-xs text-neutral-200"
                                >
                                    <span>{file.name}</span>
                                    <button
                                        type="button"
                                        onClick={() => handleRemoveFile(index)}
                                        className="rounded px-1 text-xs font-bold text-neutral-300 transition hover:bg-neutral-700 hover:text-red-300"
                                        aria-label={`Remove ${file.name}`}
                                    >
                                        x
                                    </button>
                                </span>
                            ))}
                        </div>

                        <button
                            type="button"
                            className="mt-4 rounded-md border border-neutral-700 bg-neutral-800 px-4 py-2 text-sm font-semibold text-neutral-100 transition hover:border-sky-500"
                        >
                            RUN
                        </button>
                    </aside>

                    <section className="rounded-xl border border-neutral-700 bg-neutral-900/50 p-4">
                        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                            <div className="flex flex-wrap items-center gap-2">
                                {(["chunking", "extract", "follow_up"] as FeatureTab[]).map((feature) => {
                                    const isActive = feature === activeFeature;
                                    const label = feature === "follow_up" ? "follow_up" : feature;

                                    return (
                                        <button
                                            key={feature}
                                            type="button"
                                            onClick={() => setActiveFeature(feature)}
                                            className={`rounded-md border px-4 py-2 text-sm font-semibold transition ${isActive
                                                    ? "border-sky-500 bg-sky-500/25 text-sky-100"
                                                    : "border-neutral-700 bg-neutral-800 text-neutral-300 hover:border-neutral-500"
                                                }`}
                                        >
                                            {label}
                                        </button>
                                    );
                                })}
                            </div>

                            {activeFeature === "follow_up" && (
                                <label className="inline-flex items-center gap-2 rounded-md border border-neutral-700 bg-neutral-800 px-3 py-2 text-sm text-neutral-200">
                                    <span>Toggle implicit causal</span>
                                    <button
                                        type="button"
                                        onClick={() => setIncludeImplicit((prev) => !prev)}
                                        className={`rounded px-3 py-1 text-xs font-bold ${includeImplicit ? "bg-emerald-500/25 text-emerald-200" : "bg-neutral-700 text-neutral-200"
                                            }`}
                                    >
                                        {includeImplicit ? "ON" : "OFF"}
                                    </button>
                                </label>
                            )}
                        </div>

                        <div className="space-y-3">
                            {visibleItems.map((item) => (
                                <Link
                                    key={item.id}
                                    href={{
                                        pathname: activeFeaturePath,
                                        query: {
                                            componentId: componentId ?? "",
                                            title: selectedTitle,
                                            projectId: selectedProjectId,
                                            itemId: item.id,
                                            itemStatus: item.status,
                                            sourceType: item.sourceType,
                                            fileName: item.fileName,
                                        },
                                    }}
                                    className="block rounded-lg border border-neutral-700 bg-neutral-900/80 p-4 transition hover:border-sky-500/70"
                                >
                                    <div className="flex flex-wrap items-start justify-between gap-3">
                                        <div>
                                            <p className="text-sm font-semibold text-neutral-100">{item.label}</p>
                                            <p className="mt-1 text-sm text-neutral-400">{item.fileName}</p>
                                        </div>
                                        <div>
                                            <p className="text-xs font-semibold uppercase tracking-wide text-neutral-400">Status</p>
                                            <p className="text-sm text-neutral-200">{STATUS_LABEL[item.status]}</p>
                                        </div>
                                    </div>
                                    <div className="mt-3 flex flex-wrap gap-2">
                                        {item.tags.map((tag) => (
                                            <span key={`${item.id}-${tag}`} className="rounded-md border border-neutral-700 bg-neutral-800 px-2 py-1 text-xs text-neutral-300">
                                                {tag}
                                            </span>
                                        ))}
                                    </div>
                                </Link>
                            ))}
                        </div>

                        <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
                            <p className="text-xs text-neutral-400">
                                Current component: <span className="font-semibold text-neutral-200">{selectedTitle}</span>
                            </p>
                            <p className="text-xs text-neutral-400">
                                Click any item card above to open {activeFeature === "follow_up" ? "follow-up" : activeFeature} for that item.
                            </p>
                        </div>
                    </section>
                </section>
            </main>
        </div>
    );
}

export default function CausalExtractHomePage() {
    return (
        <Suspense fallback={<div className="min-h-screen bg-[#1e1e1e] text-neutral-100" />}>
            <CausalExtractHomeContent />
        </Suspense>
    );
}
