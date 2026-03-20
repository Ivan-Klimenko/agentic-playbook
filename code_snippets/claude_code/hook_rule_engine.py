"""
Claude Code — Declarative Hook Rule Engine

A fail-safe, hot-reloadable rule engine that intercepts agent tool calls
via event-driven hooks. Rules are markdown files with YAML frontmatter,
loaded from disk on every invocation (no restart needed). Blocking rules
take priority over warnings; all hooks exit 0 even on error.

Source: plugins/hookify/core/rule_engine.py, plugins/hookify/core/config_loader.py
"""

import re
import os
import sys
import json
import glob
from functools import lru_cache
from dataclasses import dataclass, field
from typing import List, Dict, Any, Optional


# --- Rule Data Model ---
# Rules are defined as markdown files (.claude/hookify.*.local.md)
# with YAML frontmatter for conditions and a markdown body for the message.

@dataclass
class Condition:
    """A single matching condition within a rule."""
    field: str      # "command", "new_text", "file_path", "transcript", "user_prompt"
    operator: str   # "regex_match", "contains", "equals", "not_contains", "starts_with", "ends_with"
    pattern: str    # Pattern to match

@dataclass
class Rule:
    name: str
    enabled: bool
    event: str                              # "bash", "file", "stop", "prompt", "all"
    conditions: List[Condition] = field(default_factory=list)
    action: str = "warn"                    # "warn" or "block"
    tool_matcher: Optional[str] = None      # "Bash", "Edit|Write", "*"
    message: str = ""                       # Markdown body shown to agent

    @classmethod
    def from_frontmatter(cls, fm: Dict[str, Any], body: str) -> 'Rule':
        """Build rule from parsed YAML frontmatter + markdown body."""
        conditions = []

        # New format: explicit conditions list
        if 'conditions' in fm:
            conditions = [
                Condition(field=c['field'], operator=c.get('operator', 'regex_match'), pattern=c['pattern'])
                for c in fm['conditions']
            ]
        # Legacy format: simple pattern → auto-infer field from event
        elif 'pattern' in fm:
            event = fm.get('event', 'all')
            inferred_field = {'bash': 'command', 'file': 'new_text'}.get(event, 'content')
            conditions = [Condition(field=inferred_field, operator='regex_match', pattern=fm['pattern'])]

        return cls(
            name=fm.get('name', 'unnamed'),
            enabled=fm.get('enabled', True),
            event=fm.get('event', 'all'),
            conditions=conditions,
            action=fm.get('action', 'warn'),
            tool_matcher=fm.get('tool_matcher'),
            message=body.strip()
        )


# --- Regex Caching ---
# Compiled regex objects cached via LRU (max 128) to avoid recompilation.

@lru_cache(maxsize=128)
def _compile_regex(pattern: str) -> re.Pattern:
    return re.compile(pattern, re.IGNORECASE)


# --- Rule Engine ---
# Evaluates all matching rules against hook input data.
# Blocking rules take absolute priority over warnings.
# Multiple matching messages are combined with rule name labels.

class RuleEngine:

    def evaluate(self, rules: List[Rule], input_data: Dict[str, Any]) -> Dict[str, Any]:
        """Evaluate rules and return response dict for the hook system."""
        hook_event = input_data.get('hook_event_name', '')
        blocking, warning = [], []

        for rule in rules:
            if self._matches(rule, input_data):
                (blocking if rule.action == 'block' else warning).append(rule)

        if blocking:
            msg = "\n\n".join(f"**[{r.name}]**\n{r.message}" for r in blocking)
            # Response format varies by event type
            if hook_event == 'Stop':
                return {"decision": "block", "reason": msg, "systemMessage": msg}
            elif hook_event in ('PreToolUse', 'PostToolUse'):
                return {
                    "hookSpecificOutput": {
                        "hookEventName": hook_event,
                        "permissionDecision": "deny"  # Block the tool call
                    },
                    "systemMessage": msg
                }
            return {"systemMessage": msg}

        if warning:
            msg = "\n\n".join(f"**[{r.name}]**\n{r.message}" for r in warning)
            return {"systemMessage": msg}  # Warn but allow

        return {}  # No matches — allow operation

    def _matches(self, rule: Rule, data: Dict[str, Any]) -> bool:
        tool_name = data.get('tool_name', '')
        tool_input = data.get('tool_input', {})

        # Check tool matcher (e.g. "Bash", "Edit|Write", "*")
        if rule.tool_matcher and rule.tool_matcher != '*':
            if tool_name not in rule.tool_matcher.split('|'):
                return False

        if not rule.conditions:
            return False

        # All conditions must match (AND logic)
        return all(self._check(c, tool_name, tool_input, data) for c in rule.conditions)

    def _check(self, cond: Condition, tool_name: str, tool_input: dict, data: dict) -> bool:
        value = self._extract_field(cond.field, tool_name, tool_input, data)
        if value is None:
            return False

        op, pat = cond.operator, cond.pattern
        if op == 'regex_match':
            try:
                return bool(_compile_regex(pat).search(value))
            except re.error:
                return False
        elif op == 'contains':     return pat in value
        elif op == 'not_contains': return pat not in value
        elif op == 'equals':       return pat == value
        elif op == 'starts_with':  return value.startswith(pat)
        elif op == 'ends_with':    return value.endswith(pat)
        return False

    def _extract_field(self, field: str, tool_name: str, tool_input: dict, data: dict) -> Optional[str]:
        """Extract field value — normalizes across tool types."""
        # Direct match in tool_input
        if field in tool_input:
            return str(tool_input[field])

        # Event-specific fields (Stop, UserPromptSubmit)
        if field == 'reason':
            return data.get('reason', '')
        if field == 'user_prompt':
            return data.get('user_prompt', '')
        if field == 'transcript':
            # Retrospective check — read full session transcript from file
            path = data.get('transcript_path')
            if path:
                try:
                    with open(path, 'r') as f:
                        return f.read()
                except (IOError, UnicodeDecodeError):
                    return ''

        # Tool-specific field normalization
        if tool_name == 'Bash' and field == 'command':
            return tool_input.get('command', '')
        if tool_name in ('Write', 'Edit'):
            if field in ('content', 'new_text'):
                return tool_input.get('content') or tool_input.get('new_string', '')
            if field == 'file_path':
                return tool_input.get('file_path', '')

        return None


# --- Rule Loading ---
# Rules are loaded from .claude/hookify.*.local.md files on every hook invocation.
# This enables hot-reloading without restarting Claude Code.

def load_rules(event: Optional[str] = None) -> List[Rule]:
    """Load enabled rules matching the event type."""
    rules = []
    for path in glob.glob(os.path.join('.claude', 'hookify.*.local.md')):
        try:
            with open(path) as f:
                content = f.read()
            if not content.startswith('---'):
                continue
            parts = content.split('---', 2)
            if len(parts) < 3:
                continue

            # Simple YAML frontmatter parsing (no external deps)
            fm = _parse_frontmatter(parts[1])
            rule = Rule.from_frontmatter(fm, parts[2])

            if not rule.enabled:
                continue
            if event and rule.event != 'all' and rule.event != event:
                continue
            rules.append(rule)
        except Exception as e:
            print(f"Warning: Failed to load {path}: {e}", file=sys.stderr)
    return rules


def _parse_frontmatter(text: str) -> Dict[str, Any]:
    """Minimal YAML parser for rule frontmatter (no PyYAML dependency)."""
    result = {}
    current_key, current_list = None, []
    in_list = False

    for line in text.split('\n'):
        stripped = line.strip()
        if not stripped or stripped.startswith('#'):
            continue
        indent = len(line) - len(line.lstrip())

        if indent == 0 and ':' in line and not stripped.startswith('-'):
            if in_list and current_key:
                result[current_key] = current_list
                current_list, in_list = [], False

            key, value = line.split(':', 1)
            key, value = key.strip(), value.strip().strip('"').strip("'")
            if not value:
                current_key, in_list = key, True
            elif value.lower() in ('true', 'false'):
                result[key] = value.lower() == 'true'
            else:
                result[key] = value

        elif stripped.startswith('-') and in_list:
            item = stripped[1:].strip()
            if ':' in item and ',' in item:
                # Inline dict: "- field: command, operator: regex_match"
                d = {}
                for part in item.split(','):
                    if ':' in part:
                        k, v = part.split(':', 1)
                        d[k.strip()] = v.strip().strip('"').strip("'")
                current_list.append(d)
            else:
                current_list.append(item.strip('"').strip("'"))

    if in_list and current_key:
        result[current_key] = current_list
    return result


# --- Hook Entry Point ---
# Each hook event (PreToolUse, Stop, etc.) has a thin entry point script
# that reads stdin JSON, loads rules, evaluates, and writes stdout JSON.
# ALWAYS exits 0 — never blocks operations due to hook errors.

def hook_entry(event_filter: Optional[str] = None):
    """Generic hook entry point — used by PreToolUse, PostToolUse, Stop, etc."""
    try:
        input_data = json.load(sys.stdin)

        # For PreToolUse: infer event from tool name
        if event_filter is None:
            tool_name = input_data.get('tool_name', '')
            event_filter = {
                'Bash': 'bash',
                'Edit': 'file', 'Write': 'file', 'MultiEdit': 'file'
            }.get(tool_name)

        rules = load_rules(event=event_filter)
        result = RuleEngine().evaluate(rules, input_data)
        print(json.dumps(result))

    except Exception as e:
        # Fail-safe: log error, allow operation
        print(json.dumps({"systemMessage": f"Hook error: {e}"}))
    finally:
        sys.exit(0)  # ALWAYS exit 0
