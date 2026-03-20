"""
DeerFlow Prompt Engineering Patterns

The system prompt is dynamically assembled from multiple sources:
- Static template with role, thinking style, clarification system, response style
- Agent personality (SOUL.md per-agent)
- Memory context (token-budgeted <memory> block)
- Skills catalog (progressively loaded)
- Subagent orchestration guide (conditional on subagent_enabled flag)

Key pattern: CLARIFY -> PLAN -> ACT workflow enforced via system prompt.

Source: backend/packages/harness/deerflow/agents/lead_agent/prompt.py
"""

# --- Dynamic Prompt Assembly ---

def apply_prompt_template(
    subagent_enabled: bool = False,
    max_concurrent_subagents: int = 3,
    agent_name: str | None = None,
) -> str:
    # Each component is independently loaded and can be empty
    memory_context = _get_memory_context(agent_name)           # <memory>...</memory> XML
    soul = get_agent_soul(agent_name)                          # agents/{name}/SOUL.md
    skills_section = get_skills_prompt_section()               # <skill_system>...</skill_system>
    subagent_section = _build_subagent_section(n) if subagent_enabled else ""

    return SYSTEM_PROMPT_TEMPLATE.format(
        agent_name=agent_name or "DeerFlow 2.0",
        soul=soul,
        memory_context=memory_context,
        skills_section=skills_section,
        subagent_section=subagent_section,
        subagent_thinking=subagent_thinking,
        subagent_reminder=subagent_reminder,
    )


# --- Thinking Style (System Prompt Section) ---
# Teaches model to think before acting and NEVER proceed with ambiguity.

THINKING_STYLE = """
<thinking_style>
- Think concisely and strategically about the user's request BEFORE taking action
- Break down the task: What is clear? What is ambiguous? What is missing?
- **PRIORITY CHECK: If anything is unclear -> MUST ask for clarification FIRST**
- {subagent_thinking}  # injected only when subagent mode enabled
- Never write full answer in thinking, only outline
- After thinking, MUST provide actual response (thinking is for planning, response for delivery)
</thinking_style>
"""

# When subagent_enabled, this is injected into thinking_style:
SUBAGENT_THINKING = (
    "DECOMPOSITION CHECK: Can this task be broken into 2+ parallel sub-tasks? "
    "If YES, COUNT them. If count > {n}, MUST plan batches of <=n."
)


# --- Clarification System ---
# Enforces CLARIFY -> PLAN -> ACT workflow. Five clarification types with
# icons for user-facing formatting.

CLARIFICATION_TYPES = {
    "missing_info":          "?",   # required details not provided
    "ambiguous_requirement": "??",  # multiple valid interpretations
    "approach_choice":       "<>",  # several valid approaches
    "risk_confirmation":     "!!",  # destructive actions need confirmation
    "suggestion":            "*",   # recommendation needing approval
}

# The tool definition:
# ask_clarification(question, clarification_type, context?, options?)
# -> ClarificationMiddleware intercepts -> Command(goto=END) -> execution pauses


# --- Subagent Orchestration Guide ---
# Injected only when subagent_enabled=True. Teaches DECOMPOSE -> DELEGATE -> SYNTHESIZE.

SUBAGENT_SECTION = """
<subagent_system>
**DECOMPOSE -> DELEGATE -> SYNTHESIZE Pattern:**

**CRITICAL WORKFLOW** (before EVERY action):
1. COUNT: List all sub-tasks, count them: "I have N sub-tasks"
2. PLAN BATCHES: If N > {max_concurrent}:
   - "Batch 1 (this turn): first {max_concurrent} sub-tasks"
   - "Batch 2 (next turn): next batch"
3. EXECUTE: Launch ONLY current batch (max {max_concurrent} task calls)
4. REPEAT: After results return, launch next batch
5. SYNTHESIZE: After ALL batches complete, synthesize results
6. Cannot decompose -> Execute directly

**HARD LIMIT: max {max_concurrent} task calls per response. Excess silently discarded.**
</subagent_system>
"""


# --- Skills Progressive Loading ---
# Skills listed in system prompt but NOT loaded until needed.
# Agent reads SKILL.md file only when task matches skill description.

def get_skills_prompt_section() -> str:
    skills = load_skills(enabled_only=True)
    skill_items = "\n".join(
        f"<skill><name>{s.name}</name>"
        f"<description>{s.description}</description>"
        f"<location>{s.get_container_file_path(base_path)}</location></skill>"
        for s in skills
    )
    return f"""<skill_system>
**Progressive Loading Pattern:**
1. When query matches a skill -> read_file on skill's main file
2. Load referenced resources only when needed during execution
3. Follow skill's instructions precisely

{skill_items}
</skill_system>"""
