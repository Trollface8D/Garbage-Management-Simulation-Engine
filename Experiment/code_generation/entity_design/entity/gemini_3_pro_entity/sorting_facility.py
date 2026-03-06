import random
from typing import TYPE_CHECKING, Optional, Dict, Any, List
from entity_object_template import entity_object

if TYPE_CHECKING:
    from environment_template import SimulationEnvironment

class SortingFacility(entity_object):
    """
    SortingFacility (โรงคัดแยกขยะ) entity for the waste management simulation.
    
    This is a HYBRID entity. 
    Passive traits: Receives mixed waste from garbage trucks.
    Active traits: Sorts waste, processes financial data for departments, 
                   and dispatches processed waste to final destinations (BMA, N15).
    """
    
    def __init__(self, entity_object_id: str, staff_count: int = 3):
        super().__init__(entity_object_id)
        
        # Logic derived from: "จากคน 3 คนในการคัดแยกขยะเนี่ย มันคงไม่ success กันอยู่แล้ว ซึ่งไม่เพียงพออยู่แล้ว"
        # (Limited number of sorters (3-4 people) vs large volume causes unsuccessful sorting/insufficiency)
        self.staff_count = staff_count
        self.processing_capacity_per_tick = self.staff_count * 50.0  # kg per tick
        
        # State variables
        self.unprocessed_waste_kg = 0.0
        self.waste_queue: List[Dict[str, Any]] = []
        
        # Separated waste inventories
        self.sortable_pile_kg = 0.0
        self.unsortable_compressed_kg = 0.0
        self.rdf_fuel_kg = 0.0
        
        # Financial tracking
        self.pending_finance_transfers: List[Dict[str, Any]] = []
        
        self.is_backlogged = False
        self.state = "Operational"
        self.action_intent = None

    # ==================== PASSIVE TRAIT METHODS ====================

    def get_status(self) -> Dict[str, Any]:
        """Returns the current operational state, inventories, and backlog status."""
        return {
            "entity_id": self.entity_object_id,
            "staff_count": self.staff_count,
            "unprocessed_waste_kg": self.unprocessed_waste_kg,
            "inventories": {
                "sortable_pile": self.sortable_pile_kg,
                "unsortable_compressed": self.unsortable_compressed_kg,
                "rdf_fuel": self.rdf_fuel_kg
            },
            "is_backlogged": self.is_backlogged,
            "state": self.state
        }

    def on_interact(self, initiator: 'entity_object', action: str, env: Optional['SimulationEnvironment'] = None, payload: Any = None):
        """Handles receiving waste from garbage trucks."""
        if action == "receive_mixed_waste":
            self._intake_waste(payload)

    # ==================== ACTIVE TRAIT METHODS ====================

    def perceive(self, env: Optional['SimulationEnvironment'] = None):
        """Assesses current workload and backlog status."""
        # Determine if the facility is overwhelmed due to low staff
        if self.unprocessed_waste_kg > (self.processing_capacity_per_tick * 2):
            self.is_backlogged = True
            self.state = "Backlogged"
        else:
            self.is_backlogged = False
            self.state = "Processing"

    def decide_action(self) -> Optional[str]:
        """Decides whether to sort waste, send data to finance, or dispatch waste."""
        
        if self.unprocessed_waste_kg > 0:
            self.action_intent = "sort_waste"
            return self.action_intent
            
        # Logic derived from: "เพื่อส่งข้อมูลพวกเนี้ยให้กับทางกองคลัง เพื่อโอนเงินให้กับ จัดจ่ายเรื่องเงินให้กับแต่ละหน่วยงาน"
        if len(self.pending_finance_transfers) > 0:
            self.action_intent = "send_finance_data"
            return self.action_intent
            
        # Dispatch conditions
        if self.unsortable_compressed_kg > 500.0 or self.rdf_fuel_kg > 200.0:
            self.action_intent = "dispatch_processed_waste"
            return self.action_intent

        self.action_intent = "idle"
        return self.action_intent

    def act(self, env: Optional['SimulationEnvironment'] = None):
        """Executes the facility operations based on decisions."""
        if self.action_intent == "sort_waste":
            self._perform_sorting(env)
            
        elif self.action_intent == "send_finance_data":
            self._process_finance_data(env)
            
        elif self.action_intent == "dispatch_processed_waste":
            self._dispatch_waste(env)
            
        elif self.action_intent == "idle":
            self.state = "Idle"

    # ==================== INTERNAL BEHAVIOR LOGIC ====================

    def _intake_waste(self, payload: Dict[str, Any]):
        """Receives mixed waste from transport."""
        if not payload: return
        
        # Logic derived from: "แล้วก็เวลาเราขนส่ง เราก็คือ เราใส่รวมกันอยู่แล้ว... แล้วเราค่อยไปแยกปลายทางใช่ไหมครับ"
        # (The transport process involves mixing waste types initially... waste team separates at destination)
        amount = payload.get("amount", 0.0)
        self.unprocessed_waste_kg += amount
        self.waste_queue.append(payload)

    def _perform_sorting(self, env: Optional['SimulationEnvironment']):
        """Simulates the labor-intensive sorting process."""
        
        process_amount = min(self.processing_capacity_per_tick, self.unprocessed_waste_kg)
        self.unprocessed_waste_kg -= process_amount
        
        # Process items in the queue up to the processed amount
        processed_this_tick = 0.0
        while self.waste_queue and processed_this_tick < process_amount:
            item = self.waste_queue.pop(0)
            item_weight = item.get("amount", 0.0)
            processed_this_tick += item_weight
            
            # Logic derived from: "ขยะที่เกิดขึ้น บางส่วนที่คนเนี่ยสามารถคัดแยกได้ เขาก็จะกองไว้อีกส่วนนึง"
            # (Waste being sortable results in piling separately)
            is_sortable = random.random() > 0.4
            
            if is_sortable:
                self.sortable_pile_kg += item_weight * 0.6
                
                # Logic derived from: "การแยกขยะทั่วไป เอามาล้าง... เราก็แยกออกมาเพื่อส่งให้ N15 เป็นขยะเชื้อเพลิง"
                # (Separating and cleaning waste allows sending to N15 as fuel waste (RDF))
                self.rdf_fuel_kg += item_weight * 0.4 
                
                # Queue revenue processing if it has an ownership label
                if item.get("ownership_label"):
                    self.pending_finance_transfers.append({
                        "unit": item["ownership_label"],
                        "revenue_base": item_weight * 10.0 # Arbitrary revenue calculation
                    })
            else:
                # Logic derived from: "อีกส่วนนึงที่คัดแยกไม่ได้เนี่ย เขาก็จะอัดเข้าถังสีเหลือง ที่เป็นถังบีบอัดขยะ ของ กทม."
                # (Waste being unsortable results in compression into yellow BMA bins)
                self.unsortable_compressed_kg += item_weight

    def _process_finance_data(self, env: Optional['SimulationEnvironment']):
        """Sends calculated revenue data to the Finance Division."""
        
        # Logic derived from: "เพื่อส่งข้อมูลพวกเนี้ยให้กับทางกองคลัง เพื่อโอนเงินให้กับ จัดจ่ายเรื่องเงินให้กับแต่ละหน่วยงาน"
        # Logic derived from: "แต่ถ้าเป็นของหน่วยงาน หรือสำนักงาน หรือภาคเนี่ย ก็จะเข้าหน่วยงาน 80 เข้ามหาวิทยาลัย 20"
        
        if env:
            for transfer in self.pending_finance_transfers:
                total_revenue = transfer["revenue_base"]
                unit_share = total_revenue * 0.80
                uni_share = total_revenue * 0.20
                
                env.trigger_event("finance_transfer", payload={
                    "target_unit": transfer["unit"],
                    "unit_amount": unit_share,
                    "university_amount": uni_share
                })
                
        self.pending_finance_transfers.clear()

    def _dispatch_waste(self, env: Optional['SimulationEnvironment']):
        """Sends processed waste to final endpoints."""
        
        if env:
            # Logic derived from: "ส่วนสถานที่อยู่ในภาพรวมที่มารวมอยู่ที่โรงคัดแยกขยะเนี่ย ก็จะถูกส่งให้กับ กทม. ก็คือส่ง กทม. กำจัดนั่นแหละ"
            if self.unsortable_compressed_kg > 0:
                bma_site = env.get_entity_by_type("bma_disposal")
                if bma_site:
                    env.interact_with_object(bma_site, "receive_waste", payload={
                        "amount": self.unsortable_compressed_kg,
                        "type": "unsortable_compressed"
                    })
                self.unsortable_compressed_kg = 0.0
            
            # Dispatch to N15
            if self.rdf_fuel_kg > 0:
                n15_site = env.get_entity_by_type("n15_rdf")
                if n15_site:
                    env.interact_with_object(n15_site, "receive_waste", payload={
                        "amount": self.rdf_fuel_kg,
                        "type": "cleaned_general"
                    })
                self.rdf_fuel_kg = 0.0