"""
Entity Template Module - Re-export
This module now imports from the modular structure for backward compatibility.
"""

from .environment import SimulationEnvironment
from .policy import Policy
from .entity_object import entity_object

__all__ = [
    'SimulationEnvironment',
    'Policy',
    'entity_object'
]