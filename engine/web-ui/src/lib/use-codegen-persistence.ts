/**
 * Persistence utilities for CodeGen workspace state.
 * Enables recovery of job state and user selections across page reloads.
 */

import type { CodeGenJobStatus, CodeGenPreviewResult, CodeGenPolicyOutline } from "@/lib/code-gen-api-client";
import type { ArtifactFile } from "@/app/code/code-gen-workspace";
import type { MapGraphPayload } from "@/lib/map-types";

export interface PersistedCodeGenState {
  version: 1;
  jobId: string | null;
  preview: CodeGenPreviewResult | null;
  status: CodeGenJobStatus | null;
  error: string | null;
}

export interface PersistedWorkspaceState {
  version: 1;
  causalChoices: Array<{ id: string; componentId: string; label: string }>;
  mapGraph: MapGraphPayload | null;
  mapStatus: string;
  selectedEntityIds: string[];
  selectedPolicyIds: string[];
  // Back-compat: used to be string[]; now store CodeGenPolicyOutline[]
  manualPolicies: CodeGenPolicyOutline[];
  artifactFiles: ArtifactFile[];
  previewText: string;
}

/**
 * Generate a storage key for a given component.
 * Ensures different simulation components have isolated sessions.
 */
function getJobStorageKey(componentId: string): string {
  return `codegen-job:${componentId}`;
}

function getWorkspaceStorageKey(componentId: string): string {
  return `codegen-workspace:${componentId}`;
}

/**
 * Save job state to localStorage.
 */
export function saveJobState(
  componentId: string,
  state: PersistedCodeGenState,
): void {
  if (typeof window === "undefined") return;
  try {
    const key = getJobStorageKey(componentId);
    window.localStorage.setItem(key, JSON.stringify(state));
  } catch (err) {
    console.warn("[CodeGen Persistence] Failed to save job state:", err);
  }
}

/**
 * Load job state from localStorage.
 */
export function loadJobState(componentId: string): PersistedCodeGenState | null {
  if (typeof window === "undefined") return null;
  try {
    const key = getJobStorageKey(componentId);
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PersistedCodeGenState;
    // Validate version for future migrations
    if (parsed.version !== 1) return null;
    return parsed;
  } catch (err) {
    console.warn("[CodeGen Persistence] Failed to load job state:", err);
    return null;
  }
}

/**
 * Save workspace (UI) state to localStorage.
 */
export function saveWorkspaceState(
  componentId: string,
  state: PersistedWorkspaceState,
): void {
  if (typeof window === "undefined") return;
  try {
    const key = getWorkspaceStorageKey(componentId);
    window.localStorage.setItem(key, JSON.stringify(state));
  } catch (err) {
    console.warn("[CodeGen Persistence] Failed to save workspace state:", err);
  }
}

/**
 * Load workspace (UI) state from localStorage.
 */
export function loadWorkspaceState(componentId: string): PersistedWorkspaceState | null {
  if (typeof window === "undefined") return null;
  try {
    const key = getWorkspaceStorageKey(componentId);
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PersistedWorkspaceState;
    // Validate version for future migrations
    if (parsed.version !== 1) return null;
    return parsed;
  } catch (err) {
    console.warn("[CodeGen Persistence] Failed to load workspace state:", err);
    return null;
  }
}

/**
 * Clear all persisted state for a component.
 * Called when user explicitly resets the workspace.
 */
export function clearAllPersistence(componentId: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(getJobStorageKey(componentId));
    window.localStorage.removeItem(getWorkspaceStorageKey(componentId));
  } catch (err) {
    console.warn("[CodeGen Persistence] Failed to clear persisted state:", err);
  }
}
