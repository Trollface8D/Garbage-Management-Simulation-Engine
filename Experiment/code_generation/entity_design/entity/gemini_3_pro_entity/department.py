import random
from typing import TYPE_CHECKING, Optional, Dict, Any
from entity_object_template import entity_object

if TYPE_CHECKING:
    from environment_template import SimulationEnvironment

class Department(entity_object):
    """
    Department (Unit/Office/Faculty) entity for the waste management simulation.
    
    This is an ACTIVE entity that generates waste, brings it down to designated spots,
    labels it for revenue tracking, and requests special pickup rounds for large materials.
    """
    
    def __init__(self, entity_object_id: str, department_name: str, has_shop_space: bool = False):
        super().__init__(entity_object_id)
        self.department_name = department_name
        self.state = "Idle"
        
        # Entity characteristics based on qualitative data
        self.has_shop_space = has_shop_space
        
        # Waste inventory
        self.general_waste_volume = 0.0
        self.large_debris_volume = 0.0
        
        self.action_intent = None
        self.earned_revenue = 0.0

    # ==================== ACTIVE TRAIT METHODS ====================
    
    def perceive(self, env: Optional['SimulationEnvironment'] = None):
        """
        Gathers information and passively generates waste over time.
        """
        # Passive waste generation
        if random.random() < 0.3:
            self.general_waste_volume += random.uniform(2.0, 10.0)
        
        # Occasional large waste generation (e.g., from shop space)
        if self.has_shop_space and random.random() < 0.1:
            self.large_debris_volume += random.uniform(20.0, 50.0)

    def decide_action(self) -> Optional[str]:
        """
        Decides the next action based on accumulated waste.
        """
        # Logic derived from: "ถ้าเป็นของหน่วยงาน หรือเป็นของทางคณะ อะไรพวกเนี้ย เขาก็จะเรียกเป็นรอบๆ"
        # Departments/Faculties request pickup rounds for large or specific waste.
        if self.large_debris_volume > 0 or self.general_waste_volume > 30.0:
            self.action_intent = "request_pickup_round"
            return self.action_intent

        # Logic derived from: "เขาก็จะเอาขยะจากหน่วยงาน หรือสำนักงานของตัวเองเนี่ยลงมาไว้ตามแต่ละตึก ตามใต้ตึกอะ ตามจุดที่เขาคุยกันไว้"
        # Units and offices bring down waste to designated spots at each building.
        if self.general_waste_volume > 0 and self.state == "Idle":
            self.action_intent = "bring_down_and_label_waste"
            return self.action_intent

        self.action_intent = "idle"
        return self.action_intent

    def act(self, env: Optional['SimulationEnvironment'] = None):
        """
        Executes the decided action.
        """
        if self.action_intent == "request_pickup_round":
            self._perform_pickup_request(env)
            
        elif self.action_intent == "bring_down_and_label_waste":
            self._perform_bring_down_and_label(env)
            
        elif self.action_intent == "idle":
            self.state = "Idle"

    # ==================== INTERNAL BEHAVIOR LOGIC ====================

    def _perform_pickup_request(self, env: Optional['SimulationEnvironment']):
        """
        Simulates the department scheduling a special pickup round for large waste.
        """
        self.state = "Scheduling_Pickup"
        
        if env:
            env.trigger_event("schedule_special_pickup", payload={
                "requester": self.department_name,
                "waste_volume": self.large_debris_volume + self.general_waste_volume
            })
            
        # Logic derived from: "บางพื้นที่ของอาคารเนี้ย มีพื้นที่อยู่ในช็อป ใช่ไหม เขาก็จะอาจมากองลงตรงนี้ไว้ก่อน... เขาก็จะเข้ามาคุย เข้าไปเก็บในช็อปเลย"
        # Faculties with shop space store waste inside the shop before pickup.
        if self.has_shop_space:
            self.state = "Storing_Waste_In_Shop"
        else:
            self.large_debris_volume = 0.0 # Handled by the pickup
            self.state = "Idle"

    def _perform_bring_down_and_label(self, env: Optional['SimulationEnvironment']):
        """
        Simulates bringing waste to a designated spot and labeling it for revenue tracking.
        """
        self.state = "Disposing_Waste"
        
        # Logic derived from: "เขาก็จะติดป้ายไว้ว่าเป็นของหน่วยงานใคร"
        # Units and offices label waste to identify ownership.
        waste_payload = {
            "amount": self.general_waste_volume,
            "type": "general",
            "source": self.department_name,
            "ownership_label": self.department_name 
        }
        
        if env:
            target_spot = env.get_nearest_waste_cage(self.entity_object_id)
            if target_spot:
                env.interact_with_object(target_spot, "deposit_waste", payload=waste_payload)
            
            # Logic derived from: "แต่ถ้าเป็นของหน่วยงาน หรือสำนักงาน หรือภาคเนี่ย ก็จะเข้าหน่วยงาน 80 เข้ามหาวิทยาลัย 20"
            # Revenue from unit waste is allocated to the Unit 80%.
            # The actual revenue transfer happens downstream (e.g., via Finance Division),
            # but the label ensures it is credited to this department during the sorting process.
            
        self.general_waste_volume = 0.0
        self.state = "Idle"
        
    def receive_revenue(self, amount: float):
        """
        Updates the earned revenue for the department.
        """
        # Logic derived from: "เพื่อส่งข้อมูลพวกเนี้ยให้กับทางกองคลัง เพื่อโอนเงินให้กับ จัดจ่ายเรื่องเงินให้กับแต่ละหน่วยงาน"
        # Sending waste data to Finance Division enables money transfer to units.
        self.earned_revenue += amount
        self.state = "Revenue_Received"