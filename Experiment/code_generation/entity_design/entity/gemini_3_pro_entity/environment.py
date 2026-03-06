# ===== waste_environment.py =====

import random
from typing import TYPE_CHECKING, Optional, Dict, Any, List
from environment_template import SimulationEnvironment

if TYPE_CHECKING:
    from entity_object_template import entity_object

class WasteManagementEnvironment(SimulationEnvironment):
    """
    The concrete simulation environment for the University Waste Management system.
    
    Acts as the Mediator for all active and passive entities (Janitors, Trucks, Bins, 
    Buildings, Sorting Facilities, etc.). It manages global time, tracks financial 
    ledgers, processes system-wide events, and facilitates spatial queries.
    
    Logic derived from: "กะว่าจะเอาไปทำเป็น ตัวจบ โปรเจกต์จบ... จะทำเป็นพวก แบบ แนว อ่า Optimize ระบบ"
    Logic derived from: "เราสร้าง Simulation ขึ้นมา แล้วแบบ พยายามที่จะ ลอกเลียนแบบ สภาวะตอนนี้ แล้วดูว่า พอเปลี่ยน นโยบาย เล็กน้อยเนี่ย ในจุดๆ นึงเนี่ย มันดีขึ้นไหม"
    (The environment is designed to simulate current conditions and allow policy optimization testing.)
    """

    TIME_PHASES = [
        "morning", 
        "midday", 
        "3pm", 
        "4pm", 
        "5pm", 
        "evening", 
        "late_night"
    ]

    def __init__(self):
        super().__init__()
        
        self.event_log: List[str] = []
        self.special_pickup_requests: List[Dict[str, Any]] = []
        
        # Finance Ledger to track university and unit revenues
        self.finance_ledger = {
            "university_central": 0.0,
            "units": {}
        }
        
        # Initialize default properties based on interview context
        self.set_property("time_of_day", "morning")
        self.set_property("time_index", 0)
        self.set_property("day_of_week", "monday")

    # ==================== TIME & SIMULATION LOOP ====================

    def tick(self):
        """
        Advances the simulation time and triggers perception/action loops for all entities.
        """
        # Advance time phase
        current_idx = self.get_property("time_index", 0)
        next_idx = (current_idx + 1) % len(self.TIME_PHASES)
        self.set_property("time_index", next_idx)
        self.set_property("time_of_day", self.TIME_PHASES[next_idx])
        
        time_now = self.get_time_of_day()
        self.log_event(f"--- Time advanced to: {time_now} ---")

        # Logic derived from: "น้องๆ มีจัดกิจกรรม รับน้อง... ก็จะเกิดขยะ มหาศาล... เที่ยงคืน ตี 2 มึงยังไม่เลิกกันเลย มันก็มีขยะพวกเนี้ย เกิดขึ้น"
        # Logic derived from: "อย่างสมมติ รถรอบเนี่ยมาเก็บตอน 3 โมง แม่บ้านที่อยู่ในอาคารเอามาทิ้งตอน 4 โมง"
        # The specific time phases dictate when certain actors behave (trucks at 3pm, maids at 4pm/5pm, students at late_night).

        # 1. All entities perceive their environment
        for entity in self.entity_objects:
            if hasattr(entity, 'perceive'):
                entity.perceive(self)

        # 2. All entities decide their actions
        for entity in self.entity_objects:
            if hasattr(entity, 'decide_action'):
                entity.decide_action()

        # 3. All entities act upon the environment
        for entity in self.entity_objects:
            if hasattr(entity, 'act'):
                entity.act(self)

    # ==================== HELPERS & MEDIATOR FUNCTIONS ====================

    def get_time_of_day(self) -> str:
        """Returns the current simulated time phase."""
        return self.get_property("time_of_day", "morning")

    def log_event(self, message: str):
        """Centralized logging for simulation events."""
        self.event_log.append(f"[{self.get_time_of_day().upper()}] {message}")
        print(f"[{self.get_time_of_day().upper()}] {message}")

    def trigger_event(self, event_name: str, payload: Any = None, **kwargs):
        """
        Handles system-wide events decoupled from direct entity-to-entity interaction.
        """
        if event_name == "finance_transfer":
            self._handle_finance_transfer(payload)
            
        elif event_name == "schedule_special_pickup":
            # Logic derived from: "ถ้าเป็นของหน่วยงาน หรือเป็นของทางคณะ อะไรพวกเนี้ย เขาก็จะเรียกเป็นรอบๆ"
            # (Departments request pickup rounds)
            self.special_pickup_requests.append(payload)
            self.log_event(f"Scheduled special pickup for {payload.get('requester')} ({payload.get('waste_volume')}kg).")
            
        elif event_name == "chemical_spill_accident":
            # Logic derived from: "ทำให้แบบ เกิดเหตุ อะ ถ่ายเคมี 6 รั่วไหล 6 รดตัวเองบ้าง"
            self.log_event(f"EMERGENCY: Chemical spill at {payload.get('source')} due to ignored regulations.")
            
        elif event_name == "equipment_damaged_by_collectors":
            # Logic derived from: "คนเก็บขยะ ใช้รุนแรง ชิบหาย ไอ้เหี้ย มึงใช้มือ พวกเหี้ย นี่ใช้ตีน ตี แตก แหกเนี่ย... พังหมด"
            severity = kwargs.get("severity", "high")
            self.log_event(f"Equipment damaged by garbage collectors handling roughly. Severity: {severity}.")
            
        elif event_name == "building_capacity_warning":
            # Logic derived from: "แต่ มันก็มีทางที่เขาเป็นคณะทำงานในเรื่องเนี้ย เขาก็จะตักเตือนอะไรเงี้ย ให้รีบจัดการ"
            self.log_event(f"Working committee issued warning for building {payload.get('building')} due to excessive overflow.")
            
        elif event_name == "executive_inspection_failure":
            # Logic derived from: "ตกค้างเย็นนี้ พรุ่งนี้เช้า อ่า พวกคณะทำงาน หรือประธานมาเห็นเนี่ย เขาก็จะบอกละ เอ๊ะ ทำไมจุดนี้ขยะเยอะจัง"
            self.log_event(f"Executive complaint: Waste residue found overnight at building {payload.get('building')}.")

    def interact_with_object(self, target_obj: 'entity_object', action: str, payload: Any = None):
        """Facilitates safe interaction between an active entity and a target object."""
        if hasattr(target_obj, 'on_interact'):
            target_obj.on_interact(initiator=self, action=action, env=self, payload=payload)

    # ==================== SPATIAL & QUERY HELPERS ====================

    def get_nearest_waste_cage(self, entity_id: str) -> Optional['entity_object']:
        """Returns the nearest CollectionPoint/Cage. (Simplified to return the first available for now)"""
        for obj in self.entity_objects:
            if obj.__class__.__name__ == "CollectionPoint":
                return obj
        return None

    def get_nearest_bin(self, entity_id: str) -> Optional['entity_object']:
        """Returns the nearest TrashCan."""
        for obj in self.entity_objects:
            if obj.__class__.__name__ == "TrashCan":
                return obj
        return None

    def get_entity_by_type(self, entity_type: str) -> Optional['entity_object']:
        """Retrieves specific disposal sites or singleton entities."""
        for obj in self.entity_objects:
            if getattr(obj, "site_type", None) == entity_type or getattr(obj, "bin_type", None) == entity_type:
                return obj
        return None

    def check_building_waste_level(self, entity_id: str) -> bool:
        """Helper for janitors to check if a building has generated waste."""
        for obj in self.entity_objects:
            if obj.__class__.__name__ == "Building" and obj.internal_waste_volume > 0:
                return True
        return False

    def get_collection_points_with_waste(self) -> bool:
        """Helper for garbage trucks to see if any standard pickup points have waste."""
        for obj in self.entity_objects:
            if obj.__class__.__name__ == "CollectionPoint" and obj.current_waste_kg > 0:
                return True
        return False

    def get_special_pickup_requests(self) -> bool:
        """Helper for garbage trucks to check for special departmental requests."""
        return len(self.special_pickup_requests) > 0

    # ==================== INTERNAL BUSINESS LOGIC ====================

    def _handle_finance_transfer(self, payload: Dict[str, Any]):
        """
        Processes financial payouts from sorting facility revenue to departments.
        """
        # Logic derived from: "เพื่อส่งข้อมูลพวกเนี้ยให้กับทางกองคลัง เพื่อโอนเงินให้กับ จัดจ่ายเรื่องเงินให้กับแต่ละหน่วยงาน"
        # (Sending waste data to Finance Division enables money transfer to units)
        
        # Logic derived from: "แต่ถ้าเป็นของหน่วยงาน หรือสำนักงาน หรือภาคเนี่ย ก็จะเข้าหน่วยงาน 80 เข้ามหาวิทยาลัย 20"
        # (Revenue from unit waste is allocated to the Unit 80% and University 20%)
        
        target_unit = payload.get("target_unit")
        unit_amount = payload.get("unit_amount", 0.0)
        university_amount = payload.get("university_amount", 0.0)
        
        if target_unit not in self.finance_ledger["units"]:
            self.finance_ledger["units"][target_unit] = 0.0
            
        self.finance_ledger["units"][target_unit] += unit_amount
        self.finance_ledger["university_central"] += university_amount
        
        self.log_event(f"FINANCE: Transferred {unit_amount} to {target_unit} and {university_amount} to University Central.")
        
        # Notify the actual department entity so it can update its internal state
        for obj in self.entity_objects:
            if obj.__class__.__name__ == "Department" and getattr(obj, "department_name", None) == target_unit:
                if hasattr(obj, "receive_revenue"):
                    obj.receive_revenue(unit_amount)

    # ==================== POLICY MANAGEMENT ====================

    def apply_policy(self, policy_name: str):
        """
        Applies a systemic change to observe its effects on the simulation.
        """
        self.log_event(f"*** APPLYING POLICY: {policy_name} ***")
        
        if policy_name == "upgrade_all_infrastructure":
            # Logic derived from: "พี่อยากจะเปลี่ยน ใหม่ ให้มันมีขนาดที่ ใหญ่กว่าเนี้ย แล้วก็มีหลังคง หลังคา ปิด"
            for obj in self.entity_objects:
                if obj.__class__.__name__ == "CollectionPoint":
                    self.interact_with_object(obj, "upgrade_infrastructure")
                    
        elif policy_name == "add_sorting_staff":
            # Logic derived from: "แต่ ถ้าเราจัดการขึ้น เราต้องไปหาคนอีกคน 2 คน มาเพื่อจัดการตรงนี้ ก่อน"
            # (Hiring additional staff increases financial cost but helps management)
            for obj in self.entity_objects:
                if obj.__class__.__name__ == "SortingFacility":
                    obj.staff_count += 2
                    obj.processing_capacity_per_tick = obj.staff_count * 50.0
            self.finance_ledger["university_central"] -= 10000.0 # Deduct budget
            
        elif policy_name == "rent_reusable_equipment":
            # Logic derived from: "เขา ก็ มีการ ไปเช่า พวก อุปกรณ์ อ่า พวกแก้วน้ำ พวกชาม พวกจาน มา ลดขยะ ได้ อย่าง เยอะ เลย"
            # (Renting reusable equipment reduces waste quantity)
            self.set_property("event_waste_reduction_modifier", 0.5)