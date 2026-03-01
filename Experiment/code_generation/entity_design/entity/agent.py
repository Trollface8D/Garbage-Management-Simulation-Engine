from abc import ABC
from typing import TYPE_CHECKING, Optional, List

if TYPE_CHECKING:
    from .environment import SimulationEnvironment
    from .policy import Policy

# ---------------------------------------------------------
# UNIFIED AGENT TEMPLATE
# ---------------------------------------------------------
class Agent(ABC):
    """
    Unified template for all Agents in the simulation.
    
    Agents can have active traits (perceive, decide, act) and/or passive traits (hold state, be acted upon).
    
    ACTIVE TRAIT: Override perceive(), decide_action(), and act() methods
    - Used for agents that can autonomously perceive, make decisions, and take actions
    - Examples: Janitor, Student, Truck Driver
    
    PASSIVE TRAIT: Override get_status() and on_interact() methods
    - Used for agents that hold state and can be acted upon by other agents
    - Examples: Garbage Bin, Waste Buffer, Large Waste Item
    
    HYBRID (Both Traits): Override all five methods above
    - Used for agents that can both act autonomously AND be acted upon
    - Examples: Smart Garbage Truck (acts autonomously but also has capacity state),
                Sorting Station (processes waste but also accumulates it)
    
    The trait(s) an agent has are determined by which methods you implement.
    Only implement the methods relevant to your agent's capabilities.
    
    POLICIES: Agents can have policies attached that modify their behavior.
    """
    
    def __init__(self, agent_id: str):
        self.agent_id = agent_id
        self.state = "Idle"
        self._policies: List['Policy'] = []  # Policies attached to this agent
    
    # ==================== POLICY MANAGEMENT ====================
    
    def add_policy(self, policy: 'Policy'):
        """
        Attach a policy to this agent.
        
        Args:
            policy: The policy to attach
        """
        if policy.is_applicable_to(self):
            self._policies.append(policy)
        else:
            raise ValueError(f"Policy '{policy.policy_name}' cannot be applied to agent '{self.agent_id}'")
    
    def remove_policy(self, policy_name: str):
        """
        Remove a policy from this agent by name.
        
        Args:
            policy_name: Name of the policy to remove
        """
        self._policies = [p for p in self._policies if p.policy_name != policy_name]
    
    def get_policies(self) -> List['Policy']:
        """Returns all policies attached to this agent."""
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
    # Implement these if your agent can perceive, decide, and act autonomously
    
    def perceive(self, env: Optional['SimulationEnvironment'] = None):
        """
        [ACTIVE TRAIT] Agent gathers information from the environment.
        
        Override this method if your agent needs to perceive its surroundings
        (e.g., a Janitor sees a full bin, a Student notices nearby trash bins).
        
        Args:
            env: The simulation environment to perceive from (optional if agent uses direct perception)
        """
        raise NotImplementedError(
            f"Agent '{self.agent_id}' does not implement perceive(). "
            "This agent does not have active perception capabilities."
        )
    
    def decide_action(self) -> Optional[str]:
        """
        [ACTIVE TRAIT] Agent decides what action to take based on perceptions and policies.
        
        Override this method if your agent can make decisions autonomously
        (e.g., Janitor decides to empty a bin, Student decides to throw away trash).
        
        Returns:
            str: The action the agent has decided to take, or None if no action
        """
        raise NotImplementedError(
            f"Agent '{self.agent_id}' does not implement decide_action(). "
            "This agent does not have active decision-making capabilities."
        )
    
    def act(self, env: Optional['SimulationEnvironment'] = None):
        """
        [ACTIVE TRAIT] Agent executes its decided action, interacting with the environment or other agents.
        
        Override this method if your agent can perform actions
        (e.g., Janitor empties bin, Student throws waste into bin).
        
        Args:
            env: The simulation environment to act within (optional if agent acts directly on other agents)
        """
        raise NotImplementedError(
            f"Agent '{self.agent_id}' does not implement act(). "
            "This agent does not have active action capabilities."
        )
    
    # ==================== PASSIVE TRAIT METHODS ====================
    # Implement these if your agent has state and can be acted upon
    
    def get_status(self) -> dict:
        """
        [PASSIVE TRAIT] Returns the current state of the agent.
        
        Override this method if your agent has state that others need to query
        (e.g., bin capacity, waste volume, location, temperature).
        
        Returns:
            dict: Current state information (e.g., {"capacity": 0.8, "location": "Building A"})
        """
        raise NotImplementedError(
            f"Agent '{self.agent_id}' does not implement get_status(). "
            "This agent does not have queryable state."
        )
    
    def on_interact(self, initiator: 'Agent', action: str, env: Optional['SimulationEnvironment'] = None):
        """
        [PASSIVE TRAIT] Defines how the agent reacts when another agent interacts with it.
        
        Override this method if your agent can be acted upon by other agents
        (e.g., a bin receives waste from a student, a buffer is emptied by a janitor).
        
        Args:
            initiator: The agent performing the interaction
            action: The type of interaction (e.g., "deposit_waste", "empty_bin", "collect")
            env: The simulation environment context (optional if direct agent-to-agent interaction)
        """
        raise NotImplementedError(
            f"Agent '{self.agent_id}' does not implement on_interact(). "
            "This agent cannot be interacted with by other agents."
        )


# Backward compatibility aliases
Stakeholder = Agent  # Active agents were previously called Stakeholders
SimulationObject = Agent  # Passive agents were previously called SimulationObjects
