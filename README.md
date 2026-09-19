# Ops CLI

> **One command layer for your machines, tools, and workflows.**

**Ops CLI** is an opinionated, extensible command-line platform for bootstrapping machines, installing and configuring tools, simplifying complex CLIs, and composing repeatable automation workflows.

Instead of remembering dozens of commands, flags, configuration files, and setup steps, Ops CLI provides a consistent interface:

```bash
ops bootstrap
ops doctor

ops tool install docker
ops tool setup git

ops youtube audio <url>

ops docker cleanup

ops workflow run backup
```

> **Status:** early scaffolding. Only `ops --version` works so far — everything below describes the planned design. See the [roadmap](docs/roadmap.md).

## Installation

Releases are self-contained tarballs (Node.js bundled) published to GitHub Releases. On a fresh machine only [mise](https://mise.jdx.dev) is required:

```bash
curl https://mise.run | sh
mise use -g github:ttungbmt/opsctl

ops --version
```

If mise's `minimum_release_age` hides a fresh release, pin it explicitly: `mise use -g github:ttungbmt/opsctl@0.1.0`.

Update:

```bash
mise up github:ttungbmt/opsctl
```

Development install (runs straight from a local checkout):

```bash
git clone https://github.com/ttungbmt/opsctl && cd opsctl
mise install
pnpm install
pnpm link:global   # symlinks ~/.local/bin/ops → apps/cli/bin/run.js
```

## Why Ops CLI?

Modern environments depend on dozens of tools (package managers, mise, chezmoi, git, docker, yt-dlp, cloud CLIs…), each with its own commands, config formats, and flags. Ops CLI creates a unified abstraction over them.

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

More in [Vision](docs/vision.md).

## Core Principles

```text
Command != Business Logic
Feature != Provider
CLI != TUI
Tool != Workflow
Install != Setup
Human Output != Machine Output
```

Details in [Architecture](docs/architecture.md#core-principles).

## Documentation

| Doc | Contents |
| --- | --- |
| [Vision](docs/vision.md) | Why Ops CLI, goals, long-term vision |
| [Architecture](docs/architecture.md) | Stack, layers, principles, providers, process execution, configuration, secrets, output modes, naming, safety, repo structure |
| [Commands](docs/commands.md) | Command model, global flags, and every planned command group |
| [Roadmap](docs/roadmap.md) | v0.1 → v0.8+ milestones and MVP scope |
| [Features](docs/features.md) | Full planned feature list |
| [Cheatsheet](docs/cheatsheet.md) | Condensed stack, rules, and development order |
