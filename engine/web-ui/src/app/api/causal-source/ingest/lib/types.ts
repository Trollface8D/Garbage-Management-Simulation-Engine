import type { CausalSourceItem } from "@/lib/db";

export type SupportedSourceType = "text" | "audio";
export type SupportedUploadKind = "txt" | "pdf" | "audio";

export type ParsedIngestRequest = {
    projectId: string;
    componentId: string;
    label: string;
    file: File;
};

export type IngestSourceResult = {
    item: CausalSourceItem;
    rawTextLength: number;
};
