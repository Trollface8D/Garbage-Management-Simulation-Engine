# ---------------------------------------------------------
# THE MEDIATOR (Environment)
# ---------------------------------------------------------
class SimulationEnvironment:
    """
    Acts as the Mediator. All entities talk to the environment, 
    not directly to each other, to prevent spaghetti code.
    """
    def __init__(self):
        self.stakeholders = []
        self.objects = []
        self.policies = []
        self.behaviors = []
        
    def register_entity(self, entity):
        # Logic to add entity to the appropriate list
        pass
