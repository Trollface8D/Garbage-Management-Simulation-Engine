"""
main.py — KMUTT Garbage Management Simulation Entry Point

Builds the full campus simulation directly from the physical_map data files
(no hard-coded node names or waste values).  Spawns every entity type, wires
them into the mediator environment, and runs the perceive-decide-act loop.

This file is generated using Claude Sonnet 4.6.
"""

import json
import os

from environment import WasteManagementEnvironment
from building import Building
from floor import Floor
from trashcan import TrashCan
from collection_point import CollectionPoint
from student import Student
from university_personel import UniversityPersonnel
from janitor import Janitor
from garbage_truck import GarbageTruck
from sorting_facility import SortingFacility
from disposal_site import DisposalSite
from policy import (
    WasteRevenuePolicy,
    EWasteActivityHourPolicy,
    ReusableEquipmentPolicy,
    SpecialPickupSchedulingPolicy,
    InfrastructureUpgradePolicy,
)

# ---------------------------------------------------------------------------
# Physical map data  (single source of truth — no hard-coded values below)
# ---------------------------------------------------------------------------
MAP_DIR = os.path.normpath(
    os.path.join(os.path.dirname(os.path.abspath(__file__)),
                 '..', '..', '..', 'physical_map')
)

def _load_json(filename: str) -> dict:
    with open(os.path.join(MAP_DIR, filename), encoding='utf-8') as f:
        return json.load(f)

building_map_data = _load_json('building_trashbuffer.json')   # TR-series
outdoor_map_data  = _load_json('outdoor_trashbuffer.json')    # L-series

# Index by node id for quick lookup
TR_NODES = {node['id']: node for node in building_map_data['nodes']}
L_NODES_ACTIVE = [n for n in outdoor_map_data['nodes'] if n.get('status') == 'active']

# The only TR-node that is the sorting plant, not a regular building
SORTING_PLANT_NODE_ID = 'TR-6'
# Dormitory node (highest student population)
DORM_NODE_ID = 'TR-1'

# Keywords that indicate a building has laboratory facilities
LAB_KEYWORDS = frozenset({'microbiology', 'physics', 'chemistry', 'chemical', 'electronic'})

# ---------------------------------------------------------------------------
# Environment
# ---------------------------------------------------------------------------
env = WasteManagementEnvironment()

# ---------------------------------------------------------------------------
# Global policies
# ---------------------------------------------------------------------------
for policy in [
    WasteRevenuePolicy(),
    EWasteActivityHourPolicy(),
    ReusableEquipmentPolicy(),
    SpecialPickupSchedulingPolicy(),
    InfrastructureUpgradePolicy(),
]:
    env.add_global_policy(policy)

# ---------------------------------------------------------------------------
# Terminal disposal sites
# ---------------------------------------------------------------------------
DISPOSAL_SITES = [
    ('bma_disposal',          'disposal_bma'),
    ('n15_rdf',               'disposal_n15'),
    ('mirror_foundation',     'disposal_mirror'),
    ('fertilizer_processing', 'disposal_fertilizer'),
]
for site_type, site_id in DISPOSAL_SITES:
    site = DisposalSite(site_id, site_type)
    env.register_entity_object(site)

# ---------------------------------------------------------------------------
# Sorting facility  (TR-6 — Front of Waste Separation Plant)
# ---------------------------------------------------------------------------
facility = SortingFacility('sorting_01', staff_count=3)
env.register_entity_object(facility)
env.register_entity_location('sorting_01', SORTING_PLANT_NODE_ID)

# ---------------------------------------------------------------------------
# Buildings, ground floors, bins, janitors, personnel (all TR-nodes except TR-6)
# ---------------------------------------------------------------------------
for node_id, node in TR_NODES.items():
    if node_id == SORTING_PLANT_NODE_ID:
        continue

    slug      = node_id.lower().replace('-', '_')          # "tr_1", "tr_2", …
    name_en   = node.get('name_en', node_id)
    waste_kg  = node['waste']['total']

    # Buildings with > 5 000 kg/month baseline are treated as high-budget flagships
    budget_tier = 'high' if waste_kg > 5000 else 'limited'
    bldg = Building(f'bldg_{slug}', budget_tier=budget_tier)
    env.register_entity_object(bldg)
    env.register_entity_location(f'bldg_{slug}', node_id)

    # Ground floor: weighing scale + logbook are always present at ground level
    floor = Floor(f'floor_{slug}_ground', floor_level='ground')
    env.register_entity_object(floor)

    # Trash can: yellow BMA compression bins for very high-waste buildings
    bin_type = 'yellow_bma' if waste_kg > 5000 else 'general'
    bin_obj  = TrashCan(f'bin_{slug}', bin_type=bin_type, label=name_en)
    env.register_entity_object(bin_obj)
    env.register_entity_location(f'bin_{slug}', node_id)

    # One janitor per building; immediately linked to building's roster
    janitor = Janitor(f'jan_{slug}')
    bldg.assigned_janitors.append(f'jan_{slug}')
    env.register_entity_object(janitor)
    env.register_entity_location(f'jan_{slug}', node_id)

    # University personnel / academic staff for this building
    name_lower = name_en.lower()
    has_lab    = any(kw in name_lower for kw in LAB_KEYWORDS)
    has_shop   = node.get('type') == 'Service'
    personnel  = UniversityPersonnel(
        f'dept_{slug}',
        department_name=name_en,
        has_shop_space=has_shop,
        has_lab=has_lab,
    )
    env.register_entity_object(personnel)
    env.register_entity_location(f'dept_{slug}', node_id)

# ---------------------------------------------------------------------------
# Students  (proportional to dormitory baseline waste; seated at dorm node)
# ---------------------------------------------------------------------------
dorm_waste        = TR_NODES[DORM_NODE_ID]['waste']['total']
total_tr_waste    = sum(n['waste']['total'] for n in TR_NODES.values())
# Rough scaling: 1 student entity per ~1 000 kg monthly dorm waste, minimum 3
n_students        = max(3, round(dorm_waste / 1000))
n_volunteers      = max(1, round(n_students * 0.2))   # ~20 % are volunteers

for i in range(n_students):
    stu = Student(f'stu_{i+1:03d}', is_volunteer=(i < n_volunteers))
    env.register_entity_object(stu)
    env.register_entity_location(f'stu_{i+1:03d}', DORM_NODE_ID)

# ---------------------------------------------------------------------------
# Outdoor collection points  (active L-series nodes only)
# ---------------------------------------------------------------------------
for node in L_NODES_ACTIVE:
    node_id   = node['id']
    slug      = node_id.lower().replace('.', '_').replace('-', '_')
    waste_kg  = node['waste']['total']

    # High-waste outdoor points get upgraded (non-budget-constrained) cages
    budget_constrained = waste_kg < 1000
    cage = CollectionPoint(
        f'cage_{slug}',
        location_type=node.get('type', 'Outdoor Point'),
        budget_constrained=budget_constrained,
    )
    env.register_entity_object(cage)
    env.register_entity_location(f'cage_{slug}', node_id)

# ---------------------------------------------------------------------------
# Garbage trucks
# ---------------------------------------------------------------------------
truck_standard = GarbageTruck('truck_01',        is_garden_team=False)
truck_garden   = GarbageTruck('truck_garden_01', is_garden_team=True)
for truck in [truck_standard, truck_garden]:
    env.register_entity_object(truck)
    # Trucks are stationed at / dispatched from the sorting plant
    env.register_entity_location(truck.entity_object_id, SORTING_PLANT_NODE_ID)

# ---------------------------------------------------------------------------
# Simulation loop
# ---------------------------------------------------------------------------
SIMULATION_DAYS = 3
PHASES_PER_DAY  = len(WasteManagementEnvironment.TIME_PHASES)
DAYS_OF_WEEK    = ['monday', 'tuesday', 'wednesday', 'thursday',
                   'friday', 'saturday', 'sunday']

print("=" * 62)
print("  KMUTT Waste Management Simulation")
print(f"  Entities registered  : {len(env.entity_objects)}")
print(f"  Map nodes loaded     : {len(env._node_data)}")
print(f"  Graph edges          : {sum(len(v) for v in env._graph.values()) // 2}")
print(f"  Students spawned     : {n_students}  ({n_volunteers} volunteers)")
print(f"  Running              : {SIMULATION_DAYS} days × {PHASES_PER_DAY} phases/day")
print("=" * 62)

for day in range(SIMULATION_DAYS):
    day_name = DAYS_OF_WEEK[day % len(DAYS_OF_WEEK)]
    env.set_property('day_of_week', day_name)
    print(f"\n{'-' * 62}")
    print(f"  DAY {day + 1}  ({day_name.upper()})")
    print(f"{'-' * 62}")
    for _ in range(PHASES_PER_DAY):
        env.tick()

# ---------------------------------------------------------------------------
# Post-simulation summary
# ---------------------------------------------------------------------------
print("\n" + "=" * 62)
print("  SIMULATION COMPLETE — SUMMARY")
print("=" * 62)

# Finance
print(f"\n  University Central Revenue : "
      f"{env.finance_ledger['university_central']:.2f} THB")
if env.finance_ledger['units']:
    print("  Unit Revenue Breakdown:")
    for unit, amount in sorted(env.finance_ledger['units'].items()):
        print(f"    {unit:<38s} {amount:>10.2f} THB")
else:
    print("  Unit Revenue Breakdown : (no transfers processed yet)")

# Sorting facility
s = facility.get_status()
print(f"\n  Sorting Facility [{facility.entity_object_id}]  —  staff: {s['staff_count']}")
print(f"    Unprocessed      : {s['unprocessed_waste_kg']:>8.1f} kg"
      f"  (backlogged: {s['is_backlogged']})")
print(f"    Sortable pile    : {s['inventories']['sortable_pile']:>8.1f} kg")
print(f"    RDF fuel ready   : {s['inventories']['rdf_fuel']:>8.1f} kg")
print(f"    Unsortable (BMA) : {s['inventories']['unsortable_compressed']:>8.1f} kg")

# Trucks
for truck in [truck_standard, truck_garden]:
    ts = truck.get_status()
    label = 'Garden Team' if ts['is_garden_team'] else 'Standard'
    print(f"\n  Truck [{ts['entity_id']}]  ({label})")
    print(f"    Load             : {ts['current_load_kg']:>8.1f} / "
          f"{ts['capacity_kg']:.1f} kg")
    print(f"    Extra-round cost : {ts['accumulated_extra_costs']:>8.2f} THB")

# Overflowing collection points
overflowing = [
    obj for obj in env.entity_objects
    if obj.__class__.__name__ == 'CollectionPoint' and obj.is_overflowing
]
print(f"\n  Overflowing collection points : {len(overflowing)}")
for cp in overflowing:
    print(f"    {cp.entity_object_id:<30s}  {cp.current_waste_kg:.1f} kg")

# Disposal sites
print("\n  Disposal Site Totals:")
for obj in env.entity_objects:
    if obj.__class__.__name__ == 'DisposalSite':
        ds = obj.get_status()
        print(f"    [{ds['site_type']:<25s}]  "
              f"{ds['total_received_kg']:>8.1f} kg  |  "
              f"{ds['processed_products']} products")

# Pending special pickups
pending = env.get_special_pickup_requests()
print(f"\n  Pending special pickups : {len(pending)}")
for req in pending:
    print(f"    {req.get('requester', '?'):<30s}  "
          f"{req.get('waste_volume', '?')} kg")

print("\n" + "=" * 62)