export type Category = "Causal" | "Map" | "Code" | "Comparison";
export type FilterOption = "All" | Category;

export type SimulationProject = {
    id: string;
    name: string;
};

export type ProjectComponentCategory = Exclude<Category, "Comparison">;

type SimulationComponentBase = {
    id: string;
    title: string;
    category: Category;
    lastEdited: string;
};

export type ProjectScopedComponent = SimulationComponentBase & {
    category: ProjectComponentCategory;
    projectId: string;
};

export type ComparisonComponent = SimulationComponentBase & {
    category: "Comparison";
    leftProjectId: string;
    rightProjectId: string;
};

export type SimulationComponent = ProjectScopedComponent | ComparisonComponent;

export const filterOptions: FilterOption[] = ["All", "Causal", "Map", "Code", "Comparison"];

export const simulationProjects: SimulationProject[] = [
    { id: "garbage-management", name: "Garbage Management" },
    { id: "urban-waste-dynamics", name: "Urban Waste Dynamics" },
    { id: "regional-routing-lab", name: "Regional Routing Lab" },
];

export const simulationComponents: SimulationComponent[] = [
    {
        id: "landfill-route-dynamics",
        title: "Landfill Route Dynamics",
        category: "Causal",
        lastEdited: "2 hours ago",
        projectId: "garbage-management",
    },
    {
        id: "district-transfer-overview",
        title: "District Transfer Overview",
        category: "Map",
        lastEdited: "5 hours ago",
        projectId: "garbage-management",
    },
    {
        id: "optimization-engine-v2",
        title: "Optimization Engine v2",
        category: "Code",
        lastEdited: "8 hours ago",
        projectId: "garbage-management",
    },
    {
        id: "cost-vs-time-benchmark",
        title: "Cost vs Time Benchmark",
        category: "Comparison",
        lastEdited: "10 hours ago",
        leftProjectId: "garbage-management",
        rightProjectId: "urban-waste-dynamics",
    },
    {
        id: "waste-source-feedback",
        title: "Waste Source Feedback",
        category: "Causal",
        lastEdited: "14 hours ago",
        projectId: "urban-waste-dynamics",
    },
    {
        id: "satellite-drop-map",
        title: "Satellite Drop Map",
        category: "Map",
        lastEdited: "16 hours ago",
        projectId: "urban-waste-dynamics",
    },
    {
        id: "dispatcher-ruleset",
        title: "Dispatcher Ruleset",
        category: "Code",
        lastEdited: "20 hours ago",
        projectId: "regional-routing-lab",
    },
    {
        id: "fuel-and-delay-analysis",
        title: "Fuel and Delay Analysis",
        category: "Comparison",
        lastEdited: "24 hours ago",
        leftProjectId: "garbage-management",
        rightProjectId: "regional-routing-lab",
    },
];

export const categoryPath: Record<Category, string> = {
    Causal: "causal_extract",
    Map: "map",
    Code: "code",
    Comparison: "comparison",
};

export function isProjectScopedComponent(component: SimulationComponent): component is ProjectScopedComponent {
    return component.category !== "Comparison";
}

export function isComparisonComponent(component: SimulationComponent): component is ComparisonComponent {
    return component.category === "Comparison";
}

export function findProjectById(projectId: string | null | undefined): SimulationProject | undefined {
    if (!projectId) {
        return undefined;
    }
    return simulationProjects.find((project) => project.id === projectId);
}

export function getProjectName(projectId: string | null | undefined): string {
    return findProjectById(projectId)?.name ?? "Unknown project";
}

export function getProjectIdForComponent(componentId: string | null | undefined): string | undefined {
    const component = findComponentById(componentId);
    if (!component || !isProjectScopedComponent(component)) {
        return undefined;
    }
    return component.projectId;
}

const componentSeedTextById: Record<string, string[]> = {
    "landfill-route-dynamics": [
        "Waste from campus bins is collected in rounds, sorted at transfer points, and then routed either to recycling partners or municipal disposal. Overflow events often happen when internal handoff timing does not match collection timing.",
        "Operationally, the key causal chain starts with mixed disposal behavior, then increased manual sorting effort, then delayed truck loading, and finally a higher chance of temporary overflow at local holding areas.",
    ],
    "waste-source-feedback": [
        "Feedback from staff and students indicates that visible overflow is strongly tied to schedule mismatch and inconsistent source separation. When sorting quality improves at source, downstream handling speed improves significantly.",
        "A practical intervention is to tighten pickup windows and standardize handoff checkpoints so each team can verify quantities before transfer to central processing.",
    ],
};

export function findComponentById(componentId: string | null | undefined): SimulationComponent | undefined {
    if (!componentId) {
        return undefined;
    }
    return simulationComponents.find((component) => component.id === componentId);
}

export function getSeedBlocksForComponent(componentId: string | null | undefined): string[] {
    if (!componentId) {
        return [];
    }
    return componentSeedTextById[componentId] ?? [];
}

export function getComponentsForProject(projectId: string): SimulationComponent[] {
    return simulationComponents.filter((component) => {
        if (isProjectScopedComponent(component)) {
            return component.projectId === projectId;
        }
        return component.leftProjectId === projectId || component.rightProjectId === projectId;
    });
}

export type ProjectSummary = {
    total: number;
    causal: number;
    map: number;
    code: number;
    comparison: number;
    latestEdited: string;
};

export function getProjectSummary(projectId: string): ProjectSummary {
    const components = getComponentsForProject(projectId);
    const latestEdited = components[0]?.lastEdited ?? "No activity";

    return {
        total: components.length,
        causal: components.filter((component) => component.category === "Causal").length,
        map: components.filter((component) => component.category === "Map").length,
        code: components.filter((component) => component.category === "Code").length,
        comparison: components.filter((component) => component.category === "Comparison").length,
        latestEdited,
    };
}
