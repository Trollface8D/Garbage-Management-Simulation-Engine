"use client";

import { useParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import MapExtractionWorkspace from "@/app/components/map-extraction-workspace";
import {
  findComponentById as findSeedComponentById,
  findProjectById as findSeedProjectById,
  type SimulationComponent,
  type SimulationProject,
} from "@/lib/simulation-components";
import { loadComponents, loadProjects } from "@/lib/pm-storage";

export default function MapArtifactPage() {
  const params = useParams<{ componentId: string }>();
  const componentId = params.componentId;

  const [projects, setProjects] = useState<SimulationProject[]>([]);
  const [components, setComponents] = useState<SimulationComponent[]>([]);

  useEffect(() => {
    const loadData = async () => {
      const [nextProjects, nextComponents] = await Promise.all([loadProjects(), loadComponents()]);
      setProjects(nextProjects);
      setComponents(nextComponents);
    };

    void loadData();
  }, []);

  const selectedComponent = useMemo(
    () => components.find((component) => component.id === componentId) ?? findSeedComponentById(componentId),
    [componentId, components],
  );

  const projectId = useMemo(() => {
    if (!selectedComponent || selectedComponent.category === "PolicyTesting") {
      return "";
    }

    return selectedComponent.projectId;
  }, [selectedComponent]);

  const projectName = useMemo(() => {
    if (!projectId) {
      return "Unselected project";
    }

    return projects.find((project) => project.id === projectId)?.name ?? findSeedProjectById(projectId)?.name ?? "Unselected project";
  }, [projectId, projects]);

  const title = selectedComponent?.title ?? componentId;
  const backHref = projectId ? `/pm/${encodeURIComponent(projectId)}` : "/";

  return (
    <MapExtractionWorkspace
      componentId={componentId}
      title={title}
      projectName={projectName}
      backHref={backHref}
    />
  );
}
