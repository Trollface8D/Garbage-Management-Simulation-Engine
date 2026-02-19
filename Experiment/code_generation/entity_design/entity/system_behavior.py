from abc import ABC, abstractmethod
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .environment import SimulationEnvironment

# ---------------------------------------------------------
# SYSTEM BEHAVIOR TEMPLATE (Observer/Event Pattern)
# ---------------------------------------------------------
class SystemBehavior(ABC):
    """
    Template for System Behaviors (e.g., Disregarding rules -> spills).
    These are autonomous causal loops that trigger when conditions are met.
    """
    @property
    @abstractmethod
    def behavior_name(self) -> str:
        pass

    @abstractmethod
    def check_condition(self, env: 'SimulationEnvironment') -> bool:
        """Evaluates the environment to see if this behavior should trigger."""
        pass

    @abstractmethod
    def execute(self, env: 'SimulationEnvironment'):
        """The consequence or action of the behavior if the condition is met."""
        pass
