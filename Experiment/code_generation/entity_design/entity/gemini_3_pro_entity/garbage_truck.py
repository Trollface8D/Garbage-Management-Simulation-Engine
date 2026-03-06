import random
from typing import TYPE_CHECKING, Optional, List, Dict, Any
from entity_object_template import entity_object

if TYPE_CHECKING:
    from environment_template import SimulationEnvironment

class GarbageTruck(entity_object):
    """
    Garbage Truck / Waste Collector entity for the waste management simulation.
    
    This is an ACTIVE entity that operates on specific schedules, collects waste 
    from various campus points, and transports it to sorting facilities or external landfills.
    """
    
    def __init__(self, entity_object_id: str, is_garden_team: bool = False):
        super().__init__(entity_object_id)
        
        # Logic derived from: "ซึ่งขยะภายนอกเนี่ย ก็จะเป็นทีมของงานสวน ที่ดูแลสวนภายนอกเนี่ย เขาจะมีฝ่ายที่เป็นฝ่ายจัดการขยะ เขาก็จะขับรถเนี่ย เก็บรอบ ม."
        # The garden team has a specific unit that drives around collecting external waste.
        self.is_garden_team = is_garden_team 
        
        self.capacity_kg = 2000.0  # Assumed standard truck capacity
        self.current_load_kg = 0.0
        self.collected_waste_items = []
        self.current_time = "morning"
        self.action_intent = None
        
        self.accumulated_extra_costs = 0.0
        self.has_large_debris = False

    # ==================== HYBRID / PASSIVE TRAITS ====================

    def get_status(self) -> Dict[str, Any]:
        """Returns the current state of the garbage truck."""
        return {
            "entity_id": self.entity_object_id,
            "is_garden_team": self.is_garden_team,
            "current_load_kg": self.current_load_kg,
            "capacity_kg": self.capacity_kg,
            "accumulated_extra_costs": self.accumulated_extra_costs,
            "state": self.state
        }

    # ==================== ACTIVE TRAIT METHODS ====================
    
    def perceive(self, env: Optional['SimulationEnvironment'] = None):
        """
        Gathers information on the current time and available waste from the environment.
        """
        if env:
            self.current_time = env.get_time_of_day()
            self.pending_collection_points = env.get_collection_points_with_waste()
            self.special_requests = env.get_special_pickup_requests()
        else:
            self.pending_collection_points = True
            self.special_requests = False

    def decide_action(self) -> Optional[str]:
        """
        Decides the collection route based on the time of day, load capacity, and special requests.
        """
        if self.current_load_kg >= self.capacity_kg:
            self.action_intent = "transport_to_destination"
            return self.action_intent

        # Logic derived from: "อย่างสมมติ รถรอบเนี่ยมาเก็บตอน 3 โมง..."
        # Truck performs its standard scheduled collection at 3 PM.
        if self.current_time == "3pm":
            self.action_intent = "collect_regular_route"
            
        # Logic derived from: "ว่าสมมติถ้ามีขยะเศษวัสดุ ที่เป็นชิ้นใหญ่ อะไรอย่างเงี้ย เราก็จะนับวัน เพื่อมาเก็บเป็นแต่ละรอบๆ ไป"
        # Large construction waste requires scheduling specific pickup rounds.
        elif self.special_requests and self.current_time == "scheduled_round":
            self.action_intent = "collect_special_round"
            
        # Logic derived from: "เขาจะมาขับรถเก็บตอนรอบ 5 โมง อีกรอบเหรอ... ซึ่งเขาต้องเสียเงินเพิ่ม"
        # Collecting an additional round at 5 PM incurs extra financial costs.
        elif self.current_time == "5pm" and self.pending_collection_points:
            self.action_intent = "collect_extra_round"
            
        # Logic derived from: "พอเก็บรวบรวมครบเสร็จ เขาก็จะไปที่โรงคัดแยกขยะ"
        # Completion of waste collection leads to transporting waste.
        elif self.current_time in ["end_of_day", "evening"] and self.current_load_kg > 0:
            self.action_intent = "transport_to_destination"
            
        else:
            self.action_intent = "idle"
            
        return self.action_intent

    def act(self, env: Optional['SimulationEnvironment'] = None):
        """
        Executes the collection, transport, or dumping actions.
        """
        if self.action_intent == "collect_regular_route":
            self._perform_collection(env, is_extra_round=False)
            
        elif self.action_intent == "collect_special_round":
            self._perform_special_collection(env)
            
        elif self.action_intent == "collect_extra_round":
            self._perform_collection(env, is_extra_round=True)
            
        elif self.action_intent == "transport_to_destination":
            self._dump_at_destination(env)
            
        elif self.action_intent == "idle":
            self.state = "Idle"

    # ==================== INTERNAL BEHAVIOR LOGIC ====================

    def _perform_collection(self, env: Optional['SimulationEnvironment'], is_extra_round: bool):
        """
        Handles the mechanics of picking up waste from bins/cages and loading it onto the truck.
        """
        self.state = "Collecting"
        
        if is_extra_round:
            # Logic derived from: "เขาจะมาขับรถเก็บตอนรอบ 5 โมง อีกรอบเหรอ... ซึ่งเขาต้องเสียเงินเพิ่ม"
            self.accumulated_extra_costs += 1000.0  # Arbitrary extra cost penalty for the simulation
        
        # In a full simulation, this would iterate over physical cages in `env`
        collected_volume = random.uniform(200.0, 500.0) 
        
        if self.current_load_kg + collected_volume <= self.capacity_kg:
            self.current_load_kg += collected_volume
            
            # Logic derived from: "แล้วก็เวลาเราขนส่ง เราก็คือ เราใส่รวมกันอยู่แล้ว... แล้วเราค่อยไปแยกปลายทางใช่ไหมครับ"
            # The transport process involves mixing waste types initially in the truck.
            self.collected_waste_items.append("mixed_transport_waste")
            
            # Logic derived from: "คนเก็บขยะ ใช้รุนแรง ชิบหาย ไอ้เหี้ย มึงใช้มือ พวกเหี้ย นี่ใช้ตีน ตี แตก แหกเนี่ย... พังหมด"
            # Garbage collectors using rough handling causes equipment damage.
            # We trigger a potential damage event on the passive objects (bins) in the environment.
            if env and random.random() < 0.3:  # 30% chance of rough handling
                env.trigger_event("equipment_damaged_by_collectors", severity="high")
        else:
            self.current_load_kg = self.capacity_kg

    def _perform_special_collection(self, env: Optional['SimulationEnvironment']):
        """
        Handles specific non-routine pickups, such as large materials from shops.
        """
        self.state = "Special_Collection"
        
        # Logic derived from: "บางพื้นที่ของอาคารเนี้ย มีพื้นที่อยู่ในช็อป ใช่ไหม เขาก็จะอาจมากองลงตรงนี้ไว้ก่อน... เขาก็จะเข้ามาคุย เข้าไปเก็บในช็อปเลย"
        # Waste collectors collect waste directly from the shop.
        collected_volume = random.uniform(100.0, 300.0)
        self.current_load_kg += collected_volume
        self.has_large_debris = True

    def _dump_at_destination(self, env: Optional['SimulationEnvironment']):
        """
        Empties the truck at the appropriate facility depending on the load.
        """
        self.state = "Transporting_and_Dumping"
        
        if self.has_large_debris:
            # Logic derived from: "เศษวัสดุ เนี่ย ถ้ามันไม่ได้... เอาไปใช้ประโยชน์อะไรไม่ได้แล้วเนี่ย เขาก็จะขี่ เอารถที่ขนขยะเนี่ย ขนเอาไปทิ้งด้านนอก"
            # Unusable construction waste leads to transportation to external landfill.
            destination = "External_Landfill"
            self.has_large_debris = False
        else:
            # Logic derived from: "พอเก็บรวบรวมครบเสร็จ เขาก็จะไปที่โรงคัดแยกขยะ"
            # Completion of regular waste collection leads to transporting waste to the sorting plant.
            destination = "Sorting_Plant"
            
        if env:
            env.log_event(f"Truck {self.entity_object_id} dumped {self.current_load_kg}kg at {destination}.")
            
        # Reset state after dumping
        self.current_load_kg = 0.0
        self.collected_waste_items.clear()
        self.state = "Idle"