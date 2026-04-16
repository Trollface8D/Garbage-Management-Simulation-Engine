import { NextResponse } from "next/server";

export class HttpError extends Error {
    status: number;

    constructor(message: string, status = 400) {
        super(message);
        this.name = "HttpError";
        this.status = status;
    }
}

export function badRequestError(message: string): HttpError {
    return new HttpError(message, 400);
}

function asErrorMessage(error: unknown): string {
    if (error instanceof Error) {
        return error.message;
    }

    return String(error || "Failed to ingest source file.");
}

export function toHttpErrorResponse(error: unknown) {
    if (error instanceof HttpError) {
        return NextResponse.json({ error: error.message }, { status: error.status });
    }

    const message = asErrorMessage(error);

    if (/FOREIGN KEY constraint failed/i.test(message)) {
        return NextResponse.json(
            { error: "Selected project/component is invalid. Please reopen this artifact from PM dashboard." },
            { status: 400 },
        );
    }

    if (/PDF parser could not extract readable text|PDF is unreadable/i.test(message)) {
        return NextResponse.json({ error: message }, { status: 400 });
    }

    console.error("[causal-source/ingest]", message);
    return NextResponse.json({ error: message }, { status: 500 });
}
