# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository Purpose

A practitioner's reference for building LLM-powered agents — an industry best-practices knowledge base. Patterns, inspections, and code snippets are extracted from real agentic projects via structured analysis. This is a **documentation/knowledge-base repo**, not a runnable application. There are no build steps, tests, or linting.

## How This Repo Grows

New content comes from **inspecting real agentic codebases** using `PROJECT_INSPECTION.md` as the primary workflow. Every inspection produces:
1. An **inspection document** in `inspections/<project_name>.md` — structured analysis following all 8 sections of the checklist
2. **Code snippets** in `code_snippets/<project_name>/` — extracted, simplified, self-contained patterns
3. **Pattern updates** to top-level markdown files — new insights merged into the appropriate pattern doc

When asked to inspect or analyze a project, always follow `PROJECT_INSPECTION.md` — it defines the inspection order, what to look for, what questions to answer, and how to save snippets.

## Inspection Workflow (from PROJECT_INSPECTION.md)

Analyze in this order:
1. **Architecture & Agent Topology** — hierarchy, instantiation, communication, delegation
2. **Thinking & Reasoning** — think step, visibility, tool selection, reflection
3. **Planning & Execution** — plan generation, schema, injection, tracking, re-planning
4. **Context Management** — splitting, isolation, history, token budget, overflow recovery
5. **Tool System** — definition, registration, selection, parallel execution, error recovery
6. **Flow Control & Error Handling** — core loop, iteration limits, termination, HITL
7. **User Interruption & Interference** — interrupt primitives, cancellation, permission gates, resume
8. **State & Persistence** — state schema, mutability, memory tiers, checkpointing

For each section: find the code, read the tests, trace a request, save snippets, document gaps.

## Structure

- **Top-level markdown files** — pattern documents organized by domain:
  - `AGENT_PATTERNS.md` — core agentic design (architecture selection, state, context engineering, prompts)
  - `LANGGRAPH_PATTERNS.md` — LangGraph-specific implementation patterns
  - `PRODUCTION_PATTERNS.md` — patterns for agents handling untrusted input at scale (prompt injection, tool policies, loop detection, HITL)
  - `ANTI_PATTERNS.md` — 42 common pitfalls with cross-references to fixes
  - `ORCHESTRATION_PATTERNS.md` — multi-agent topologies (pipeline, routing, hierarchical, star, etc.)
  - `INFRA_PATTERNS.md` — production infrastructure extracted from OpenClaw
  - `PROJECT_INSPECTION.md` — the master checklist for reverse-engineering agentic codebases

- **`inspections/`** — deep-dive architecture analyses of real projects, each following the PROJECT_INSPECTION.md checklist

- **`code_snippets/`** — implementation patterns extracted from inspected projects, organized by source project

## Conventions

- Pattern documents use heavy cross-referencing between files (anti-patterns link to fixes in other docs, etc.).
- Code snippets are **annotated extracts, not runnable modules** — they illustrate patterns with inline comments explaining *why*, not *what*.
- Every snippet file must include: header comment (project, pattern, description, source path), section labels, and simplified self-contained code.
- Snippet naming: `code_snippets/<project_name>/<pattern_name>.<ext>` — name by what the pattern does, not the source filename. 2-3 words max.
- Do NOT save trivial wrappers, standard library usage without agentic insight, or code that only makes sense with full project context.
- New inspections must follow `PROJECT_INSPECTION.md` structure and order.
- New patterns discovered during inspection should be merged into the appropriate top-level doc, not left only in the inspection file.
- Update `README.md` when adding new inspections or code snippets.
