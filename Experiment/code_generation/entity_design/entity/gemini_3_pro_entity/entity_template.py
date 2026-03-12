"""
Entity Template Module - Re-export
This module now imports from the modular structure for backward compatibility.
"""

from .environment_template import SimulationEnvironment
from .policy_template import Policy
from .entity_object_template import entity_object

__all__ = [
    'SimulationEnvironment',
    'Policy',
    'entity_object'
]