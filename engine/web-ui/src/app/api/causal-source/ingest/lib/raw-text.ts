import { UNSUPPORTED_FILE_ERROR_MESSAGE } from "./file-kind";
import { transcribeAudioViaBackend } from "./backend-transcribe";
import { extractPdfWithLocalParser } from "./pdf";
import type { SupportedUploadKind } from "./types";

export async function extractRawTextFromUploadedFile(
    file: File,
    buffer: Buffer,
    uploadKind: SupportedUploadKind,
): Promise<string> {
    if (uploadKind === "audio") {
        return transcribeAudioViaBackend(buffer, file.type, file.name);
    }

    if (uploadKind === "pdf") {
        return extractPdfWithLocalParser(buffer, file.name);
    }

    if (uploadKind === "txt") {
        return buffer.toString("utf8").trim();
    }

    throw new Error(UNSUPPORTED_FILE_ERROR_MESSAGE);
}
