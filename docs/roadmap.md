# Roadmap

> Part of the [Ops CLI](../README.md) docs.

## Development Roadmap

### v0.1 — Foundation

```text
oclif foundation

configuration

process executor

structured output

doctor

basic tests
```

Target commands:

```bash
ops version

ops doctor

ops config get

ops config set
```

---

### v0.2 — Machine Bootstrap

```text
OS detection

package abstraction

tool abstraction

bootstrap

profiles
```

Target:

```bash
ops bootstrap developer

ops package install

ops tool install

ops tool setup
```

---

### v0.3 — CLI Wrappers

First opinionated integrations:

```text
yt-dlp

ffmpeg

Docker

Git

GitHub CLI
```

Target:

```bash
ops youtube video

ops youtube audio

ops docker cleanup

ops git sync
```

---

### v0.4 — Automation

```text
workflow engine

plan/apply

idempotency

history

backup/restore
```

---

### v0.5 — TUI

```text
React + Ink

dashboard

tool management

system health

workflow execution

command palette
```

---

### v0.6 — Plugin Platform

```text
oclif plugins

plugin SDK

hooks

plugin discovery

plugin lifecycle
```

---

### v0.7 — Remote & Cloud

```text
SSH

servers

AWS

Oracle Cloud

Cloudflare
```

---

### v0.8+ — AI & Agents

```text
AI diagnostics

agent-friendly APIs

MCP server

natural-language workflows

AI-assisted troubleshooting
```

---

## MVP

The initial version intentionally stays small.

First milestone:

```text
Core CLI

Config

Executor

Doctor

Package abstraction

Tool abstraction

Bootstrap

yt-dlp wrapper
```

Target commands:

```bash
ops version

ops doctor

ops bootstrap

ops package install <package>

ops tool install <tool>

ops tool setup <tool>

ops tool doctor <tool>

ops youtube video <url>

ops youtube audio <url>

ops config get <key>

ops config set <key> <value>
```

Everything else should grow from this foundation.
