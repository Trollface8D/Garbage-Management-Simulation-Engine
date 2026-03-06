import random
from typing import TYPE_CHECKING, Optional, Dict, Any, List
from entity_object_template import entity_object

if TYPE_CHECKING:
    from environment_template import SimulationEnvironment

class Floor(entity_object):
    """
    Floor entity for the waste management simulation.
    
    This is a PASSIVE entity representing a specific floor or level within a building 
    (especially the ground floor or "under the building" area). It serves as a designated 
    spot where units bring their waste, holds weighing scales, and maintains a logbook 
    for waste data collection.
    """
    
    def __init__(self, entity_object_id: str, floor_level: str = "ground"):
        super().__init__(entity_object_id)
        self.floor_level = floor_level
        
        # State variables
        self.accumulated_waste_kg = 0.0
        self.waste_items = []
        self.logbook_entries = []
        
        # Logic derived from: "ซึ่งแต่ละอาคารเนี่ย แต่ละตึก ใต้ตึกเนี่ย จะมีกิโล ที่ทางพี่เอง ได้ซื้อให้ นี่แหละ ก็จะมีกิโล คนละตัวๆ ตัว ก็คือจะมาชั่งข้างล่าง แล้วก็จดใส่ สมุด บันทึกใส่สมุด"
        # The ground floor/downstairs has a weighing scale and a logbook for staff to use.
        self.has_scale = True if floor_level.lower() in ["ground", "downstairs", "under_building", "1"] else False
        self.has_logbook = self.has_scale
        
        self.state = "Operational"

    # ==================== PASSIVE TRAIT METHODS ====================

    def get_status(self) -> Dict[str, Any]:
        """Returns the current state of the floor and its accumulated waste."""
        return {
            "entity_id": self.entity_object_id,
            "floor_level": self.floor_level,
            "has_scale": self.has_scale,
            "has_logbook": self.has_logbook,
            "accumulated_waste_kg": self.accumulated_waste_kg,
            "waste_item_count": len(self.waste_items),
            "state": self.state
        }

    def on_interact(self, initiator: 'entity_object', action: str, env: Optional['SimulationEnvironment'] = None, payload: Any = None):
        """Handles interactions such as depositing waste, using the scale, or recording data."""
        
        if action == "deposit_waste":
            self._receive_waste(payload)
            
        elif action == "use_scale":
            return self._provide_scale()
            
        elif action == "record_logbook":
            self._record_in_logbook(initiator, payload)
            
        elif action == "collect_waste":
            self._be_emptied()

    # ==================== INTERNAL BEHAVIOR LOGIC ====================

    def _receive_waste(self, waste_payload: dict):
        """
        Receives waste brought down by units, offices, or piled up during monthly rounds.
        """
        if not waste_payload:
            return
            
        amount = waste_payload.get("amount", 0.0)
        
        # Logic derived from: "เขาก็จะเอาขยะจากหน่วยงาน หรือสำนักงานของตัวเองเนี่ยลงมาไว้ตามแต่ละตึก ตามใต้ตึกอะ ตามจุดที่เขาคุยกันไว้ เขาก็จะติดป้ายไว้ว่าเป็นของหน่วยงานใคร"
        # Units and offices bring down waste to designated spots at each building (typically downstairs/ground floor).
        
        # Logic derived from: "แต่ถ้าเป็นพวกของขยะรีไซเคิล ที่เป็นตาม ตามรอบของเดือนอะไรเงี้ย เขาก็จะวางกองไว้หน้าตึก"
        # Monthly recycle rounds involve piling waste in front of buildings (ground floor/exterior).
        
        self.accumulated_waste_kg += amount
        self.waste_items.append(waste_payload)
        
        if self.accumulated_waste_kg > 100.0:
            self.state = "Overflowing_Pile"

    def _provide_scale(self) -> float:
        """
        Simulates an entity attempting to weigh trash using the floor's scale.
        """
        # Logic derived from: "ซึ่งแต่ละอาคารเนี่ย แต่ละตึก ใต้ตึกเนี่ย จะมีกิโล... ก็คือจะมาชั่งข้างล่าง"
        # Staff weigh trash downstairs where the scale is located.
        if self.has_scale:
            return self.accumulated_waste_kg
        else:
            return -1.0 # Indicates no scale is present on this floor

    def _record_in_logbook(self, initiator: 'entity_object', record_data: dict):
        """
        Logs the waste data into the floor's physical logbook.
        """
        # Logic derived from: "แล้วก็จดใส่ สมุด บันทึกใส่สมุด"
        # Staff record trash data in a notebook.
        
        if not self.has_logbook:
            return

        # Logic derived from: "ปัญหาคือ เราอะ อยากจะเก็บ ให้มัน มันมีข้อมูล อย่างชัดเจน แบบ ที่มันจะมีข้อมูล ขาดหาย แต่ว่า ไอ้ขั้นตอนการ ชั่งขยะ ในปัจจุบัน มันก็ดูจะ ยุ่งยากเกินไป สำหรับ พนักงาน ปัจจุบัน ที่จะทำ"
        # Complicated weighing process leads to missing data.
        is_missing_data = random.random() < 0.3 # 30% chance data is missing or incomplete due to process complexity
        
        if is_missing_data:
            record_data["weight"] = None 
            record_data["notes"] = "Missing Data - Complicated Process"
        
        self.logbook_entries.append({
            "initiator": initiator.entity_object_id,
            "data": record_data
        })

    def _be_emptied(self):
        """
        Clears the accumulated waste when it is collected by Janitors or the Waste Team.
        """
        self.accumulated_waste_kg = 0.0
        self.waste_items.clear()
        self.state = "Operational"