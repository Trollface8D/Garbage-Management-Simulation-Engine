import random
from stakeholder import Stakeholder

class Janitor(Stakeholder):
    """
    Represents the cleaning staff (maids/housekeepers) in the facility.
    
    Behaviors are derived from field research indicating specific working hours,
    ad-hoc data recording practices, and interactions with waste collection schedules.
    """

    def __init__(self, env, name, building_assigned):
        super().__init__(env, name)
        self.building_assigned = building_assigned
        
        # Logic derived from Chunk 5: "แต่แม่บ้าน เลิกงานกี่โมง 5 โมง"
        # (But what time do maids finish? 5 PM)
        self.shift_end_hour = 17 
        
        # Logic derived from Chunk 6: "แม่บ้านเขา แล้วแต่อารมณ์" 
        # (Maids depend on mood)
        # 0.0 = Bad mood (guesses data/skips), 1.0 = Good mood (diligent)
        self.compliance_mood = random.random() 

    def step(self):
        """
        Daily routine step function called by the simulation environment.
        """
        current_hour = self.env.now_hour  # Assuming env provides time context

        # Morning Routine
        if 8 <= current_hour <= 10:
            self._manage_morning_waste()

        # End of Shift Routine
        if current_hour == self.shift_end_hour:
            self._finalize_daily_disposal()

    def _manage_morning_waste(self):
        """
        Handles waste accumulation and compression during the morning.
        """
        # Logic derived from Chunk 2: "แม่บ้านที่จะคอยดูแล ก็คือจะมาคอยเก็บ ช่วยคัดแยกในระดับนึง"
        # (Housekeepers... collect... help sort to some level)
        self.building_assigned.waste_storage.sort_waste(efficiency=0.3) # Partial sorting

        # Logic derived from Chunk 3: "แม่บ้านเนี่ยจะเก็บขยะรอบเช้าเนี่ย มาอัด... ขยะมันก็จะถูกอัด อัดๆๆ มาจนล้นตลอด"
        # (Maids collect morning round... compress... waste gets compressed until overflowing)
        self.building_assigned.waste_storage.compress_waste()
        
    def _finalize_daily_disposal(self):
        """
        Brings waste down to the collection point at the end of the shift.
        """
        waste_batch = self.building_assigned.waste_storage.collect_for_disposal()
        
        # Logic derived from Chunk 6: "แต่ ตัวถังขยะเอง มันก็ ไม่ได้ซัพพอร์ต... เรื่องของการชั่งน้ำหนัก"
        # (The bins don't support weighing... process is too complicated)
        # Logic derived from Chunk 6: "เขาก็ ส่วนใหญ่ก็ ยกขึ้นรถเลย ไม่ต้องชั่ง"
        # (Most lift directly to truck... don't weigh)
        recorded_weight = self._record_data_process(waste_batch)
        
        # Transport Logic
        self._transport_to_pickup_point(waste_batch)
        
        # Log the discrepancy between actual and recorded
        self.log_event(
            event_type="DATA_ENTRY",
            details={
                "actual_weight": waste_batch['weight'],
                "recorded_weight": recorded_weight,
                "discrepancy": abs(waste_batch['weight'] - recorded_weight)
            }
        )

    def _record_data_process(self, waste_batch):
        """
        Simulates the data recording process which is prone to error and 'guessing'.
        """
        # Logic derived from Chunk 6: "แม่บ้านเขา แล้วแต่อารมณ์... อยากจะเขียนน่ะ"
        # (Maids depend on mood... write what they want)
        if self.compliance_mood < 0.4:
            # Logic derived from Chunk 6: "พี่อะ แซวตลอดอะ ว่า วันนี้ชอบเลขอะไร... ยกโชก (เสี่ยงโชค)"
            # (I tease them... what number do you like today... lottery/luck)
            # Logic derived from Chunk 6: "มันคลาดเคลื่อน จนไม่รู้จะคลาดเคลื่อนยังไงละ"
            # (It's so inaccurate/discrepant)
            lucky_number = random.randint(5, 20) # Arbitrary "lucky number" guessing
            return lucky_number
        
        elif self.compliance_mood < 0.7:
                # Logic derived from Chunk 6: "ขั้นตอนการ ชั่งขยะ ในปัจจุบัน มันก็ดูจะ ยุ่งยากเกินไป"
                # (Current weighing process seems too complicated)
                # They estimate visually instead of weighing
                return waste_batch['weight'] * random.uniform(0.8, 1.2)
        
        else:
            # Performs actual weighing (rare case given the text)
            return waste_batch['weight']

    def _transport_to_pickup_point(self, waste_batch):
        """
        Moves waste to the central collection point.
        """
        collection_point = self.building_assigned.central_collection_point
        collection_point.add_waste(waste_batch)

        # Logic derived from Chunk 5: "แม่บ้าน เลิกงานกี่โมง 5 โมง เขาจะถือขยะลงมาทิ้ง ตอน 5 โมง"
        # (Maids finish at 5 PM, bring trash down at 5 PM)
        # Logic derived from Chunk 5: "โดยแม่บ้านเองเนี่ย มันมีรอบวันเก็บ... ช่วงอา 3 โมง 4 โมง"
        # (Collection rounds are at 3 PM - 4 PM)
        # Logic derived from Chunk 5: "ซึ่งอันเนี้ยแหละ คือ ทำให้คาด... คลาดเคลื่อนได้... เพราะเก็บตอนเก็บมา 4 โมง"
        # (This causes discrepancy... because they collected at 4 PM)
        
        last_collection_time = self.env.get_last_truck_visit_time(self.building_assigned)
        
        if last_collection_time < self.shift_end_hour:
                # Logic derived from Chunk 5: "มันก็เป็นขยะที่ตกค้าง... ตกค้างเย็นนี้ พรุ่งนี้เช้า... ประธานมาเห็น"
                # (It becomes residual waste... residue overnight... president sees it next morning)
                collection_point.flag_residue_issue()
                
                # Logic derived from Chunk 7: "คนเก็บขยะ ใช้รุนแรง... ตี แตก แหกเนี่ย... พังหมด"
                # (Collectors use violence/rough handling... break [bins])
                # Note: While this action is by collectors, the maid places the bin there to be handled roughly later.
                collection_point.increment_wear_and_tear(amount=5)