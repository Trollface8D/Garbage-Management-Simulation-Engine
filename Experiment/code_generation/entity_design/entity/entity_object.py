from abc import ABC
from typing import TYPE_CHECKING, Optional, List

if TYPE_CHECKING:
    from .environment import SimulationEnvironment
    from .policy import Policy

# ---------------------------------------------------------
# UNIFIED entity_object TEMPLATE
# ---------------------------------------------------------
class entity_object(ABC):
    """
    Unified template for all entity_objects in the simulation.
    
    entity_objects can have active traits (perceive, decide, act) and/or passive traits (hold state, be acted upon).
    
    ACTIVE TRAIT: Override perceive(), decide_action(), and act() methods
    - Used for entity_objects that can autonomously perceive, make decisions, and take actions
    - Examples: Janitor, Student, Truck Driver
    
    PASSIVE TRAIT: Override get_status() and on_interact() methods
    - Used for entity_objects that hold state and can be acted upon by other entity_objects
    - Examples: Garbage Bin, Waste Buffer, Large Waste Item
    
    HYBRID (Both Traits): Override all five methods above
    - Used for entity_objects that can both act autonomously AND be acted upon
    - Examples: Smart Garbage Truck (acts autonomously but also has capacity state),
                Sorting Station (processes waste but also accumulates it)
    
    The trait(s) an entity_object has are determined by which methods you implement.
    Only implement the methods relevant to your entity_object's capabilities.
    
    POLICIES: entity_objects can have policies attached that modify their behavior.
    """
    
    def __init__(self, entity_object_id: str):
        self.entity_object_id = entity_object_id
        self.state = "Idle"
        self._policies: List['Policy'] = []  # Policies attached to this entity_object
    
    # ==================== POLICY MANAGEMENT ====================
    
    def add_policy(self, policy: 'Policy'):
        """
        Attach a policy to this entity_object.
        
        Args:
            policy: The policy to attach
        """
        if policy.is_applicable_to(self):
            self._policies.append(policy)
        else:
            raise ValueError(f"Policy '{policy.policy_name}' cannot be applied to entity_object '{self.entity_object_id}'")
    
    def remove_policy(self, policy_name: str):
        """
        Remove a policy from this entity_object by name.
        
        Args:
            policy_name: Name of the policy to remove
        """
        self._policies = [p for p in self._policies if p.policy_name != policy_name]
    
    def get_policies(self) -> List['Policy']:
        """Returns all policies attached to this entity_object."""
        return self._policies.copy()
    
    def apply_policies(self, context: dict, env: Optional['SimulationEnvironment'] = None) -> dict:
        """
        Apply all attached policies to the given context.
        Policies are applied in order they were added.
        
        Args:
            context: Context information for policies
            env: Optional environment reference
            
        Returns:
            dict: Combined results from all policies
        """
        results = {}
        for policy in self._policies:
            policy_result = policy.apply(self, context, env)
            results[policy.policy_name] = policy_result
        return results
    
    # ==================== ACTIVE TRAIT METHODS ====================
    # Implement these if your entity_object can perceive, decide, and act autonomously
    
    def perceive(self, env: Optional['SimulationEnvironment'] = None):
        """
        [ACTIVE TRAIT] entity_object gathers information from the environment.
        
        Override this method if your entity_object needs to perceive its surroundings
        (e.g., a Janitor sees a full bin, a Student notices nearby trash bins).
        
        Args:
            env: The simulation environment to perceive from (optional if entity_object uses direct perception)
        """
        raise NotImplementedError(
            f"entity_object '{self.entity_object_id}' does not implement perceive(). "
            "This entity_object does not have active perception capabilities."
        )
    
    def decide_action(self) -> Optional[str]:
        """
        [ACTIVE TRAIT] entity_object decides what action to take based on perceptions and policies.
        
        Override this method if your entity_object can make decisions autonomously
        (e.g., Janitor decides to empty a bin, Student decides to throw away trash).
        
        Returns:
            str: The action the entity_object has decided to take, or None if no action
        """
        raise NotImplementedError(
            f"entity_object '{self.entity_object_id}' does not implement decide_action(). "
            "This entity_object does not have active decision-making capabilities."
        )
    
    def act(self, env: Optional['SimulationEnvironment'] = None):
        """
        [ACTIVE TRAIT] entity_object executes its decided action, interacting with the environment or other entity_objects.
        
        Override this method if your entity_object can perform actions
        (e.g., Janitor empties bin, Student throws waste into bin).
        
        Args:
            env: The simulation environment to act within (optional if entity_object acts directly on other entity_objects)
        """
        raise NotImplementedError(
            f"entity_object '{self.entity_object_id}' does not implement act(). "
            "This entity_object does not have active action capabilities."
        )
    
    # ==================== PASSIVE TRAIT METHODS ====================
    # Implement these if your entity_object has state and can be acted upon
    
    def get_status(self) -> dict:
        """
        [PASSIVE TRAIT] Returns the current state of the entity_object.
        
        Override this method if your entity_object has state that others need to query
        (e.g., bin capacity, waste volume, location, temperature).
        
        Returns:
            dict: Current state information (e.g., {"capacity": 0.8, "location": "Building A"})
        """
        raise NotImplementedError(
            f"entity_object '{self.entity_object_id}' does not implement get_status(). "
            "This entity_object does not have queryable state."
        )
    
    def on_interact(self, initiator: 'entity_object', action: str, env: Optional['SimulationEnvironment'] = None):
        """
        [PASSIVE TRAIT] Defines how the entity_object reacts when another entity_object interacts with it.
        
        Override this method if your entity_object can be acted upon by other entity_objects
        (e.g., a bin receives waste from a student, a buffer is emptied by a janitor).
        
        Args:
            initiator: The entity_object performing the interaction
            action: The type of interaction (e.g., "deposit_waste", "empty_bin", "collect")
            env: The simulation environment context (optional if direct entity_object-to-entity_object interaction)
        """
        raise NotImplementedError(
            f"entity_object '{self.entity_object_id}' does not implement on_interact(). "
            "This entity_object cannot be interacted with by other entity_objects."
        )


# Backward compatibility aliases
Stakeholder = entity_object  # Active entity_objects were previously called Stakeholders
SimulationObject = entity_object  # Passive entity_objects were previously called SimulationObjects
