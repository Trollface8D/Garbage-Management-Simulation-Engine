import { randomUUID } from "crypto";
import { and, desc, eq } from "drizzle-orm";
import drizzleDb from "./drizzle";
import {
    codegenGeneratedFiles,
    codegenInputEntities,
    codegenRunMetrics,
    codegenRuns,
} from "./schema";

export type CodegenRunStatus = "queued" | "running" | "completed" | "failed" | "cancelled";
export type CodegenRunSourceType = "manual" | "derived_causal" | "follow_up" | "imported";
export type CodegenMetricType = "text" | "number" | "boolean" | "json";

export type CreateCodegenRunInput = {
    id?: string;
    projectId?: string;
    componentId?: string;
    causalProjectDocumentId?: string;
    sourceType?: CodegenRunSourceType;
    status?: CodegenRunStatus;
    model?: string;
    inputPrompt?: string;
    startedAt?: string;
};

export type RecordCodegenInputEntity = {
    id?: string;
    entityName: string;
    sourceCausalId?: string;
    sourceHead?: string;
    sourceRelationship?: string;
    sourceTail?: string;
    sourceDetail?: string;
};

export type RecordCodegenGeneratedFile = {
    id?: string;
    entityName: string;
    filePath: string;
    language?: string;
    fileSizeBytes?: number;
    generationOrder?: number;
};

export type UpsertCodegenMetricInput = {
    key: string;
    value: string | number | boolean | Record<string, unknown> | Array<unknown>;
    type?: CodegenMetricType;
};

export type CodegenRunRecord = {
    id: string;
    projectId: string | null;
    componentId: string | null;
    causalProjectDocumentId: string | null;
    sourceType: CodegenRunSourceType;
    status: CodegenRunStatus;
    model: string | null;
    inputPrompt: string | null;
    startedAt: string | null;
    finishedAt: string | null;
    durationMs: number | null;
    inputEntityCount: number;
    generatedEntityCount: number;
    generatedFileCount: number;
    errorMessage: string | null;
    createdAt: string;
    updatedAt: string;
};

function nowIso(): string {
    return new Date().toISOString();
}

function normalizeRunStatus(status: string | undefined): CodegenRunStatus {
    if (status === "running" || status === "completed" || status === "failed" || status === "cancelled") {
        return status;
    }
    return "queued";
}

function normalizeSourceType(sourceType: string | undefined): CodegenRunSourceType {
    if (sourceType === "derived_causal" || sourceType === "follow_up" || sourceType === "imported") {
        return sourceType;
    }
    return "manual";
}

function normalizeMetricType(metricType: string | undefined): CodegenMetricType {
    if (metricType === "number" || metricType === "boolean" || metricType === "json") {
        return metricType;
    }
    return "text";
}

function metricValueToText(value: UpsertCodegenMetricInput["value"], type: CodegenMetricType): string {
    if (type === "json") {
        return JSON.stringify(value);
    }

    if (type === "boolean") {
        return String(Boolean(value));
    }

    if (type === "number") {
        const numeric = typeof value === "number" ? value : Number(value);
        return Number.isFinite(numeric) ? String(numeric) : "0";
    }

    if (typeof value === "string") {
        return value;
    }

    return JSON.stringify(value);
}

function toCodegenRunRecord(row: {
    id: string;
    projectId: string | null;
    componentId: string | null;
    causalProjectDocumentId: string | null;
    sourceType: string;
    status: string;
    model: string | null;
    inputPrompt: string | null;
    startedAt: string | null;
    finishedAt: string | null;
    durationMs: number | null;
    inputEntityCount: number;
    generatedEntityCount: number;
    generatedFileCount: number;
    errorMessage: string | null;
    createdAt: string;
    updatedAt: string;
}): CodegenRunRecord {
    return {
        id: row.id,
        projectId: row.projectId,
        componentId: row.componentId,
        causalProjectDocumentId: row.causalProjectDocumentId,
        sourceType: normalizeSourceType(row.sourceType),
        status: normalizeRunStatus(row.status),
        model: row.model,
        inputPrompt: row.inputPrompt,
        startedAt: row.startedAt,
        finishedAt: row.finishedAt,
        durationMs: row.durationMs,
        inputEntityCount: row.inputEntityCount,
        generatedEntityCount: row.generatedEntityCount,
        generatedFileCount: row.generatedFileCount,
        errorMessage: row.errorMessage,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
    };
}

export function createCodegenRun(input: CreateCodegenRunInput): CodegenRunRecord {
    const createdAt = nowIso();
    const runId = (input.id ?? randomUUID()).trim();
    if (!runId) {
        throw new Error("Codegen run id is required.");
    }

    const sourceType = normalizeSourceType(input.sourceType);
    const status = normalizeRunStatus(input.status);

    drizzleDb
        .insert(codegenRuns)
        .values({
            id: runId,
            projectId: input.projectId?.trim() || null,
            componentId: input.componentId?.trim() || null,
            causalProjectDocumentId: input.causalProjectDocumentId?.trim() || null,
            sourceType,
            status,
            model: input.model?.trim() || null,
            inputPrompt: input.inputPrompt ?? null,
            startedAt: input.startedAt || (status === "running" ? createdAt : null),
            finishedAt: null,
            durationMs: null,
            inputEntityCount: 0,
            generatedEntityCount: 0,
            generatedFileCount: 0,
            errorMessage: null,
            createdAt,
            updatedAt: createdAt,
        })
        .run();

    return getCodegenRunById(runId) as CodegenRunRecord;
}

export function getCodegenRunById(runId: string): CodegenRunRecord | null {
    const trimmed = runId.trim();
    if (!trimmed) {
        return null;
    }

    const row = drizzleDb
        .select({
            id: codegenRuns.id,
            projectId: codegenRuns.projectId,
            componentId: codegenRuns.componentId,
            causalProjectDocumentId: codegenRuns.causalProjectDocumentId,
            sourceType: codegenRuns.sourceType,
            status: codegenRuns.status,
            model: codegenRuns.model,
            inputPrompt: codegenRuns.inputPrompt,
            startedAt: codegenRuns.startedAt,
            finishedAt: codegenRuns.finishedAt,
            durationMs: codegenRuns.durationMs,
            inputEntityCount: codegenRuns.inputEntityCount,
            generatedEntityCount: codegenRuns.generatedEntityCount,
            generatedFileCount: codegenRuns.generatedFileCount,
            errorMessage: codegenRuns.errorMessage,
            createdAt: codegenRuns.createdAt,
            updatedAt: codegenRuns.updatedAt,
        })
        .from(codegenRuns)
        .where(eq(codegenRuns.id, trimmed))
        .get();

    return row ? toCodegenRunRecord(row) : null;
}

export function listCodegenRunsForComponent(componentId: string, limit = 50): CodegenRunRecord[] {
    const trimmed = componentId.trim();
    if (!trimmed) {
        return [];
    }

    const safeLimit = Math.max(1, Math.min(limit, 1000));
    const rows = drizzleDb
        .select({
            id: codegenRuns.id,
            projectId: codegenRuns.projectId,
            componentId: codegenRuns.componentId,
            causalProjectDocumentId: codegenRuns.causalProjectDocumentId,
            sourceType: codegenRuns.sourceType,
            status: codegenRuns.status,
            model: codegenRuns.model,
            inputPrompt: codegenRuns.inputPrompt,
            startedAt: codegenRuns.startedAt,
            finishedAt: codegenRuns.finishedAt,
            durationMs: codegenRuns.durationMs,
            inputEntityCount: codegenRuns.inputEntityCount,
            generatedEntityCount: codegenRuns.generatedEntityCount,
            generatedFileCount: codegenRuns.generatedFileCount,
            errorMessage: codegenRuns.errorMessage,
            createdAt: codegenRuns.createdAt,
            updatedAt: codegenRuns.updatedAt,
        })
        .from(codegenRuns)
        .where(eq(codegenRuns.componentId, trimmed))
        .orderBy(desc(codegenRuns.createdAt))
        .limit(safeLimit)
        .all();

    return rows.map(toCodegenRunRecord);
}

export function markCodegenRunRunning(runId: string, startedAt?: string): boolean {
    const trimmed = runId.trim();
    if (!trimmed) {
        return false;
    }

    const now = nowIso();
    const result = drizzleDb
        .update(codegenRuns)
        .set({
            status: "running",
            startedAt: startedAt || now,
            updatedAt: now,
            errorMessage: null,
        })
        .where(eq(codegenRuns.id, trimmed))
        .run();

    return (result.changes ?? 0) > 0;
}

export function markCodegenRunCompleted(
    runId: string,
    input?: {
        finishedAt?: string;
        durationMs?: number;
        generatedEntityCount?: number;
        generatedFileCount?: number;
    },
): boolean {
    const trimmed = runId.trim();
    if (!trimmed) {
        return false;
    }

    const now = nowIso();
    const current = getCodegenRunById(trimmed);
    if (!current) {
        return false;
    }

    const finishedAt = input?.finishedAt || now;
    let durationMs = input?.durationMs;
    if (durationMs == null && current.startedAt) {
        const startedMillis = Date.parse(current.startedAt);
        const finishedMillis = Date.parse(finishedAt);
        if (Number.isFinite(startedMillis) && Number.isFinite(finishedMillis)) {
            durationMs = Math.max(0, finishedMillis - startedMillis);
        }
    }

    const generatedFileCount =
        input?.generatedFileCount ??
        drizzleDb
            .select({ count: codegenGeneratedFiles.id })
            .from(codegenGeneratedFiles)
            .where(eq(codegenGeneratedFiles.runId, trimmed))
            .all().length;

    drizzleDb
        .update(codegenRuns)
        .set({
            status: "completed",
            finishedAt,
            durationMs: durationMs ?? null,
            generatedEntityCount: input?.generatedEntityCount ?? current.generatedEntityCount,
            generatedFileCount,
            updatedAt: now,
            errorMessage: null,
        })
        .where(eq(codegenRuns.id, trimmed))
        .run();

    return true;
}

export function markCodegenRunFailed(runId: string, errorMessage: string, finishedAt?: string): boolean {
    const trimmed = runId.trim();
    if (!trimmed) {
        return false;
    }

    const now = nowIso();
    const result = drizzleDb
        .update(codegenRuns)
        .set({
            status: "failed",
            finishedAt: finishedAt || now,
            errorMessage: errorMessage.trim() || "Unknown codegen failure.",
            updatedAt: now,
        })
        .where(eq(codegenRuns.id, trimmed))
        .run();

    return (result.changes ?? 0) > 0;
}

export function saveCodegenInputEntities(runId: string, entities: RecordCodegenInputEntity[], replace = true): number {
    const trimmed = runId.trim();
    if (!trimmed) {
        throw new Error("runId is required.");
    }

    const now = nowIso();

    return drizzleDb.transaction((tx) => {
        if (replace) {
            tx.delete(codegenInputEntities).where(eq(codegenInputEntities.runId, trimmed)).run();
        }

        let inserted = 0;
        for (const entity of entities) {
            const name = entity.entityName.trim();
            if (!name) {
                continue;
            }

            tx
                .insert(codegenInputEntities)
                .values({
                    id: entity.id?.trim() || randomUUID(),
                    runId: trimmed,
                    entityName: name,
                    sourceCausalId: entity.sourceCausalId?.trim() || null,
                    sourceHead: entity.sourceHead?.trim() || null,
                    sourceRelationship: entity.sourceRelationship?.trim() || null,
                    sourceTail: entity.sourceTail?.trim() || null,
                    sourceDetail: entity.sourceDetail?.trim() || null,
                    createdAt: now,
                })
                .onConflictDoUpdate({
                    target: [codegenInputEntities.runId, codegenInputEntities.entityName],
                    set: {
                        sourceCausalId: entity.sourceCausalId?.trim() || null,
                        sourceHead: entity.sourceHead?.trim() || null,
                        sourceRelationship: entity.sourceRelationship?.trim() || null,
                        sourceTail: entity.sourceTail?.trim() || null,
                        sourceDetail: entity.sourceDetail?.trim() || null,
                        createdAt: now,
                    },
                })
                .run();

            inserted += 1;
        }

        tx
            .update(codegenRuns)
            .set({
                inputEntityCount: inserted,
                updatedAt: now,
            })
            .where(eq(codegenRuns.id, trimmed))
            .run();

        return inserted;
    });
}

export function saveCodegenGeneratedFiles(runId: string, files: RecordCodegenGeneratedFile[], replace = true): number {
    const trimmed = runId.trim();
    if (!trimmed) {
        throw new Error("runId is required.");
    }

    const now = nowIso();

    return drizzleDb.transaction((tx) => {
        if (replace) {
            tx.delete(codegenGeneratedFiles).where(eq(codegenGeneratedFiles.runId, trimmed)).run();
        }

        let inserted = 0;
        const uniqueEntities = new Set<string>();

        for (let index = 0; index < files.length; index += 1) {
            const file = files[index];
            const entityName = file.entityName.trim();
            const filePath = file.filePath.trim();
            if (!entityName || !filePath) {
                continue;
            }

            tx
                .insert(codegenGeneratedFiles)
                .values({
                    id: file.id?.trim() || randomUUID(),
                    runId: trimmed,
                    entityName,
                    filePath,
                    language: file.language?.trim() || null,
                    fileSizeBytes: typeof file.fileSizeBytes === "number" ? file.fileSizeBytes : null,
                    generationOrder: typeof file.generationOrder === "number" ? file.generationOrder : index,
                    createdAt: now,
                })
                .onConflictDoUpdate({
                    target: [codegenGeneratedFiles.runId, codegenGeneratedFiles.filePath],
                    set: {
                        entityName,
                        language: file.language?.trim() || null,
                        fileSizeBytes: typeof file.fileSizeBytes === "number" ? file.fileSizeBytes : null,
                        generationOrder: typeof file.generationOrder === "number" ? file.generationOrder : index,
                        createdAt: now,
                    },
                })
                .run();

            uniqueEntities.add(entityName);
            inserted += 1;
        }

        tx
            .update(codegenRuns)
            .set({
                generatedFileCount: inserted,
                generatedEntityCount: uniqueEntities.size,
                updatedAt: now,
            })
            .where(eq(codegenRuns.id, trimmed))
            .run();

        return inserted;
    });
}

export function upsertCodegenMetrics(runId: string, metrics: UpsertCodegenMetricInput[]): number {
    const trimmed = runId.trim();
    if (!trimmed) {
        throw new Error("runId is required.");
    }

    const now = nowIso();
    let upserted = 0;

    drizzleDb.transaction((tx) => {
        for (const metric of metrics) {
            const key = metric.key.trim();
            if (!key) {
                continue;
            }

            const metricType = normalizeMetricType(metric.type);
            const metricValue = metricValueToText(metric.value, metricType);

            tx
                .insert(codegenRunMetrics)
                .values({
                    id: `${trimmed}:${key}`,
                    runId: trimmed,
                    metricKey: key,
                    metricType,
                    metricValue,
                    createdAt: now,
                })
                .onConflictDoUpdate({
                    target: [codegenRunMetrics.runId, codegenRunMetrics.metricKey],
                    set: {
                        metricType,
                        metricValue,
                        createdAt: now,
                    },
                })
                .run();

            upserted += 1;
        }

        tx
            .update(codegenRuns)
            .set({
                updatedAt: now,
            })
            .where(eq(codegenRuns.id, trimmed))
            .run();
    });

    return upserted;
}

export function listCodegenGeneratedFiles(runId: string): Array<{
    id: string;
    runId: string;
    entityName: string;
    filePath: string;
    language: string | null;
    fileSizeBytes: number | null;
    generationOrder: number;
    createdAt: string;
}> {
    const trimmed = runId.trim();
    if (!trimmed) {
        return [];
    }

    return drizzleDb
        .select({
            id: codegenGeneratedFiles.id,
            runId: codegenGeneratedFiles.runId,
            entityName: codegenGeneratedFiles.entityName,
            filePath: codegenGeneratedFiles.filePath,
            language: codegenGeneratedFiles.language,
            fileSizeBytes: codegenGeneratedFiles.fileSizeBytes,
            generationOrder: codegenGeneratedFiles.generationOrder,
            createdAt: codegenGeneratedFiles.createdAt,
        })
        .from(codegenGeneratedFiles)
        .where(eq(codegenGeneratedFiles.runId, trimmed))
        .orderBy(codegenGeneratedFiles.generationOrder)
        .all();
}

export function listCodegenMetrics(runId: string): Array<{
    key: string;
    type: CodegenMetricType;
    value: string;
}> {
    const trimmed = runId.trim();
    if (!trimmed) {
        return [];
    }

    const rows = drizzleDb
        .select({
            key: codegenRunMetrics.metricKey,
            type: codegenRunMetrics.metricType,
            value: codegenRunMetrics.metricValue,
        })
        .from(codegenRunMetrics)
        .where(eq(codegenRunMetrics.runId, trimmed))
        .orderBy(codegenRunMetrics.metricKey)
        .all();

    return rows.map((row) => ({
        key: row.key,
        type: normalizeMetricType(row.type),
        value: row.value,
    }));
}

export function listCodegenRuns(
    input?: {
        projectId?: string;
        componentId?: string;
        status?: CodegenRunStatus;
        limit?: number;
    },
): CodegenRunRecord[] {
    const safeLimit = Math.max(1, Math.min(input?.limit ?? 200, 1000));

    const predicates = [];
    if (input?.projectId?.trim()) {
        predicates.push(eq(codegenRuns.projectId, input.projectId.trim()));
    }
    if (input?.componentId?.trim()) {
        predicates.push(eq(codegenRuns.componentId, input.componentId.trim()));
    }
    if (input?.status) {
        predicates.push(eq(codegenRuns.status, input.status));
    }

    const rows = drizzleDb
        .select({
            id: codegenRuns.id,
            projectId: codegenRuns.projectId,
            componentId: codegenRuns.componentId,
            causalProjectDocumentId: codegenRuns.causalProjectDocumentId,
            sourceType: codegenRuns.sourceType,
            status: codegenRuns.status,
            model: codegenRuns.model,
            inputPrompt: codegenRuns.inputPrompt,
            startedAt: codegenRuns.startedAt,
            finishedAt: codegenRuns.finishedAt,
            durationMs: codegenRuns.durationMs,
            inputEntityCount: codegenRuns.inputEntityCount,
            generatedEntityCount: codegenRuns.generatedEntityCount,
            generatedFileCount: codegenRuns.generatedFileCount,
            errorMessage: codegenRuns.errorMessage,
            createdAt: codegenRuns.createdAt,
            updatedAt: codegenRuns.updatedAt,
        })
        .from(codegenRuns)
        .where(predicates.length > 0 ? and(...predicates) : undefined)
        .orderBy(desc(codegenRuns.createdAt))
        .limit(safeLimit)
        .all();

    return rows.map(toCodegenRunRecord);
}
