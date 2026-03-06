import random
from typing import TYPE_CHECKING, Optional, Dict, Any
from entity_object_template import entity_object

if TYPE_CHECKING:
    from environment_template import SimulationEnvironment

class UniversityPersonnel(entity_object):
    """
    UniversityPersonnel (Staff/Units/Faculties/Offices) entity for the waste management simulation.
    
    This is an ACTIVE entity that generates waste, keeps waste in offices or shops, 
    requests specific pickup rounds, labels waste for revenue tracking, and complains about overflow.
    """
    
    def __init__(self, entity_object_id: str, department_name: str, has_shop_space: bool = False, has_lab: bool = False):
        super().__init__(entity_object_id)
        self.department_name = department_name
        self.state = "Idle"
        
        # Entity characteristics based on qualitative data
        self.has_shop_space = has_shop_space
        self.has_lab = has_lab
        self.keeps_food_in_office = random.choice([True, False])
        self.ignores_lab_rules = random.choice([True, False]) if has_lab else False
        
        # Waste inventory
        self.general_waste_volume = 0.0
        self.large_debris_volume = 0.0
        
        self.sees_overflow = False
        self.pests_in_office = False
        self.action_intent = None
        self.earned_revenue = 0.0

    # ==================== ACTIVE TRAIT METHODS ====================
    
    def perceive(self, env: Optional['SimulationEnvironment'] = None):
        """
        Gathers information from the environment, such as time of day, 
        and visual checks of nearby designated waste spots.
        """
        if env:
            # Check if designated spots or bins are overflowing
            nearest_bin = env.get_nearest_bin(self.entity_object_id)
            if nearest_bin and nearest_bin.get_status().get("state") == "Overflowing":
                self.sees_overflow = True
            else:
                self.sees_overflow = False
        else:
            self.sees_overflow = random.choice([True, False])

        # Passive waste generation during work hours
        if random.random() < 0.4:
            self.general_waste_volume += random.uniform(1.0, 5.0)
        
        # Occasional large waste generation (e.g., from shop or events)
        if self.has_shop_space and random.random() < 0.1:
            self.large_debris_volume += random.uniform(20.0, 50.0)

    def decide_action(self) -> Optional[str]:
        """
        Decides the next action based on accumulated waste, office conditions, and environment state.
        """
        # Logic derived from: "สุดท้ายเนี่ย ก็จะมีพวกแบบเนี้ย มา ทำให้แบบ เกิดเหตุ อะ ถ่ายเคมี 6 รั่วไหล 6 รดตัวเองบ้าง"
        # Ignoring lab regulations causes chemical spills and personal injury.
        if self.has_lab and self.ignores_lab_rules and random.random() < 0.05:
            self.action_intent = "trigger_lab_accident"
            return self.action_intent

        # Logic derived from: "กินข้าวบูด... อยู่ในออฟฟิศ หนู มด อ่า พวกเนี้ย ซึ่งต่อเนื่องมาอีก จัดการยากกว่าเดิมอีก"
        # Keeping food waste in the office attracts rats and ants.
        if self.keeps_food_in_office and self.general_waste_volume > 3.0 and not self.pests_in_office:
            self.action_intent = "attract_office_pests"
            return self.action_intent

        # Logic derived from: "ถ้าเป็นของหน่วยงาน หรือเป็นของทางคณะ อะไรพวกเนี้ย เขาก็จะเรียกเป็นรอบๆ"
        # Departments and faculties request pickup rounds (managed process).
        if self.large_debris_volume > 0 or self.general_waste_volume > 20.0:
            self.action_intent = "request_pickup_round"
            return self.action_intent

        # Logic derived from: "เขาก็จะเอาขยะจากหน่วยงาน หรือสำนักงานของตัวเองเนี่ยลงมาไว้ตามแต่ละตึก ตามใต้ตึกอะ ตามจุดที่เขาคุยกันไว้"
        # Units and offices bring down waste to designated spots at each building.
        if self.general_waste_volume > 0 and self.state == "Idle":
            self.action_intent = "bring_down_and_label_waste"
            return self.action_intent

        # Logic derived from: "ก็จะถูกฟ้องอะไรเงี้ย ก็คือจากบุคลากรบ้าง จากนักศึกษาบ้าง ว่าขยะแต่ละจุดเนี่ยมันล้น"
        # Trash overflow at various points leads to complaints from staff.
        if self.sees_overflow and self.state == "Idle" and random.random() < 0.3:
            self.action_intent = "complain_about_overflow"
            return self.action_intent

        self.action_intent = "idle"
        return self.action_intent

    def act(self, env: Optional['SimulationEnvironment'] = None):
        """
        Executes the decided action, interacting with the environment, coordinators, or holding spots.
        """
        if self.action_intent == "trigger_lab_accident":
            self._perform_lab_accident(env)
            
        elif self.action_intent == "attract_office_pests":
            self._perform_pest_attraction(env)
            
        elif self.action_intent == "request_pickup_round":
            self._perform_pickup_request(env)
            
        elif self.action_intent == "bring_down_and_label_waste":
            self._perform_bring_down_and_label(env)
            
        elif self.action_intent == "complain_about_overflow":
            self._perform_complaint(env)
            
        elif self.action_intent == "idle":
            self.state = "Idle"

    # ==================== INTERNAL BEHAVIOR LOGIC ====================

    def _perform_lab_accident(self, env: Optional['SimulationEnvironment']):
        """Simulates a chemical spill due to ignoring regulations."""
        self.state = "Handling_Emergency"
        if env:
            env.trigger_event("chemical_spill_accident", payload={"source": self.department_name})
        self.state = "Idle"

    def _perform_pest_attraction(self, env: Optional['SimulationEnvironment']):
        """Simulates pests invading the office due to stored food waste."""
        self.state = "Dealing_With_Pests"
        self.pests_in_office = True
        if env:
            env.log_event(f"Pests (rats/ants) attracted to office {self.department_name} due to kept food waste.")

    def _perform_pickup_request(self, env: Optional['SimulationEnvironment']):
        """
        Simulates staff contacting the coordinator to schedule a pickup round.
        """
        self.state = "Scheduling_Pickup"
        
        # Logic derived from: "สมมุติขยะที่นี่มี เขาก็จะติดต่อคนนี้... พี่คนเนี้ยก็จะติดต่อไปทางพี่มอส เพื่อจะนัดวัน เพื่อจะเข้ามารับ"
        # Building PM contacts the coordinator when waste is present, who contacts Mr. Moss to schedule pickup.
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
            self.large_debris_volume = 0.0 # Assuming it gets picked up
            self.state = "Idle"

    def _perform_bring_down_and_label(self, env: Optional['SimulationEnvironment']):
        """
        Simulates staff bringing waste to a designated spot and labeling it for revenue tracking.
        """
        self.state = "Disposing_Waste"
        
        # Logic derived from: "เขาก็จะเอาขยะจากหน่วยงาน หรือสำนักงานของตัวเองเนี่ยลงมาไว้ตามแต่ละตึก ตามจุดที่เขาคุยกันไว้ เขาก็จะติดป้ายไว้ว่าเป็นของหน่วยงานใคร"
        # Units and offices label waste to identify ownership.
        waste_payload = {
            "amount": self.general_waste_volume,
            "type": "general",
            "source": self.department_name,
            "ownership_label": self.department_name # Crucial for the 80/20 revenue split downstream
        }
        
        if env:
            target_spot = env.get_nearest_waste_cage(self.entity_object_id)
            if target_spot:
                env.interact_with_object(target_spot, "deposit_waste", payload=waste_payload)
                
            # Logic derived from: "แม่บ้านที่จะคอยดูแล ก็คือจะมาคอยเก็บ ช่วยคัดแยกในระดับนึง จากการที่นักศึกษา หรือบุคลากรทิ้ง"
            # Staff discarding waste triggers housekeepers sorting partially.
            env.trigger_event("notify_janitor_waste_discarded")
            
            # Logic derived from: "แต่ถ้าเป็นของหน่วยงาน หรือสำนักงาน หรือภาคเนี่ย ก็จะเข้าหน่วยงาน 80 เข้ามหาวิทยาลัย 20"
            # Revenue from unit waste is allocated to the Unit 80% (Handled downstream, but entity resets its volume here)
            
        self.general_waste_volume = 0.0
        self.pests_in_office = False # Clearing waste clears the immediate pest attractant
        self.state = "Idle"

    def _perform_complaint(self, env: Optional['SimulationEnvironment']):
        """Simulates personnel complaining to administration about overflowing bins."""
        self.state = "Complaining"
        if env:
            env.log_event(f"Complaint filed by Staff/Unit {self.department_name} regarding trash overflow.")
        self.sees_overflow = False
        self.state = "Idle"