import { NextResponse } from "next/server";
import type { SimulationComponent, SimulationProject } from "@/lib/simulation-components";
import {
  createComponent,
  createProject,
  hardDeleteComponent,
  hardDeleteProject,
  listComponents,
  listDeletedComponents,
  listDeletedProjects,
  listProjects,
  listRecents,
  migrateLegacyData,
  restoreComponent,
  restoreProject,
  softDeleteComponent,
  softDeleteProject,
  trackRecent,
} from "@/lib/db";

export const runtime = "nodejs";

type PMResource =
  | "projects"
  | "components"
  | "trash-projects"
  | "trash-components"
  | "recents";

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
  | "track-recent";

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
        component.category !== "Comparison"
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

      if (category !== "Causal" && category !== "Map" && category !== "Code" && category !== "Comparison") {
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

    default:
      return badRequest("Unsupported action.");
  }
}
