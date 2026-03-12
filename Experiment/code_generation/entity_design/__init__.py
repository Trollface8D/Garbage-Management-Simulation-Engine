"""
Entity Design Package

This package contains the base templates for the simulation framework.
All classes use the Mediator pattern with SimulationEnvironment as the central coordinator.
"""

from .environment import SimulationEnvironment
from .policy import Policy
from .system_behavior import SystemBehavior
from .agent import Agent, Stakeholder, SimulationObject

__all__ = [
    'SimulationEnvironment',
    'Policy',
    'SystemBehavior',
    'Agent',
    'SimulationObject',  # Backward compatibility alias
    'Stakeholder',       # Backward compatibility alias
]
