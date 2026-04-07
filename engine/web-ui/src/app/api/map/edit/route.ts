import { NextResponse } from "next/server";
import type { MapEditRequest, MapEditResult, MapGraphPayload } from "@/lib/map-types";

export const runtime = "nodejs";

function badRequest(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

function applySimplePromptPatch(graph: MapGraphPayload, prompt: string): MapEditResult {
  const nextGraph: MapGraphPayload = {
    vertices: graph.vertices.map((vertex) => ({ ...vertex })),
    edges: graph.edges.map((edge) => ({ ...edge })),
    metadata: { ...(graph.metadata || {}) },
  };

  const renameMatch = prompt.match(/rename\s+node\s+(.+?)\s+to\s+(.+)/i);
  if (renameMatch) {
    const sourceLabel = renameMatch[1].trim();
    const targetLabel = renameMatch[2].trim();
    const target = nextGraph.vertices.find(
      (vertex) => vertex.id.toLowerCase() === sourceLabel.toLowerCase() || vertex.label.toLowerCase() === sourceLabel.toLowerCase(),
    );

    if (target) {
      target.label = targetLabel;
      return {
        changeSummary: `Renamed node ${sourceLabel} to ${targetLabel}.`,
        graph: nextGraph,
      };
    }
  }

  const removeEdgeMatch = prompt.match(/remove\s+edge\s+(.+)/i);
  if (removeEdgeMatch) {
    const edgeId = removeEdgeMatch[1].trim();
    const before = nextGraph.edges.length;
    nextGraph.edges = nextGraph.edges.filter((edge) => edge.id.toLowerCase() !== edgeId.toLowerCase());

    if (nextGraph.edges.length !== before) {
      return {
        changeSummary: `Removed edge ${edgeId}.`,
        graph: nextGraph,
      };
    }
  }

  // TODO(team-backend): replace this stub with model-driven JSON edit service.
  // Current behavior records prompt history and returns unchanged graph.
  const previousPrompts = Array.isArray(nextGraph.metadata?.promptHistory)
    ? (nextGraph.metadata?.promptHistory as string[])
    : [];

  nextGraph.metadata = {
    ...(nextGraph.metadata || {}),
    promptHistory: [...previousPrompts, prompt],
    lastEditPrompt: prompt,
  };

  return {
    changeSummary: "No structural patch rule matched. Prompt was recorded in metadata.promptHistory.",
    graph: nextGraph,
  };
}

export async function POST(request: Request) {
  let body: MapEditRequest;

  try {
    body = (await request.json()) as MapEditRequest;
  } catch {
    return badRequest("Invalid JSON payload.");
  }

  if (!body?.componentId?.trim()) {
    return badRequest("componentId is required.");
  }

  if (!body?.prompt?.trim()) {
    return badRequest("prompt is required.");
  }

  if (!body?.graph || !Array.isArray(body.graph.vertices) || !Array.isArray(body.graph.edges)) {
    return badRequest("graph with vertices and edges is required.");
  }

  try {
    const result = applySimplePromptPatch(body.graph, body.prompt.trim());
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to apply graph edit.";
    return badRequest(message, 500);
  }
}
