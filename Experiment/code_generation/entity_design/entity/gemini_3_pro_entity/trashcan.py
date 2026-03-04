from typing import TYPE_CHECKING, Optional, Dict, Any
import random
from entity_object_template import entity_object

if TYPE_CHECKING:
    from environment_template import SimulationEnvironment

class TrashCan(entity_object):
    """
    Trash Can (Bin) entity for the waste management simulation.
    
    This is a PASSIVE entity that holds waste, has specific types/colors based
    on institutional policies, and can be acted upon by active entities 
    (e.g., Students depositing waste, Janitors/Collectors emptying it).
    """
    
    def __init__(self, entity_object_id: str, bin_type: str = "general", label: str = "Unassigned"):
        super().__init__(entity_object_id)
        self.bin_type = bin_type  
        
        # Logic derived from: "เขาก็จะติดป้ายไว้ว่าเป็นของหน่วยงานใคร"
        # (Units and offices label waste to identify ownership)
        self.label = label
        
        self.capacity_kg = 50.0 
        self.current_weight_kg = 0.0
        self.waste_contents = []
        
        # Logic derived from: "แต่ ตัวถังขยะเอง มันก็ ไม่ได้ซัพพอร์ต ขนาดนั้นนะ อย่างเช่น เรื่องของการชั่งน้ำหนัก หรือตัวของกิโล อะไรเงี้ย"
        # (Trash cans do not support weighing mechanisms natively)
        self.supports_weighing = False
        
        self.condition = "Good" # Can degrade to "Damaged" during collection
        
        self._configure_bin_type()

    def _configure_bin_type(self):
        """Sets initial parameters and expected waste types based on the specific type of bin."""
        
        # Logic derived from: "ช่วงสถานการณ์โควิด ก็จะมีถังแยกออกมาอีก ที่เป็นถังขยะติดเชื้อ ที่คอยทิ้งพวกชุดตรวจ ATK แมสก์"
        # (COVID-19 caused separation of infectious waste bins for ATK kits and masks)
        if self.bin_type == "infectious":
            self.expected_waste_types = ["ATK", "masks", "infectious"]
            self.is_compressible = False
            
        # Logic derived from: "อีกส่วนนึงที่คัดแยกไม่ได้เนี่ย เขาก็จะอัดเข้าถังสีเหลือง ที่เป็นถังบีบอัดขยะ ของ กทม."
        # (Waste being unsortable results in compression into yellow BMA bins)
        elif self.bin_type == "yellow_bma":
            self.expected_waste_types = ["unsortable"]
            self.is_compressible = True
            self.capacity_kg = 200.0 # Industrial compression bins hold more
            
        # Logic derived from: "ถังขยะ ถังเทาอะครับ ที่เป็นเศษวัสดุ พวกเหล็ก ปูน อะไรพวกเนี้ย"
        # (Gray bins contain construction waste like iron, cement)
        elif self.bin_type == "gray_construction":
            self.expected_waste_types = ["construction_waste", "iron", "cement"]
            self.capacity_kg = 150.0
            self.is_compressible = False
            
        else:
            self.expected_waste_types = ["general", "recyclable", "food"]
            self.is_compressible = False

    # ==================== PASSIVE TRAIT METHODS ====================

    def get_status(self) -> Dict[str, Any]:
        """
        Returns the current state of the trash can, which can be queried by the environment
        or active entities like Janitors.
        """
        return {
            "entity_id": self.entity_object_id,
            "bin_type": self.bin_type,
            "label": self.label,
            "current_weight_kg": self.current_weight_kg,
            "capacity_kg": self.capacity_kg,
            "is_full": self.current_weight_kg >= self.capacity_kg,
            "condition": self.condition,
            "supports_weighing": self.supports_weighing,
            "waste_contents": self.waste_contents,
            "state": self.state
        }

    def on_interact(self, initiator: 'entity_object', action: str, env: Optional['SimulationEnvironment'] = None, payload: Any = None):
        """
        Defines how the trash can reacts when another entity interacts with it.
        """
        if action == "deposit_waste":
            self._receive_waste(payload)
            
        elif action == "compress_waste":
            self._compress_waste()
            
        elif action == "collect_and_empty":
            self._be_emptied(initiator)

    # ==================== INTERNAL BEHAVIOR LOGIC ====================

    def _receive_waste(self, waste_data: dict):
        """Processes incoming waste from an entity throwing trash away."""
        if not waste_data:
            return
            
        amount = waste_data.get("amount", 0.0)
        waste_type = waste_data.get("type", "unknown")
        
        # Logic derived from: "ทุกคน ใน ม. เนี่ย แยกขยะ ได้ พื้นฐาน เนี่ย แยกได้ อยู่แล้ว แต่ เวลา ทิ้ง มึง ถึง แยก ไม่ได้"
        # (Everyone knows how to separate fundamentally but fails during the actual act of throwing)
        # Simulation of human behavior overriding designated bin types:
        if waste_type not in self.expected_waste_types and random.random() > 0.2:
            waste_type = "mixed_unseparated"

        if self.current_weight_kg + amount <= self.capacity_kg:
            self.current_weight_kg += amount
            self.waste_contents.append(waste_type)
        else:
            self.current_weight_kg = self.capacity_kg
            self.state = "Overflowing"

    def _compress_waste(self):
        """Compresses waste to free up capacity, if the bin supports it."""
        # Logic derived from: "อีกส่วนนึงที่คัดแยกไม่ได้เนี่ย เขาก็จะอัดเข้าถังสีเหลือง ที่เป็นถังบีบอัดขยะ ของ กทม."
        if getattr(self, "is_compressible", False) and self.bin_type == "yellow_bma":
            # Compressing reduces the physical volume/weight footprint
            self.current_weight_kg = max(0.0, self.current_weight_kg * 0.6)
            self.state = "Compressed"

    def _be_emptied(self, initiator: 'entity_object'):
        """Handles the bin being cleared out by a collection entity."""
        
        # Logic derived from: "คนเก็บขยะ ใช้รุนแรง ชิบหาย ไอ้เหี้ย มึงใช้มือ พวกเหี้ย นี่ใช้ตีน ตี แตก แหกเนี่ย... พังหมด"
        # (Garbage collectors using rough handling causes equipment damage)
        rough_handling_probability = 0.15
        
        # We assume active entities doing the collection might pass a "roughness" trait, 
        # or we simulate it arbitrarily here based on the interview data.
        if random.random() < rough_handling_probability:
            self.condition = "Damaged"
            
        self.current_weight_kg = 0.0
        self.waste_contents.clear()
        self.state = "Idle"