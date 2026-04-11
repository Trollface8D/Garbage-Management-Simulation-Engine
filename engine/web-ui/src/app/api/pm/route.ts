import { NextResponse } from "next/server";
import type { SimulationComponent, SimulationProject } from "@/lib/simulation-components";
import {
  createComponent,
  createProject,
  deleteCausalSourceItem,
  getCausalArtifactsForItem,
  getCausalSourceItem,
  hardDeleteComponent,
  hardDeleteProject,
  listCausalSourceItems,
  listComponents,
  listDeletedComponents,
  listDeletedProjects,
  listLatestTextChunkRecordsForExperimentItem,
  listLatestTextChunksForExperimentItem,
  listLatestChunkExtractionsForExperimentItem,
  listProjects,
  listRecents,
  migrateLegacyData,
  restoreComponent,
  restoreProject,
  saveCausalArtifacts,
  softDeleteComponent,
  softDeleteProject,
  saveTextChunks,
  trackRecent,
  upsertCausalSourceItem,
} from "../../../lib/db";

export const runtime = "nodejs";

type PMResource =
  | "projects"
  | "components"
  | "trash-projects"
  | "trash-components"
  | "recents"
  | "causal-source-items"
  | "causal-source-item"
  | "text-chunks"
  | "text-chunk-records"
  | "chunk-extractions"
  | "causal-artifacts";

type PMAction =
  | "create-project"
  | "create-component"
  | "migrate-legacy"
  | "soft-delete-project"
  | "soft-delete-component"
  | "restore-project"
  | "restore-component"
  | "hard-delete-project"
  | "hard-delete-component"
  | "track-recent"
  | "upsert-causal-source-item"
  | "delete-causal-source-item"
  | "save-text-chunks"
  | "save-causal-artifacts";

type PMActionRequest = {
  action: PMAction;
  payload?: unknown;
};

function asRecord(payload: unknown): Record<string, unknown> {
  return payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
}

function asString(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  return typeof value === "string" ? value : "";
}

function asArray<T>(payload: Record<string, unknown>, key: string): T[] {
  const value = payload[key];
  return Array.isArray(value) ? (value as T[]) : [];
}

function badRequest(message: string) {
  return NextResponse.json({ error: message }, { status: 400 });
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const resource = url.searchParams.get("resource") as PMResource | null;

  if (!resource) {
    return badRequest("Missing resource query param.");
  }

  switch (resource) {
    case "projects":
      return NextResponse.json(listProjects(false));
    case "components":
      return NextResponse.json(listComponents(false));
    case "trash-projects":
      return NextResponse.json(listDeletedProjects());
    case "trash-components":
      return NextResponse.json(listDeletedComponents());
    case "recents":
      return NextResponse.json(listRecents());
    case "causal-source-items": {
      const projectId = (url.searchParams.get("projectId") ?? "").trim();
      const componentId = (url.searchParams.get("componentId") ?? "").trim();

      if (!projectId) {
        return badRequest("projectId is required for causal-source-items.");
      }

      return NextResponse.json(listCausalSourceItems(projectId, componentId || undefined));
    }
    case "causal-source-item": {
      const itemId = (url.searchParams.get("itemId") ?? "").trim();
      if (!itemId) {
        return badRequest("itemId is required for causal-source-item.");
      }

      const item = getCausalSourceItem(itemId);
      if (!item) {
        return badRequest("Causal source item not found.");
      }

      return NextResponse.json(item);
    }
    case "text-chunks": {
      const itemId = (url.searchParams.get("itemId") ?? "").trim();
      if (!itemId) {
        return badRequest("itemId is required for text-chunks.");
      }

      return NextResponse.json(listLatestTextChunksForExperimentItem(itemId));
    }
    case "text-chunk-records": {
      const itemId = (url.searchParams.get("itemId") ?? "").trim();
      if (!itemId) {
        return badRequest("itemId is required for text-chunk-records.");
      }

      return NextResponse.json(listLatestTextChunkRecordsForExperimentItem(itemId));
    }
    case "chunk-extractions": {
      const itemId = (url.searchParams.get("itemId") ?? "").trim();
      if (!itemId) {
        return badRequest("itemId is required for chunk-extractions.");
      }
      return NextResponse.json(listLatestChunkExtractionsForExperimentItem(itemId));
    }
    case "causal-artifacts": {
      const itemId = (url.searchParams.get("itemId") ?? "").trim();
      if (!itemId) {
        return badRequest("itemId is required for causal-artifacts.");
      }

      return NextResponse.json(getCausalArtifactsForItem(itemId));
    }
    default:
      return badRequest("Unsupported resource.");
  }
}

export async function POST(request: Request) {
  let body: PMActionRequest;
  try {
    body = (await request.json()) as PMActionRequest;
  } catch {
    return badRequest("Invalid JSON payload.");
  }

  const payload = asRecord(body.payload);

  switch (body.action) {
    case "migrate-legacy": {
      const summary = migrateLegacyData({
        projects: asArray<SimulationProject>(payload, "projects"),
        components: asArray<SimulationComponent>(payload, "components"),
        deletedProjects: asArray(payload, "deletedProjects"),
        deletedComponents: asArray(payload, "deletedComponents"),
        recents: asArray(payload, "recents"),
      });

      return NextResponse.json({ ok: true, summary });
    }

    case "create-project": {
      const id = asString(payload, "id").trim();
      const name = asString(payload, "name").trim();
      if (!id || !name) {
        return badRequest("Project id and name are required.");
      }

      const project: SimulationProject = { id, name };
      return NextResponse.json(createProject(project));
    }

    case "create-component": {
      const component = payload as SimulationComponent;
      if (!component || typeof component.id !== "string" || typeof component.title !== "string") {
        return badRequest("Invalid component payload.");
      }

      if (
        component.category !== "Causal" &&
        component.category !== "Map" &&
        component.category !== "Code" &&
        component.category !== "PolicyTesting"
      ) {
        return badRequest("Invalid component category.");
      }

      return NextResponse.json(createComponent(component));
    }

    case "soft-delete-project": {
      const projectId = asString(payload, "projectId").trim();
      if (!projectId) {
        return badRequest("projectId is required.");
      }
      return NextResponse.json({ ok: softDeleteProject(projectId) });
    }

    case "soft-delete-component": {
      const componentId = asString(payload, "componentId").trim();
      if (!componentId) {
        return badRequest("componentId is required.");
      }
      return NextResponse.json({ ok: softDeleteComponent(componentId) });
    }

    case "restore-project": {
      const projectId = asString(payload, "projectId").trim();
      if (!projectId) {
        return badRequest("projectId is required.");
      }
      return NextResponse.json({ ok: restoreProject(projectId) });
    }

    case "restore-component": {
      const componentId = asString(payload, "componentId").trim();
      if (!componentId) {
        return badRequest("componentId is required.");
      }
      return NextResponse.json({ ok: restoreComponent(componentId) });
    }

    case "hard-delete-project": {
      const projectId = asString(payload, "projectId").trim();
      if (!projectId) {
        return badRequest("projectId is required.");
      }
      return NextResponse.json({ ok: hardDeleteProject(projectId) });
    }

    case "hard-delete-component": {
      const componentId = asString(payload, "componentId").trim();
      if (!componentId) {
        return badRequest("componentId is required.");
      }
      return NextResponse.json({ ok: hardDeleteComponent(componentId) });
    }

    case "track-recent": {
      const componentId = asString(payload, "componentId").trim();
      const title = asString(payload, "title").trim();
      const category = asString(payload, "category").trim() as SimulationComponent["category"];
      const href = asString(payload, "href").trim();
      const projectIdRaw = asString(payload, "projectId").trim();

      if (!componentId || !title || !category || !href) {
        return badRequest("componentId, title, category, and href are required.");
      }

      if (category !== "Causal" && category !== "Map" && category !== "Code" && category !== "PolicyTesting") {
        return badRequest("Invalid category.");
      }

      const recent = trackRecent({
        componentId,
        title,
        category,
        href,
        projectId: projectIdRaw || undefined,
      });

      return NextResponse.json(recent);
    }

    case "upsert-causal-source-item": {
      const id = asString(payload, "id").trim();
      const projectId = asString(payload, "projectId").trim();
      const componentId = asString(payload, "componentId").trim();
      const label = asString(payload, "label").trim();
      const fileName = asString(payload, "fileName").trim();
      const sourceType = asString(payload, "sourceType").trim();
      const status = asString(payload, "status").trim();
      const textContent = asString(payload, "textContent");
      const inputModeRaw = asString(payload, "inputMode").trim();
      const storagePathOrBlobRaw = asString(payload, "storagePathOrBlob");
      const transcriptTextRaw = asString(payload, "transcriptText");
      const tags = asArray<string>(payload, "tags").filter((tag) => typeof tag === "string");

      if (!id || !projectId || !componentId || !label || !fileName || !sourceType || !status) {
        return badRequest("id, projectId, componentId, label, fileName, sourceType, and status are required.");
      }

      if (sourceType !== "text" && sourceType !== "audio") {
        return badRequest("Invalid sourceType.");
      }

      if (status !== "raw_text" && status !== "chunked" && status !== "extracted") {
        return badRequest("Invalid status.");
      }

      return NextResponse.json(
        upsertCausalSourceItem({
          id,
          projectId,
          componentId,
          label,
          fileName,
          sourceType,
          status,
          tags,
          textContent,
          inputMode:
            inputModeRaw === "upload" ||
            inputModeRaw === "manual_text" ||
            inputModeRaw === "api" ||
            inputModeRaw === "other"
              ? inputModeRaw
              : undefined,
          storagePathOrBlob: storagePathOrBlobRaw.trim() ? storagePathOrBlobRaw : null,
          transcriptText: transcriptTextRaw.trim() ? transcriptTextRaw : null,
        }),
      );
    }

    case "delete-causal-source-item": {
      const itemId = asString(payload, "itemId").trim();
      if (!itemId) {
        return badRequest("itemId is required.");
      }

      return NextResponse.json({ ok: deleteCausalSourceItem(itemId) });
    }

    case "save-text-chunks": {
      const experimentItemId = asString(payload, "experimentItemId").trim();
      const projectId = asString(payload, "projectId").trim();
      const componentId = asString(payload, "componentId").trim();
      const model = asString(payload, "model").trim() || undefined;
      const chunkSizeWordsRaw = payload.chunkSizeWords;
      const chunkOverlapWordsRaw = payload.chunkOverlapWords;
      const chunks = asArray<string>(payload, "chunks").filter((entry) => typeof entry === "string");

      if (!experimentItemId || !projectId || !componentId) {
        return badRequest("experimentItemId, projectId, and componentId are required.");
      }

      const chunkSizeWords =
        typeof chunkSizeWordsRaw === "number" && Number.isFinite(chunkSizeWordsRaw) ? chunkSizeWordsRaw : undefined;
      const chunkOverlapWords =
        typeof chunkOverlapWordsRaw === "number" && Number.isFinite(chunkOverlapWordsRaw)
          ? chunkOverlapWordsRaw
          : undefined;

      return NextResponse.json(
        saveTextChunks({
          experimentItemId,
          projectId,
          componentId,
          chunks,
          model,
          chunkSizeWords,
          chunkOverlapWords,
        }),
      );
    }

    case "save-causal-artifacts": {
      const experimentItemId = asString(payload, "experimentItemId").trim();
      const rawExtraction = asArray(payload, "rawExtraction") as Parameters<typeof saveCausalArtifacts>[0]["rawExtraction"];
      const followUp = asArray(payload, "followUp") as Parameters<typeof saveCausalArtifacts>[0]["followUp"];

      if (!experimentItemId) {
        return badRequest("experimentItemId is required.");
      }

      return NextResponse.json(
        saveCausalArtifacts({
          experimentItemId,
          rawExtraction,
          followUp,
        }),
      );
    }

    default:
      return badRequest("Unsupported action.");
  }
}
