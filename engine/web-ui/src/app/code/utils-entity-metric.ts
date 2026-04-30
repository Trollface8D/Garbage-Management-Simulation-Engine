/**
 * Utility functions for entity and metric management.
 * These are shared across multiple components to avoid duplication.
 */

export function makeSlug(value: string): string {
    const trimmed = value.trim().toLowerCase();
    if (!trimmed) {
        return "untitled";
    }

    return trimmed.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "untitled";
}

export function makeUniqueId(base: string, usedIds: Set<string>): string {
    let candidate = base;
    let seq = 2;
    while (usedIds.has(candidate)) {
        candidate = `${base}-${String(seq)}`;
        seq += 1;
    }
    usedIds.add(candidate);
    return candidate;
}

export function buildChunkTextsFromRawExtraction(rawExtraction: any[]): string[] {
    return rawExtraction.map((chunk, index) => {
        const joined = chunk.classes
            .map((classItem: any) => classItem.source_text?.trim() || "")
            .filter(Boolean)
            .join("\n\n")
            .trim();

        return joined || `Imported extraction chunk ${String(index + 1)}`;
    });
}

export function extractRawExtractionFromItem(item: any): any[] {
    const record = item as unknown as Record<string, unknown>;
    const { normalizeExtractionPayload } = require("./json-import-handler");

    const direct = normalizeExtractionPayload(item.rawExtraction);
    if (direct.length > 0) {
        return direct;
    }

    const snakeCase = normalizeExtractionPayload(record.raw_extraction);
    if (snakeCase.length > 0) {
        return snakeCase;
    }

    return normalizeExtractionPayload([item]);
}
