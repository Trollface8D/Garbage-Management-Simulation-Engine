from abc import ABC, abstractmethod
from typing import Any, TYPE_CHECKING, Optional

if TYPE_CHECKING:
    from .environment_template import SimulationEnvironment
    from .entity_object_template import entity_object

# ---------------------------------------------------------
# POLICY TEMPLATE (Strategy Pattern)
# ---------------------------------------------------------
class Policy(ABC):
    """
    Template for Policies that can be applied to entity_objects.
    Policies define behaviors or rules that entity_objects follow (Strategy Pattern).
    
    Examples:
    - WasteRevenuePolicy: Determines how waste collection revenue is divided
    - CollectionSchedulePolicy: Defines when and how entity_objects collect waste
    - CapacityManagementPolicy: Rules for handling entity_object capacity limits
    """
    
    @property
    @abstractmethod
    def policy_name(self) -> str:
        """Name identifier for this policy."""
        pass

    @abstractmethod
    def apply(self, entity_object: 'entity_object', context: dict, env: Optional['SimulationEnvironment'] = None) -> dict:
        """
        Applies the policy to a specific entity_object with given context.
        
        Args:
            entity_object: The entity_object this policy is being applied to
            context: Relevant information for the policy (e.g., {'waste_amount': 100, 'waste_type': 'general'})
            env: Optional simulation environment for accessing global state
            
        Returns:
            dict: The result of applying the policy (e.g., {'department_share': 40, 'university_share': 60})
        """
        pass

    def is_applicable_to(self, entity_object: 'entity_object') -> bool:
        """
        Checks if this policy can be applied to the given entity_object.
        Override this to restrict policies to specific entity_object types.
        
        Args:
            entity_object: The entity_object to check
            
        Returns:
            bool: True if policy can be applied to this entity_object
        """
        return True  # Default: applicable to all entity_objects
