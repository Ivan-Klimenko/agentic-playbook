"""
Ouroboros Tool Registry

Plugin architecture with auto-discovery, two-tier tool visibility
(core + extended via meta-tools), thread-sticky executor for stateful
tools (Playwright), and per-tool timeout with graceful recovery.

Source: ouroboros/tools/registry.py, ouroboros/tools/tool_discovery.py, ouroboros/loop.py
"""

from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional
import pathlib


# --- Tool Entry ---

@dataclass
class ToolEntry:
    """Single tool descriptor: name, schema, handler, metadata."""
    name: str
    schema: Dict[str, Any]              # OpenAI function calling format
    handler: Callable                    # fn(ctx: ToolContext, **kwargs) -> str
    is_code_tool: bool = False           # For metrics tracking
    timeout_sec: int = 120              # Per-tool configurable timeout


@dataclass
class ToolContext:
    """Execution context passed to every tool call."""
    repo_dir: pathlib.Path
    drive_root: pathlib.Path
    branch_dev: str = "ouroboros"
    pending_events: list = field(default_factory=list)      # Events for supervisor
    current_chat_id: Optional[int] = None
    current_task_type: Optional[str] = None

    # LLM-driven model switch (set by switch_model tool, read by loop.py)
    active_model_override: Optional[str] = None
    active_effort_override: Optional[str] = None

    # Fork bomb protection
    task_depth: int = 0


# --- Core vs Extended Tools ---
# 29 core tools always in context. Extended tools discoverable via meta-tools.

CORE_TOOL_NAMES = {
    "repo_read", "repo_list", "repo_write_commit", "repo_commit_push",
    "drive_read", "drive_list", "drive_write",
    "run_shell", "claude_code_edit",
    "git_status", "git_diff",
    "schedule_task", "wait_for_task", "get_task_result",
    "update_scratchpad", "update_identity",
    "chat_history", "web_search",
    "send_owner_message", "switch_model",
    "request_restart", "promote_to_stable",
    "knowledge_read", "knowledge_write",
    "browse_page", "browser_action", "analyze_screenshot",
}


class ToolRegistry:
    """Plugin architecture: auto-discovers tools from ouroboros/tools/ modules."""

    def __init__(self, repo_dir, drive_root):
        self._entries: Dict[str, ToolEntry] = {}
        self._ctx = ToolContext(repo_dir=repo_dir, drive_root=drive_root)
        self._load_modules()

    def _load_modules(self):
        """Auto-discover tool modules that export get_tools() -> List[ToolEntry]."""
        import importlib, pkgutil
        import ouroboros.tools as tools_pkg
        for _importer, modname, _ispkg in pkgutil.iter_modules(tools_pkg.__path__):
            if modname.startswith("_") or modname == "registry":
                continue
            mod = importlib.import_module(f"ouroboros.tools.{modname}")
            if hasattr(mod, "get_tools"):
                for entry in mod.get_tools():
                    self._entries[entry.name] = entry

    def schemas(self, core_only=False):
        """Return tool schemas. core_only=True returns only CORE_TOOL_NAMES + meta-tools."""
        if not core_only:
            return [{"type": "function", "function": e.schema} for e in self._entries.values()]
        return [
            {"type": "function", "function": e.schema}
            for e in self._entries.values()
            if e.name in CORE_TOOL_NAMES or e.name in ("list_available_tools", "enable_tools")
        ]

    def execute(self, name, args):
        entry = self._entries.get(name)
        if entry is None:
            return f"⚠️ Unknown tool: {name}"
        return entry.handler(self._ctx, **args)


# --- Dynamic Tool Discovery (meta-tools) ---
# LLM can discover and enable extended tools at runtime.
# Closures capture the live tool_schemas list — appending to it
# makes new tools visible to the LLM on the next round.

def setup_dynamic_tools(registry, tool_schemas, messages):
    """Wire list_available_tools/enable_tools into the active session."""
    enabled_extra = set()

    def _handle_list_tools(**kwargs):
        non_core = registry.list_non_core_tools()
        if not non_core:
            return "All tools are already in your active set."
        lines = [f"**{len(non_core)} additional tools available**:"]
        for t in non_core:
            lines.append(f"- **{t['name']}**: {t['description'][:120]}")
        return "\n".join(lines)

    def _handle_enable_tools(tools="", **kwargs):
        """Appends schemas to the LIVE list — LLM sees them next round."""
        names = [n.strip() for n in tools.split(",") if n.strip()]
        for name in names:
            schema = registry.get_schema_by_name(name)
            if schema and name not in enabled_extra:
                tool_schemas.append(schema)  # Mutates the list the LLM sees
                enabled_extra.add(name)
        return f"✅ Enabled: {', '.join(names)}"

    registry.override_handler("list_available_tools", _handle_list_tools)
    registry.override_handler("enable_tools", _handle_enable_tools)

    # Inform LLM about available extended tools
    non_core_count = len(registry.list_non_core_tools())
    if non_core_count > 0:
        messages.append({
            "role": "system",
            "content": f"You have {len(tool_schemas)} core tools. "
                       f"{non_core_count} additional tools available via "
                       f"`list_available_tools` / `enable_tools`."
        })


# --- Thread-Sticky Executor for Stateful Tools ---
# Playwright sync API requires greenlet thread-affinity.
# This executor ensures all browser calls run in the same thread.

STATEFUL_BROWSER_TOOLS = frozenset({"browse_page", "browser_action"})

class StatefulToolExecutor:
    """Single-thread executor for tools that need thread affinity."""

    def __init__(self):
        self._executor = None  # ThreadPoolExecutor(max_workers=1), created on first use

    def submit(self, fn, *args, **kwargs):
        if self._executor is None:
            from concurrent.futures import ThreadPoolExecutor
            self._executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="stateful_tool")
        return self._executor.submit(fn, *args, **kwargs)

    def reset(self):
        """On timeout: shutdown current thread, create fresh one."""
        if self._executor:
            self._executor.shutdown(wait=False, cancel_futures=True)
            self._executor = None


# --- Tool Execution with Timeout ---

def execute_with_timeout(tools, tool_call, timeout_sec, stateful_executor=None):
    fn_name = tool_call["function"]["name"]
    use_stateful = stateful_executor and fn_name in STATEFUL_BROWSER_TOOLS

    if use_stateful:
        future = stateful_executor.submit(execute_single_tool, tools, tool_call)
        try:
            return future.result(timeout=timeout_sec)
        except TimeoutError:
            stateful_executor.reset()  # Kill the stuck thread, create new one
            return {"result": f"⚠️ TOOL_TIMEOUT: Browser state reset.", "is_error": True}
    else:
        # One-shot executor to avoid shutdown(wait=True) deadlock
        from concurrent.futures import ThreadPoolExecutor
        executor = ThreadPoolExecutor(max_workers=1)
        try:
            future = executor.submit(execute_single_tool, tools, tool_call)
            return future.result(timeout=timeout_sec)
        except TimeoutError:
            return {"result": f"⚠️ TOOL_TIMEOUT ({fn_name})", "is_error": True}
        finally:
            executor.shutdown(wait=False, cancel_futures=True)
