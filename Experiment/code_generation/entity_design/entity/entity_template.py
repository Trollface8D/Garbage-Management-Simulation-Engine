"""
Entity Template Module - Re-export
This module now imports from the modular structure for backward compatibility.
"""

from .environment import SimulationEnvironment
from .policy import Policy
from .agent import Agent

__all__ = [
    'SimulationEnvironment',
    'Policy',
    'Agent'
]