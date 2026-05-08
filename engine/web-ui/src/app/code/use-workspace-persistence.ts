import { useCallback, useEffect, useState } from "react";

type PersistedWorkspaceData = {
    schemaVersion: number;
    exportedAt: string;
    componentId: string | null;
    [key: string]: unknown;
};

/**
 * Custom hook for managing workspace persistence in localStorage.
 * Handles serialization, hydration, and updates of workspace snapshots.
 * Keeps persistence logic separate from the main page component.
 */
export function useWorkspacePersistence(componentId: string | null) {
    const [hydrated, setHydrated] = useState<boolean>(false);

    const getStorageKey = useCallback(
        () => `workspace-snapshot-${componentId || "root"}`,
        [componentId],
    );

    const loadPersistedSnapshot = useCallback((): PersistedWorkspaceData | null => {
        if (typeof window === "undefined") return null;

        try {
            const key = getStorageKey();
            const raw = localStorage.getItem(key);
            if (!raw) return null;

            const parsed = JSON.parse(raw) as PersistedWorkspaceData;
            if (!parsed || typeof parsed !== "object") return null;

            return parsed;
        } catch {
            return null;
        }
    }, [getStorageKey]);

    const persistSnapshot = useCallback(
        (data: PersistedWorkspaceData) => {
            if (typeof window === "undefined") return;

            try {
                const key = getStorageKey();
                const serialized = JSON.stringify({
                    ...data,
                    schemaVersion: 1,
                    exportedAt: new Date().toISOString(),
                });
                localStorage.setItem(key, serialized);
            } catch {
                console.warn("Failed to persist workspace snapshot to localStorage");
            }
        },
        [getStorageKey],
    );

    const clearPersistedSnapshot = useCallback(() => {
        if (typeof window === "undefined") return;

        try {
            const key = getStorageKey();
            localStorage.removeItem(key);
        } catch {
            console.warn("Failed to clear workspace snapshot from localStorage");
        }
    }, [getStorageKey]);

    // Hydrate on mount
    useEffect(() => {
        setHydrated(true);
    }, []);

    return {
        // State
        hydrated,

        // Handlers
        loadPersistedSnapshot,
        persistSnapshot,
        clearPersistedSnapshot,
    };
}
