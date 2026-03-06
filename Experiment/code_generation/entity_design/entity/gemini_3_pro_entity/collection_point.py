# ===== collection_point.py =====

import random
from typing import TYPE_CHECKING, Optional, Dict, Any, List
from entity_object_template import entity_object

if TYPE_CHECKING:
    from environment_template import SimulationEnvironment

class CollectionPoint(entity_object):
    """
    CollectionPoint (Waste Holding Cage / จุดพักขยะ) entity for the waste management simulation.
    
    This is a PASSIVE entity. It receives waste from active entities (Janitors, Students, Departments).
    It manages state related to capacity, overflow, and structural limitations based on budget.
    """
    
    def __init__(self, entity_object_id: str, location_type: str = "standard", budget_constrained: bool = True):
        super().__init__(entity_object_id)
        self.location_type = location_type
        
        # State variables
        self.current_waste_kg = 0.0
        self.piled_waste_kg = 0.0  # Waste piled outside the cage
        self.is_overflowing = False
        self.state = "Operational"
        
        # Design Attributes
        # Logic derived from: "งบมัน จำกัด ด้วยแหละ อืม ใช่... ซึ่งมันมี งบจำกัด ไง มันก็เลย ออกมาเป็น แบบเนี้ย"
        # (Limited budget resulted in the current waste cage design which is problematic)
        self.budget_constrained = budget_constrained
        
        if self.budget_constrained:
            self.capacity_kg = 150.0
            self.has_roof = False
            self.design_size = "compact"
        else:
            self._apply_upgraded_design()

    def _apply_upgraded_design(self):
        """Applies the ideal redesign features."""
        # Logic derived from: "พี่อยากจะเปลี่ยน ใหม่ ให้มันมีขนาดที่ ใหญ่กว่าเนี้ย แล้วก็มีหลังคง หลังคา ปิด กันฝ่ง กันฝน"
        # (The interviewer wants to redesign the waste cage to be larger and have a roof)
        self.capacity_kg = 400.0
        self.has_roof = True
        self.design_size = "large"
        self.budget_constrained = False

    # ==================== PASSIVE TRAIT METHODS ====================

    def get_status(self) -> Dict[str, Any]:
        """Returns the current structural and waste state of the collection point."""
        
        # Logic derived from: "แต่มันก็ ยังไม่ได้ ตอบโจทย์ หรือมันก็ ไม่ง่าย ต่อแม่บ้าน เอง เหมือนกัน อืม ซึ่งมันก็ เล็กเกินไป"
        # (The compact design of the cage causes difficulty for the cleaners because it is too small)
        difficulty_modifier = "High" if self.design_size == "compact" else "Low"
        
        return {
            "entity_id": self.entity_object_id,
            "location_type": self.location_type,
            "design": {
                "size": self.design_size,
                "has_roof": self.has_roof,
                "cleaner_difficulty": difficulty_modifier
            },
            "waste_levels": {
                "inside_cage_kg": self.current_waste_kg,
                "piled_outside_kg": self.piled_waste_kg,
                "capacity_kg": self.capacity_kg,
                "is_overflowing": self.is_overflowing
            },
            "state": self.state
        }

    def on_interact(self, initiator: 'entity_object', action: str, env: Optional['SimulationEnvironment'] = None, payload: Any = None):
        """Handles interactions such as receiving waste, compressing waste, or being emptied."""
        
        if action == "deposit_waste":
            self._receive_waste(payload)
            
        elif action == "compress_and_add_waste":
            self._receive_and_compress(payload)
            
        elif action == "pile_waste_outside":
            self._pile_waste(payload)
            
        elif action == "empty_cage":
            self._be_emptied()
            
        elif action == "trigger_external_influx":
            self._handle_external_influx()
            
        elif action == "upgrade_infrastructure":
            self._apply_upgraded_design()

    # ==================== INTERNAL BEHAVIOR LOGIC ====================

    def _receive_waste(self, amount: float):
        """Standard intake of waste into the cage."""
        if amount is None: return
        
        self.current_waste_kg += amount
        self._check_overflow()

    def _receive_and_compress(self, amount: float):
        """
        Simulates housekeepers adding and compressing morning trash, which paradoxically 
        leads to constant overflow due to structural limits.
        """
        if amount is None: return
        
        # Logic derived from: "ปัญหาที่ขยะล้นจุดพักขยะเนี่ย จะเป็นช่วงตอนเช้าเลย เพราะว่าแม่บ้านเนี่ยจะเก็บขยะรอบเช้าเนี่ย มาอัด"
        # (Housekeepers collecting and compressing morning trash causes trash overflow at collection points)
        
        # Logic derived from: "สรุปขยะมันก็จะถูกอัด อัดๆๆ มาจนล้นตลอด"
        # (Adding more trash in the morning round results in constant trash overflow)
        
        # Compressing doesn't reduce mass, it just forces it in until it breaks the threshold
        self.current_waste_kg += amount
        self.is_overflowing = True
        self.state = "Overflowing_Compressed"

    def _pile_waste(self, amount: float):
        """
        Simulates actors dropping waste outside the physical bounds of the cage, creating piles.
        """
        if amount is None: return
        
        # Logic derived from: "ที่เห็นมาตรงกองเนี่ย ส่วนใหญ่จะเป็นนักศึกษากอง"
        # (Students cause waste piles at the waste cage/collection point)
        self.piled_waste_kg += amount
        
        # Even if the inside isn't technically full, piles mean the point is effectively overflowing
        self.is_overflowing = True
        self.state = "Overflowing_With_Piles"

    def _handle_external_influx(self):
        """
        Simulates massive uncontrolled waste influx at specific locations (like the Red Building).
        """
        # Logic derived from: "มีทั้ง ตลาด โรงเรียน ตึก 14 ชั้น ที่เป็นโรงแรม มันจะไม่ล้นได้ไงอะ... รวมทิ้ง อยู่ตรงนั้นน่ะ มันก็ บาน"
        # (The market, school, 14-story hotel building contribute to waste overflow at the Red Building area)
        if self.location_type == "red_building_area":
            massive_influx = random.uniform(100.0, 300.0)
            self.current_waste_kg += massive_influx
            self._check_overflow()

    def _check_overflow(self):
        """Evaluates if the collection point has breached its capacity."""
        if self.current_waste_kg > self.capacity_kg:
            self.is_overflowing = True
            
            # Overflow spillage goes to the outside pile
            spillage = self.current_waste_kg - self.capacity_kg
            self.current_waste_kg = self.capacity_kg
            self.piled_waste_kg += spillage
            
            self.state = "Overflowing"

    def _be_emptied(self):
        """
        Simulates the garbage truck or garden team completely clearing the collection point.
        """
        # Logic derived from: "เขาก็จะขับรถเนี่ย เก็บรอบ ม... พอเก็บรวบรวมครบเสร็จ เขาก็จะไปที่โรงคัดแยกขยะ"
        self.current_waste_kg = 0.0
        self.piled_waste_kg = 0.0
        self.is_overflowing = False
        self.state = "Operational"