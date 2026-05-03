# Generate Simulation Code State behavior

Use this format to describe each generation state in the simulation code pipeline. Keep each state focused on what it does, how it behaves, and what it depends on or creates.

## Code Generation Flow Overview

**User Interactions During Code Generation:**
- **Cancel button**: Pauses the code generation process. Button becomes "Resume" to continue from the same stage. User can edit policies in Stage 2 before resuming.
- **Edit button**: Stops code generation and removes all progress (equivalent to reset behavior). Returns user to input selection phase.

---

## 1. Entities

Activation:
a) User clicks the Generate button (or Resume button after pause)

Behavior:
- Import the target entity list from entity extraction outside of code generation
- Deduplicate and rank entities before any code generation begins
- Create the simulation entities list from the target entity list
- Preserve each entity's label, type, frequency, and generated identifier for later stages

User Interaction:
- None — this stage runs automatically

Dependency:
- [Outside state] entity extraction
- [State 2] Policies
- [State 3] Dependencies
- [State 4] Entity classes

Output:
- Ranked simulation entity list used as the source of truth for the rest of the pipeline

## 2. Policies

Activation:
a) State 1 entities are available

Behavior (Auto-generation):
- Import the target entities from the entity list
- Read the causal rules that describe what each policy should enforce
- Generate the policy outline with trigger, target entity, target method, and inputs
- Keep the outline separate from code generation so later states can reference it

**User Interaction (BLOCKING):**
- **Policy Selection**: User must select at least 1 policy from the generated list
- **Optional Manual Policies**: User can add custom policies with title and description
- **Confirm & Proceed**: User clicks "Confirm & Proceed" button to continue to Stage 3
- **Pause/Resume**: User can click Cancel to pause; selected policies are preserved and can be edited before resuming
- **Edit**: User can click Edit button to reset and return to input selection phase

Dependency:
- [State 1] Entities
- [Outside state] causal data
- [State 7] Policy modules

Output:
- Policy outline (auto-generated list + manual policies) used to guide entity behavior and policy code generation
- Selected policy IDs from user confirmation

## 3. Dependencies

Activation:
a) Entities and policies are confirmed by user

Behavior:
- Import the entity list and policy outline
- Identify which entities depend on other entities to exist or be initialized first
- Create dependency edges between related entities
- Order the generation flow so upstream entities are built before downstream entities

User Interaction:
- None — this stage runs automatically

Dependency:
- [State 1] Entities
- [State 2] Policies (user-confirmed selection)
- [State 4] Entity classes

Output:
- Dependency graph used to determine the entity generation order

## 4. Entity classes

Activation:
a) Dependency order is ready
 (iterative code generation)
- Use previously generated entity code to keep method names and interfaces consistent
- Fill in the class structure, attributes, and behavior implied by the causal data

User Interaction:
- None — this stage runs automatically

Dependency:
- [State 1] Entities
- [State 2] Policies (user-confirmed selection)
Dependency:
- [State 1] Entities
- [State 2] Policies
- [State 3] Dependencies
- [Outside state] entity templates

Output:
- Generated entity class files for the simulation

## 5. Validate protocol

Activation:
a) Entity class generation is complete

Behavior:
- Import the generated entity classes
- Check that every entity follows the required runtime protocol
User Interaction:
- None — this stage runs automatically

Dependency:
- [State 4] Entity classes
- [Outside state] runtime protocol rules

Output:
- Validation result for entity classes (pass/fail with error details if applicable)es

Output:
- Validation result for entity classes

## 6. Environment

Activation:
a) Entity classes pass validation

User Interaction:
- None — this stage runs automatically

Dependency:
- [State 4] Entity classes
- [State 1] Entities
- [State 2] Policies (user-confirmed selection)stries, world state, and tick/update control
- Wire the environment so entities can interact through one central simulation surface

Dependency:
- [State 4] Entity classes
- [State 1] Entities
- [State 2] Policies
- [State 3] Dependencies

Output:
- Environment class or module used to run the simulation

## 7. Policy modules
 (iterative code generation)
- Implement the behavior changes that the simulation must enforce
- Use previously generated policies so the new policy does not duplicate existing logic
- Apply user-selected policies and manual policies from Stage 2

User Interaction:
- None — this stage runs automatically

Dependency:
- [State 2] Policies (user-confirmed selection with manual additions)classes and the environment
- Generate one policy module per policy rule
- Implement the behavior changes that the simulation must enforce
- Use previously generated policies so the new policy does not duplicate existing logic

Dependency:
- [State 2] Policies
- [State 4] Entity classes
- [State 6] Environment

Output:
- Generated policy modules for simulation behavior rules

## 8. Validate policies

Activation:
a) Policy module generation is complete
User Interaction:
- None — this stage runs automatically

Dependency:
- [State 7] Policy modules
- [State 6] Environment

Output:
- Validation result for policy modules (pass/fail with error details if applicable) the runtime contract

Dependency:
- [State 7] Policy modules
- [State 6] Environment

Output:
- Validation result for policy modules

## 9. Finalize

Activation:
a) All previous states complete successfully
User Interaction:
- None — this stage runs automatically

Dependency:
- [State 1] Entities
- [State 2] Policies (user-confirmed selection with manual additions)
- [State 3] Dependencies
- [State 4] Entity classes
- [State 5] Validate protocol
- [State 6] Environment
- [State 7] Policy modules
- [State 8] Validate policies

Output:
- Final simulation code bundle and manifest

---

## After Finalize: Run Simulation & Visualize

Once Stage 9 (Finalize) completes successfully:
- Artifacts are ready for download
- The simulation code is fetched to the "Run simulation & visualize" module
- User can view and interact with generated entity classes
- User can execute the simulation and analyze outputs
- [State 5] Validate protocol
- [State 6] Environment
- [State 7] Policy modules
- [State 8] Validate policies

Output:
- Final simulation code bundle and manifest