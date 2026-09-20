# Vision

> Part of the [Ops CLI](../README.md) docs.

## Why Ops CLI?

Modern development environments depend on many different tools:

```text
winget
apt
brew

mise
chezmoi

git
gh

docker

yt-dlp
ffmpeg

terraform
kubectl
helm

aws
oci
cloudflared
wrangler

...
```

Each tool has:

- different commands
- different configuration formats
- different installation methods
- different conventions
- dozens or hundreds of flags

Ops CLI creates a unified abstraction over them.

For example, instead of remembering:

```bash
yt-dlp \
  --extract-audio \
  --audio-format mp3 \
  --embed-thumbnail \
  --embed-metadata \
  --write-info-json \
  <url>
```

use:

```bash
ops youtube audio <url>
```

Ops CLI keeps the underlying tools powerful while making common workflows simple and repeatable.

---

## Goals

Ops CLI is designed around several core goals.

### Bootstrap a new machine

Turn a fresh machine into a ready-to-use environment:

```bash
ops bootstrap developer
```

Potentially configuring:

```text
package manager
↓
development tools
↓
shell
↓
Git
↓
SSH
↓
dotfiles
↓
Docker
↓
cloud tools
↓
verification
```

---

### Simplify complex tools

Wrap frequently used tools behind opinionated, memorable commands.

```bash
ops youtube audio <url>

ops docker cleanup --safe

ops git sync

ops server doctor production
```

---

### Provide one consistent interface

Instead of:

```bash
apt install ...
winget install ...
brew install ...
```

use:

```bash
ops tool install <tool>
```

Ops CLI detects the platform and selects the appropriate provider.

---

### Automate repeatable workflows

Compose multiple tools into higher-level workflows:

```bash
ops workflow run new-machine
ops workflow run backup
ops workflow run youtube-archive
ops workflow run deploy
```

---

### Work equally well for humans and agents

Interactive usage:

```bash
ops tool install docker
```

Automation:

```bash
ops tool install docker \
  --yes \
  --json \
  --non-interactive
```

The same capabilities should be usable by:

```text
Humans
Shell scripts
CI/CD
Claude Code
Codex CLI
Gemini CLI
n8n
AI agents
MCP clients
```

---

## Personal Ops Platform

The long-term goal is to evolve Ops CLI from a simple automation CLI into a **Personal Ops Platform** with:

```text
CLI
↓
Tool Manager
↓
System Automation
↓
Workflow Engine
↓
TUI Control Center
↓
Plugin Platform
↓
AI / Agent Interface
```

---

## Long-Term Vision

Ops CLI starts as:

```text
Bootstrap Tool
```

then evolves into:

```text
Bootstrap Tool
      ↓
Tool Manager
      ↓
CLI Orchestrator
      ↓
Workflow Engine
      ↓
TUI Control Center
      ↓
Plugin Platform
      ↓
AI-powered Personal Ops
```

The ultimate goal is simple:

> **One command layer for your machines, tools, and workflows.**

Or, in practice:

```bash
ops
```

should eventually be the first command needed after setting up a new machine — and the main command used to operate it afterward.
