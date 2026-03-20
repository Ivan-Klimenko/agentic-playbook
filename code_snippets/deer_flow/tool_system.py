"""
DeerFlow Tool System

Multi-source tool composition: config-based (YAML + reflection), built-in,
and MCP servers. Tools are filtered per agent/subagent based on model
capabilities (vision), runtime flags (subagent_enabled), and per-agent
tool_groups from config. Deferred tool loading via tool_search prevents
context bloat when many MCP tools are available.

Source: backend/packages/harness/deerflow/tools/tools.py,
        backend/packages/harness/deerflow/tools/builtins/tool_search.py,
        backend/packages/harness/deerflow/mcp/cache.py
"""

# --- Built-in Tools ---
# Always available to the lead agent. Subagents get a filtered subset.

BUILTIN_TOOLS = [present_file_tool, ask_clarification_tool]
SUBAGENT_TOOLS = [task_tool]        # only included when subagent_enabled=True
SEARCH_TOOLS = [tool_search_tool]   # only included when tool_search.enabled=True


# --- Tool Composition ---
# Three sources merged: config-based, built-in, MCP.

def get_available_tools(
    groups: list[str] | None = None,   # per-agent tool_groups filter
    include_mcp: bool = True,
    model_name: str | None = None,
    subagent_enabled: bool = False,
) -> list[BaseTool]:
    config = get_app_config()

    # 1. Config-based tools: loaded via reflection from config.yaml
    #    Each tool entry: {name, group, use: "deerflow.sandbox.tools:bash_tool"}
    loaded_tools = [
        resolve_variable(tool.use, BaseTool)
        for tool in config.tools
        if groups is None or tool.group in groups
    ]

    # 2. MCP tools: cached globally, staleness-checked via config file mtime
    mcp_tools = []
    if include_mcp:
        extensions_config = ExtensionsConfig.from_file()
        if extensions_config.get_enabled_mcp_servers():
            mcp_tools = get_cached_mcp_tools()

    # 3. Built-in tools: conditionally includes subagent + vision + search tools
    builtin = BUILTIN_TOOLS.copy()
    if subagent_enabled:
        builtin.extend(SUBAGENT_TOOLS)

    model_config = config.get_model_config(model_name)
    if model_config and model_config.supports_vision:
        builtin.append(view_image_tool)

    if config.tool_search and config.tool_search.enabled:
        builtin.extend(SEARCH_TOOLS)

    return loaded_tools + builtin + mcp_tools


# --- Deferred Tool Loading ---
# Hides MCP tool schemas from LLM until agent explicitly searches for them.
# Prevents context bloat when dozens of MCP tools are available.

class DeferredToolRegistry:
    """Stores deferred tools by name + description for search."""

    def __init__(self):
        self._tools: dict[str, BaseTool] = {}  # name -> full tool

    def register(self, tool: BaseTool):
        self._tools[tool.name] = tool

    def search(self, query: str, max_results: int = 5) -> list[BaseTool]:
        """Three query syntaxes:
        - "select:name1,name2" -- fetch exact tools by name
        - "+keyword rest" -- require keyword in name, rank by rest
        - "pattern" -- regex match against name + description
        """
        if query.startswith("select:"):
            names = query[7:].split(",")
            return [self._tools[n.strip()] for n in names if n.strip() in self._tools]

        if query.startswith("+"):
            parts = query[1:].split(None, 1)
            required = parts[0]
            candidates = {n: t for n, t in self._tools.items() if required in n}
            # Rank remaining candidates by rest of query if provided
            return list(candidates.values())[:max_results]

        # Default: regex match
        pattern = re.compile(query, re.IGNORECASE)
        matches = [
            t for n, t in self._tools.items()
            if pattern.search(n) or pattern.search(t.description or "")
        ]
        return matches[:max_results]


class DeferredToolFilterMiddleware(AgentMiddleware):
    """Strips deferred tool schemas from LLM binding.
    ToolNode still has all tools for execution routing --
    only the model prompt sees the filtered set."""

    def wrap_model_call(self, request, handler):
        # Filter out deferred tool schemas before model sees them
        active_names = {t.name for t in self.active_tools}
        request.tools = [t for t in request.tools if t["name"] in active_names]
        return handler(request)


# --- MCP Tool Caching ---
# Global cache with asyncio.Lock for thread-safe lazy initialization.
# Staleness detected by checking extensions_config.json modification time.

_mcp_tools_cache: list[BaseTool] | None = None
_mcp_tools_lock = asyncio.Lock()
_config_mtime: float | None = None

async def _load_mcp_tools() -> list[BaseTool]:
    """Lazy-loads MCP tools from all enabled servers."""
    async with _mcp_tools_lock:
        current_mtime = extensions_config_path.stat().st_mtime
        if _mcp_tools_cache is not None and _config_mtime == current_mtime:
            return _mcp_tools_cache  # cache hit

        # Cache miss or stale: reload from MCP servers
        tools = await get_mcp_tools()  # uses langchain-mcp-adapters
        _mcp_tools_cache = tools
        _config_mtime = current_mtime
        return tools


# --- Subagent Tool Filtering ---
# Subagents inherit parent tools minus denied tools (no nesting).

def _filter_tools(all_tools, allowed, disallowed) -> list[BaseTool]:
    filtered = all_tools
    if allowed is not None:
        filtered = [t for t in filtered if t.name in set(allowed)]
    if disallowed is not None:
        filtered = [t for t in filtered if t.name not in set(disallowed)]
    return filtered

# Default disallowed for subagents:
# ["task", "ask_clarification", "present_files"] -> no nesting, no HITL, no artifacts
