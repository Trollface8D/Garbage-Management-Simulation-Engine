"use client";

import { type ChangeEvent } from "react";
import {
    type ExtractionPayloadRecord,
} from "@/lib/pm-storage";
import {
    type SimulationComponent,
    type SimulationProject,
} from "@/lib/simulation-components";

export type JsonImportItem = {
    id?: string;
    title?: string;
    name?: string;
    projectId?: string;
    projectName?: string;
    project?: string;
    lastEdited?: string;
    category?: string;
    sourceText?: string;
    rawExtraction?: ExtractionPayloadRecord[];
    extracted?: GeminiExtractedRelation[];
    pattern_type?: string;
    sentence_type?: string;
    marked_type?: string;
    explicit_type?: string;
    marker?: string;
    source_text?: string;
    head?: string;
    relationship?: string;
    tail?: string;
    detail?: string;
};

export type JsonImportProject = {
    id?: string;
    name?: string;
};

export type JsonImportPayload = {
    projects?: JsonImportProject[];
    causal?: JsonImportItem[];
    causalItems?: JsonImportItem[];
    map?: JsonImportItem[];
    mapItems?: JsonImportItem[];
    components?: JsonImportItem[];
};

type GeminiExtractedRelation = {
    head?: string;
    relationship?: string;
    tail?: string;
    detail?: string;
};

type JsonImportHandlerProps = {
    isImporting: boolean;
    importMessage: string;
    importError: string;
    onImportJsonFile: (event: ChangeEvent<HTMLInputElement>) => void;
};

export default function JsonImportHandler({
    isImporting,
    importMessage,
    importError,
    onImportJsonFile,
}: JsonImportHandlerProps) {
    return (
        <div className="fixed bottom-4 right-4 z-30">
            <input
                type="file"
                accept=".json,application/json"
                className="hidden"
                id="json-import-input"
                onChange={onImportJsonFile}
                disabled={isImporting}
            />

            <div className="flex flex-col items-end gap-2">
                {importMessage && (
                    <div className="max-w-xs rounded-md border border-emerald-800/70 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-200">
                        {importMessage}
                    </div>
                )}
                {importError && (
                    <div className="max-w-xs rounded-md border border-red-800/70 bg-red-500/10 px-3 py-2 text-xs text-red-200">
                        {importError}
                    </div>
                )}
                {isImporting && (
                    <div className="max-w-xs rounded-md border border-neutral-800 bg-neutral-950/60 px-3 py-2 text-xs text-neutral-200">
                        Importing JSON file…
                    </div>
                )}
            </div>
        </div>
    );
}

// Export types and utilities for use in parent component
export function sanitizeFilenameSegment(value: string): string {
    return value.replace(/[^a-z0-9._-]+/gi, "_").replace(/^_+|_+$/g, "") || "imported";
}

const isObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null;

const readText = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

const clip = (value: string, max: number): string =>
    value.length <= max ? value : `${value.slice(0, Math.max(0, max - 3))}...`;

const normalizeChunkLabel = (label: string, index: number): string => {
    const trimmed = label.trim();
    const match = /chunk\s*[-_]?\s*(\d+)/i.exec(trimmed);
    if (match) {
        return `chunk ${String(match[1])}`;
    }

    return `chunk ${String(index + 1)}`;
};

const normalizeExtractedRelation = (
    value: unknown,
): { head: string; relationship: string; tail: string; detail: string } | null => {
    if (!isObject(value)) {
        return null;
    }

    const head = readText(value.head);
    const relationship = readText(value.relationship);
    const tail = readText(value.tail);
    const detail = readText(value.detail);

    if (!head && !relationship && !tail && !detail) {
        return null;
    }

    return { head, relationship, tail, detail };
};

const normalizeExtractionClass = (
    value: unknown,
    fallbackSourceText: string,
): {
    pattern_type: string;
    sentence_type: string;
    marked_type: string;
    explicit_type: string;
    marker: string;
    source_text: string;
    extracted: Array<{ head: string; relationship: string; tail: string; detail: string }>;
} | null => {
    if (!isObject(value)) {
        return null;
    }

    const extractedSource = Array.isArray(value.extracted) ? value.extracted : [value];
    const extracted = extractedSource
        .map((entry) => normalizeExtractedRelation(entry))
        .filter(
            (entry): entry is { head: string; relationship: string; tail: string; detail: string } =>
                entry !== null,
        );

    if (extracted.length === 0) {
        return null;
    }

    return {
        pattern_type: readText(value.pattern_type),
        sentence_type: readText(value.sentence_type),
        marked_type: readText(value.marked_type),
        explicit_type: readText(value.explicit_type),
        marker: readText(value.marker),
        source_text: readText(value.source_text) || fallbackSourceText || extracted[0].head || "Imported source",
        extracted,
    };
};

export const normalizeExtractionPayload = (value: unknown): ExtractionPayloadRecord[] => {
    if (!Array.isArray(value)) {
        return [];
    }

    const hasChunkStructure = value.some(
        (entry) => isObject(entry) && (Array.isArray(entry.classes) || typeof entry.chunk_label === "string"),
    );

    if (hasChunkStructure) {
        return value
            .map((chunkEntry, index) => {
                if (!isObject(chunkEntry)) {
                    return null;
                }

                const classesInput = Array.isArray(chunkEntry.classes) ? chunkEntry.classes : [];
                const classes = classesInput
                    .map((classValue) => normalizeExtractionClass(classValue, ""))
                    .filter(
                        (classValue): classValue is {
                            pattern_type: string;
                            sentence_type: string;
                            marked_type: string;
                            explicit_type: string;
                            marker: string;
                            source_text: string;
                            extracted: Array<{ head: string; relationship: string; tail: string; detail: string }>;
                        } => classValue !== null,
                    );

                if (classes.length === 0) {
                    return null;
                }

                return {
                    chunk_label: normalizeChunkLabel(readText(chunkEntry.chunk_label), index),
                    classes,
                } satisfies ExtractionPayloadRecord;
            })
            .filter((chunk): chunk is ExtractionPayloadRecord => chunk !== null);
    }

    return value
        .map((classEntry, index) => {
            const normalizedClass = normalizeExtractionClass(classEntry, "");
            if (!normalizedClass) {
                return null;
            }

            return {
                chunk_label: `chunk ${String(index + 1)}`,
                classes: [normalizedClass],
            } satisfies ExtractionPayloadRecord;
        })
        .filter((chunk): chunk is ExtractionPayloadRecord => chunk !== null);
};

export const normalizeGeminiTranscriptArray = (
    input: unknown[],
    sourceFileName: string,
): JsonImportPayload => {
    const rawExtraction = normalizeExtractionPayload(input);
    const relationCount = rawExtraction.reduce(
        (total, chunk) =>
            total + chunk.classes.reduce((chunkTotal, classItem) => chunkTotal + classItem.extracted.length, 0),
        0,
    );

    const firstSourceText =
        rawExtraction
            .flatMap((chunk) => chunk.classes.map((classItem) => classItem.source_text))
            .find((text) => readText(text)) || "";

    if (relationCount === 0) {
        return { causalItems: [] };
    }

    const cleanFileName = sourceFileName.trim() || "imported-transcript.json";
    const baseName = cleanFileName.replace(/\.[^/.]+$/, "");
    const title = clip(cleanFileName || firstSourceText || "imported-transcript", 180);

    return {
        causalItems: [
            {
                id: `causal-gemini-file-${sanitizeFilenameSegment(baseName.toLowerCase())}`,
                title,
                lastEdited: "extracted",
                sourceText: firstSourceText,
                rawExtraction,
            },
        ],
    };
};

export const normalizeImportPayload = (
    value: unknown,
    sourceFileName: string,
): JsonImportPayload => {
    if (Array.isArray(value)) {
        const normalized = normalizeGeminiTranscriptArray(value, sourceFileName);
        if ((normalized.causalItems?.length ?? 0) > 0) {
            return normalized;
        }

        throw new Error(
            "Unsupported JSON array format. For array payloads, provide transcript items with an extracted list.",
        );
    }

    if (isObject(value)) {
        const record = value as Record<string, unknown>;
        const rawExtraction = normalizeExtractionPayload(record.raw_extraction);

        if (rawExtraction.length > 0) {
            const cleanFileName = sourceFileName.trim() || "imported-causal.json";
            const baseName = cleanFileName.replace(/\.[^/.]+$/, "");

            return {
                projects: Array.isArray(record.projects) ? (record.projects as JsonImportProject[]) : undefined,
                causalItems: [
                    {
                        id: `causal-file-${sanitizeFilenameSegment(baseName.toLowerCase())}`,
                        title: cleanFileName,
                        lastEdited: "extracted",
                        rawExtraction,
                    },
                ],
            };
        }

        return value as JsonImportPayload;
    }

    throw new Error("Invalid JSON format. Expected an object payload or transcript array payload.");
}
