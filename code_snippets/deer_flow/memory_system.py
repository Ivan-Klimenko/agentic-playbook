"""
DeerFlow Long-Term Memory System

Persistent cross-session memory with LLM-powered updates. Key patterns:
- Structured JSON with user context, history timeline, and confidence-scored facts
- Debounced async updates via configurable window to batch multiple conversations
- Token-budgeted injection into system prompt (max 2000 tokens)
- Facts ranked by confidence, oldest/lowest pruned at max_facts limit
- Upload mentions stripped to prevent ghost file references
- Per-agent memory isolation supported via agent_name parameter

Source: backend/packages/harness/deerflow/agents/memory/updater.py,
        backend/packages/harness/deerflow/agents/memory/prompt.py
"""

# --- Memory Schema ---
# Stored as JSON file, versioned, with structured sections.

EMPTY_MEMORY = {
    "version": "1.0",
    "lastUpdated": "ISO8601",
    "user": {
        "workContext":     {"summary": "", "updatedAt": ""},  # 2-3 sentences
        "personalContext": {"summary": "", "updatedAt": ""},  # 1-2 sentences
        "topOfMind":       {"summary": "", "updatedAt": ""},  # 3-5 sentences, updated most often
    },
    "history": {
        "recentMonths":      {"summary": "", "updatedAt": ""},  # 4-6 sentences, last 1-3 months
        "earlierContext":    {"summary": "", "updatedAt": ""},  # 3-5 sentences, 3-12 months
        "longTermBackground": {"summary": "", "updatedAt": ""},  # 2-4 sentences, foundational
    },
    "facts": [
        # {"id": "fact_abc123", "content": "...", "category": "preference|knowledge|context|behavior|goal",
        #  "confidence": 0.9, "createdAt": "ISO8601", "source": "thread_id"}
    ],
}


# --- Memory Injection (Token-Budgeted) ---
# Injected into system prompt as <memory>...</memory> XML block.
# Facts sorted by confidence, included until token budget exhausted.

def format_memory_for_injection(memory_data: dict, max_tokens: int = 2000) -> str:
    sections = []

    # Format user context and history sections (always included)
    for section_key in ("user", "history"):
        for field, data in memory_data.get(section_key, {}).items():
            if data.get("summary"):
                sections.append(f"- {field}: {data['summary']}")

    # Facts: ranked by confidence, incrementally added until budget hit
    ranked_facts = sorted(
        memory_data.get("facts", []),
        key=lambda f: f.get("confidence", 0),
        reverse=True,
    )
    running_tokens = count_tokens("\n".join(sections))

    fact_lines = []
    for fact in ranked_facts:
        line = f"- [{fact['category']} | {fact['confidence']:.2f}] {fact['content']}"
        line_tokens = count_tokens(line)
        if running_tokens + line_tokens <= max_tokens:
            fact_lines.append(line)
            running_tokens += line_tokens
        else:
            break  # budget exhausted

    return "\n".join(sections + ["Facts:"] + fact_lines)


# --- Memory Update (LLM-Powered) ---
# Conversation -> LLM extracts updates -> merge into existing memory.

class MemoryUpdater:
    def update_memory(self, messages, thread_id=None, agent_name=None) -> bool:
        current_memory = get_memory_data(agent_name)
        conversation_text = format_conversation_for_update(messages)

        # LLM call with structured output prompt
        prompt = MEMORY_UPDATE_PROMPT.format(
            current_memory=json.dumps(current_memory),
            conversation=conversation_text,
        )
        response = self._get_model().invoke(prompt)
        update_data = json.loads(response.content)

        # Apply updates: merge summaries, add/remove facts
        updated = self._apply_updates(current_memory, update_data, thread_id)

        # Strip upload mentions (session-scoped files cause ghost refs)
        updated = _strip_upload_mentions_from_memory(updated)

        # Enforce max facts (100 default), prune by lowest confidence
        if len(updated["facts"]) > config.max_facts:
            updated["facts"] = sorted(
                updated["facts"], key=lambda f: f["confidence"], reverse=True
            )[:config.max_facts]

        return _save_memory_to_file(updated, agent_name)


# --- Async Update Queue (Debounced) ---
# Batches memory updates to avoid thrashing. Only last update per thread retained.

class MemoryUpdateQueue:
    def __init__(self, updater: MemoryUpdater, debounce_seconds: float = 30.0):
        self._updater = updater
        self._debounce = debounce_seconds
        self._queue: dict[str, tuple[list, str | None]] = {}  # thread_id -> (messages, agent_name)
        self._lock = threading.Lock()
        self._timer: threading.Timer | None = None

    def enqueue(self, thread_id: str, messages: list, agent_name: str | None = None):
        with self._lock:
            self._queue[thread_id] = (messages, agent_name)
            if self._timer is None:
                self._timer = threading.Timer(self._debounce, self._flush)
                self._timer.start()

    def _flush(self):
        with self._lock:
            pending = dict(self._queue)
            self._queue.clear()
            self._timer = None

        for thread_id, (messages, agent_name) in pending.items():
            self._updater.update_memory(messages, thread_id, agent_name)


# --- Caching with Staleness Detection ---
# Memory loaded from disk with mtime-based cache invalidation.

_memory_cache: dict[str | None, tuple[dict, float | None]] = {}

def get_memory_data(agent_name=None) -> dict:
    file_path = _get_memory_file_path(agent_name)
    current_mtime = file_path.stat().st_mtime if file_path.exists() else None

    cached = _memory_cache.get(agent_name)
    if cached is None or cached[1] != current_mtime:
        # Cache miss or stale -- reload from disk
        data = _load_memory_from_file(agent_name)
        _memory_cache[agent_name] = (data, current_mtime)
        return data
    return cached[0]
