<div align="center">

```
              ▄▄▄
            ▄█▀ ▀█▄

       ████  █   █   ███
       █     █   █  █   █
       ███   █   █  █   █
       █      █ █   █   █
       ████    █     ███

          ▀▀▀▀   ▀▀▀▀
```

<h3>evopi — a provider-agnostic, self-improving RLM coding agent</h3>

<p>
  <a href="packages/coding-agent/docs/index.md">Documentation</a> &bull;
  <a href="packages/coding-agent/docs/quickstart.md">Quickstart</a> &bull;
  <a href="packages/coding-agent/docs/providers.md">Providers</a>
</p>

<p>
  <a href="https://github.com/sunwoo95/oh-my-evopi/actions/workflows/release.yml">
    <img src="https://github.com/sunwoo95/oh-my-evopi/actions/workflows/release.yml/badge.svg" alt="Release" />
  </a>
  <a href="LICENSE">
    <img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT License" />
  </a>
</p>

</div>

evopi is an open-source coding and research agent CLI for general and long-running work. It connects to the model provider of *your* choice — subscription OAuth, API keys, cloud endpoints, or local servers — and is designed around two core abstractions:

- The **Recursive Language Model (RLM)** treats context as variables (*prompt-as-a-variable*) and tools like recursive subagents as function calls (*programmatic tool / sub-agent calling*) inside a persistent Python REPL.
- The **Continual Harness** stores supplemental prompts, memories, skill descriptions, and reusable subagent specifications as durable state that evopi can refine through small, evidence-backed updates, local to the session by default.

evopi combines a persistent Python control environment with durable harness state, so useful working context and reusable operating patterns can outlive a single chat window.

- **Everything is programmatic:** a persistent Python REPL is the built-in model tool; file operations, shell commands, tool use, subagents, and context management happen through code.
- **Subagents are built in:** `rlm(...)` spawns real child agents for parallel or background work and returns their results programmatically.
- **The harness can improve:** `/refine` reviews the current trajectory and can apply small, evidence-backed updates to supplemental harness state. It never rewrites the immutable base system prompt, and recorded snapshots support rollback.
- **Skills are executable:** skills are importable Python packages, and the built-in skill creator can turn recurring workflows into project or personal skills.
- **Sessions run in the background:** daemon-backed agents keep running when the terminal disconnects and can be reattached later.
- **Agents communicate directly:** running agents can exchange messages and orchestrate one another without routing everything through the user.
- **Long tasks keep moving:** automatic compaction, persistent goals, heartbeats, schedules, autonomous mode, and retained subagents preserve progress across turns and terminal sessions.

## Getting Started

Install the latest stable release on macOS or Linux:

```bash
curl -fsSL https://sunwoo95.github.io/oh-my-evopi/install.sh | sh
```

The installer downloads a versioned release, verifies its SHA-256 checksum, installs the `evopi` command, and can prepare the Python runtime used by the agent.

Start evopi from the repository or directory you want it to work in:

```bash
cd /path/to/project
evopi
```

On first launch, run `/login` and pick any provider. evopi works in the current directory and can run commands and modify files there. Use a disposable clone, clean worktree, or another checkpoint you can inspect and restore.

> [!WARNING]
> evopi executes model-generated Python and project commands with your user permissions. Its worker and kernel processes improve lifecycle isolation and recovery; they are **not** a security sandbox. Review changes and use trusted repositories, instructions, skills, and extensions only. Run untrusted code or instructions in an external sandbox or restricted environment.

Useful commands:

```bash
evopi agents                   # Browse running, idle, and saved sessions
evopi attach <agent>           # Reattach to a running session
evopi --resume [path|id]       # Browse sessions or resume one directly
evopi status                   # Inspect background service state
evopi doctor [--fix]           # Inspect or repair background services
evopi update [--force]         # Update evopi
evopi shutdown [--force]       # Stop every agent, worker, and background service
```

All configuration and state live under a single `~/.evopi` directory.

## Bring Your Own Provider

evopi is not tied to any model vendor. `/login` offers every connection mode side by side, and no provider is forced, preselected, or pinned:

| Connection | Examples |
|---|---|
| Subscription OAuth | Anthropic (Claude Pro/Max), OpenAI Codex, GitHub Copilot |
| API keys (env var or `/login`) | Anthropic, OpenAI, Google, OpenRouter, DeepSeek, Groq, Mistral, xAI, ZAI, MiniMax, Cerebras, Hugging Face, Prime Inference, and more |
| Cloud endpoints | Amazon Bedrock, Google Vertex AI, Azure OpenAI, Databricks serving endpoints, Cloudflare AI Gateway / Workers AI, Vercel AI Gateway |
| Custom / local | Ollama, LM Studio, vLLM, or any OpenAI/Anthropic-compatible server via `models.json` or extensions |

Databricks is discovered live: `/login` → **Databricks** asks for the workspace URL and an access token, queries the workspace's serving-endpoints API, and registers every Claude endpoint it finds as a model. See [providers.md](packages/coding-agent/docs/providers.md) for the full setup guide and [models.md](packages/coding-agent/docs/models.md) for custom model definitions.

## Built for Long-Running Work

evopi is built for long-running work, especially for evaluations in research. These features are available in the TUI, and when run autonomously.

- **Continual Harness:** `/refine` can persist focused, reviewable lessons as supplemental prompts, memories, reusable skill descriptions, or subagent specifications, with recorded refinement history. It does not replace packaging and reviewing new executable skills.
- **Grounded self-improvement (evo layer):** an optional, evidence-gated refinement arm. When enabled (`EVOPI_EVO=on` or the `evo.enabled` setting), an external pass/fail signal file (`EVOPI_FEEDBACK_FILE`) gates refinement: non-failures are skipped, and failures inject grounded feedback into the refinement planner. Fully off by default — with the evo layer disabled, evopi behaves identically to its upstream baseline.
- **Direct agent-to-agent communication:** running agents and retained subagents can discover one another, exchange messages, and steer active work.
- **Daemon-backed continuity:** active sessions, Python REPL state, schedules, and subagents keep running when the terminal detaches and can be reattached later.
- **Heartbeats and schedules:** `/heartbeat`, `rlm_heartbeat`, and `evopi schedule` can re-enter a session periodically or at a specific time.
- **Persistent goals:** `/goal` keeps an objective and its progress active across turns until it is completed, paused, or cleared.
- **Bounded autonomous mode:** `/autonomous` continues within configured turn, token, and time budgets and can run user-defined quality gates. A passed gate checks only what that gate verifies; reaching a limit does not imply task success.

## Repository Layout

evopi is a TypeScript monorepo:

| Package | What it does |
|---|---|
| [`packages/coding-agent`](packages/coding-agent) | The `evopi` CLI: TUI, sessions, Python REPL kernel, skills, extensions |
| [`packages/ai`](packages/ai) | Unified LLM API: model catalog, provider dialects, OAuth, streaming |
| [`packages/agent`](packages/agent) | Agent core: transport abstraction, state management, attachment |
| [`packages/tui`](packages/tui) | Terminal UI library with differential rendering |
| [`packages/hashline`](packages/hashline) | Compact line-anchored patch language and applier |
| [`packages/mnemopi`](packages/mnemopi) | Memory kernels: MMR rerank, vector index, cosine clustering |
| [`packages/natives-loader`](packages/natives-loader) | Loader for prebuilt native modules with pure-JS fallback |

## Documentation

- [Quickstart](packages/coding-agent/docs/quickstart.md) — install, authenticate, and run a first session
- [Usage and CLI reference](packages/coding-agent/docs/usage.md) — commands, sessions, autonomous limits, and output modes
- [Provider setup](packages/coding-agent/docs/providers.md) — subscriptions, API keys, cloud endpoints, and custom providers
- [Long-running and background agents](packages/coding-agent/docs/long-running-agents.md) — detach and reattach, goals, heartbeats, and schedules
- [RLM programming model](packages/coding-agent/docs/rlm.md) — the persistent Python REPL, subagents, skills, and the trust model
- [JSON mode](packages/coding-agent/docs/json.md) and [RPC mode](packages/coding-agent/docs/rpc.md) — headless automation and integrations
- [Skills](packages/coding-agent/docs/skills.md) — install and create reusable capabilities
- [Architecture overview](packages/coding-agent/docs/architecture.md) — daemon, worker, kernel, and persistence boundaries
- [Development](packages/coding-agent/docs/development.md) — build and run from source

## Contributing

Open an [issue](https://github.com/sunwoo95/oh-my-evopi/issues) for bug reports and feature requests, or send a pull request. Read the [contribution guidelines](CONTRIBUTING.md) for the full process, and report security vulnerabilities privately by following the [security policy](SECURITY.md).

## Lineage and Acknowledgements

evopi stands on three upstreams:

- **[prime-agent](https://github.com/PrimeIntellect-ai/prime-agent)** (Prime Intellect) provides the skeleton: the RLM harness, Python REPL kernel, daemon runtime, continual-harness design, and the provider/OAuth connectivity layer. evopi is a hard fork; Prime Inference remains available as one peer provider among many.
- **[oh-my-pi](https://github.com/can1357/oh-my-pi)** contributes selected TypeScript assets, ported and adapted for Node: the hashline anchor-based patch engine (the optional `hashline_edit` tool), prebuilt native bindings with pure-JS fallbacks, memory kernels, credential-pool rotation, open-model tool-call dialect parsers, prompt-engineering skill guides, and the evaluation metaharness.
- **[pi](https://github.com/earendil-works/pi)** (earendil-works) is the original agent and TUI foundation both upstreams build on. The pi-era extension, skill, package, and theme surfaces remain compatible.

The evo layer implements the grounded-feedback delta from **EVO-HARNESS: Context-to-Harness Skill Compilation for Self-Evolving Agents** ([arXiv 2608.15071](https://arxiv.org/abs/2608.15071)): an external verification signal gates and grounds harness refinement while the solver model stays frozen.

If you use this codebase in your research, please cite the Prime Agent paper that describes the underlying harness:

```bibtex
@article{karten2026prime,
  title={Prime Agent: A Self-Improving RLM Harness},
  author={Karten, Seth and Zhang, Alex L. and Thomas, Kevin and Müller, Sebastian and Bakouch, Elie and Auras, Daniel and Senghaas, Mika and Obeid, Fares and Dunas, Konstantin and Hagemann, Johannes and Jaghouar, Sami},
  journal={arXiv preprint arXiv:2608.23552},
  year={2026}
}
```

## License

evopi is fully open source and released under the [MIT License](LICENSE).
