# ===== disposal_site.py =====

import random
from typing import TYPE_CHECKING, Optional, Dict, Any, List
from entity_object_template import entity_object

if TYPE_CHECKING:
    from environment_template import SimulationEnvironment

class DisposalSite(entity_object):
    """
    DisposalSite (Facility/Destination) entity for the waste management simulation.
    
    This is a PASSIVE entity representing the various final or intermediate 
    destinations for university waste. Different site types process waste 
    differently (e.g., recycling, turning into fuel, repairing for charity).
    """
    
    VALID_SITE_TYPES = [
        "sorting_plant", 
        "bma_disposal", 
        "n15_rdf", 
        "mirror_foundation", 
        "fertilizer_processing", 
        "external_landfill"
    ]
    
    def __init__(self, entity_object_id: str, site_type: str):
        super().__init__(entity_object_id)
        
        if site_type not in self.VALID_SITE_TYPES:
            raise ValueError(f"Invalid site_type. Must be one of: {self.VALID_SITE_TYPES}")
            
        self.site_type = site_type
        
        # Tracking metrics
        self.total_received_kg = 0.0
        self.processed_products = 0  # e.g., repaired computers, bags of fertilizer
        self.waste_inventory: List[Dict[str, Any]] = []
        self.state = "Operational"

    # ==================== PASSIVE TRAIT METHODS ====================

    def get_status(self) -> Dict[str, Any]:
        """Returns the current operational state and metrics of the disposal site."""
        return {
            "entity_id": self.entity_object_id,
            "site_type": self.site_type,
            "total_received_kg": self.total_received_kg,
            "processed_products": self.processed_products,
            "state": self.state
        }

    def on_interact(self, initiator: 'entity_object', action: str, env: Optional['SimulationEnvironment'] = None, payload: Any = None):
        """Handles incoming waste from transport entities (like GarbageTrucks)."""
        
        if action == "receive_waste":
            self._process_incoming_waste(payload, env)

    # ==================== INTERNAL BEHAVIOR LOGIC ====================

    def _process_incoming_waste(self, waste_payload: Dict[str, Any], env: Optional['SimulationEnvironment']):
        """
        Routes and processes the incoming waste payload according to the specific rules
        of the disposal site type.
        """
        if not waste_payload:
            return
            
        amount_kg = waste_payload.get("amount", 0.0)
        waste_type = waste_payload.get("type", "unknown")
        
        self.total_received_kg += amount_kg
        self.waste_inventory.append(waste_payload)
        
        # --- Route logic based on causal data from qualitative research ---
        
        if self.site_type == "sorting_plant":
            # Logic derived from: "พอเก็บรวบรวมครบเสร็จ เขาก็จะไปที่โรงคัดแยกขยะ"
            # (Completion of waste collection leads to transporting waste to the sorting plant)
            self.state = "Sorting_Waste"
            
            # Logic derived from: "ส่วนสถานที่อยู่ในภาพรวมที่มารวมอยู่ที่โรงคัดแยกขยะเนี่ย ก็จะถูกส่งให้กับ กทม. ก็คือส่ง กทม. กำจัดนั่นแหละ"
            # (Waste at the sorting facility is sent to BMA for disposal)
            if env:
                bma_site = env.get_entity_by_type("bma_disposal")
                if bma_site:
                    env.interact_with_object(bma_site, "receive_waste", payload={"amount": amount_kg, "type": "sorted_general"})
            self.state = "Operational"
            
        elif self.site_type == "bma_disposal":
            # Logic derived from: "ส่วนสถานที่อยู่ในภาพรวมที่มารวมอยู่ที่โรงคัดแยกขยะเนี่ย ก็จะถูกส่งให้กับ กทม."
            # BMA is the final endpoint for general/unsortable waste.
            self.state = "Disposed_in_Landfill"
            
        elif self.site_type == "n15_rdf":
            # Logic derived from: "การแยกขยะทั่วไป เอามาล้าง... เราก็แยกออกมาเพื่อส่งให้ N15 เป็นขยะเชื้อเพลิง"
            # (Separating and cleaning waste allows sending to N15 as fuel waste (RDF))
            if waste_type == "cleaned_general":
                self.state = "Processed_into_RDF"
                self.processed_products += (amount_kg * 0.8) # Arbitrary conversion rate for RDF
                
        elif self.site_type == "mirror_foundation":
            # Logic derived from: "ขยะอิเล็กทรอนิกส์บางส่วนที่มันยังสามารถเป็นอะไหล่ หรือสามารถใช้ได้เนี่ย ก็จะถูกส่งไปให้กับมูลนิธิกระจกเงา"
            # (Reusable e-waste is sent to Mirror Foundation for use as spare parts)
            self.state = "Repairing_Electronics"
            
            # Logic derived from: "เขาก็จะนำไปเป็นวัตถุดิบ เป็นอะไหล่ ให้กับในการซ่อมอุปกรณ์คอมพิวเตอร์ ที่จะส่งให้กับน้องๆ ที่อยู่ตามชนบท"
            # (Mirror Foundation uses parts to repair computers for children in rural areas)
            if waste_type == "e_waste":
                # For every arbitrary X kg of e-waste, 1 computer is repaired
                repaired_amount = int(amount_kg // 15) 
                self.processed_products += repaired_amount
                if env and repaired_amount > 0:
                    env.log_event(f"Mirror Foundation repaired {repaired_amount} computers for rural children.")
            self.state = "Operational"
            
        elif self.site_type == "fertilizer_processing":
            # Logic derived from: "อย่างพวกเศษต้นไม้อย่างเงี้ย เราก็มาทำปุ๋ย"
            # (Tree debris is processed into fertilizer)
            if waste_type == "tree_debris":
                self.state = "Composting"
                self.processed_products += (amount_kg * 0.5) # Arbitrary mass conversion to compost
                
        elif self.site_type == "external_landfill":
            # Logic derived from: "เศษวัสดุ เนี่ย ถ้ามันไม่ได้... เอาไปใช้ประโยชน์อะไรไม่ได้แล้วเนี่ย เขาก็จะขี่ เอารถที่ขนขยะเนี่ย ขนเอาไปทิ้งด้านนอก"
            # (Unusable construction waste leads to transportation to external landfill)
            if waste_type in ["construction_unusable", "large_debris"]:
                self.state = "Dumped_Externally"