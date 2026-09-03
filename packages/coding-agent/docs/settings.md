# Settings

evopi uses JSON settings files with project settings overriding global settings.

| Location | Scope |
|----------|-------|
| `~/.evopi/agent/settings.json` | Global (all projects) |
| `.evopi/agent/settings.json` | Project (current directory) |

Edit directly or use `/settings` for common options.

## All Settings

### Model & Thinking

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `defaultProvider` | string | - | Default provider (e.g., `"anthropic"`, `"openai"`) |
| `defaultModel` | string | - | Default model ID |
| `defaultThinkingLevel` | string | `"xhigh"` | `"off"`, `"minimal"`, `"low"`, `"medium"`, `"high"`, `"xhigh"`, `"max"` |
| `hideThinkingBlock` | boolean | `false` | Hide thinking blocks in output |
| `thinkingBudgets` | object | - | Custom token budgets per thinking level |

#### thinkingBudgets

```json
{
  "thinkingBudgets": {
    "minimal": 1024,
    "low": 4096,
    "medium": 10240,
    "high": 32768
  }
}
```

### UI & Display

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `theme` | string | `"dark"` | Theme name (`"dark"`, `"light"`, or custom) |
| `quietStartup` | boolean | `false` | Hide startup header |
| `collapseChangelog` | boolean | `false` | Show condensed changelog after updates |
| `treeFilterMode` | string | `"user-only"` | Default filter for `/tree`: `"default"`, `"no-tools"`, `"user-only"`, `"labeled-only"`, `"all"` |
| `editorPaddingX` | number | `0` | Horizontal padding for input editor (0-3) |
| `autocompleteMaxVisible` | number | `5` | Max visible items in autocomplete dropdown (3-20) |
| `showHardwareCursor` | boolean | `false` | Show terminal cursor |

### Update Checks

Stable builds fetch the release manifest at `https://pub-728493de92a943e2a9b2d17b4719f318.r2.dev/latest.json`. Beta builds fetch `beta.json` and continue following beta updates. Override the base URL with `EVOPI_DOWNLOAD_BASE_URL`.

Set `PI_SKIP_VERSION_CHECK=1` to disable the evopi version update check. Use `--offline` or `PI_OFFLINE=1` to disable startup network operations, including update checks and package update checks.

The stable `latest.json` and beta `beta.json` manifests use the same JSON shape:

```json
{
  "version": "0.73.1",
  "package": "evopi",
  "tarball": "releases/v0.73.1/evopi-0.73.1.tgz"
}
```

`version` is required. `package` is optional and may also be named `packageName`; it defaults to the current package name. `tarball` is optional; when present, evopi installs that tarball instead of the package name. Relative tarball paths resolve against `EVOPI_DOWNLOAD_BASE_URL`.

### Pseudonymous usage analytics

evopi sends pseudonymous, aggregate usage and performance events to Prime Intellect. These events include version and operating-system category, onboarding outcome and duration, execution mode (`interactive`, `print`, `json`, `rpc`, or `acp`), run outcomes, TTFT and latency, prompt and turn counts, token usage, tool success counts, retries, and compactions.

evopi does not send prompts, responses, thinking, tool arguments or results, command text, filenames, paths, repository information, environment variables, credentials, raw error messages, hostnames, usernames, emails, or hardware identifiers. A random installation ID is stored as `telemetry.json` in the configured agent directory (normally `~/.evopi/agent/`).

Telemetry can be disabled globally or for an individual project. Project settings can only further restrict telemetry: they cannot re-enable a global opt-out or suppress the global one-time disclosure.

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `telemetry.enabled` | boolean | `true` | Send pseudonymous aggregate usage and performance events |

Disable analytics with any of:

```json
{
  "telemetry": {
    "enabled": false
  }
}
```

```bash
EVOPI_TELEMETRY=0 evopi
DO_NOT_TRACK=1 evopi
evopi --offline
```

`EVOPI_TELEMETRY_ENDPOINT` overrides the ingestion endpoint for development and self-hosted deployments.

### Warnings

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `warnings.anthropicExtraUsage` | boolean | `true` | Show a warning when Anthropic subscription auth may use paid extra usage |

```json
{
  "warnings": {
    "anthropicExtraUsage": false
  }
}
```

### Kernel (Python REPL)

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `kernel.cellTimeoutMs` | number | `1800000` (30 min) | Wall-clock cap per `ipython` cell. On expiry the kernel is interrupted; a cell that ignores the interrupt (e.g. `SIG_IGN`) gets its kernel discarded and the next cell boots a fresh one restored from the last snapshot. `0` disables the cap. |
| `kernel.envPolicy` | `"denylist"` \| `"allowlist"` | `"denylist"` | How the host environment is filtered before the kernel subprocess is spawned. `denylist` withholds only evopi's own provider credentials (see `EVOPI_KERNEL_INHERIT_SECRETS`). `allowlist` passes only a fixed safe set — `PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`, `PWD`, `TZ`, `LANG`, `LANGUAGE`, `LC_*`, `TERM`, `COLORTERM`, `TMPDIR`/`TMP`/`TEMP`, `XDG_*`, `EVOPI_*` (minus `EVOPI_API_KEY_POOL_*`), `VIRTUAL_ENV`, `PYTHON*`, `UV_*`, `PIP_*`, CA bundles (`NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`, `SSL_CERT_DIR`, `REQUESTS_CA_BUNDLE`, `CURL_CA_BUNDLE`), `HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY` (either case) — plus `kernel.envAllow`, so unknown `*_API_KEY`/`*_TOKEN` variables never reach model-authored code. Provider credentials stay withheld in both modes unless `EVOPI_KERNEL_INHERIT_SECRETS=1`. Withheld names are listed in the kernel diagnostics tail (capped at 12, then `+N more`). |
| `kernel.envAllow` | string[] | `[]` | Extra environment names passed in `allowlist` mode, e.g. `["SERPER_API_KEY", "MYCO_*"]`. A trailing `*` matches a prefix. Ignored under `denylist`. |

```json
{
  "kernel": {
    "envPolicy": "allowlist",
    "envAllow": ["SERPER_API_KEY", "GH_TOKEN", "MYCO_*"]
  }
}
```

Related environment variables (override settings):

| Variable | Effect |
|----------|--------|
| `EVOPI_KERNEL_CELL_TIMEOUT_MS` | Per-cell cap in ms; `0` or `off` disables. Beats `kernel.cellTimeoutMs`. |
| `EVOPI_KERNEL_INHERIT_SECRETS` | `1` passes the host's LLM-provider credentials (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `EVOPI_API_KEY_POOL_*`, …) into the kernel. By default they are withheld — model-authored code and everything `bash()` spawns cannot read them. Project-facing credentials (`GH_TOKEN`, AWS IAM/profile, `GOOGLE_APPLICATION_CREDENTIALS`, `SERPER_API_KEY`) are always inherited under the default `denylist` policy. |
| `EVOPI_KERNEL_ENV_POLICY` | `allowlist` or `denylist`. Beats `kernel.envPolicy`. |

### Permission gate

The intent-layer gate inspects `bash` commands and `ipython` cells that reach a shell (`bash(...)`, `!cmd`, `os.system`/`subprocess`) for destructive patterns, and modifications of protected paths (`.env`, `.git/`, `~/.ssh`, key files, …). Recursive `rm` is judged per target: `rm -rf ./dist`, `rm -rf node_modules`, `cd build && rm -rf out` and absolute paths under the session cwd pass; `/`, `~`/`$HOME`, a bare `*` or `/*`, `..` traversal that leaves the cwd, and absolute paths outside the cwd are flagged (`--no-preserve-root` and `sudo` always are).

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `permissionGate.mode` | `"block"` \| `"warn"` \| `"off"` | `"block"` | `block` prompts in the TUI and refuses when there is no UI; `warn` only notifies; `off` disables the gate (unattended eval). |
| `permissionGate.allow` | string[] | `[]` | Regex sources (JavaScript syntax). A command matching any of them bypasses the gate entirely. Invalid entries are ignored with a one-time warning. Project `.evopi/agent/settings.json` replaces (does not append to) the global list. |

```json
{
  "permissionGate": {
    "allow": ["^rm -rf /scratch/", "^docker system prune"]
  }
}
```

Every gate decision (`allowed-by-whitelist`, `warned`, `blocked`, `confirmed-by-user`, `denied-by-user`) is appended to the session log as a `permission_gate` entry with the hazard kind, tool name, mode and the first 16 hex characters of the command's SHA-256 — never the command text.

| Variable | Effect |
|----------|--------|
| `EVOPI_PERMISSION_GATE` | `block`, `warn`, or `off`. Beats `permissionGate.mode`. |

### Compaction

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `compaction.enabled` | boolean | `true` | Enable auto-compaction |
| `compaction.reserveTokens` | number | `16384` | Tokens reserved for LLM response |
| `compaction.keepRecentTokens` | number | `20000` | Recent tokens to keep (not summarized) |

```json
{
  "compaction": {
    "enabled": true,
    "reserveTokens": 16384,
    "keepRecentTokens": 20000
  }
}
```

### Branch Summary

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `branchSummary.reserveTokens` | number | `16384` | Tokens reserved for branch summarization |
| `branchSummary.skipPrompt` | boolean | `false` | Skip "Summarize branch?" prompt on `/tree` navigation (defaults to no summary) |

### Retry

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `retry.enabled` | boolean | `true` | Enable automatic agent-level retry on transient errors |
| `retry.maxRetries` | number | `3` | Maximum agent-level retry attempts |
| `retry.baseDelayMs` | number | `2000` | Base delay for agent-level exponential backoff (2s, 4s, 8s) |
| `retry.provider.timeoutMs` | number | SDK default | Provider/SDK request timeout in milliseconds |
| `retry.provider.maxRetries` | number | SDK default | Provider/SDK retry attempts |
| `retry.provider.maxRetryDelayMs` | number | `60000` | Max server-requested delay before failing (60s) |

When a provider requests a retry delay longer than `retry.provider.maxRetryDelayMs` (e.g., Google's "quota will reset after 5h"), the request fails immediately with an informative error instead of waiting silently. Set to `0` to disable the cap.

```json
{
  "retry": {
    "enabled": true,
    "maxRetries": 3,
    "baseDelayMs": 2000,
    "provider": {
      "timeoutMs": 3600000,
      "maxRetries": 0,
      "maxRetryDelayMs": 60000
    }
  }
}
```

### Message Delivery

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `steeringMode` | string | `"one-at-a-time"` | How steering messages are sent: `"all"` or `"one-at-a-time"` |
| `followUpMode` | string | `"one-at-a-time"` | How follow-up messages are sent: `"all"` or `"one-at-a-time"` |
| `transport` | string | `"sse"` | Preferred transport for providers that support multiple transports: `"sse"`, `"websocket"`, or `"auto"` |

### Terminal & Images

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `terminal.showImages` | boolean | `true` | Show image type and dimensions in terminal |
| `terminal.clearOnShrink` | boolean | `false` | Clear empty rows when content shrinks (can cause flicker) |
| `images.autoResize` | boolean | `true` | Resize images to 2000x2000 max |
| `images.blockImages` | boolean | `false` | Block all images from being sent to LLM |

### Shell

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `shellPath` | string | - | Custom shell path (e.g., for Cygwin on Windows) |
| `shellCommandPrefix` | string | - | Prefix for every bash command (e.g., `"shopt -s expand_aliases"`) |
| `npmCommand` | string[] | - | Command argv used for npm package lookup/install operations (e.g., `["mise", "exec", "node@20", "--", "npm"]`) |

```json
{
  "npmCommand": ["mise", "exec", "node@20", "--", "npm"]
}
```

`npmCommand` is used for all npm package-manager operations, including installs, uninstalls, and dependency installs inside git packages. Use argv-style entries exactly as the process should be launched. When `npmCommand` is configured, git package dependency installs use plain `install` to avoid npm-specific flags in wrappers or alternate package managers.

Normally the package manager's global modules location is queried using `root -g`. As a special case, if the first element of `npmCommand` is `"bun"`, the modules location will instead be queried with `pm bin -g`.

### Daemon

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `idleEvictionMinutes` | number or `"off"` | `90` | Idle threshold in minutes for whole-tree worker eviction and individual idle-child passivation; `"off"` disables both. |

`idleEvictionMinutes` is a global daemon policy and is read only from `~/.evopi/agent/settings.json`. Set it to a positive number to configure the idle threshold.

### Sessions

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `sessionDir` | string | - | Directory where session files are stored. Accepts absolute or relative paths, plus `~`. |

```json
{ "sessionDir": ".evopi/agent/sessions" }
```

When multiple sources specify a session directory, precedence is `--session-dir`, `EVOPI_SESSION_DIR`, the legacy `EVOPI_CODING_AGENT_SESSION_DIR`, then `sessionDir` in `settings.json`.

### Model Cycling

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `enabledModels` | string[] | - | Model patterns for Ctrl+P cycling (same format as `--models` CLI flag) |

```json
{
  "enabledModels": ["claude-*", "gpt-4o", "gemini-2*"]
}
```

### Markdown

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `markdown.codeBlockIndent` | string | `"  "` | Indentation for code blocks |

### Resources

These settings define where to load extensions, skills, prompts, and themes from.

Paths in `~/.evopi/agent/settings.json` resolve relative to `~/.evopi/agent`. Paths in `.evopi/agent/settings.json` resolve relative to `.evopi/agent`. Absolute paths and `~` are supported.

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `packages` | array | `[]` | npm/git packages to load resources from |
| `extensions` | string[] | `[]` | Local extension file paths or directories |
| `skills` | string[] | `[]` | Local skill file paths or directories |
| `prompts` | string[] | `[]` | Local prompt template paths or directories |
| `themes` | string[] | `[]` | Local theme file paths or directories |
| `enableSkillCommands` | boolean | `true` | Register skills as `/skill:name` commands |
| `enableBuiltinSkills` | boolean | `true` | Load built-in skills shipped with evopi |
| `bundledSkills.websearch` | boolean | `true` | Load the built-in `websearch` skill |

Arrays support glob patterns and exclusions. Use `!pattern` to exclude. Use `+path` to force-include an exact path and `-path` to force-exclude an exact path.

Disable the built-in `websearch` skill while keeping normal skill discovery enabled:

```json
{
  "bundledSkills": {
    "websearch": false
  }
}
```

#### packages

String form loads all resources from a package:

```json
{
  "packages": ["pi-skills", "@org/my-extension"]
}
```

Object form filters which resources to load:

```json
{
  "packages": [
    {
      "source": "pi-skills",
      "skills": ["brave-search", "transcribe"],
      "extensions": []
    }
  ]
}
```

See [packages.md](packages.md) for package management details.

## Example

```json
{
  "defaultProvider": "anthropic",
  "defaultModel": "claude-sonnet-4-20250514",
  "defaultThinkingLevel": "xhigh",
  "theme": "dark",
  "compaction": {
    "enabled": true,
    "reserveTokens": 16384,
    "keepRecentTokens": 20000
  },
  "retry": {
    "enabled": true,
    "maxRetries": 3
  },
  "enabledModels": ["claude-*", "gpt-4o"],
  "warnings": {
    "anthropicExtraUsage": true
  },
  "packages": ["pi-skills"]
}
```

## Project Overrides

Project settings (`.evopi/agent/settings.json`) override global settings. Nested objects are merged:

```json
// ~/.evopi/agent/settings.json (global)
{
  "theme": "dark",
  "compaction": { "enabled": true, "reserveTokens": 16384 }
}

// .evopi/agent/settings.json (project)
{
  "compaction": { "reserveTokens": 8192 }
}

// Result
{
  "theme": "dark",
  "compaction": { "enabled": true, "reserveTokens": 8192 }
}
```
