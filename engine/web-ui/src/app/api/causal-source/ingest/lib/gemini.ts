const GEMINI_MODEL = process.env.GEMINI_TRANSCRIBE_MODEL || "gemini-2.0-flash";

function resolveGeminiApiKey(): string | null {
    return process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || process.env.API_KEY || null;
}

function buildGeminiApiKeyErrorMessage(): string {
    return [
        "Gemini API key is missing.",
        "Set one of GEMINI_API_KEY, GOOGLE_API_KEY, or API_KEY in Engine/web-ui/.env.local",
        "(or set it in your shell environment) and restart npm run dev.",
    ].join(" ");
}

function extractGeminiText(payload: unknown): string {
    if (!payload || typeof payload !== "object") {
        return "";
    }

    const candidates = (payload as { candidates?: unknown[] }).candidates;
    if (!Array.isArray(candidates) || candidates.length === 0) {
        return "";
    }

    const first = candidates[0] as { content?: { parts?: Array<{ text?: string }> } };
    const parts = first?.content?.parts;
    if (!Array.isArray(parts)) {
        return "";
    }

    return parts
        .map((part) => (typeof part?.text === "string" ? part.text : ""))
        .join("\n")
        .trim();
}

async function runGeminiInlineDataPrompt(buffer: Buffer, mimeType: string, prompt: string): Promise<string> {
    const apiKey = resolveGeminiApiKey();
    if (!apiKey) {
        throw new Error(buildGeminiApiKeyErrorMessage());
    }

    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
        GEMINI_MODEL,
    )}:generateContent?key=${encodeURIComponent(apiKey)}`;

    const response = await fetch(endpoint, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            contents: [
                {
                    parts: [
                        { text: prompt },
                        {
                            inlineData: {
                                mimeType,
                                data: buffer.toString("base64"),
                            },
                        },
                    ],
                },
            ],
            generationConfig: {
                temperature: 0,
            },
        }),
    });

    if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(`Gemini request failed (${String(response.status)}): ${errorBody}`);
    }

    const payload = (await response.json()) as unknown;
    const text = extractGeminiText(payload);
    if (!text) {
        throw new Error("Gemini returned empty text.");
    }

    return text;
}

export async function transcribeAudioWithGemini(buffer: Buffer, mimeType: string, fileName: string): Promise<string> {
    return runGeminiInlineDataPrompt(
        buffer,
        mimeType || "audio/mpeg",
        `Transcribe this audio file verbatim to plain text. Keep original language and punctuation. File: ${fileName}`,
    );
}
