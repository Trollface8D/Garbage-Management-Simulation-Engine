import { badRequestError } from "./http-error";
import type { ParsedIngestRequest } from "./types";

export async function parseIngestRequest(request: Request): Promise<ParsedIngestRequest> {
    const formData = await request.formData();

    const projectId = String(formData.get("projectId") || "").trim();
    const componentId = String(formData.get("componentId") || "").trim();
    const label = String(formData.get("label") || "file upload").trim() || "file upload";
    const file = formData.get("file");

    if (!projectId || !componentId) {
        throw badRequestError("projectId and componentId are required.");
    }

    if (!(file instanceof File)) {
        throw badRequestError("file is required.");
    }

    if (file.size === 0) {
        throw badRequestError("Uploaded file is empty.");
    }

    return {
        projectId,
        componentId,
        label,
        file,
    };
}
