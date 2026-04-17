import { NextResponse } from "next/server";
import type { MapExtractionResult } from "@/lib/map-types";

export const runtime = "nodejs";

function badRequest(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

function resolveBackendBaseUrl(): string {
  const configured =
    process.env.BACKEND_API_BASE_URL ||
    process.env.NEXT_PUBLIC_BACKEND_API_BASE_URL ||
    "http://127.0.0.1:8000";

  return configured.replace(/\/+$/, "");
}

type MapStartResponse = {
  jobId: string;
  statusUrl: string;
  resultUrl: string;
};

type MapJobStatusResponse = {
  jobId: string;
  status: string;
  currentStage?: string | null;
  stageMessage?: string;
  error?: string | null;
};

async function parseErrorMessage(response: Response): Promise<string> {
  const fallback = `Request failed with status ${String(response.status)}`;
  try {
    const payload = (await response.json()) as { error?: string };
    return payload.error || fallback;
  } catch {
    return fallback;
  }
}

function toAbsoluteUrl(baseUrl: string, maybeRelative: string): string {
  return maybeRelative.startsWith("http") ? maybeRelative : `${baseUrl}${maybeRelative}`;
}

async function pollMapExtractResult(
  backendBaseUrl: string,
  urls: {
    statusUrl: string;
    resultUrl: string;
  },
): Promise<MapExtractionResult> {
  const pollIntervalMs = 1200;
  const maxAttempts = 300;
  const absoluteStatusUrl = toAbsoluteUrl(backendBaseUrl, urls.statusUrl);
  const absoluteResultUrl = toAbsoluteUrl(backendBaseUrl, urls.resultUrl);
  const pollStartedAt = Date.now();
  let lastStatus = "";
  let lastStage = "";

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const statusResponse = await fetch(absoluteStatusUrl, {
      method: "GET",
      cache: "no-store",
    });

    if (!statusResponse.ok) {
      throw new Error(await parseErrorMessage(statusResponse));
    }

    const statusPayload = (await statusResponse.json()) as MapJobStatusResponse;
    if (statusPayload.status !== lastStatus || (statusPayload.currentStage || "") !== lastStage) {
      console.info(
        "[map_extract][proxy] poll update",
        JSON.stringify({
          jobId: statusPayload.jobId,
          attempt,
          elapsedMs: Date.now() - pollStartedAt,
          status: statusPayload.status,
          stage: statusPayload.currentStage,
          stageMessage: statusPayload.stageMessage,
        }),
      );
      lastStatus = statusPayload.status;
      lastStage = statusPayload.currentStage || "";
    }

    if (statusPayload.status === "failed") {
      const stageInfo = statusPayload.currentStage ? ` at ${statusPayload.currentStage}` : "";
      throw new Error(statusPayload.error || `map_extract failed${stageInfo}.`);
    }

    if (statusPayload.status !== "completed") {
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
      continue;
    }

    const resultResponse = await fetch(absoluteResultUrl, {
      method: "GET",
      cache: "no-store",
    });
    if (!resultResponse.ok) {
      throw new Error(await parseErrorMessage(resultResponse));
    }
    console.info(
      "[map_extract][proxy] result fetched",
      JSON.stringify({
        elapsedMs: Date.now() - pollStartedAt,
        attempts: attempt + 1,
      }),
    );
    return (await resultResponse.json()) as MapExtractionResult;
  }

  throw new Error("map_extract job timed out while waiting for completion.");
}

export async function POST(request: Request) {
  const formData = await request.formData();

  const componentId = String(formData.get("componentId") || "").trim();
  const overviewAdditionalInformation = String(formData.get("overviewAdditionalInformation") || "").trim();
  const binAdditionalInformation = String(formData.get("binAdditionalInformation") || "").trim();
  const overviewMapFiles = formData.getAll("overviewMapFiles").filter((entry): entry is File => entry instanceof File);
  const binLocationFiles = formData.getAll("binLocationFiles").filter((entry): entry is File => entry instanceof File);

  if (!componentId) {
    return badRequest("componentId is required.");
  }

  if (overviewMapFiles.length === 0) {
    return badRequest("At least one overview map image is required.");
  }

  try {
    const requestStartedAt = Date.now();
    console.info(
      "[map_extract][proxy] request received",
      JSON.stringify({
        componentId,
        overviewMapFileCount: overviewMapFiles.length,
        binLocationFileCount: binLocationFiles.length,
      }),
    );

    const backendBaseUrl = resolveBackendBaseUrl();
    const backendStartUrl = `${backendBaseUrl}/map_extract/jobs`;

    const backendResponse = await fetch(backendStartUrl, {
      method: "POST",
      body: formData,
      cache: "no-store",
    });

    if (!backendResponse.ok) {
      return badRequest(await parseErrorMessage(backendResponse), backendResponse.status || 502);
    }

    const startPayload = (await backendResponse.json()) as MapStartResponse;
    console.info(
      "[map_extract][proxy] job started",
      JSON.stringify({
        jobId: startPayload.jobId,
        statusUrl: startPayload.statusUrl,
        resultUrl: startPayload.resultUrl,
      }),
    );

    const completedPayload = await pollMapExtractResult(backendBaseUrl, {
      statusUrl: startPayload.statusUrl,
      resultUrl: startPayload.resultUrl,
    });

    if (!completedPayload.jobId) {
      completedPayload.jobId = startPayload.jobId;
    }

    console.info(
      "[map_extract][proxy] completed",
      JSON.stringify({
        jobId: completedPayload.jobId,
        elapsedMs: Date.now() - requestStartedAt,
        vertexCount: completedPayload.graph?.vertices?.length,
        edgeCount: completedPayload.graph?.edges?.length,
      }),
    );

    return NextResponse.json(completedPayload);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to extract map graph.";
    console.error("[map_extract][proxy] failed", message);
    return badRequest(message, 500);
  }
}
