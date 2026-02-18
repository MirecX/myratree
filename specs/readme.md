# Myratree

A local-first, LLM-driven git project manager with an integrated issue tracker, running entirely in the terminal.

## What It Does

Myratree is a two-tier AI agent system that lives inside your git repository:

1. You describe features or bugs in a chat interface (TUI).
2. A **Manager agent** (an LLM) converses with you, writes specifications, creates structured issues, and orchestrates work.
3. **Worker agents** (headless Claude Code CLI instances) are spawned in isolated git worktrees — one per issue — to implement the code.
4. When a worker finishes, the Manager reviews the diff, runs tests, and merges the branch back to main.

Everything is local. `.myratree/` is gitignored and each developer runs their own instance.

## Core Principles

- **Local-first** — no cloud services, no SaaS. LLM endpoints are local (Ollama, llama.cpp, vLLM) or self-hosted. All state lives on disk.
- **Markdown as database** — issues, specs, and agent logs are plain markdown files. Human-readable, diffable, no migrations.
- **Isolated execution** — each worker operates in its own git worktree on its own branch. No worker can corrupt main or step on another worker's changes.
- **Agentic loop** — the Manager runs a standard tool-use loop (send → tool_use → execute → tool_result → repeat). Up to 10 iterations per turn, with stuck-detection.
- **Yolo mode** — when enabled, the Manager autonomously spawns workers, reviews diffs, runs tests, and merges without asking for human confirmation. This is enforced at the code level: destructive tools (`delete_issue`, `spawn_worker`, `merge_issue`, `git_commit`) require explicit user approval in the TUI when yolo mode is off.
- **Tool confirmation** — destructive tools are gated by a confirmation prompt when yolo mode is off. The Manager pauses execution, shows a description of the action in the chat, and waits for the user to type `y` or `n`. Denied actions return "Action cancelled by user." to the LLM as a tool result.
- **Startup recovery** — on initialization, Myratree detects orphaned worktrees from previous sessions (worktrees on disk with no live Worker process). Issues that were `in_progress` or `review` are reset to `open`, and a recovery summary is displayed in the chat so the user can decide whether to re-spawn workers or clean up.
- **Worker completion via stdout** — workers signal completion by outputting `ITHAVEBEENDONE` as their final message. The manager detects this in captured stdout. For blockers, workers output `STATUS: BLOCKED <reason>`.

## Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js 20+ (ESM) |
| Language | TypeScript 5.9 (strict) |
| TUI framework | React Ink 6 (React 19) |
| LLM communication | Fetch → Anthropic Messages API format (`/v1/messages`) |
| Worker execution | Claude Code CLI (`claude` binary), spawned as child processes |
| Git operations | simple-git |
| Build | tsup 8 (single-file ESM bundle) |
| Dev runner | tsx 4 |

## Project Structure

```
myratree/
├── src/
│   ├── index.tsx              # CLI entry point
│   ├── app.tsx                # Root React component
│   ├── agents/
│   │   ├── manager.ts         # Manager: LLM agent, tool execution, worker orchestration
│   │   ├── worker.ts          # Worker: Claude Code subprocess management
│   │   └── prompt-generator.ts
│   ├── components/
│   │   ├── Layout.tsx         # Root TUI layout, keyboard bindings
│   │   ├── Chat.tsx           # Chat panel with scrollable history
│   │   ├── IssueList.tsx      # Issue list with status icons
│   │   ├── AgentStatus.tsx    # Bottom status bar
│   │   └── DiffView.tsx       # Full-screen diff/log viewer
│   ├── llm/
│   │   ├── types.ts           # LLM type definitions
│   │   ├── client.ts          # Single-endpoint LLM client
│   │   └── router.ts          # Multi-endpoint weighted round-robin router
│   ├── core/
│   │   ├── config.ts          # Config loading/saving, project root detection
│   │   ├── git.ts             # Worktree creation, merging, diffs
│   │   └── init.ts            # .myratree/ scaffold creation
│   ├── issues/
│   │   ├── parser.ts          # Markdown issue file format (parse/serialize)
│   │   ├── tracker.ts         # Issue CRUD + filesystem watch
│   │   └── lifecycle.ts       # Status state machine
│   └── utils/
│       ├── logger.ts          # Structured JSON file logger
│       └── markdown.ts        # Markdown read/write helpers
├── specs/                     # Specification documents (this directory)
├── package.json
├── tsconfig.json
└── tsup.config.ts
```

## Data Flow

```
User input (Chat)
    → Manager.chat()
        → LlmRouter.complete() (weighted round-robin across endpoints)
        → Tool loop: create specs, create issues, spawn workers, review diffs, merge
            → Worker: git worktree + Claude Code subprocess
            → Worker writes ITHAVEBEENDONE to issue file
        → Manager auto-reviews → merge to main
    → TUI updates via event emitter
```

## CLI Commands

| Command | Description |
|---|---|
| `myratree` | Launch the TUI |
| `myratree init` | Initialize `.myratree/` in current repo |
| `myratree issue create` | Create an issue from CLI |
| `myratree issue list` | List all issues |
| `myratree status` | Print summary stats |
| `myratree config set <key> <val>` | Set config with dot-notation |
| `myratree reset` | Clear all myratree state and re-init |

## Spec Index

| Spec | Scope |
|---|---|
| [specs/manager.md](manager.md) | Manager agent: system prompt, tool definitions, agentic loop, worker orchestration |
| [specs/worker.md](worker.md) | Worker agent: Claude Code subprocess, prompt generation, completion protocol |
| [specs/tui.md](tui.md) | TUI: layout, components, keyboard bindings, event wiring |
