# Novatree

Local-first, LLM-driven git project manager with an integrated issue tracker. Combines a React Ink TUI with a two-tier agent architecture: a **Manager agent** that chats with you, creates issues, and reviews results, plus **Worker agents** (Claude Code CLI instances) that implement features in isolated git worktrees.

## Architecture

```
┌─ Issues ──────────┐┌─ Chat ────────────────────────┐
│                    ││                               │
│ ● #1 login-form   ││ You: Add a login form with    │
│   [in_progress]    ││ email and password...         │
│                    ││                               │
│ ○ #2 dark-mode     ││ Novatree: I'll create an      │
│   [open]           ││ issue for that. Spawning       │
│                    ││ worker now...                  │
│ ✓ #3 api-cache     ││                               │
│   [done]           ││ > _                            │
│                    ││                               │
├─ Worktrees ────────┤│                               │
│ 001-login-form     ││                               │
│  novatree/001-...  ││                               │
└────────────────────┘└───────────────────────────────┘
┌─ Agent Status ─────────────────────────────────────┐
│ worker-1: 001-login-form | running | 5m elapsed    │
│ LLM: workstation (3/3 healthy) | Queue: 0          │
└────────────────────────────────────────────────────┘
```

- **Manager Agent** — Persistent LLM running inside the TUI. Chats with you, creates/manages issues, spawns workers, reviews diffs, runs tests, merges results.
- **Worker Agents** — Claude Code CLI instances launched headlessly in git worktrees. Each works on a single issue in isolation.

## Install

```bash
git clone <repo-url>
cd novatree
npm install
npm run build
npm link
```

## Quick Start

```bash
# Initialize in any git repo
cd your-project
novatree init

# Configure your LLM endpoint
novatree config set llm.endpoints[0].url http://192.168.5.64:11434
novatree config set llm.model qwen2.5-coder-32b

# Launch the TUI
novatree
```

## CLI Commands

```bash
novatree                # Launch TUI
novatree init           # Initialize .novatree/ in current repo
novatree issue create "Add login form" --specs specs/auth.md --priority high
novatree issue list     # List all issues
novatree status         # Show project status
novatree config set <key> <value>
```

## Key Bindings

| Key | Action |
|-----|--------|
| `Tab` | Cycle focus between panels |
| `i` | Focus chat input |
| `Enter` | Send message |
| `↑/↓` | Navigate issue list |
| `d` | View diff for selected issue |
| `l` | View agent log for selected issue |
| `y` | Toggle yolo mode |
| `q` | Quit |

## Configuration

Edit `.novatree/config.json`:

```json
{
  "llm": {
    "endpoints": [
      {
        "name": "workstation",
        "url": "http://192.168.5.64:11434",
        "apiType": "anthropic",
        "weight": 3,
        "maxConcurrent": 2
      },
      {
        "name": "server",
        "url": "http://192.168.5.100:8080",
        "apiType": "anthropic",
        "weight": 1,
        "maxConcurrent": 1
      }
    ],
    "healthCheckIntervalMs": 30000,
    "contextSize": 81920,
    "model": "qwen2.5-coder-32b"
  },
  "manager": {
    "systemPromptFile": ".novatree/manager-system.md",
    "yoloMode": false
  },
  "worker": {
    "claudeCodePath": "claude",
    "maxConcurrent": 1,
    "testCommand": "npm test",
    "buildCommand": "npm run build"
  },
  "project": {
    "specsDir": "specs/",
    "mainBranch": "main"
  }
}
```

Multiple LLM endpoints are load-balanced with weighted round-robin and automatic health checking.

## Project Structure

```
your-project/
├── .novatree/              # GITIGNORED - local agent state
│   ├── config.json         # Endpoint config
│   ├── manager.md          # Manager's persistent knowledge
│   ├── manager-system.md   # Manager system prompt
│   ├── manager-history.jsonl
│   ├── issues/
│   │   ├── 001-login-form.md
│   │   └── 002-dark-mode.md
│   └── worktrees/
│       └── 001-login-form/ # Git worktree checkout
├── specs/                  # VERSION CONTROLLED - project specs
│   └── auth-flow.md
└── src/
```

`.novatree/` is fully gitignored — each developer runs `novatree init` to create their own. The `specs/` directory is the shared project bible, version-controlled and referenced by issues.

## How It Works

1. Describe a feature in the chat
2. Manager creates an issue with spec references
3. Manager creates a git worktree and spawns a Claude Code worker
4. Worker implements the feature, commits, and writes `ITHAVEBEENDONE` to the issue
5. Manager reviews the diff, runs tests, and merges to main
6. Worktree is cleaned up, issue is closed

## Tech Stack

| Component | Technology |
|-----------|-----------|
| Runtime | Node.js 20+ |
| Language | TypeScript (ESM) |
| TUI | React Ink 5 |
| LLM | Anthropic Messages API (compatible with llama.cpp/vLLM) |
| Workers | Claude Code CLI (headless) |
| Git | simple-git |
| Build | tsup |
