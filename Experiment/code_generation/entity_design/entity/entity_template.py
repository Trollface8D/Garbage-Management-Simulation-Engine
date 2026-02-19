"""
Entity Template Module - Re-export
This module now imports from the modular structure for backward compatibility.
"""

from .environment import SimulationEnvironment
from .policy import Policy
from .system_behavior import SystemBehavior
from .simulation_object import SimulationObject
from .stakeholder import Stakeholder

__all__ = [
    'SimulationEnvironment',
    'Policy',
    'SystemBehavior',
    'SimulationObject',
    'Stakeholder',
]