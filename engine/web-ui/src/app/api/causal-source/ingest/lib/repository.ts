import { and, eq, isNull } from "drizzle-orm";
import { getCausalSourceItem, saveTextChunks, upsertCausalSourceItem, type CausalSourceItem } from "@/lib/db";
import drizzleDb from "@/lib/db-modules/drizzle";
import {
    componentProjectLinks,
    componentTrash,
    projectComponents,
    projects,
    projectTrash,
} from "@/lib/db-modules/schema";
import type { SupportedSourceType, SupportedUploadKind } from "./types";

export function projectExists(projectId: string): boolean {
    const row = drizzleDb
        .select({ id: projects.id })
        .from(projects)
        .leftJoin(projectTrash, eq(projectTrash.projectId, projects.id))
        .where(and(eq(projects.id, projectId), isNull(projectTrash.projectId)))
        .limit(1)
        .get();

    return Boolean(row);
}

export function componentExists(projectId: string, componentId: string): boolean {
    const row = drizzleDb
        .select({ id: projectComponents.id })
        .from(projectComponents)
        .innerJoin(componentProjectLinks, eq(componentProjectLinks.componentId, projectComponents.id))
        .leftJoin(componentTrash, eq(componentTrash.componentId, projectComponents.id))
        .leftJoin(projectTrash, eq(projectTrash.projectId, componentProjectLinks.projectId))
        .where(
            and(
                eq(projectComponents.id, componentId),
                eq(componentProjectLinks.projectId, projectId),
                isNull(componentTrash.componentId),
                isNull(projectTrash.projectId),
            ),
        )
        .limit(1)
        .get();

    return Boolean(row);
}

type SaveSourceItemParams = {
    itemId: string;
    projectId: string;
    componentId: string;
    label: string;
    fileName: string;
    sourceType: SupportedSourceType;
    uploadKind: SupportedUploadKind;
    rawText: string;
    storedPath: string;
};

export function saveSourceItem(params: SaveSourceItemParams): CausalSourceItem {
    const {
        itemId,
        projectId,
        componentId,
        label,
        fileName,
        sourceType,
        uploadKind,
        rawText,
        storedPath,
    } = params;

    let saved: CausalSourceItem = upsertCausalSourceItem({
        id: itemId,
        projectId,
        componentId,
        label,
        fileName,
        sourceType,
        status: "raw_text",
        tags: ["uploaded", sourceType === "audio" ? "transcribed" : "parsed"],
        textContent: rawText,
        inputMode: "upload",
        storagePathOrBlob: storedPath,
        transcriptText: sourceType === "audio" ? rawText : null,
    });

    if (uploadKind === "txt") {
        saveTextChunks({
            experimentItemId: itemId,
            projectId,
            componentId,
            chunks: [rawText],
        });

        const refreshed = getCausalSourceItem(itemId);
        if (refreshed) {
            saved = refreshed;
        }
    }

    return saved;
}
