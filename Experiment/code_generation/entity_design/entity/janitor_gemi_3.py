import random
from stakeholder import Stakeholder

class Janitor(Stakeholder):
    """
    Represents the Janitor/Housekeeper/Maid entity in the waste management simulation.
    Responsible for collecting, partially sorting, weighing (or guessing), and disposing of waste.
    """
    
    def __init__(self, agent_id, name):
        super().__init__(agent_id, name)
        # Shift end time influences disposal behavior leading to missed collections
        self.shift_end_time = 17  # 17:00 or 5:00 PM
        
        # State variables affecting behavior
        self.mood = random.choice(['good', 'bad', 'lazy'])
        self.finds_process_complicated = True
        
    def collect_and_sort_waste(self, waste_volume):
        """
        Simulates the initial collection and sorting of waste by the janitor.
        """
        # Logic derived from: "แม่บ้านที่จะคอยดูแล ก็คือจะมาคอยเก็บ ช่วยคัดแยกในระดับนึง จากการที่นักศึกษา หรือบุคลากรทิ้ง"
        # Pattern: Housekeepers sorting partially
        sorted_percentage = random.uniform(0.1, 0.4) 
        sorted_waste = waste_volume * sorted_percentage
        unsorted_waste = waste_volume * (1 - sorted_percentage)
        
        return sorted_waste, unsorted_waste

    def process_morning_trash(self, waste_cage):
        """
        Simulates the morning routine of compressing trash into the holding area.
        """
        # Logic derived from: "โดยปัญหาที่ขยะล้นจุดพักขยะเนี่ย จะเป็นช่วงตอนเช้าเลย เพราะว่าแม่บ้านเนี่ยจะเก็บขยะรอบเช้าเนี่ย มาอัด"
        # Pattern: Housekeepers collecting and compressing morning trash causes trash overflow
        waste_cage.receive_compressed_waste(time_of_day="morning")
        
        # Logic derived from: "สรุปขยะมันก็จะถูกอัด อัดๆๆ มาจนล้นตลอด"
        # Pattern: Adding more trash in the morning round results in constant trash overflow
        waste_cage.check_and_trigger_overflow()

    def weigh_and_record_waste(self, actual_weight):
        """
        Simulates the data entry process for waste weight, heavily influenced by human factors.
        """
        # Logic derived from: "ปัญหาคือ... ไอ้ขั้นตอนการ ชั่งขยะ ในปัจจุบัน มันก็ดูจะ ยุ่งยากเกินไป สำหรับ พนักงาน ปัจจุบัน ที่จะทำ"
        # Pattern: Current trash weighing process is too complicated for current staff -> leads to missing data
        if self.finds_process_complicated and random.random() < 0.3:
            # Logic derived from: "เขาก็ ส่วนใหญ่ก็ ยกขึ้นรถเลย ไม่ต้องชั่ง ไม่ค่อยได้ชั่ง ประมาณเนี้ย"
            # Pattern: Lifting trash directly to the truck results in not weighing the trash
            return None, "missing_data_lifted_directly"

        # Logic derived from: "ไม่ใช่ข้อมูลที่ แม่บ้านเขา แล้วแต่อารมณ์ อยากจะเขียนน่ะ"
        # Logic derived from: "พี่อะ แซวตลอดอะ ว่า วันนี้ชอบเลขอะไร ยกโชก... ชอบเลขอะไร วันนี้ชอบ เอ้ย ไม่เก้า ไม่เก้ากิโล... ซึ่งตอนนี้ มันคลาดเคลื่อน จนไม่รู้จะคลาดเคลื่อนยังไงละ"
        # Pattern: Maids guessing numbers causes extreme data inaccuracy (treating data entry like a lottery)
        if self.mood in ['bad', 'lazy']:
            guessed_weight = random.uniform(1.0, 50.0)  # Random lottery guess
            return guessed_weight, "inaccurate_guessed_data"
            
        # Logic derived from: "เขาก็จะเก็บรวบรวมแต่ละถัง ชั่งน้ำหนัก แล้วก็เอาไปไว้ที่กรงพักขยะ"
        return actual_weight, "accurate_data"

    def dispose_waste_end_of_day(self, current_hour, waste_cage):
        """
        Simulates the afternoon/evening disposal routine relative to the collection truck's schedule.
        """
        # Logic derived from: "แต่แม่บ้าน เลิกงานกี่โมง 5 โมง เขาจะถือขยะลงมาทิ้ง ตอน 5 โมง" 
        # Logic derived from: "อย่างสมมติ รถรอบเนี่ยมาเก็บตอน 3 โมง แม่บ้าน... เอามาทิ้งตอน 4 โมง ซึ่งก็จะมีขยะล้น ขยะเหลืออยู่ในนั้น ก็คือขยะตกค้าง"
        # Pattern: maids bringing trash at 5 PM causes discrepancy in collection because collection finishes at 4 PM
        if current_hour >= 16:  # Disposal happens after the 15:00 (3 PM) truck collection
            # Pattern: missing the collection round results in waste residue overnight
            waste_cage.add_residual_waste(status="residue_overnight")

    def interact_with_infrastructure(self, waste_cage):
        """
        Updates the janitor's state based on the infrastructure they must interact with.
        """
        # Logic derived from: "แต่มันก็ ยังไม่ได้ ตอบโจทย์ หรือมันก็ ไม่ง่าย ต่อแม่บ้าน เอง เหมือนกัน อืม ซึ่งมันก็ เล็กเกินไป"
        # Pattern: The compact design of the cage causes difficulty for the cleaners
        if waste_cage.design_type == "compact" or waste_cage.size < self.required_working_space:
            self.mood = "bad"  # Difficult working conditions negatively impact mood/compliance
            self.finds_process_complicated = True