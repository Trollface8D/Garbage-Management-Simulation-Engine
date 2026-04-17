import type { SupportedUploadKind } from "./types";

export const UNSUPPORTED_FILE_ERROR_MESSAGE = "Unsupported file format. Please upload only .txt, .pdf, or audio files.";

function getFileNameLower(file: File): string {
    return file.name.toLowerCase();
}

function isAudioFile(file: File): boolean {
    return file.type.startsWith("audio/") || /\.(mp3|wav|m4a|ogg|flac|aac|webm)$/i.test(getFileNameLower(file));
}

function isPdfFile(file: File): boolean {
    return file.type === "application/pdf" || getFileNameLower(file).endsWith(".pdf");
}

function isTxtFile(file: File): boolean {
    return getFileNameLower(file).endsWith(".txt");
}

export function detectUploadKind(file: File): SupportedUploadKind | null {
    if (isAudioFile(file)) {
        return "audio";
    }

    if (isPdfFile(file)) {
        return "pdf";
    }

    if (isTxtFile(file)) {
        return "txt";
    }

    return null;
}
