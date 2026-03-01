from typing import Any, Dict, List, Optional
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .agent import Agent
    from .policy import Policy
    from .system_behavior import SystemBehavior

# ---------------------------------------------------------
# THE MEDIATOR (Environment)
# ---------------------------------------------------------
class SimulationEnvironment:
    """
    Acts as the Mediator. All entities can talk to the environment.
    
    The environment maintains:
    1. Agents (both active and passive)
    2. Global properties that affect all agents
    3. Global policies and system behaviors
    
    Active agents can modify global properties through set_property().
    All agents can observe global properties through get_property().
    """
    def __init__(self):
        self.agents: List['Agent'] = []
        self.policies: List['Policy'] = []
        self.behaviors: List['SystemBehavior'] = []
        
        # Global properties that affect all agents
        # Examples: weather, time_of_day, waste_price, collection_schedule, etc.
        self._global_properties: Dict[str, Any] = {}
        
        # Backward compatibility
        self.stakeholders = []  # Deprecated: use agents instead
        self.objects = []  # Deprecated: use agents instead
    
    # ==================== ENTITY MANAGEMENT ====================
    
    def register_agent(self, agent: 'Agent'):
        """
        Register an agent (active or passive) in the environment.
        
        Args:
            agent: The agent to register
        """
        if agent not in self.agents:
            self.agents.append(agent)
    
    def unregister_agent(self, agent_id: str):
        """
        Remove an agent from the environment by ID.
        
        Args:
            agent_id: ID of the agent to remove
        """
        self.agents = [a for a in self.agents if a.agent_id != agent_id]
    
    def get_agent(self, agent_id: str) -> Optional['Agent']:
        """
        Retrieve an agent by ID.
        
        Args:
            agent_id: ID of the agent to retrieve
            
        Returns:
            The agent, or None if not found
        """
        for agent in self.agents:
            if agent.agent_id == agent_id:
                return agent
        return None
    
    def get_all_agents(self) -> List['Agent']:
        """Returns all registered agents."""
        return self.agents.copy()
    
    # ==================== GLOBAL PROPERTY MANAGEMENT ====================
    
    def set_property(self, key: str, value: Any):
        """
        Set a global property that affects the simulation.
        Active agents can call this to modify the environment state.
        
        Examples:
        - env.set_property('waste_collection_price', 5.0)
        - env.set_property('weather', 'rainy')
        - env.set_property('time_of_day', 'morning')
        
        Args:
            key: Property name
            value: Property value
        """
        self._global_properties[key] = value
    
    def get_property(self, key: str, default: Any = None) -> Any:
        """
        Get a global property value.
        All agents can call this to observe the environment state.
        
        Args:
            key: Property name
            default: Default value if property doesn't exist
            
        Returns:
            The property value, or default if not found
        """
        return self._global_properties.get(key, default)
    
    def get_all_properties(self) -> Dict[str, Any]:
        """Returns a copy of all global properties."""
        return self._global_properties.copy()
    
    def remove_property(self, key: str):
        """
        Remove a global property.
        
        Args:
            key: Property name to remove
        """
        if key in self._global_properties:
            del self._global_properties[key]
    
    # ==================== POLICY MANAGEMENT ====================
    
    def add_global_policy(self, policy: 'Policy'):
        """
        Add a policy that applies globally to the environment.
        
        Args:
            policy: The policy to add
        """
        if policy not in self.policies:
            self.policies.append(policy)
    
    def remove_global_policy(self, policy_name: str):
        """
        Remove a global policy by name.
        
        Args:
            policy_name: Name of the policy to remove
        """
        self.policies = [p for p in self.policies if p.policy_name != policy_name]
    
    def get_global_policies(self) -> List['Policy']:
        """Returns all global policies."""
        return self.policies.copy()
    
    # ==================== SYSTEM BEHAVIOR MANAGEMENT ====================
    
    def add_behavior(self, behavior: 'SystemBehavior'):
        """
        Add a system behavior to the environment.
        
        Args:
            behavior: The behavior to add
        """
        if behavior not in self.behaviors:
            self.behaviors.append(behavior)
    
    def remove_behavior(self, behavior_name: str):
        """
        Remove a system behavior by name.
        
        Args:
            behavior_name: Name of the behavior to remove
        """
        self.behaviors = [b for b in self.behaviors if b.behavior_name != behavior_name]
    
    def get_behaviors(self) -> List['SystemBehavior']:
        """Returns all system behaviors."""
        return self.behaviors.copy()
    
    # ==================== BACKWARD COMPATIBILITY ====================
    
    def register_entity(self, entity):
        """
        Deprecated: Use register_agent() instead.
        Logic to add entity to the appropriate list.
        """
        self.register_agent(entity)
