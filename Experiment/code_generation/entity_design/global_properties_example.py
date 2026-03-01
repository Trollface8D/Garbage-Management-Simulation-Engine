"""
Example: Active Agents Modifying Global Properties and Passive Agents Observing Them

This example demonstrates how:
1. Active agents can modify global environment properties
2. Passive agents are affected by these global properties
3. All agents can observe the environment state
"""

from entity.agent import Agent
from entity.environment import SimulationEnvironment
from typing import Optional


# ==============================================================================
# EXAMPLE 1: ACTIVE AGENT MODIFYING GLOBAL PROPERTIES
# ==============================================================================
class WeatherStation(Agent):
    """Active agent that updates weather conditions in the environment."""
    
    def __init__(self, agent_id: str):
        super().__init__(agent_id)
        self.current_weather = "sunny"
    
    def perceive(self, env: Optional[SimulationEnvironment] = None):
        """Sense external weather conditions."""
        # Simulate weather detection
        import random
        weather_options = ["sunny", "rainy", "cloudy"]
        self.current_weather = random.choice(weather_options)
    
    def decide_action(self) -> str:
        """Decide to update weather if changed."""
        return "update_weather"
    
    def act(self, env: Optional[SimulationEnvironment] = None):
        """Update global weather property in environment."""
        if env:
            # Active agent modifies global property
            env.set_property('weather', self.current_weather)
            env.set_property('last_updated', 'now')
            print(f"{self.agent_id} updated weather to: {self.current_weather}")


class PriceController(Agent):
    """Active agent that adjusts waste collection prices based on demand."""
    
    def __init__(self, agent_id: str):
        super().__init__(agent_id)
        self.price = 5.0
    
    def perceive(self, env: Optional[SimulationEnvironment] = None):
        """Check current demand and capacity."""
        if env:
            demand = env.get_property('waste_demand', 100)
            capacity = env.get_property('collection_capacity', 100)
            
            # Calculate price based on demand/capacity ratio
            if demand > capacity:
                self.price = 7.0  # High demand
            elif demand < capacity * 0.5:
                self.price = 3.0  # Low demand
            else:
                self.price = 5.0  # Normal
    
    def decide_action(self) -> str:
        return "update_price"
    
    def act(self, env: Optional[SimulationEnvironment] = None):
        """Update global waste collection price."""
        if env:
            # Active agent modifies global property
            env.set_property('waste_collection_price', self.price)
            print(f"{self.agent_id} set price to: ${self.price}")


# ==============================================================================
# EXAMPLE 2: PASSIVE AGENT AFFECTED BY GLOBAL PROPERTIES
# ==============================================================================
class OutdoorGarbageBin(Agent):
    """Passive agent whose behavior is affected by weather."""
    
    def __init__(self, agent_id: str, capacity: float):
        super().__init__(agent_id)
        self.capacity = capacity
        self.current_volume = 0.0
        self.location = "outdoor"
    
    def get_status(self) -> dict:
        """Return status, affected by global weather property."""
        # Passive agent observes global property
        # Note: In practice, you'd pass env to get_status or cache it
        return {
            "capacity": self.capacity,
            "current_volume": self.current_volume,
            "location": self.location,
            "is_full": self.current_volume >= self.capacity
        }
    
    def on_interact(self, initiator: Agent, action: str, env: Optional[SimulationEnvironment] = None):
        """Handle interactions, behavior modified by weather."""
        if action == "deposit_waste":
            amount = 1.0
            
            # Passive agent observes global environment property
            if env:
                weather = env.get_property('weather', 'sunny')
                
                # Weather affects decomposition rate
                if weather == "rainy":
                    # Rain compacts waste, effective volume reduced
                    amount *= 0.8
                    print(f"  [Weather Effect] Rain compacting waste in {self.agent_id}")
                elif weather == "sunny":
                    # Heat expands waste, effective volume increased
                    amount *= 1.2
                    print(f"  [Weather Effect] Heat expanding waste in {self.agent_id}")
            
            self.current_volume = min(self.current_volume + amount, self.capacity)
            print(f"{initiator.agent_id} deposited {amount:.1f} units into {self.agent_id}")
            
        elif action == "empty_bin":
            waste_removed = self.current_volume
            self.current_volume = 0.0
            print(f"{initiator.agent_id} emptied {waste_removed:.1f} units from {self.agent_id}")


class WasteCollectionTruck(Agent):
    """Passive agent whose capacity is affected by global fuel price."""
    
    def __init__(self, agent_id: str, capacity: float):
        super().__init__(agent_id)
        self.base_capacity = capacity
        self.current_load = 0.0
    
    def get_status(self) -> dict:
        """Return status with effective capacity based on fuel price."""
        return {
            "base_capacity": self.base_capacity,
            "current_load": self.current_load,
            "is_full": self.current_load >= self.base_capacity
        }
    
    def on_interact(self, initiator: Agent, action: str, env: Optional[SimulationEnvironment] = None):
        """Handle interactions, affected by global economic conditions."""
        if action == "load_waste":
            amount = 10.0
            
            # Passive agent observes global economic property
            if env:
                fuel_price = env.get_property('fuel_price', 1.0)
                
                # High fuel price means truck operates at reduced capacity to save costs
                effective_capacity = self.base_capacity
                if fuel_price > 2.0:
                    effective_capacity = self.base_capacity * 0.7
                    print(f"  [Economic Effect] High fuel price reducing {self.agent_id} operations")
                
                # Check against effective capacity
                if self.current_load + amount > effective_capacity:
                    print(f"  [Capacity Limit] {self.agent_id} at effective capacity!")
                    return
            
            self.current_load = min(self.current_load + amount, self.base_capacity)
            print(f"{initiator.agent_id} loaded {amount} units into {self.agent_id}")
            
        elif action == "unload":
            self.current_load = 0.0
            print(f"{initiator.agent_id} unloaded {self.agent_id}")


# ==============================================================================
# EXAMPLE 3: HYBRID AGENT BOTH MODIFYING AND OBSERVING GLOBAL PROPERTIES
# ==============================================================================
class SmartSortingStation(Agent):
    """Hybrid agent that both observes and modifies global properties."""
    
    def __init__(self, agent_id: str):
        super().__init__(agent_id)
        self.sorted_waste = {"recyclable": 0, "general": 0}
        self.efficiency = 1.0
    
    # ACTIVE TRAIT: Perceive and Act
    def perceive(self, env: Optional[SimulationEnvironment] = None):
        """Observe workload and adjust efficiency."""
        if env:
            # Observe global demand
            demand = env.get_property('waste_demand', 0)
            if demand > 200:
                self.efficiency = 0.7  # Overloaded
            else:
                self.efficiency = 1.0  # Normal operations
    
    def decide_action(self) -> str:
        return "update_sorting_capacity"
    
    def act(self, env: Optional[SimulationEnvironment] = None):
        """Update global sorting capacity based on efficiency."""
        if env:
            capacity = 100 * self.efficiency
            # Modify global property
            env.set_property('sorting_capacity', capacity)
            env.set_property('sorting_efficiency', self.efficiency)
            print(f"{self.agent_id} updated sorting capacity to: {capacity}")
    
    # PASSIVE TRAIT: Status and Interactions
    def get_status(self) -> dict:
        """Return status affected by global properties."""
        return {
            "sorted_waste": self.sorted_waste,
            "efficiency": self.efficiency
        }
    
    def on_interact(self, initiator: Agent, action: str, env: Optional[SimulationEnvironment] = None):
        """Handle waste sorting, affected by pricing."""
        if action == "sort_waste":
            if env:
                # Observe global pricing to determine sorting priority
                recyclable_price = env.get_property('recyclable_price', 10)
                general_price = env.get_property('general_price', 5)
                
                if recyclable_price > general_price * 2:
                    # High incentive for recycling
                    self.sorted_waste["recyclable"] += 70
                    self.sorted_waste["general"] += 30
                    print(f"  [Price Effect] {self.agent_id} prioritizing recyclables (price: ${recyclable_price})")
                else:
                    # Normal sorting
                    self.sorted_waste["recyclable"] += 50
                    self.sorted_waste["general"] += 50
                    print(f"  [Normal] {self.agent_id} standard sorting")


# ==============================================================================
# SIMULATION EXAMPLE
# ==============================================================================
def run_simulation():
    """Demonstrate active agents modifying and passive agents observing global properties."""
    
    print("="*80)
    print("SIMULATION: Global Properties in Action")
    print("="*80)
    
    # Create environment
    env = SimulationEnvironment()
    
    # Set initial global properties
    env.set_property('weather', 'sunny')
    env.set_property('fuel_price', 1.5)
    env.set_property('waste_demand', 100)
    env.set_property('collection_capacity', 100)
    env.set_property('recyclable_price', 15)
    env.set_property('general_price', 5)
    
    # Create agents
    weather_station = WeatherStation("WeatherStation_1")
    price_controller = PriceController("PriceController_1")
    outdoor_bin = OutdoorGarbageBin("OutdoorBin_1", capacity=100)
    truck = WasteCollectionTruck("Truck_1", capacity=200)
    sorting_station = SmartSortingStation("SortingStation_1")
    
    # Register all agents
    env.register_agent(weather_station)
    env.register_agent(price_controller)
    env.register_agent(outdoor_bin)
    env.register_agent(truck)
    env.register_agent(sorting_station)
    
    print("\n--- STEP 1: Active agents perceive and modify environment ---")
    weather_station.perceive(env)
    weather_station.act(env)
    
    print("\n--- STEP 2: Passive agent affected by weather ---")
    class Student(Agent):
        def __init__(self, aid):
            super().__init__(aid)
        def perceive(self, env): pass
        def decide_action(self): return "dispose"
        def act(self, env): pass
    
    student = Student("Student_1")
    outdoor_bin.on_interact(student, "deposit_waste", env)
    
    print("\n--- STEP 3: Active agent modifies economic conditions ---")
    env.set_property('fuel_price', 2.5)  # Fuel price increases
    print(f"Environment: Fuel price increased to ${env.get_property('fuel_price')}")
    
    print("\n--- STEP 4: Passive agent affected by economic conditions ---")
    truck.on_interact(student, "load_waste", env)
    
    print("\n--- STEP 5: Hybrid agent observes and modifies ---")
    env.set_property('waste_demand', 250)  # High demand
    sorting_station.perceive(env)
    sorting_station.act(env)
    sorting_station.on_interact(student, "sort_waste", env)
    
    print("\n--- FINAL GLOBAL STATE ---")
    properties = env.get_all_properties()
    for key, value in sorted(properties.items()):
        print(f"  {key}: {value}")
    
    print("\n" + "="*80)


if __name__ == "__main__":
    run_simulation()
