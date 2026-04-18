import { randomUUID } from "crypto";
import { badRequestError } from "./http-error";
import { detectUploadKind, UNSUPPORTED_FILE_ERROR_MESSAGE } from "./file-kind";
import { extractRawTextFromUploadedFile } from "./raw-text";
import { componentExists, projectExists, saveSourceItem } from "./repository";
import { deleteUploadedFile, saveUploadedFile } from "./storage";
import type { IngestSourceResult, ParsedIngestRequest, SupportedSourceType } from "./types";

export async function ingestUploadedSource(input: ParsedIngestRequest): Promise<IngestSourceResult> {
    const { projectId, componentId, label, file } = input;

    if (!projectExists(projectId)) {
        throw badRequestError(`projectId '${projectId}' was not found or is deleted.`);
    }

    if (!componentExists(projectId, componentId)) {
        throw badRequestError(`componentId '${componentId}' was not found in project '${projectId}' or is deleted.`);
    }

    const uploadKind = detectUploadKind(file);
    if (!uploadKind) {
        throw badRequestError(UNSUPPORTED_FILE_ERROR_MESSAGE);
    }

    const sourceType: SupportedSourceType = uploadKind === "audio" ? "audio" : "text";
    const itemId = randomUUID();
    let storedPath = "";

    try {
        const upload = await saveUploadedFile(file, itemId);
        storedPath = upload.storedPath;

        const rawText = (await extractRawTextFromUploadedFile(file, upload.buffer, uploadKind)).trim();
        if (!rawText) {
            throw badRequestError("No readable text could be extracted from uploaded file.");
        }

        const item = saveSourceItem({
            itemId,
            projectId,
            componentId,
            label,
            fileName: file.name,
            sourceType,
            uploadKind,
            rawText,
            storedPath,
        });

        return {
            item,
            rawTextLength: rawText.length,
        };
    } catch (error) {
        if (storedPath) {
            await deleteUploadedFile(storedPath);
        }

        throw error;
    }
}
