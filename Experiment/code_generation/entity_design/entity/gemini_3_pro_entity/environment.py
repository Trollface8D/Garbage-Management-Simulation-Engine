# ===== waste_environment.py =====

import csv
import heapq
import json
import os
import random
from typing import TYPE_CHECKING, Optional, Dict, Any, List, Tuple
from environment_template import SimulationEnvironment

if TYPE_CHECKING:
    from entity_object_template import entity_object

class WasteManagementEnvironment(SimulationEnvironment):
    """
    The concrete simulation environment for the University Waste Management system.
    
    Acts as the Mediator for all active and passive entities (Janitors, Trucks, Bins, 
    Buildings, Sorting Facilities, etc.). It manages global time, tracks financial 
    ledgers, processes system-wide events, and facilitates spatial queries.
    
    Logic derived from: "กะว่าจะเอาไปทำเป็น ตัวจบ โปรเจกต์จบ... จะทำเป็นพวก แบบ แนว อ่า Optimize ระบบ"
    Logic derived from: "เราสร้าง Simulation ขึ้นมา แล้วแบบ พยายามที่จะ ลอกเลียนแบบ สภาวะตอนนี้ แล้วดูว่า พอเปลี่ยน นโยบาย เล็กน้อยเนี่ย ในจุดๆ นึงเนี่ย มันดีขึ้นไหม"
    (The environment is designed to simulate current conditions and allow policy optimization testing.)
    """

    TIME_PHASES = [
        "morning", 
        "midday", 
        "3pm", 
        "4pm", 
        "5pm", 
        "evening", 
        "late_night"
    ]

    def __init__(self):
        super().__init__()
        
        self.event_log: List[str] = []
        self.special_pickup_requests: List[Dict[str, Any]] = []
        
        # Finance Ledger to track university and unit revenues
        self.finance_ledger = {
            "university_central": 0.0,
            "units": {}
        }
        
        # Spatial graph loaded from physical_map data files.
        # _graph: node_id -> list of (neighbour_id, weight) edges (undirected)
        # _node_data: node_id -> full JSON node dict (waste amounts, name, type, etc.)
        # _entity_location: entity_object_id -> map node_id
        self._graph: Dict[str, List[Tuple[str, float]]] = {}
        self._node_data: Dict[str, Dict[str, Any]] = {}
        self._entity_location: Dict[str, str] = {}
        self._load_physical_map()
        
        # Initialize default properties based on interview context
        self.set_property("time_of_day", "morning")
        self.set_property("time_index", 0)
        self.set_property("day_of_week", "monday")

    # ==================== PHYSICAL MAP LOADING ====================

    def _load_physical_map(self):
        """
        Loads the campus spatial graph and per-node waste baseline data from the
        three physical_map files:
          - building_trashbuffer.json  (TR-series indoor buffer nodes)
          - outdoor_trashbuffer.json   (L-series outdoor collection-point nodes)
          - extracted_adjacent_travesal_path.csv  (weighted adjacency edges)
        """
        map_dir = os.path.normpath(
            os.path.join(os.path.dirname(os.path.abspath(__file__)),
                         '..', '..', '..', 'physical_map')
        )

        # --- node data (TR + L series) ---
        for filename in ('building_trashbuffer.json', 'outdoor_trashbuffer.json'):
            path = os.path.join(map_dir, filename)
            if not os.path.exists(path):
                continue
            with open(path, encoding='utf-8') as f:
                data = json.load(f)
            for node in data.get('nodes', []):
                self._node_data[node['id']] = node

        # --- adjacency graph (undirected, weighted) ---
        csv_path = os.path.join(map_dir, 'extracted_adjacent_travesal_path.csv')
        if os.path.exists(csv_path):
            with open(csv_path, encoding='utf-8', newline='') as f:
                reader = csv.DictReader(f)
                for row in reader:
                    src, tgt, w = row['Source'], row['Target'], float(row['Weight'])
                    self._graph.setdefault(src, []).append((tgt, w))
                    self._graph.setdefault(tgt, []).append((src, w))  # undirected

    def register_entity_location(self, entity_id: str, node_id: str):
        """
        Associates a simulation entity with a physical map node so that
        spatial queries (nearest bin, nearest cage, etc.) can use real
        campus distances instead of falling back to list-order.

        Call this after registering an entity::

            env.register_entity(my_building)
            env.register_entity_location('my_building', 'TR-3')
        """
        self._entity_location[entity_id] = node_id

    def _dijkstra(self, start_node: str) -> Dict[str, float]:
        """
        Returns the shortest-path distances from *start_node* to every
        reachable node in the campus graph (edge weights are traversal costs
        from extracted_adjacent_travesal_path.csv).
        """
        dist: Dict[str, float] = {start_node: 0.0}
        heap: List[Tuple[float, str]] = [(0.0, start_node)]
        while heap:
            d, u = heapq.heappop(heap)
            if d > dist.get(u, float('inf')):
                continue
            for v, w in self._graph.get(u, []):
                nd = d + w
                if nd < dist.get(v, float('inf')):
                    dist[v] = nd
                    heapq.heappush(heap, (nd, v))
        return dist

    # ==================== TIME & SIMULATION LOOP ====================

    def tick(self):
        """
        Advances the simulation time and triggers perception/action loops for all entities.
        """
        # Advance time phase
        current_idx = self.get_property("time_index", 0)
        next_idx = (current_idx + 1) % len(self.TIME_PHASES)
        self.set_property("time_index", next_idx)
        self.set_property("time_of_day", self.TIME_PHASES[next_idx])
        
        time_now = self.get_time_of_day()
        self.log_event(f"--- Time advanced to: {time_now} ---")

        # Logic derived from: "น้องๆ มีจัดกิจกรรม รับน้อง... ก็จะเกิดขยะ มหาศาล... เที่ยงคืน ตี 2 มึงยังไม่เลิกกันเลย มันก็มีขยะพวกเนี้ย เกิดขึ้น"
        # Logic derived from: "อย่างสมมติ รถรอบเนี่ยมาเก็บตอน 3 โมง แม่บ้านที่อยู่ในอาคารเอามาทิ้งตอน 4 โมง"
        # The specific time phases dictate when certain actors behave (trucks at 3pm, maids at 4pm/5pm, students at late_night).

        # 1. All entities perceive their environment
        for entity in self.entity_objects:
            if hasattr(entity, 'perceive'):
                try:
                    entity.perceive(self)
                except NotImplementedError:
                    pass  # passive-only entity has no perception

        # 2. All entities decide their actions
        for entity in self.entity_objects:
            if hasattr(entity, 'decide_action'):
                try:
                    entity.decide_action()
                except NotImplementedError:
                    pass

        # 3. All entities act upon the environment
        for entity in self.entity_objects:
            if hasattr(entity, 'act'):
                try:
                    entity.act(self)
                except NotImplementedError:
                    pass

    # ==================== HELPERS & MEDIATOR FUNCTIONS ====================

    def get_time_of_day(self) -> str:
        """Returns the current simulated time phase."""
        return self.get_property("time_of_day", "morning")

    def log_event(self, message: str):
        """Centralized logging for simulation events."""
        self.event_log.append(f"[{self.get_time_of_day().upper()}] {message}")
        print(f"[{self.get_time_of_day().upper()}] {message}")

    def trigger_event(self, event_name: str, payload: Any = None, **kwargs):
        """
        Handles system-wide events decoupled from direct entity-to-entity interaction.
        """
        if event_name == "finance_transfer":
            self._handle_finance_transfer(payload)
            
        elif event_name == "schedule_special_pickup":
            # Logic derived from: "ถ้าเป็นของหน่วยงาน หรือเป็นของทางคณะ อะไรพวกเนี้ย เขาก็จะเรียกเป็นรอบๆ"
            # (Departments request pickup rounds)
            self.special_pickup_requests.append(payload)
            self.log_event(f"Scheduled special pickup for {payload.get('requester')} ({payload.get('waste_volume')}kg).")
            
        elif event_name == "chemical_spill_accident":
            # Logic derived from: "ทำให้แบบ เกิดเหตุ อะ ถ่ายเคมี 6 รั่วไหล 6 รดตัวเองบ้าง"
            self.log_event(f"EMERGENCY: Chemical spill at {payload.get('source')} due to ignored regulations.")
            
        elif event_name == "equipment_damaged_by_collectors":
            # Logic derived from: "คนเก็บขยะ ใช้รุนแรง ชิบหาย ไอ้เหี้ย มึงใช้มือ พวกเหี้ย นี่ใช้ตีน ตี แตก แหกเนี่ย... พังหมด"
            severity = kwargs.get("severity", "high")
            self.log_event(f"Equipment damaged by garbage collectors handling roughly. Severity: {severity}.")
            
        elif event_name == "building_capacity_warning":
            # Logic derived from: "แต่ มันก็มีทางที่เขาเป็นคณะทำงานในเรื่องเนี้ย เขาก็จะตักเตือนอะไรเงี้ย ให้รีบจัดการ"
            self.log_event(f"Working committee issued warning for building {payload.get('building')} due to excessive overflow.")
            
        elif event_name == "executive_inspection_failure":
            # Logic derived from: "ตกค้างเย็นนี้ พรุ่งนี้เช้า อ่า พวกคณะทำงาน หรือประธานมาเห็นเนี่ย เขาก็จะบอกละ เอ๊ะ ทำไมจุดนี้ขยะเยอะจัง"
            self.log_event(f"Executive complaint: Waste residue found overnight at building {payload.get('building')}.")

    def interact_with_object(self, target_obj: 'entity_object', action: str, payload: Any = None):
        """Facilitates safe interaction between an active entity and a target object."""
        if hasattr(target_obj, 'on_interact'):
            target_obj.on_interact(initiator=self, action=action, env=self, payload=payload)

    # ==================== SPATIAL & QUERY HELPERS ====================

    def get_nearest_waste_cage(self, entity_id: str) -> Optional['entity_object']:
        """
        Returns the CollectionPoint entity closest to *entity_id* by campus
        traversal distance (Dijkstra on the physical map graph).

        Outdoor L-series nodes are the primary candidates; TR-series building
        cages are also considered.  Falls back to the first registered
        CollectionPoint if the entity has no map location assigned.
        """
        cage_entities = [
            obj for obj in self.entity_objects
            if obj.__class__.__name__ == "CollectionPoint"
        ]
        if not cage_entities:
            return None

        start_node = self._entity_location.get(entity_id)
        if start_node and start_node in self._graph:
            distances = self._dijkstra(start_node)
            best_cage, best_dist = None, float('inf')
            for cage in cage_entities:
                cage_node = self._entity_location.get(cage.entity_object_id)
                if cage_node:
                    d = distances.get(cage_node, float('inf'))
                    if d < best_dist:
                        best_dist = d
                        best_cage = cage
            if best_cage:
                return best_cage

        return cage_entities[0]  # fallback: first registered cage

    def get_nearest_bin(self, entity_id: str) -> Optional['entity_object']:
        """
        Returns the TrashCan entity closest to *entity_id* by campus traversal
        distance (Dijkstra on the physical map graph).

        TrashCans are located inside buildings (TR-series nodes).  If the
        requesting entity has no map location, returns the first registered bin.
        """
        bin_entities = [
            obj for obj in self.entity_objects
            if obj.__class__.__name__ == "TrashCan"
        ]
        if not bin_entities:
            return None

        start_node = self._entity_location.get(entity_id)
        if start_node and start_node in self._graph:
            distances = self._dijkstra(start_node)
            best_bin, best_dist = None, float('inf')
            for bin_obj in bin_entities:
                bin_node = self._entity_location.get(bin_obj.entity_object_id)
                if bin_node:
                    d = distances.get(bin_node, float('inf'))
                    if d < best_dist:
                        best_dist = d
                        best_bin = bin_obj
            if best_bin:
                return best_bin

        return bin_entities[0]  # fallback: first registered bin

    def get_entity_by_type(self, entity_type: str) -> Optional['entity_object']:
        """Retrieves specific disposal sites or singleton entities."""
        for obj in self.entity_objects:
            if getattr(obj, "site_type", None) == entity_type or getattr(obj, "bin_type", None) == entity_type:
                return obj
        return None

    def check_building_waste_level(self, entity_id: str) -> bool:
        """
        Returns True if the building assigned to this janitor/entity has waste
        that needs to be collected.

        Resolution order:
        1. If a Building entity lists *entity_id* in its ``assigned_janitors``,
           check that building's ``internal_waste_volume``.
        2. If the entity has a map location (register via
           ``register_entity_location``), check the physical-map node's baseline
           total waste for that TR-series node.
        3. Fall back to any Building entity with non-zero internal waste.
        """
        # 1. Check the building that explicitly lists this janitor
        for obj in self.entity_objects:
            if obj.__class__.__name__ == "Building":
                if entity_id in getattr(obj, 'assigned_janitors', []):
                    return obj.internal_waste_volume > 0

        # 2. Use the physical map baseline for the janitor's assigned node
        node_id = self._entity_location.get(entity_id)
        if node_id and node_id in self._node_data:
            baseline = self._node_data[node_id].get('waste', {}).get('total', 0)
            return baseline > 0

        # 3. Fallback: any building with accumulated runtime waste
        for obj in self.entity_objects:
            if obj.__class__.__name__ == "Building" and obj.internal_waste_volume > 0:
                return True
        return False

    def get_collection_points_with_waste(self) -> List['entity_object']:
        """
        Returns a list of CollectionPoint entities that currently hold waste,
        sorted by descending waste volume so trucks service the fullest points
        first.

        An entity is included when *either*:
        - its runtime ``current_waste_kg`` is above zero, **or**
        - it has no runtime waste yet but its physical-map baseline shows
          historically positive waste (seeding initial state).

        Active outdoor L-nodes from the map that have no entity registered are
        also logged as warnings so they can be wired up.
        """
        active_points: List['entity_object'] = []
        registered_nodes = {
            self._entity_location.get(obj.entity_object_id)
            for obj in self.entity_objects
        }

        for obj in self.entity_objects:
            if obj.__class__.__name__ != "CollectionPoint":
                continue
            if obj.current_waste_kg > 0:
                active_points.append(obj)
            else:
                # Seed from physical-map baseline when runtime is zero
                node_id = self._entity_location.get(obj.entity_object_id)
                if node_id:
                    baseline = self._node_data.get(node_id, {}).get('waste', {}).get('total', 0)
                    if baseline > 0:
                        active_points.append(obj)

        # Warn about active map nodes that have no entity yet
        for node_id, node in self._node_data.items():
            if (node_id.startswith('L')
                    and node.get('status') == 'active'
                    and node_id not in registered_nodes
                    and node.get('waste', {}).get('total', 0) > 0):
                self.log_event(
                    f"WARNING: Map node {node_id} ({node.get('name_en', '')}) "
                    f"has waste but no CollectionPoint entity is registered."
                )

        return sorted(active_points, key=lambda x: x.current_waste_kg, reverse=True)

    def get_special_pickup_requests(self) -> List[Dict[str, Any]]:
        """
        Returns the full list of pending special-pickup request dicts submitted
        by Department entities via ``trigger_event('schedule_special_pickup', ...)``.  
        Returns an empty list when none are pending (falsy, so existing
        ``if self.special_requests:`` checks in GarbageTruck still work).
        """
        return list(self.special_pickup_requests)

    # ==================== INTERNAL BUSINESS LOGIC ====================

    def _handle_finance_transfer(self, payload: Dict[str, Any]):
        """
        Processes financial payouts from sorting facility revenue to departments.
        """
        # Logic derived from: "เพื่อส่งข้อมูลพวกเนี้ยให้กับทางกองคลัง เพื่อโอนเงินให้กับ จัดจ่ายเรื่องเงินให้กับแต่ละหน่วยงาน"
        # (Sending waste data to Finance Division enables money transfer to units)
        
        # Logic derived from: "แต่ถ้าเป็นของหน่วยงาน หรือสำนักงาน หรือภาคเนี่ย ก็จะเข้าหน่วยงาน 80 เข้ามหาวิทยาลัย 20"
        # (Revenue from unit waste is allocated to the Unit 80% and University 20%)
        
        target_unit = payload.get("target_unit")
        unit_amount = payload.get("unit_amount", 0.0)
        university_amount = payload.get("university_amount", 0.0)
        
        if target_unit not in self.finance_ledger["units"]:
            self.finance_ledger["units"][target_unit] = 0.0
            
        self.finance_ledger["units"][target_unit] += unit_amount
        self.finance_ledger["university_central"] += university_amount
        
        self.log_event(f"FINANCE: Transferred {unit_amount} to {target_unit} and {university_amount} to University Central.")
        
        # Notify the actual department entity so it can update its internal state
        for obj in self.entity_objects:
            if obj.__class__.__name__ == "Department" and getattr(obj, "department_name", None) == target_unit:
                if hasattr(obj, "receive_revenue"):
                    obj.receive_revenue(unit_amount)

    # ==================== POLICY MANAGEMENT ====================

    def apply_policy(self, policy_name: str):
        """
        Applies a systemic change to observe its effects on the simulation.
        """
        self.log_event(f"*** APPLYING POLICY: {policy_name} ***")
        
        if policy_name == "upgrade_all_infrastructure":
            # Logic derived from: "พี่อยากจะเปลี่ยน ใหม่ ให้มันมีขนาดที่ ใหญ่กว่าเนี้ย แล้วก็มีหลังคง หลังคา ปิด"
            for obj in self.entity_objects:
                if obj.__class__.__name__ == "CollectionPoint":
                    self.interact_with_object(obj, "upgrade_infrastructure")
                    
        elif policy_name == "add_sorting_staff":
            # Logic derived from: "แต่ ถ้าเราจัดการขึ้น เราต้องไปหาคนอีกคน 2 คน มาเพื่อจัดการตรงนี้ ก่อน"
            # (Hiring additional staff increases financial cost but helps management)
            for obj in self.entity_objects:
                if obj.__class__.__name__ == "SortingFacility":
                    obj.staff_count += 2
                    obj.processing_capacity_per_tick = obj.staff_count * 50.0
            self.finance_ledger["university_central"] -= 10000.0 # Deduct budget
            
        elif policy_name == "rent_reusable_equipment":
            # Logic derived from: "เขา ก็ มีการ ไปเช่า พวก อุปกรณ์ อ่า พวกแก้วน้ำ พวกชาม พวกจาน มา ลดขยะ ได้ อย่าง เยอะ เลย"
            # (Renting reusable equipment reduces waste quantity)
            self.set_property("event_waste_reduction_modifier", 0.5)