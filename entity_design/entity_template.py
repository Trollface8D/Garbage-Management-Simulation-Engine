from abc import ABC, abstractmethod
from typing import List, Any

# ---------------------------------------------------------
# 1. THE MEDIATOR (Environment)
# ---------------------------------------------------------
class SimulationEnvironment:
    """
    Acts as the Mediator. All entities talk to the environment, 
    not directly to each other, to prevent spaghetti code.
    """
    def __init__(self):
        self.stakeholders = []
        self.objects = []
        self.policies = []
        self.behaviors = []
        
    def register_entity(self, entity):
        # Logic to add entity to the appropriate list
        pass

# ---------------------------------------------------------
# 2. POLICY TEMPLATE (Strategy Pattern)
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
    def enforce(self, context: Any, env: SimulationEnvironment) -> dict:
        """
        Applies the policy rules to a given context.
        Example: If context is 'Waste Revenue', return {'department': 40, 'university': 60}
        """
        pass

# ---------------------------------------------------------
# 3. SYSTEM BEHAVIOR TEMPLATE (Observer/Event Pattern)
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
    def check_condition(self, env: SimulationEnvironment) -> bool:
        """Evaluates the environment to see if this behavior should trigger."""
        pass

    @abstractmethod
    def execute(self, env: SimulationEnvironment):
        """The consequence or action of the behavior if the condition is met."""
        pass

# ---------------------------------------------------------
# 4. OBJECT TEMPLATE (Passive Entities)
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
    def on_interact(self, initiator: 'Stakeholder', action: str, env: SimulationEnvironment):
        """Defines how the object reacts when a stakeholder uses it."""
        pass

# ---------------------------------------------------------
# 5. STAKEHOLDER TEMPLATE (Active Agents)
# ---------------------------------------------------------
class Stakeholder(ABC):
    """
    Template for Stakeholders (e.g., Janitor, Student).
    Stakeholders are active agents that make decisions and interact with Objects.
    """
    def __init__(self, stakeholder_id: str):
        self.stakeholder_id = stakeholder_id

    @abstractmethod
    def perceive(self, env: SimulationEnvironment):
        """Agent gathers information from the environment (e.g., sees a full bin)."""
        pass

    @abstractmethod
    def decide_action(self) -> str:
        """Agent decides what to do based on perceptions and assigned Policies."""
        pass

    @abstractmethod
    def act(self, env: SimulationEnvironment):
        """Agent executes the action, interacting with the Environment or Objects."""
        pass