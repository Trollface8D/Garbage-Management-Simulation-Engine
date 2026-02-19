from abc import ABC, abstractmethod
from typing import Any

# In this scenario, we will simulate a Janitor (Stakeholder) finding a full Garbage Bin (Object).
# When the Janitor empties it, a Revenue Policy (Policy) determines how the recycled waste is
# split into money for the university, and a Waste Overflow (System Behavior) monitors the
# environment to see if bins are getting too full.

# --- Base Templates (from previous step) ---
class Policy(ABC):
    @abstractmethod
    def enforce(self, context: Any) -> dict: pass

class SystemBehavior(ABC):
    @abstractmethod
    def check_condition(self, env: 'SimulationEnvironment') -> bool: pass
    @abstractmethod
    def execute(self, env: 'SimulationEnvironment'): pass

class SimulationObject(ABC):
    def __init__(self, object_id: str):
        self.object_id = object_id
    @abstractmethod
    def on_interact(self, initiator: 'Stakeholder', action: str, env: 'SimulationEnvironment'): pass

class Stakeholder(ABC):
    def __init__(self, stakeholder_id: str):
        self.stakeholder_id = stakeholder_id
    @abstractmethod
    def act(self, env: 'SimulationEnvironment'): pass


# --- 1. CONCRETE MEDIATOR (Environment) ---
class SimulationEnvironment:
    def __init__(self):
        self.stakeholders = []
        self.objects = []
        self.policies = {}
        self.behaviors = []
        self.university_funds = 0
        self.department_funds = 0

    def add_entity(self, entity):
        if isinstance(entity, Stakeholder): self.stakeholders.append(entity)
        elif isinstance(entity, SimulationObject): self.objects.append(entity)
        elif isinstance(entity, SystemBehavior): self.behaviors.append(entity)
        elif isinstance(entity, Policy): self.policies[entity.__class__.__name__] = entity

    def step(self):
        """Runs one 'tick' or step of the simulation."""
        print("\n--- Simulation Step Starting ---")
        
        # 1. Stakeholders take actions
        for stakeholder in self.stakeholders:
            stakeholder.act(self)
            
        # 2. System Behaviors react to the new state
        for behavior in self.behaviors:
            if behavior.check_condition(self):
                behavior.execute(self)

    def request_interaction(self, initiator, target_object, action):
        """Mediator routes the interaction from Stakeholder to Object."""
        target_object.on_interact(initiator, action, self)


# --- 2. CONCRETE OBJECT (Garbage Bin) ---
class GarbageBin(SimulationObject):
    def __init__(self, object_id: str, capacity: int, current_waste: int):
        super().__init__(object_id)
        self.capacity = capacity
        self.current_waste = current_waste

    def is_full(self):
        return self.current_waste >= self.capacity

    def on_interact(self, initiator: Stakeholder, action: str, env: SimulationEnvironment):
        if action == "empty_bin" and self.current_waste > 0:
            print(f"[{self.object_id}] {initiator.stakeholder_id} is emptying the bin.")
            
            # Fetch the policy from the environment to calculate revenue
            revenue_policy = env.policies.get("WasteRevenuePolicy")
            if revenue_policy:
                split = revenue_policy.enforce(self.current_waste)
                env.university_funds += split['university']
                env.department_funds += split['department']
                print(f"[{self.object_id}] Generated Funds -> Uni: ${split['university']}, Dept: ${split['department']}")

            self.current_waste = 0 # Bin is now empty


# --- 3. CONCRETE STAKEHOLDER (Janitor) ---
class Janitor(Stakeholder):
    def act(self, env: SimulationEnvironment):
        # Janitor perceives the environment: finds bins that need emptying
        for obj in env.objects:
            if isinstance(obj, GarbageBin) and obj.is_full():
                print(f"[{self.stakeholder_id}] Noticed {obj.object_id} is full. Taking action.")
                # Janitor does NOT directly change the bin. It asks the Environment to mediate.
                env.request_interaction(self, obj, "empty_bin")


# --- 4. CONCRETE POLICY (Revenue Split) ---
class WasteRevenuePolicy(Policy):
    def enforce(self, waste_amount: int) -> dict:
        """Translates waste volume into revenue: 60% University, 40% Department."""
        total_revenue = waste_amount * 2 # Let's say 1 unit of waste = $2
        return {
            "university": total_revenue * 0.60,
            "department": total_revenue * 0.40
        }


# --- 5. CONCRETE BEHAVIOR (Overflow Warning) ---
class BinOverflowBehavior(SystemBehavior):
    def check_condition(self, env: SimulationEnvironment) -> bool:
        # Condition: Are there any bins over capacity?
        return any(isinstance(obj, GarbageBin) and obj.current_waste > obj.capacity for obj in env.objects)

    def execute(self, env: SimulationEnvironment):
        print("[SYSTEM BEHAVIOR TRIGERRED] Warning: Waste overflow detected! Hygiene levels dropping.")


# ==========================================
# RUNNING THE SIMULATION
# ==========================================
if __name__ == "__main__":
    # Setup
    env = SimulationEnvironment()
    
    # Add our concrete entities
    env.add_entity(WasteRevenuePolicy())
    env.add_entity(BinOverflowBehavior())
    env.add_entity(Janitor("Janitor Bob"))
    
    # Add some bins (Bin 1 is full, Bin 2 is overflowing)
    env.add_entity(GarbageBin("Bin_A (Main Hall)", capacity=10, current_waste=10))
    env.add_entity(GarbageBin("Bin_B (Science Lab)", capacity=20, current_waste=25))

    # Run the simulation for one step
    env.step()
    
    # Print final environment state
    print(f"\n--- Final Environment State ---")
    print(f"University Funds: ${env.university_funds}")
    print(f"Department Funds: ${env.department_funds}")