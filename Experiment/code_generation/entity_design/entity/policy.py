from abc import ABC, abstractmethod
from typing import Any, TYPE_CHECKING

if TYPE_CHECKING:
    from .environment import SimulationEnvironment

# ---------------------------------------------------------
# POLICY TEMPLATE (Strategy Pattern)
# ---------------------------------------------------------
class Policy(ABC):
    """
    Template for Policies (e.g., Waste Revenue Division, Changing Policy).
    Policies are applied to actions or states to determine outcomes or limits.
    """
    @property
    @abstractmethod
    def policy_name(self) -> str:
        pass

    @abstractmethod
    def enforce(self, context: Any, env: 'SimulationEnvironment') -> dict:
        """
        Applies the policy rules to a given context.
        Example: If context is 'Waste Revenue', return {'department': 40, 'university': 60}
        """
        pass
