from abc import ABC, abstractmethod
from typing import Any, TYPE_CHECKING, Optional

if TYPE_CHECKING:
    from .environment import SimulationEnvironment
    from .agent import Agent

# ---------------------------------------------------------
# POLICY TEMPLATE (Strategy Pattern)
# ---------------------------------------------------------
class Policy(ABC):
    """
    Template for Policies that can be applied to Agents.
    Policies define behaviors or rules that agents follow (Strategy Pattern).
    
    Examples:
    - WasteRevenuePolicy: Determines how waste collection revenue is divided
    - CollectionSchedulePolicy: Defines when and how agents collect waste
    - CapacityManagementPolicy: Rules for handling agent capacity limits
    """
    
    @property
    @abstractmethod
    def policy_name(self) -> str:
        """Name identifier for this policy."""
        pass

    @abstractmethod
    def apply(self, agent: 'Agent', context: dict, env: Optional['SimulationEnvironment'] = None) -> dict:
        """
        Applies the policy to a specific agent with given context.
        
        Args:
            agent: The agent this policy is being applied to
            context: Relevant information for the policy (e.g., {'waste_amount': 100, 'waste_type': 'general'})
            env: Optional simulation environment for accessing global state
            
        Returns:
            dict: The result of applying the policy (e.g., {'department_share': 40, 'university_share': 60})
        """
        pass

    def is_applicable_to(self, agent: 'Agent') -> bool:
        """
        Checks if this policy can be applied to the given agent.
        Override this to restrict policies to specific agent types.
        
        Args:
            agent: The agent to check
            
        Returns:
            bool: True if policy can be applied to this agent
        """
        return True  # Default: applicable to all agents
