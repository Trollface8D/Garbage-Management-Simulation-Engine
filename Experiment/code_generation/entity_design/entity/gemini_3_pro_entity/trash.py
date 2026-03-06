import random
from typing import TYPE_CHECKING, Optional, Dict, Any
from entity_object_template import entity_object

if TYPE_CHECKING:
    from environment_template import SimulationEnvironment

class Trash(entity_object):
    """
    Trash (Waste) entity for the waste management simulation.
    
    This is a PASSIVE entity representing a specific batch or unit of waste.
    It holds states like weight, type, ownership, and condition (e.g., residual, pest-infested).
    It is acted upon by Active entities (Janitors, Students, Waste Management Team).
    """
    
    def __init__(self, entity_object_id: str, waste_type: str, weight_kg: float, source: str = "unknown", generated_time: str = "day"):
        super().__init__(entity_object_id)
        
        # Core attributes
        self.waste_type = waste_type 
        self.weight_kg = weight_kg
        self.source = source 
        self.generated_time = generated_time
        
        # Dynamic states based on qualitative field research
        self.ownership_label = None
        self.is_mixed = False
        self.has_pests = False
        self.is_residual = False
        self.is_compressed = False
        self.destination = None
        self.revenue_split = None
        
        self.state = "Generated"

    # ==================== PASSIVE TRAIT METHODS ====================

    def get_status(self) -> Dict[str, Any]:
        """
        Returns the current state of the trash batch, which can be queried by the environment
        or active entities like Janitors and Trucks.
        """
        return {
            "entity_id": self.entity_object_id,
            "waste_type": self.waste_type,
            "weight_kg": self.weight_kg,
            "source": self.source,
            "ownership_label": self.ownership_label,
            "is_mixed": self.is_mixed,
            "has_pests": self.has_pests,
            "is_residual": self.is_residual,
            "is_compressed": self.is_compressed,
            "destination": self.destination,
            "state": self.state
        }

    def on_interact(self, initiator: 'entity_object', action: str, env: Optional['SimulationEnvironment'] = None, payload: Any = None):
        """
        Defines how the trash batch reacts when another entity interacts with it.
        """
        if action == "label_ownership":
            self._apply_label()
            
        elif action == "miss_collection":
            self._become_residue()
            
        elif action == "attract_pests":
            self._develop_pests()
            
        elif action == "mix_during_transport":
            self._mix_waste()
            
        elif action == "compress":
            self._compress()
            
        elif action == "process_disposal":
            self._route_to_destination()

    # ==================== INTERNAL BEHAVIOR LOGIC ====================

    def _apply_label(self):
        """Applies an ownership label to the waste, typically done by units or offices."""
        # Logic derived from: "เขาก็จะติดป้ายไว้ว่าเป็นของหน่วยงานใคร"
        # (Units and offices label waste to identify ownership)
        self.ownership_label = self.source
        self.state = "Labeled"

    def _become_residue(self):
        """Changes state to residual waste if it misses the collection round."""
        # Logic derived from: "แต่มันก็ทำให้รอบการเก็บ มันพลาดกัน ทำให้เกิดปัญหา... มันก็เป็นขยะที่ตกค้าง"
        # (missing the collection round results in waste residue overnight)
        self.is_residual = True
        self.state = "Residue"

    def _develop_pests(self):
        """Simulates the attraction of pests if food waste is left unmanaged."""
        # Logic derived from: "กินข้าวบูด... อยู่ในออฟฟิศ หนู มด อ่า พวกเนี้ย ซึ่งต่อเนื่องมาอีก จัดการยากกว่าเดิมอีก"
        # (keeping food waste in the office attracts rats, ants, making waste management more difficult)
        if self.waste_type == "food" and self.state in ["Generated", "Residue"]:
            self.has_pests = True
            self.state = "Pest_Infested"

    def _mix_waste(self):
        """Marks the waste as mixed, which happens during transport."""
        # Logic derived from: "แล้วก็เวลาเราขนส่ง เราก็คือ เราใส่รวมกันอยู่แล้ว... แล้วเราค่อยไปแยกปลายทางใช่ไหมครับ"
        # (The transport process involves mixing waste types initially)
        self.is_mixed = True
        self.state = "In_Transport"

    def _compress(self):
        """Compresses the waste, typically for unsortable items."""
        # Logic derived from: "อีกส่วนนึงที่คัดแยกไม่ได้เนี่ย เขาก็จะอัดเข้าถังสีเหลือง ที่เป็นถังบีบอัดขยะ ของ กทม."
        # (Waste being unsortable results in compression into yellow BMA bins)
        if not self.is_compressed and self.waste_type == "unsortable":
            self.is_compressed = True
            self.state = "Compressed"

    def _route_to_destination(self):
        """Determines the final destination and financial outcome of the waste based on its type."""
        
        # Logic derived from: "แต่ถ้าเป็นของหน่วยงาน หรือสำนักงาน หรือภาคเนี่ย ก็จะเข้าหน่วยงาน 80 เข้ามหาวิทยาลัย 20"
        # (Revenue from unit waste is allocated to the Unit 80% and the University 20%)
        if self.ownership_label and self.ownership_label not in ["student", "unaffiliated"]:
            self.revenue_split = {"unit": 0.8, "university": 0.2}

        # Route E-Waste
        if self.waste_type == "e_waste":
            # Logic derived from: "ขยะอิเล็กทรอนิกส์บางส่วนที่มันยังสามารถเป็นอะไหล่ หรือสามารถใช้ได้เนี่ย ก็จะถูกส่งไปให้กับมูลนิธิกระจกเงา"
            # (Reusable e-waste is sent to Mirror Foundation for use as spare parts)
            is_reusable = random.random() > 0.5
            if is_reusable:
                self.destination = "Mirror_Foundation"
            else:
                self.destination = "E_Waste_Disposal"
                
        # Route Tree Debris
        elif self.waste_type == "tree_debris":
            # Logic derived from: "อย่างพวกเศษต้นไม้อย่างเงี้ย เราก็มาทำปุ๋ย"
            # (Tree debris is processed into fertilizer)
            self.destination = "Fertilizer_Processing"
            
        # Route General/Unsortable Waste
        elif self.waste_type in ["general", "unsortable"]:
            # Logic derived from: "ส่วนสถานที่อยู่ในภาพรวมที่มารวมอยู่ที่โรงคัดแยกขยะเนี่ย ก็จะถูกส่งให้กับ กทม."
            # (Waste at the sorting facility is sent to BMA for disposal)
            self.destination = "BMA_Disposal"
            
        # Route Cleaned Fuel Waste
        elif self.waste_type == "cleaned_general":
            # Logic derived from: "การแยกขยะทั่วไป เอามาล้าง... เราก็แยกออกมาเพื่อส่งให้ N15 เป็นขยะเชื้อเพลิง"
            # (Separating and cleaning waste allows sending to N15 as fuel waste (RDF))
            self.destination = "N15_RDF"
            
        # Route Construction Waste
        elif self.waste_type == "construction_unusable":
            # Logic derived from: "เศษวัสดุ เนี่ย ถ้ามันไม่ได้... เอาไปใช้ประโยชน์อะไรไม่ได้แล้วเนี่ย เขาก็จะขี่ เอารถที่ขนขยะเนี่ย ขนเอาไปทิ้งด้านนอก"
            # (Unusable construction waste leads to transportation to external landfill near Wat Bua Phan)
            self.destination = "External_Landfill"
            
        else:
            self.destination = "Sorting_Facility"
            
        self.state = "Disposed"