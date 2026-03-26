# Arcti

**A powerful, recursive, and adaptive multi-agent orchestration system built with TypeScript and Bun.**

Arcti turns a single instruction into a complete tree of decomposed tasks, executed in parallel, verified, and synthesized automatically. It supports multiple LLM providers (local & cloud), a real-time dashboard, a persistent skill library, and much more.

> "Less, but better." — Dieter Rams inspired design


## ✨ Key Features

### Core Engine
- **Mother Agent** with **adaptive QCM** (QQOQCP) for smart requirement clarification
- **Recursive task decomposition** (sub-sub-sub-agents) down to atomic tasks
- **DAG Scheduler** for maximum parallel execution with dependency handling
- **Structured verification** + **intelligent retry** with enriched prompts and model escalation
- **3-tier model routing** with automatic escalation on failure
- **Persistent Skill Library** — auto-save, score (0-100), and reuse generated tools

### LLM Providers
- **Ollama** (local, auto-detects installed models)
- **Claude Code CLI** (uses your Claude subscription credits)
- Anthropic, OpenAI, Grok (xAI), OpenRouter
- **Per-project provider selection** + global settings

### Dashboard
- Real-time Dieter Rams-inspired interface (light & dark mode)
- Multi-project support with sidebar tabs
- Hierarchical task tree + parallel layout view
- Clickable task detail panel (output, reasoning, criteria, retry diff)
- Live LLM streaming
- Live preview (iframe for generated HTML/CSS/JS)
- Automatic artifact writing to project folder (`~/Projects/...`)
- Interactive feedback during execution
- Cost estimation, project export/import

### Extras
- Code sandbox (TS/JS/Python/Shell execution)
- Inter-project memory (learns patterns & preferences across runs)
- OS notifications
- Keyboard shortcuts
- Single binary build

## 🚀 Quick Start

### Prerequisites
- [Bun](https://bun.sh)
- Ollama (optional)
- Claude CLI (optional for subscription credits)

### Installation

```bash
git clone https://github.com/yourusername/arcti.git
cd arcti
bun install
```
## Configuration
Bashcp arcti.yaml.example arcti.yaml
### Edit arcti.yaml with your preferred providers and models
Main Commands
Bash# Check providers and available models
bun run src/index.ts check

# Run a task in CLI mode (interactive)
bun run src/index.ts run "Create a SaaS landing page for a coffee subscription"

# Start web server + real-time dashboard
bun run src/index.ts server
Dashboard available at http://localhost:3000/
Build single executable binary
Bashbun build --compile src/index.ts --outfile arcti
./arcti server

## Project Structure

```bash
src/
├── index.ts                 # CLI entry point
├── config.ts                # Multi-provider configuration
├── core/                    # Types, RunManager, Sandbox, Memory, etc.
├── agents/                  # Mother, Worker, Verifier, BaseAgent
├── llm/                     # Client, Router + all providers
├── orchestrator/            # Intake, Decomposer, Scheduler
├── tools/                   # Registry, Generator, SkillLibrary
├── server/                  # Hono API + WebSocket
└── web/                     # Dashboard (HTML + JS)

## How to Use the Dashboard

Left sidebar: Projects list + Skills library
Run button: Start new project (choose provider)
Folder field: Set output directory for artifacts
Click any task: Full details (output, criteria, retries, diff)
Stop button: Cancel running project
Settings (gear icon): Manage providers and per-tier models

## Future Roadmap

Enhanced Skill Library auto-selection
Visual DAG graph (flowchart)
Fully autonomous agent mode
Expanded unit tests
Continuous agent mode

## License
MIT

#### Arcti — Because a great agent doesn’t do everything alone. It orchestrates intelligently.
Built with ❤️ in Lima.
