import { useCallback, useState } from "react";
import { softDeleteComponent } from "@/lib/pm-storage";
import { type SimulationComponent } from "@/lib/simulation-components";

/**
 * Custom hook for managing source selection (Causal and Map items).
 * Keeps source selection logic separate from the main page component.
 */
export function useSourceSelection() {
    const [selectedCausalIds, setSelectedCausalIds] = useState<Set<string>>(new Set());
    const [selectedMapId, setSelectedMapId] = useState<string | null>(null);

    const handleToggleCausalSelection = useCallback(
        (id: string, inputsLocked: boolean, onStateReset?: () => void) => {
            if (inputsLocked) return;

            setSelectedCausalIds((prev) => {
                const next = new Set(prev);
                if (next.has(id)) {
                    next.delete(id);
                } else {
                    next.add(id);
                }
                return next;
            });

            // Reset dependent state when selection changes
            if (onStateReset) {
                onStateReset();
            }
        },
        [],
    );

    const handleToggleMapSelection = useCallback((id: string, inputsLocked: boolean) => {
        if (inputsLocked) return;
        setSelectedMapId((prev) => (prev === id ? null : id));
    }, []);

    const handleDeleteComponent = useCallback(
        async (targetId: string, onRefresh?: () => Promise<void>) => {
            try {
                await softDeleteComponent(targetId);
                if (onRefresh) {
                    await onRefresh();
                }
            } catch {
                throw new Error("Unable to delete component from database.");
            }
        },
        [],
    );

    return {
        // State
        selectedCausalIds,
        setSelectedCausalIds,
        selectedMapId,
        setSelectedMapId,

        // Handlers
        handleToggleCausalSelection,
        handleToggleMapSelection,
        handleDeleteComponent,
    };
}
