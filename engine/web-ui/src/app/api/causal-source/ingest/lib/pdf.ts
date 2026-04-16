type PdfJsModule = {
    getDocument: (source: unknown) => {
        promise: Promise<{
            numPages: number;
            getPage: (pageNumber: number) => Promise<{
                getTextContent: (options?: unknown) => Promise<{
                    items: Array<{ str?: string; hasEOL?: boolean }>;
                }>;
                cleanup?: () => void;
            }>;
            cleanup?: () => void;
            destroy?: () => Promise<void>;
        }>;
        destroy?: () => Promise<void>;
    };
};

type PdfParseModule = {
    PDFParse: new (options: { data: Uint8Array }) => {
        getText: () => Promise<{ text?: string }>;
        destroy: () => Promise<void>;
    };
};

let pdfJsModulePromise: Promise<PdfJsModule> | null = null;
let pdfParseModulePromise: Promise<PdfParseModule> | null = null;

function asErrorMessage(error: unknown): string {
    if (error instanceof Error) {
        return error.message;
    }

    return String(error);
}

function normalizeExtractedText(text: string): string {
    return text
        .replace(/\r/g, "")
        .replace(/[ \t]+\n/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}

function buildUnreadablePdfErrorMessage(fileName: string): string {
    return [
        `PDF parser could not extract readable text from '${fileName}'.`,
        "Possible causes: scanned/image-only PDF, encrypted/password-protected PDF, corrupted PDF,",
        "or non-Unicode embedded fonts (common in some pdfmake exports).",
        "Please re-export as searchable PDF with embedded Unicode fonts, or upload .txt.",
    ].join(" ");
}

async function loadPdfJsModule(): Promise<PdfJsModule> {
    if (!pdfJsModulePromise) {
        pdfJsModulePromise = import("pdfjs-dist/legacy/build/pdf.mjs") as Promise<PdfJsModule>;
    }

    return pdfJsModulePromise;
}

async function loadPdfParseModule(): Promise<PdfParseModule> {
    if (!pdfParseModulePromise) {
        pdfParseModulePromise = import("pdf-parse") as Promise<PdfParseModule>;
    }

    return pdfParseModulePromise;
}

async function extractPdfWithPdfJs(buffer: Buffer): Promise<string> {
    const pdfjsModule = await loadPdfJsModule();
    const loadingTask = pdfjsModule.getDocument({
        data: new Uint8Array(buffer),
        disableWorker: true,
    });
    const doc = await loadingTask.promise;

    try {
        const pages: string[] = [];

        for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber += 1) {
            const page = await doc.getPage(pageNumber);
            const textContent = await page.getTextContent({ disableNormalization: false });

            const pageText = textContent.items
                .map((item) => {
                    const text = typeof item.str === "string" ? item.str : "";
                    return item.hasEOL ? `${text}\n` : text;
                })
                .join(" ")
                .trim();

            if (pageText) {
                pages.push(pageText);
            }

            page.cleanup?.();
        }

        return normalizeExtractedText(pages.join("\n\n"));
    } finally {
        doc.cleanup?.();
        await doc.destroy?.().catch(() => undefined);
        await loadingTask.destroy?.().catch(() => undefined);
    }
}

async function extractPdfWithPdfParse(buffer: Buffer): Promise<string> {
    const pdfParseModule = await loadPdfParseModule();
    const parser = new pdfParseModule.PDFParse({ data: new Uint8Array(buffer) });

    try {
        const parsed = await parser.getText();
        return normalizeExtractedText(parsed?.text || "");
    } finally {
        await parser.destroy().catch(() => undefined);
    }
}

export async function extractPdfWithLocalParser(buffer: Buffer, fileName: string): Promise<string> {
    try {
        const text = await extractPdfWithPdfJs(buffer);
        if (!text) {
            throw new Error("empty extracted text");
        }

        return text;
    } catch (error) {
        console.warn("[causal-source/ingest][pdf] local parser failed", {
            fileName,
            parserError: asErrorMessage(error),
        });
    }

    try {
        const fallbackText = await extractPdfWithPdfParse(buffer);
        if (!fallbackText) {
            throw new Error("empty extracted text");
        }

        return fallbackText;
    } catch (fallbackError) {
        console.warn("[causal-source/ingest][pdf] fallback parser failed", {
            fileName,
            parserError: asErrorMessage(fallbackError),
        });
        throw new Error(buildUnreadablePdfErrorMessage(fileName));
    }
}
