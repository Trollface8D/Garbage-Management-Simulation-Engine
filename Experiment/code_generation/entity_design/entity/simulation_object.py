from abc import ABC, abstractmethod
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .environment import SimulationEnvironment
    from .stakeholder import Stakeholder

# ---------------------------------------------------------
# OBJECT TEMPLATE (Passive Entities)
# ---------------------------------------------------------
class SimulationObject(ABC):
    """
    Template for Objects (e.g., Large Waste, Garbage Buffer).
    Objects are passive; they hold state and are acted upon by Stakeholders.
    """
    def __init__(self, object_id: str):
        self.object_id = object_id
        self.state = "Idle"

    @abstractmethod
    def get_status(self) -> dict:
        """Returns the current state (e.g., volume of waste)."""
        pass

    @abstractmethod
    def on_interact(self, initiator: 'Stakeholder', action: str, env: 'SimulationEnvironment'):
        """Defines how the object reacts when a stakeholder uses it."""
        pass
