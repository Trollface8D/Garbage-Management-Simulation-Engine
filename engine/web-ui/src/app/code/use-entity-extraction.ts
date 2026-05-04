import { useRef, useState, useCallback } from "react";
import {
    groupEntitiesWithGemini,
    type SuggestedMetric,
} from "@/lib/code-gen-api-client";
import { type GeneratedEntity } from "./entity-extraction-panel";

/**
 * Custom hook for managing entity extraction, grouping, and state.
 * Keeps all entity-related logic separate from the main page component.
 */
export function useEntityExtraction() {
    const [entities, setEntities] = useState<GeneratedEntity[]>([]);
    const [isExtracted, setIsExtracted] = useState<boolean>(false);
    const [isExtracting, setIsExtracting] = useState<boolean>(false);
    const [extractError, setExtractError] = useState<string>("");
    const [isGroupingEntities, setIsGroupingEntities] = useState<boolean>(false);
    const [groupError, setGroupError] = useState<string>("");
    const [collapsedParentIds, setCollapsedParentIds] = useState<Set<string>>(new Set());
    const [groupLog, setGroupLog] = useState<
        Array<{ id: number; ts: number; level: "info" | "warn" | "error"; message: string }>
    >([]);

    const groupAbortRef = useRef<AbortController | null>(null);
    const groupLogIdRef = useRef<number>(0);
    const groupStartRef = useRef<number>(0);

    const appendGroupLog = useCallback(
        (level: "info" | "warn" | "error", message: string) => {
            groupLogIdRef.current += 1;
            const id = groupLogIdRef.current;
            setGroupLog((prev) => [...prev, { id, ts: Date.now(), level, message }]);
        },
        [],
    );

    const handleCancelGrouping = useCallback(() => {
        const controller = groupAbortRef.current;
        if (!controller) return;
        controller.abort();
        appendGroupLog("warn", "Cancel requested — aborting request");
    }, [appendGroupLog]);

    const handleGroupWithGemini = useCallback(
        (
            entities: GeneratedEntity[],
            selectedModel: string,
            inputsLocked: boolean,
        ) => {
            if (isGroupingEntities || inputsLocked) return;

            const originals = entities.filter((entity) => !entity.memberIds);
            if (originals.length === 0) {
                setGroupError("Extract entities first before grouping.");
                return;
            }

            setGroupError("");
            setGroupLog([]);
            setIsGroupingEntities(true);

            const counts: Record<string, number> = {};
            for (const entity of originals) {
                counts[entity.name] = (counts[entity.name] || 0) + entity.count;
            }

            const controller = new AbortController();
            groupAbortRef.current = controller;
            groupStartRef.current = Date.now();
            const distinctNames = Object.keys(counts).length;
            const modelLabel = selectedModel.trim() || "(env default)";

            appendGroupLog(
                "info",
                `Posting ${String(distinctNames)} distinct entities to ${modelLabel}…`,
            );

            (async () => {
                try {
                    const groups = await groupEntitiesWithGemini(
                        counts,
                        selectedModel,
                        controller.signal,
                    );
                    const elapsed = Math.round((Date.now() - groupStartRef.current) / 100) / 10;
                    appendGroupLog(
                        "info",
                        `Received ${String(groups.length)} groups in ${String(elapsed)}s`,
                    );

                    if (groups.length === 0) {
                        appendGroupLog("warn", "Gemini returned no groups");
                        setGroupError("Gemini returned no groups.");
                        return;
                    }

                    const byName = new Map<string, GeneratedEntity>();
                    for (const original of originals) {
                        const key = original.name.toLowerCase();
                        if (!byName.has(key)) byName.set(key, original);
                    }

                    const consumed = new Set<string>();
                    const parents: GeneratedEntity[] = [];
                    const updatedOriginals = new Map<string, GeneratedEntity>(
                        originals.map((o) => [o.id, { ...o, selected: false, parentId: undefined }]),
                    );

                    groups.forEach((group, idx) => {
                        const memberIds: string[] = [];
                        const parentSlug = group.canonical
                            .toLowerCase()
                            .replace(/[^a-z0-9]+/g, "-");
                        const parentId = `entity-canonical-${String(idx)}-${parentSlug}`;

                        for (const member of group.members) {
                            const original = byName.get(member.name.toLowerCase());
                            if (!original || consumed.has(original.id)) continue;
                            consumed.add(original.id);
                            memberIds.push(original.id);
                            updatedOriginals.set(original.id, {
                                ...(updatedOriginals.get(original.id) ?? original),
                                selected: false,
                                parentId,
                            });
                        }

                        if (memberIds.length === 0) return;
                        parents.push({
                            id: parentId,
                            name: group.canonical,
                            count: group.count,
                            selected: true,
                            memberIds,
                        });
                    });

                    if (parents.length === 0) {
                        appendGroupLog(
                            "warn",
                            "Returned groups did not match any extracted entity by name",
                        );
                        setGroupError("Gemini grouping did not match any current entities.");
                        return;
                    }

                    const ungroupedOriginals = originals
                        .filter((o) => !consumed.has(o.id))
                        .map((o) => ({ ...o, selected: true, parentId: undefined }));

                    const next: GeneratedEntity[] = [];
                    parents.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

                    for (const parent of parents) {
                        next.push(parent);
                        const memberSet = new Set(parent.memberIds);
                        const members = originals
                            .filter((o) => memberSet.has(o.id))
                            .map((o) => updatedOriginals.get(o.id) ?? o)
                            .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
                        next.push(...members);
                    }

                    next.push(
                        ...ungroupedOriginals.sort(
                            (a, b) => b.count - a.count || a.name.localeCompare(b.name),
                        ),
                    );

                    setEntities(next);
                    setCollapsedParentIds(new Set(parents.map((p) => p.id)));
                    appendGroupLog(
                        "info",
                        `Built ${String(parents.length)} parent groups, ${String(next.length - parents.length)} child rows`,
                    );
                } catch (err) {
                    if (
                        (err instanceof DOMException && err.name === "AbortError") ||
                        (err instanceof Error && err.name === "AbortError")
                    ) {
                        appendGroupLog("warn", "Request cancelled");
                        setGroupError("Grouping cancelled.");
                    } else {
                        const message =
                            err instanceof Error ? err.message : "Semantic grouping failed.";
                        appendGroupLog("error", message);
                        setGroupError(message);
                    }
                } finally {
                    groupAbortRef.current = null;
                    setIsGroupingEntities(false);
                }
            })();
        },
        [isGroupingEntities, appendGroupLog],
    );

    const handleToggleEntity = useCallback((targetId: string) => {
        setEntities((prev) =>
            prev.map((entity) =>
                entity.id === targetId ? { ...entity, selected: !entity.selected } : entity,
            ),
        );
    }, []);

    const handleAddManualEntity = useCallback(
        (name: string, inputsLocked: boolean) => {
            if (inputsLocked) return { error: "Inputs are locked" };

            const trimmed = name.trim();
            if (!trimmed) {
                return { error: "Type a name first." };
            }

            setEntities((prev) => {
                const exists = prev.some(
                    (entity) => entity.name.toLowerCase() === trimmed.toLowerCase(),
                );
                if (exists) {
                    return prev;
                }

                const slug = trimmed.toLowerCase().replace(/[^a-z0-9]+/g, "-");
                const newEntity: GeneratedEntity = {
                    id: `entity-manual-${String(Date.now())}-${slug}`,
                    name: trimmed,
                    count: 1,
                    selected: true,
                };
                return [...prev, newEntity];
            });

            setIsExtracted(true);
            return { success: true };
        },
        [],
    );

    return {
        // State
        entities,
        setEntities,
        isExtracted,
        setIsExtracted,
        isExtracting,
        setIsExtracting,
        extractError,
        setExtractError,
        isGroupingEntities,
        groupError,
        setGroupError,
        groupLog,
        setGroupLog,
        collapsedParentIds,
        setCollapsedParentIds,

        // Handlers
        handleGroupWithGemini,
        handleCancelGrouping,
        handleToggleEntity,
        handleAddManualEntity,
        appendGroupLog,
    };
}
