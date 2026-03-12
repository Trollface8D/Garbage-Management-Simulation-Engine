import random
from typing import TYPE_CHECKING, Optional
from entity_object_template import entity_object

if TYPE_CHECKING:
    from environment_template import SimulationEnvironment

class Student(entity_object):
    """
    Student entity for the waste management simulation.
    
    This is an ACTIVE entity representing the university's student body. Students are 
    primary generators of waste, actors in late-night events, and sources of friction 
    regarding proper waste separation and disposal locations. Some may also act as volunteers.
    """
    
    def __init__(self, entity_object_id: str, is_volunteer: bool = False):
        super().__init__(entity_object_id)
        self.state = "Idle"
        self.is_volunteer = is_volunteer
        self.current_time = "day"
        self.held_waste_volume = 0.0
        self.action_intent = None
        self.sees_overflow = False

    # ==================== ACTIVE TRAIT METHODS ====================
    
    def perceive(self, env: Optional['SimulationEnvironment'] = None):
        """
        Gathers information from the environment, such as the time of day, ongoing events,
        and the visual state of nearby trash bins (e.g., if they are overflowing).
        """
        if env:
            self.current_time = env.get_time_of_day()
            
            # Perceive if nearby bins/cages are full
            nearest_bin = env.get_nearest_bin(self.entity_object_id)
            if nearest_bin and nearest_bin.get_status().get("is_full", False):
                self.sees_overflow = True
            else:
                self.sees_overflow = False
        else:
            # Fallback for standalone testing
            self.current_time = random.choice(["day", "late_night"])
            self.sees_overflow = random.choice([True, False])

        # Randomly generate daily waste if not already holding some
        if self.held_waste_volume <= 0 and random.random() < 0.3:
            self.held_waste_volume = random.uniform(0.5, 2.0)

    def decide_action(self) -> Optional[str]:
        """
        Decides the next action based on time of day, held waste, and perceived environment.
        """
        # Logic derived from: "น้องๆ มีจัดกิจกรรม รับน้อง... ก็จะเกิดขยะ มหาศาล... เที่ยงคืน ตี 2 มึงยังไม่เลิกกันเลย มันก็มีขยะพวกเนี้ย เกิดขึ้น"
        # Late night activities (midnight to 2 AM) result in massive waste generation.
        if self.current_time == "late_night" and random.random() < 0.4:
            self.action_intent = "generate_event_waste"
            return self.action_intent

        # Logic derived from: "เวลา มีกิจกรรม ต่างๆ ก็จะมีพวก น้องๆ เนี่ย มายืน แยกขยะ ช่วยแยกขยะ"
        # Student volunteers stand to help separate waste during events.
        if self.current_time == "event" and self.is_volunteer:
            self.action_intent = "volunteer_sort_waste"
            return self.action_intent

        if self.held_waste_volume > 0:
            self.action_intent = "dispose_waste"
            return self.action_intent

        # Logic derived from: "ก็จะถูกฟ้องอะไรเงี้ย ก็คือจากบุคลากรบ้าง จากนักศึกษาบ้าง ว่าขยะแต่ละจุดเนี่ยมันล้น"
        # Trash overflow at various points leads to complaints from students.
        if self.sees_overflow and self.state == "Idle" and random.random() < 0.2:
            self.action_intent = "complain_about_overflow"
            return self.action_intent

        self.action_intent = "idle"
        return self.action_intent

    def act(self, env: Optional['SimulationEnvironment'] = None):
        """
        Executes the decided action, interacting with bins, events, or administration.
        """
        if self.action_intent == "generate_event_waste":
            self._perform_event_waste_generation()
            
        elif self.action_intent == "dispose_waste":
            self._perform_waste_disposal(env)
            
        elif self.action_intent == "volunteer_sort_waste":
            self._perform_volunteer_sorting(env)
            
        elif self.action_intent == "complain_about_overflow":
            self._perform_complaint(env)
            
        elif self.action_intent == "idle":
            self.state = "Idle"

    # ==================== INTERNAL BEHAVIOR LOGIC ====================

    def _perform_event_waste_generation(self):
        """
        Simulates massive waste generation during student activities like freshmen reception.
        """
        self.state = "At_Event"
        # Generate a significantly larger amount of waste compared to daily generation
        self.held_waste_volume += random.uniform(10.0, 30.0)
        self.action_intent = "dispose_waste" # Immediately look to dispose of this mass

    def _perform_waste_disposal(self, env: Optional['SimulationEnvironment']):
        """
        Simulates the actual act of throwing away trash, factoring in convenience, 
        failure to separate, and creating piles.
        """
        self.state = "Disposing_Waste"
        
        # Logic derived from: "ส่วนที่เกิดปัญหาส่วนใหญ่ ก็จะเป็นปัจจัยที่ควบคุมได้ยาก เช่น... ปัจจัยก็จะเกิดจากบุคลากรที่ไม่ได้มีสังกัดชัดเจน เช่น นักศึกษา"
        # Students are unaffiliated personnel causing waste management problems (hard to control).
        
        # Logic derived from: "ทุกคน ใน ม. เนี่ย แยกขยะ ได้ พื้นฐาน เนี่ย แยกได้ อยู่แล้ว แต่ เวลา ทิ้ง มึง ถึง แยก ไม่ได้"
        # Everyone knows how to separate fundamentally, but fails during the actual act of throwing.
        failed_to_separate = random.random() < 0.8  # High probability of failing to separate at the bin
        
        # Logic derived from: "บางคน มา ขนาด มีคนยืนบอก มันยัง ทิ้ง ลงไปเลย เออ ไม่สนใจอะ"
        # Some people ignore waste separation instructions even when volunteers are present.
        ignored_instructions = random.random() < 0.3
        
        # Logic derived from: "ใกล้มือ มั้ง บางที เดินมา ใกล้มือ กู ก็ทิ้ง นี่แหละ"
        # Convenience causes indiscriminate dumping (throwing waste because it is near hand).
        dumped_indiscriminately = random.random() < 0.4

        if env:
            nearest_bin = env.get_nearest_bin(self.entity_object_id)
            waste_payload = {
                "amount": self.held_waste_volume,
                "type": "mixed_unseparated" if (failed_to_separate or ignored_instructions) else "general",
                "source": "student"
            }
            
            # Logic derived from: "ที่เห็นมาตรงกองเนี่ย ส่วนใหญ่จะเป็นนักศึกษากอง"
            # Students cause waste piles at the waste cage/collection point.
            if dumped_indiscriminately or (nearest_bin and nearest_bin.get_status().get("is_full", False)):
                # Instead of putting it IN the bin, they pile it up AT the collection point
                env.trigger_event("student_piled_waste_at_point", payload=waste_payload)
            elif nearest_bin:
                env.interact_with_object(nearest_bin, "deposit_waste", payload=waste_payload)
                
            # Logic derived from: "แม่บ้านที่จะคอยดูแล ก็คือจะมาคอยเก็บ ช่วยคัดแยกในระดับนึง จากการที่นักศึกษา หรือบุคลากรทิ้ง"
            # Students discarding waste triggers housekeepers sorting partially.
            env.trigger_event("notify_janitor_waste_discarded")

        self.held_waste_volume = 0.0
        self.state = "Idle"

    def _perform_volunteer_sorting(self, env: Optional['SimulationEnvironment']):
        """
        Simulates a student acting as a volunteer to help separate waste at an event.
        """
        self.state = "Volunteering"
        if env:
            env.log_event(f"Student {self.entity_object_id} is volunteering to separate waste.")
            # In a full simulation, this might reduce the 'failed_to_separate' probability for other students nearby.
            env.trigger_event("volunteer_active_at_bins")

    def _perform_complaint(self, env: Optional['SimulationEnvironment']):
        """
        Simulates a student complaining about overflowing bins to the administration.
        """
        self.state = "Complaining"
        if env:
            env.log_event(f"Complaint filed by Student {self.entity_object_id} regarding trash overflow.")
        self.sees_overflow = False # Reset after complaining
        self.state = "Idle"