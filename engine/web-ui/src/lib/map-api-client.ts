import type {
  MapEditRequest,
  MapEditResult,
  MapExtractionRequest,
  MapExtractionResult,
} from "@/lib/map-types";

const DEFAULT_EXTRACT_ENDPOINT = "/api/map/extract";
const DEFAULT_EDIT_ENDPOINT = "/api/map/edit";

function getExtractEndpoint(): string {
  // TODO(team-backend): set NEXT_PUBLIC_MAP_EXTRACT_ENDPOINT when backend endpoint is ready.
  return process.env.NEXT_PUBLIC_MAP_EXTRACT_ENDPOINT || DEFAULT_EXTRACT_ENDPOINT;
}

function getEditEndpoint(): string {
  // TODO(team-backend): set NEXT_PUBLIC_MAP_EDIT_ENDPOINT when backend endpoint is ready.
  return process.env.NEXT_PUBLIC_MAP_EDIT_ENDPOINT || DEFAULT_EDIT_ENDPOINT;
}

function getAuthHeaders(): Record<string, string> {
  // TODO(auth): Electron window app currently has no auth.
  // Keep this hook so token-based auth can be added later without changing page logic.
  return {};
}

async function parseErrorMessage(response: Response): Promise<string> {
  const fallback = `Request failed with status ${String(response.status)}`;

  try {
    const payload = (await response.json()) as { error?: string };
    return payload.error || fallback;
  } catch {
    return fallback;
  }
}

export async function extractMapGraph(input: MapExtractionRequest): Promise<MapExtractionResult> {
  const formData = new FormData();
  formData.set("componentId", input.componentId);
  formData.set("overviewAdditionalInformation", input.overviewAdditionalInformation);
  formData.set("binAdditionalInformation", input.binAdditionalInformation);

  for (const file of input.overviewMapFiles) {
    formData.append("overviewMapFiles", file);
  }

  for (const file of input.binLocationFiles) {
    formData.append("binLocationFiles", file);
  }

  const response = await fetch(getExtractEndpoint(), {
    method: "POST",
    headers: {
      ...getAuthHeaders(),
    },
    body: formData,
  });

  if (!response.ok) {
    throw new Error(await parseErrorMessage(response));
  }

  return (await response.json()) as MapExtractionResult;
}

export async function editMapGraph(input: MapEditRequest): Promise<MapEditResult> {
  const response = await fetch(getEditEndpoint(), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...getAuthHeaders(),
    },
    body: JSON.stringify(input),
  });

  if (!response.ok) {
    throw new Error(await parseErrorMessage(response));
  }

  return (await response.json()) as MapEditResult;
}
