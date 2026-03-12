"""
Agent Usage Examples - Demonstrating Active, Passive, and Hybrid Traits

This file shows how to use the unified Agent class for code generation.
Simply override the methods that match your agent's capabilities.
"""

from Experiment.code_generation.entity_design.entity.entity_object_template import Agent
from Experiment.code_generation.entity_design.entity.environment_template import SimulationEnvironment


# ==============================================================================
# EXAMPLE 1: ACTIVE AGENT (Janitor)
# Agent that can perceive, decide, and act - but has no state to query
# ==============================================================================
class Janitor(Agent):
    """Active agent that patrols and empties bins."""
    
    def __init__(self, agent_id: str):
        super().__init__(agent_id)
        self.assigned_area = None
        self.current_task = None
    
    # ACTIVE TRAIT: Implement perceive, decide_action, and act
    
    def perceive(self, env: SimulationEnvironment):
        """Look for bins that need emptying in assigned area."""
        # Implementation: scan environment for full bins
        self.current_task = "check_bins"
    
    def decide_action(self) -> str:
        """Decide whether to empty a bin or patrol."""
        if self.current_task == "bin_full":
            return "empty_bin"
        return "patrol"
    
    def act(self, env: SimulationEnvironment):
        """Execute the decided action."""
        action = self.decide_action()
        if action == "empty_bin":
            # Implementation: empty the bin
            print(f"{self.agent_id} is emptying a bin")
        else:
            print(f"{self.agent_id} is patrolling")
    
    # NOTE: We DON'T implement get_status() or on_interact()
    # because a Janitor is not acted upon by other agents


# ==============================================================================
# EXAMPLE 2: PASSIVE AGENT (Garbage Bin)
# Agent with state that can be queried and acted upon - but doesn't act autonomously
# ==============================================================================
class GarbageBin(Agent):
    """Passive agent that holds waste and can be emptied."""
    
    def __init__(self, agent_id: str, capacity: float):
        super().__init__(agent_id)
        self.capacity = capacity
        self.current_volume = 0.0
        self.location = None
    
    # PASSIVE TRAIT: Implement get_status and on_interact
    
    def get_status(self) -> dict:
        """Return current state of the bin."""
        return {
            "capacity": self.capacity,
            "current_volume": self.current_volume,
            "fill_percentage": (self.current_volume / self.capacity) * 100,
            "location": self.location,
            "is_full": self.current_volume >= self.capacity
        }
    
    def on_interact(self, initiator: Agent, action: str, env: SimulationEnvironment):
        """Handle interactions from other agents."""
        if action == "deposit_waste":
            # Student or other agent deposits waste
            amount = 1.0  # Could be passed as parameter
            self.current_volume = min(self.current_volume + amount, self.capacity)
            print(f"{initiator.agent_id} deposited waste into {self.agent_id}")
            
        elif action == "empty_bin":
            # Janitor empties the bin
            waste_removed = self.current_volume
            self.current_volume = 0.0
            print(f"{initiator.agent_id} emptied {waste_removed} units from {self.agent_id}")
    
    # NOTE: We DON'T implement perceive(), decide_action(), or act()
    # because a Garbage Bin doesn't act autonomously


# ==============================================================================
# EXAMPLE 3: HYBRID AGENT (Smart Garbage Truck)
# Agent that both acts autonomously AND has state that can be queried/acted upon
# ==============================================================================
class SmartGarbageTruck(Agent):
    """Hybrid agent that collects waste autonomously and has capacity state."""
    
    def __init__(self, agent_id: str, capacity: float):
        super().__init__(agent_id)
        self.capacity = capacity
        self.current_load = 0.0
        self.route = []
        self.next_target = None
    
    # ACTIVE TRAIT: Implement perceive, decide_action, and act
    
    def perceive(self, env: SimulationEnvironment):
        """Scan environment for bins that need collection."""
        # Implementation: identify full bins along route
        self.next_target = "Building_A_Bin"
    
    def decide_action(self) -> str:
        """Decide whether to collect, dump, or travel."""
        if self.current_load >= self.capacity * 0.9:
            return "go_to_dump"
        elif self.next_target:
            return "collect_waste"
        return "patrol_route"
    
    def act(self, env: SimulationEnvironment):
        """Execute the decided action."""
        action = self.decide_action()
        if action == "collect_waste":
            # Implementation: collect from bin
            print(f"{self.agent_id} collecting waste from {self.next_target}")
            self.current_load += 10.0
        elif action == "go_to_dump":
            print(f"{self.agent_id} going to dump site")
            self.current_load = 0.0
    
    # PASSIVE TRAIT: Implement get_status and on_interact
    
    def get_status(self) -> dict:
        """Return current state of the truck."""
        return {
            "capacity": self.capacity,
            "current_load": self.current_load,
            "fill_percentage": (self.current_load / self.capacity) * 100,
            "next_target": self.next_target,
            "is_full": self.current_load >= self.capacity
        }
    
    def on_interact(self, initiator: Agent, action: str, env: SimulationEnvironment):
        """Handle interactions from other agents (e.g., dispatch system, maintenance)."""
        if action == "assign_route":
            # Dispatch system assigns new route
            self.route = ["Building_A", "Building_B", "Building_C"]
            print(f"{initiator.agent_id} assigned new route to {self.agent_id}")
            
        elif action == "request_status":
            # Other agents can query status
            return self.get_status()


# ==============================================================================
# CODE GENERATION TEMPLATE USAGE
# ==============================================================================

def generate_agent_code(agent_name: str, traits: list[str]) -> str:
    """
    Generate agent code based on specified traits.
    
    Args:
        agent_name: Name of the agent class to generate
        traits: List containing 'active' and/or 'passive'
    
    Returns:
        Generated Python code as string
    """
    has_active = 'active' in traits
    has_passive = 'passive' in traits
    
    code = f'''class {agent_name}(Agent):
    """Generated agent with {', '.join(traits)} trait(s)."""
    
    def __init__(self, agent_id: str):
        super().__init__(agent_id)
        # Add your custom attributes here
        pass
'''
    
    if has_active:
        code += '''
    # ACTIVE TRAIT METHODS
    
    def perceive(self, env: SimulationEnvironment):
        """Gather information from environment."""
        # TODO: Implement perception logic
        pass
    
    def decide_action(self) -> str:
        """Decide what action to take."""
        # TODO: Implement decision logic
        return "idle"
    
    def act(self, env: SimulationEnvironment):
        """Execute the decided action."""
        # TODO: Implement action logic
        pass
'''
    
    if has_passive:
        code += '''
    # PASSIVE TRAIT METHODS
    
    def get_status(self) -> dict:
        """Return current state."""
        # TODO: Return relevant state information
        return {"state": self.state}
    
    def on_interact(self, initiator: Agent, action: str, env: SimulationEnvironment):
        """Handle interactions from other agents."""
        # TODO: Implement interaction handling
        pass
'''
    
    return code


# Example usage:
if __name__ == "__main__":
    # Generate code for different agent types
    
    print("=" * 80)
    print("ACTIVE AGENT (Student)")
    print("=" * 80)
    print(generate_agent_code("Student", ['active']))
    
    print("\n" + "=" * 80)
    print("PASSIVE AGENT (WasteBuffer)")
    print("=" * 80)
    print(generate_agent_code("WasteBuffer", ['passive']))
    
    print("\n" + "=" * 80)
    print("HYBRID AGENT (SortingStation)")
    print("=" * 80)
    print(generate_agent_code("SortingStation", ['active', 'passive']))
