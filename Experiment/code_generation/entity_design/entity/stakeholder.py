from abc import ABC, abstractmethod
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .environment import SimulationEnvironment

# ---------------------------------------------------------
# STAKEHOLDER TEMPLATE (Active Agents)
# ---------------------------------------------------------
class Stakeholder(ABC):
    """
    Template for Stakeholders (e.g., Janitor, Student).
    Stakeholders are active agents that make decisions and interact with Objects.
    """
    def __init__(self, stakeholder_id: str):
        self.stakeholder_id = stakeholder_id

    @abstractmethod
    def perceive(self, env: 'SimulationEnvironment'):
        """Agent gathers information from the environment (e.g., sees a full bin)."""
        pass

    @abstractmethod
    def decide_action(self) -> str:
        """Agent decides what to do based on perceptions and assigned Policies."""
        pass

    @abstractmethod
    def act(self, env: 'SimulationEnvironment'):
        """Agent executes the action, interacting with the Environment or Objects."""
        pass
