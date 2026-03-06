# ===== policies.py =====

from typing import Any, TYPE_CHECKING, Optional, Dict
from policy_template import Policy

if TYPE_CHECKING:
    from environment_template import SimulationEnvironment
    from entity_object_template import entity_object

class WasteRevenuePolicy(Policy):
    """
    Policy handling the financial split of revenue generated from recycled waste.
    """
    @property
    def policy_name(self) -> str:
        return "waste_revenue_allocation"

    def is_applicable_to(self, entity_object: 'entity_object') -> bool:
        # Applies to facilities distributing funds or departments receiving them
        return entity_object.__class__.__name__ in ["SortingFacility", "Department"]

    def apply(self, entity_object: 'entity_object', context: dict, env: Optional['SimulationEnvironment'] = None) -> dict:
        # Logic derived from: "แต่ถ้าเป็นของหน่วยงาน หรือสำนักงาน หรือภาคเนี่ย ก็จะเข้าหน่วยงาน 80 เข้ามหาวิทยาลัย 20"
        # Revenue from unit waste is allocated to the Unit 80% and the University 20%.
        
        total_revenue = context.get('revenue_amount', 0.0)
        return {
            'department_share': total_revenue * 0.80,
            'university_share': total_revenue * 0.20
        }

class EWasteActivityHourPolicy(Policy):
    """
    Policy governing the exchange of electronic waste for student activity hours.
    """
    @property
    def policy_name(self) -> str:
        return "e_waste_activity_hours"

    def is_applicable_to(self, entity_object: 'entity_object') -> bool:
        return entity_object.__class__.__name__ == "Student"

    def apply(self, entity_object: 'entity_object', context: dict, env: Optional['SimulationEnvironment'] = None) -> dict:
        # Logic derived from: "ใครเนี่ยที่มีขยะอิเล็กทรอนิกส์เนี่ย ก็มาบริจาคให้กับที่นี่ ก็เหมือนแลกชั่วโมงไป"
        # Donating e-waste results in receiving activity hours exchange mechanism.
        
        ewaste_donated_kg = context.get('ewaste_kg', 0.0)
        # Assuming an arbitrary exchange rate for the simulation (e.g., 1kg = 2 hours)
        activity_hours_earned = ewaste_donated_kg * 2.0 
        
        return {
            'activity_hours_awarded': activity_hours_earned
        }

class ReusableEquipmentPolicy(Policy):
    """
    Policy representing the intervention of renting reusable equipment for events.
    """
    @property
    def policy_name(self) -> str:
        return "rent_reusable_equipment"

    def is_applicable_to(self, entity_object: 'entity_object') -> bool:
        return entity_object.__class__.__name__ in ["Student", "Department"]

    def apply(self, entity_object: 'entity_object', context: dict, env: Optional['SimulationEnvironment'] = None) -> dict:
        # Logic derived from: "เขา ก็ มีการ ไปเช่า พวก อุปกรณ์ อ่า พวกแก้วน้ำ พวกชาม พวกจาน มา ลดขยะ ได้ อย่าง เยอะ เลย หายไป เป็น 100 โล ได้เลย"
        # Renting reusable equipment reduces waste quantity by approximately 100 kg.
        
        original_waste = context.get('expected_event_waste_kg', 0.0)
        reduced_waste = max(0.0, original_waste - 100.0)
        
        return {
            'actual_waste_generated_kg': reduced_waste,
            'waste_prevented_kg': original_waste - reduced_waste
        }

class SpecialPickupSchedulingPolicy(Policy):
    """
    Policy determining how large or non-standard materials are collected.
    """
    @property
    def policy_name(self) -> str:
        return "schedule_special_pickup"

    def is_applicable_to(self, entity_object: 'entity_object') -> bool:
        return entity_object.__class__.__name__ in ["Department", "GarbageTruck"]

    def apply(self, entity_object: 'entity_object', context: dict, env: Optional['SimulationEnvironment'] = None) -> dict:
        # Logic derived from: "ว่าสมมติถ้ามีขยะเศษวัสดุ ที่เป็นชิ้นใหญ่ อะไรอย่างเงี้ย เราก็จะนับวัน เพื่อมาเก็บเป็นแต่ละรอบๆ ไป"
        # Presence of large construction waste results in scheduling specific pickup rounds instead of regular daily collection.
        
        waste_type = context.get('waste_type', 'general')
        if waste_type in ['large_debris', 'construction_waste', 'wood', 'plywood']:
            return {
                'action': 'schedule_pickup_date',
                'immediate_pickup': False
            }
        return {
            'action': 'regular_pickup',
            'immediate_pickup': True
        }

class InfrastructureUpgradePolicy(Policy):
    """
    Intervention policy to simulate upgrading physical collection points.
    """
    @property
    def policy_name(self) -> str:
        return "upgrade_infrastructure"

    def is_applicable_to(self, entity_object: 'entity_object') -> bool:
        return entity_object.__class__.__name__ == "CollectionPoint"

    def apply(self, entity_object: 'entity_object', context: dict, env: Optional['SimulationEnvironment'] = None) -> dict:
        # Logic derived from: "พี่ก็จะเปลี่ยน พี่อยากจะเปลี่ยน ใหม่ ให้มันมีขนาดที่ ใหญ่กว่าเนี้ย แล้วก็มีหลังคง หลังคา ปิด กันฝ่ง กันฝน ให้มันดูเป็น เหมือนกิจจะลักษณะ กว่าเนี้ย"
        # The interviewer wants to redesign the waste cage to be larger and have a roof.
        
        return {
            'new_capacity_kg': 400.0,
            'has_roof': True,
            'design_size': 'large',
            'budget_constrained': False
        }

class AdditionalSortingStaffPolicy(Policy):
    """
    Intervention policy to assess the impact of hiring more personnel at the sorting plant.
    """
    @property
    def policy_name(self) -> str:
        return "hire_additional_sorting_staff"

    def is_applicable_to(self, entity_object: 'entity_object') -> bool:
        return entity_object.__class__.__name__ == "SortingFacility"

    def apply(self, entity_object: 'entity_object', context: dict, env: Optional['SimulationEnvironment'] = None) -> dict:
        # Logic derived from: "แต่ ถ้าเราจัดการขึ้น เราต้องไปหาคนอีกคน 2 คน มาเพื่อจัดการตรงนี้ ก่อน ให้แก๊งนั้น จัดการ มันก็เพิ่มเงิน"
        # Hiring additional staff increases financial cost but management capacity.
        
        current_staff = context.get('current_staff_count', 3)
        return {
            'new_staff_count': current_staff + 2,
            'extra_financial_cost': 15000.0  # Arbitrary monthly/tick cost
        }