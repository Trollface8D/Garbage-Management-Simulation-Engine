import random
from typing import TYPE_CHECKING, Optional, Dict, Any, List
from entity_object_template import entity_object

if TYPE_CHECKING:
    from environment_template import SimulationEnvironment

class Building(entity_object):
    """
    Building entity for the waste management simulation.
    
    This is a HYBRID entity. 
    Passive traits: Acts as a container for waste units, departments, and localized holding spots (cages).
    Active traits: Manages internal coordination, building-specific policies, and reporting of overflow.
    """
    
    def __init__(self, entity_object_id: str, is_red_building: bool = False, budget_tier: str = "limited"):
        super().__init__(entity_object_id)
        self.is_red_building = is_red_building
        self.budget_tier = budget_tier
        
        # State variables
        self.internal_waste_volume = 0.0
        self.has_roof = True if budget_tier == "high" else False
        self.cage_size = "large" if budget_tier == "high" else "small"
        
        # Lists of entities associated with this building
        self.departments: List[str] = []
        self.assigned_janitors: List[str] = []
        
        # Status tracking
        self.is_overflowing = False
        self.has_residual_waste = False
        self.complaint_count = 0
        
        self.state = "Operational"

    # ==================== PASSIVE TRAIT METHODS ====================

    def get_status(self) -> Dict[str, Any]:
        """Returns the current structural and waste state of the building."""
        return {
            "entity_id": self.entity_object_id,
            "is_red_building": self.is_red_building,
            "cage_design": {
                "size": self.cage_size,
                "has_roof": self.has_roof,
                # Logic derived from: "งบมัน จำกัด ด้วยแหละ... มันก็เลย ออกมาเป็น แบบเนี้ย" 
                # (Limited budget resulted in the current waste cage design which is problematic)
                "budget_constrained": True if self.budget_tier == "limited" else False
            },
            "waste_levels": {
                "volume": self.internal_waste_volume,
                "is_overflowing": self.is_overflowing,
                "has_residue": self.has_residual_waste
            },
            "state": self.state
        }

    def on_interact(self, initiator: 'entity_object', action: str, env: Optional['SimulationEnvironment'] = None, payload: Any = None):
        """Handles waste deposits and facility management actions."""
        
        if action == "deposit_to_cage":
            self._add_to_cage(payload)
            
        elif action == "report_overflow":
            # Logic derived from: "ก็จะถูกฟ้องอะไรเงี้ย... จากบุคลากรบ้าง จากนักศึกษาบ้าง ว่าขยะแต่ละจุดเนี่ยมันล้น"
            self.complaint_count += 1
            self.state = "Under_Scrutiny"

        elif action == "clear_waste":
            self.internal_waste_volume = 0.0
            self.is_overflowing = False
            self.has_residual_waste = False
            self.state = "Operational"

    # ==================== ACTIVE TRAIT METHODS ====================

    def perceive(self, env: Optional['SimulationEnvironment'] = None):
        """The building 'perceives' its own capacity and the behavior of its tenants."""
        # Logic derived from: "มีทั้ง ตลาด โรงเรียน ตึก 14 ชั้น... มันจะไม่ล้นได้ไงอะ... รวมทิ้ง อยู่ตรงนั้นน่ะ"
        if self.is_red_building:
            # Simulate high-intensity external influx from school/market
            influx = random.uniform(50.0, 150.0)
            self.internal_waste_volume += influx

        # Check for overflow threshold
        threshold = 100.0 if self.cage_size == "large" else 40.0
        if self.internal_waste_volume > threshold:
            self.is_overflowing = True

    def decide_action(self) -> Optional[str]:
        """Decides whether to trigger warnings or requests based on current state."""
        
        # Logic derived from: "แต่ มันก็มีทางที่เขาเป็นคณะทำงาน... เขาก็จะตักเตือนอะไรเงี้ย ให้รีบจัดการ"
        if self.is_overflowing and self.state != "Warning_Issued":
            return "issue_management_warning"
            
        # Logic derived from: "ตกค้างเย็นนี้ พรุ่งนี้เช้า... คณะทำงาน หรือประธานมาเห็นเนี่ย เขาก็จะบอกละ เอ๊ะ ทำไมจุดนี้ขยะเยอะจัง"
        if self.has_residual_waste:
            return "trigger_executive_complaint"

        return "idle"

    def act(self, env: Optional['SimulationEnvironment'] = None):
        """Executes administrative or environmental reporting."""
        if self.action_intent == "issue_management_warning":
            if env:
                env.trigger_event("building_capacity_warning", payload={"building": self.entity_object_id})
                self.state = "Warning_Issued"
                
        elif self.action_intent == "trigger_executive_complaint":
            if env:
                env.trigger_event("executive_inspection_failure", payload={"building": self.entity_object_id})

    # ==================== INTERNAL BEHAVIOR LOGIC ====================

    def _add_to_cage(self, volume: float):
        """Internal logic for adding waste to the building's collection point."""
        
        # Logic derived from: "แต่มันก็ ยังไม่ได้ ตอบโจทย์... ซึ่งมันก็ เล็กเกินไป"
        # Small cages make management difficult and overflow faster.
        if self.cage_size == "small":
            effective_volume = volume * 1.5  # Complexity multiplier for poor physical space
        else:
            effective_volume = volume
            
        self.internal_waste_volume += effective_volume
        
        # Logic derived from: "ตกค้างเย็นนี้ พรุ่งนี้เช้า... มันก็เป็นขยะที่ตกค้าง"
        # If waste is added late, it's marked as residue
        current_hour = random.randint(1, 24) # Placeholder for env time
        if current_hour >= 17:
            self.has_residual_waste = True

    def upgrade_facilities(self):
        """Simulates the interviewer's desire to improve the infrastructure."""
        # Logic derived from: "พี่อยากจะเปลี่ยน ใหม่ ให้มันมีขนาดที่ ใหญ่กว่าเนี้ย แล้วก็มีหลังคง หลังคา ปิด"
        self.cage_size = "large"
        self.has_roof = True
        self.budget_tier = "upgraded"