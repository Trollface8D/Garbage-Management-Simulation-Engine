function resolveBackendBaseUrl(): string {
    const configured =
        process.env.BACKEND_API_BASE_URL ||
        process.env.NEXT_PUBLIC_BACKEND_API_BASE_URL ||
        "http://127.0.0.1:8000";

    return configured.replace(/\/+$/, "");
}

type BackendTranscribeResponse = {
    text?: string;
    error?: string;
};

export async function transcribeAudioViaBackend(
    buffer: Buffer,
    mimeType: string,
    fileName: string,
    model?: string,
): Promise<string> {
    const backendUrl = `${resolveBackendBaseUrl()}/transcribe/audio`;

    const audioBytes = new Uint8Array(buffer);
    const audioBlob = new Blob([audioBytes], { type: mimeType || "audio/mpeg" });
    const formData = new FormData();
    formData.set("audioFile", audioBlob, fileName || "audio-upload.bin");
    if (model && model.trim()) {
        formData.set("model", model.trim());
    }

    let response: Response;
    try {
        response = await fetch(backendUrl, {
            method: "POST",
            body: formData,
            cache: "no-store",
        });
    } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(
            `Failed to reach backend transcription endpoint at ${backendUrl}. ` +
                `Make sure Python backend API is running. Detail: ${detail}`,
        );
    }

    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("application/json")) {
        const rawBody = await response.text();
        throw new Error(
            `Backend returned non-JSON response for transcription (${String(response.status)}): ${rawBody}`,
        );
    }

    const payload = (await response.json()) as BackendTranscribeResponse;

    if (!response.ok) {
        throw new Error(payload.error || `Backend transcription failed with status ${String(response.status)}.`);
    }

    const text = (payload.text || "").trim();
    if (!text) {
        throw new Error("Backend transcription returned empty text.");
    }

    return text;
}
