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

## Installation

Releases are self-contained tarballs (Node.js bundled) published to GitHub Releases. On a fresh machine only [mise](https://mise.jdx.dev) is required:

```bash
curl https://mise.run | sh
mise use -g github:ttungbmt/opsctl

ops --version
```

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

# Goals

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
ops package install <package>
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

# Technology Stack

```text
Language          TypeScript

CLI Framework     oclif

TUI
├── React
└── Ink

Validation        Zod

Process Execution execa

Testing           Vitest

Package Manager   pnpm

Workspace         pnpm workspace

Build             esbuild / tsup

Formatting /
Linting           Biome
```

Future supporting technologies may include:

```text
Structured logging
Configuration management
Plugin SDK
Workflow engine
MCP server
AI SDK integrations
```

---

# Architecture

Ops CLI follows a layered architecture.

```text
                    ┌──────────────┐
                    │     CLI      │
                    │    oclif     │
                    └──────┬───────┘
                           │
                    ┌──────▼───────┐
                    │     TUI      │
                    │ React + Ink  │
                    └──────┬───────┘
                           │
              ┌────────────▼────────────┐
              │     Application Core    │
              └────────────┬────────────┘
                           │
              ┌────────────▼────────────┐
              │         Domain          │
              └────────────┬────────────┘
                           │
          ┌────────────────┼────────────────┐
          │                │                │
     Providers         Workflows         Plugins
          │                │                │
          ▼                ▼                ▼
    External CLIs      Automation       Extensions
```

The CLI and TUI are presentation layers.

They should not contain business logic.

Both call the same application core.

---

# Core Principles

```text
Command != Business Logic

Feature != Provider

CLI != TUI

Tool != Workflow

Install != Setup

Human Output != Machine Output
```

For example:

```text
ops youtube audio
        │
        ▼
YouTubeAudio Feature
        │
        ├── yt-dlp provider
        └── ffmpeg provider
```

`youtube audio` is the feature.

`yt-dlp` and `ffmpeg` are implementation providers.

This allows underlying tools to change without changing the public command interface.

---

# Command Model

The planned command hierarchy is:

```text
ops
│
├── bootstrap
├── doctor
│
├── system
├── package
├── tool
├── setup
├── env
├── dotfiles
├── service
│
├── docker
├── git
├── github
│
├── ssh
├── server
├── cloud
│
├── youtube
├── media
│
├── workflow
├── profile
├── project
├── task
│
├── config
├── secret
├── history
├── backup
│
├── plugins
│
├── ai
├── agent
└── mcp
```

Not all commands are implemented yet.

---

# Global Flags

Commands should gradually converge on a consistent set of global flags.

```bash
--json

--quiet
--verbose
--debug

--yes
--force

--dry-run

--non-interactive

--profile <name>

--config <path>
```

Example:

```bash
ops package install docker \
  --yes \
  --json \
  --non-interactive
```

---

# Bootstrap

Bootstrap a machine using an environment profile.

```bash
ops bootstrap

ops bootstrap minimal
ops bootstrap developer
ops bootstrap workstation
ops bootstrap server
```

Planned bootstrap flow:

```text
Detect
↓
Inspect
↓
Plan
↓
Install
↓
Configure
↓
Verify
↓
Report
```

Example profiles:

```text
minimal
personal
developer
work
server
cloud
ai
full
```

---

# Package Management

Ops CLI provides a unified package interface.

```bash
ops package search docker

ops package install docker
ops package remove docker

ops package update
ops package upgrade

ops package list
ops package outdated
```

Possible providers:

```text
Windows
├── winget
├── Scoop
└── Chocolatey

macOS
└── Homebrew

Linux
├── apt
├── dnf
└── pacman
```

The user should normally not need to care which provider is used.

---

# Tool Management

A **tool** is a higher-level concept than a package.

```bash
ops tool list

ops tool install node

ops tool setup git

ops tool update terraform

ops tool status docker

ops tool doctor mise
```

Initial tool candidates:

```text
git
gh

mise

node
bun
pnpm

python
uv

go
rust

docker

terraform
kubectl
helm

jq
fzf
ripgrep

yt-dlp
ffmpeg

chezmoi
```

---

# Install vs Setup

Installation and configuration are intentionally separate concepts.

```bash
ops tool install git
```

means:

> Ensure Git exists.

While:

```bash
ops tool setup git
```

means:

> Configure Git according to the user's preferred environment.

For example:

```text
Install Git

        ↓

Configure username
Configure editor
Configure default branch
Configure aliases
Configure credentials
```

---

# System Management

```bash
ops system info

ops system status

ops system doctor

ops system update

ops system cleanup

ops system env

ops system path
```

Possible checks:

```text
Operating system
Architecture
CPU
Memory
Disk
Network
PATH
Environment variables
Permissions
Package managers
Installed tools
Services
```

---

# Doctor

`doctor` is intended to become one of the central Ops CLI capabilities.

```bash
ops doctor

ops doctor system

ops doctor docker

ops doctor dev

ops doctor cloud
```

Example:

```text
System Doctor

✓ Git                 2.52
✓ Docker              Running
✓ mise                Installed
! Node                Update available
✗ Terraform           Missing
✓ Network             Healthy
```

Future:

```bash
ops doctor --fix
```

---

# YouTube & Media

One of the first wrapper features planned for Ops CLI.

Instead of working directly with dozens of `yt-dlp` options:

```bash
ops youtube video <url>

ops youtube audio <url>

ops youtube playlist <url>

ops youtube subtitles <url>

ops youtube metadata <url>

ops youtube archive <url>
```

Example presets:

```bash
ops youtube video <url> --preset 1080p

ops youtube audio <url> --preset podcast
```

Providers:

```text
yt-dlp
ffmpeg
filesystem
metadata
```

Potential presets:

```text
best
1080p
720p
audio
podcast
mobile
archive
```

---

# Docker

Planned commands:

```bash
ops docker status

ops docker ps

ops docker logs <container>

ops docker restart <container>

ops docker cleanup

ops docker cleanup --safe

ops docker doctor
```

Ops CLI does not aim to replace Docker CLI.

It provides shortcuts and workflows for frequently repeated operations.

---

# Git & GitHub

Git:

```bash
ops git setup

ops git status

ops git sync

ops git cleanup

ops git branches
```

GitHub:

```bash
ops github auth

ops github repo list

ops github clone <repository>

ops github pr list

ops github issue list
```

Underlying tools may include:

```text
git
gh
```

---

# SSH & Servers

```bash
ops ssh list

ops ssh connect <server>

ops ssh test <server>

ops server list

ops server status <server>

ops server doctor <server>

ops server update <server>
```

Example server aliases:

```text
oracle
aws
homelab
work
personal
```

---

# Cloud

Ops CLI may provide higher-level workflows for:

```text
AWS
Oracle Cloud
Cloudflare
Google Cloud
Azure
```

Example:

```bash
ops cloud aws ec2 list

ops cloud oracle instances

ops cloud cloudflare dns list
```

Ops CLI is **not intended to replace native cloud CLIs**.

Instead, it wraps frequently used workflows behind simpler commands.

---

# Profiles

Profiles describe a desired environment.

```bash
ops profile list

ops profile show developer

ops profile apply developer
```

Example concept:

```yaml
developer:
  tools:
    - git
    - node
    - docker
    - terraform

  setup:
    - git
    - ssh
    - mise
```

Profiles can eventually power:

```bash
ops bootstrap developer
```

---

# Workflow Engine

Workflows combine multiple operations.

```bash
ops workflow list

ops workflow run bootstrap

ops workflow run backup

ops workflow run youtube-archive

ops workflow run deploy
```

A workflow may contain:

```text
steps
dependencies
conditions
timeouts
retries
parallel execution
verification
rollback
```

Typical lifecycle:

```text
Detect
↓
Install
↓
Configure
↓
Execute
↓
Verify
↓
Report
```

---

# Plan & Apply

Long-term, Ops CLI should support desired-state operations.

```bash
ops plan
```

Example:

```text
System Plan

✓ Git              installed
+ Docker           install
↑ Node             22 → 24
~ ~/.gitconfig     update
✓ SSH              configured

3 changes
```

Then:

```bash
ops apply
```

Core model:

```text
Inspect
↓
Compare
↓
Plan
↓
Apply
↓
Verify
```

Operations should be idempotent whenever possible.

Running:

```bash
ops apply
ops apply
ops apply
```

should converge toward the same desired state rather than repeatedly modifying the machine.

---

# TUI

Running:

```bash
ops
```

may eventually open the interactive TUI.

The TUI is built with:

```text
React
+
Ink
```

Potential screens:

```text
Dashboard

System

Software

Tools

Services

Docker

Servers

Cloud

Workflows

Plugins

Logs

Settings
```

Concept:

```text
┌ Ops ─────────────────────────────────────────┐
│                                              │
│ System          Tools          Services      │
│                                              │
│ ✓ Windows       ✓ Git          ✓ Docker      │
│ ✓ WSL           ✓ mise         ✓ SSH         │
│ ✓ Network       ! Node         ✗ Redis       │
│                                              │
├──────────────────────────────────────────────┤
│ Servers                                      │
│                                              │
│ ✓ Oracle                                     │
│ ✓ AWS                                        │
│                                              │
├──────────────────────────────────────────────┤
│ Recent Actions                               │
│                                              │
│ • Docker cleanup                             │
│ • Node upgraded                              │
│ • Dotfiles synchronized                      │
└──────────────────────────────────────────────┘
```

The TUI calls the application layer directly.

It should **not** invoke CLI commands internally.

```text
             Application Core

             ▲              ▲
             │              │

           oclif           Ink
            CLI             TUI
```

---

# Plugin Platform

One reason for choosing oclif is its plugin architecture.

Future commands:

```bash
ops plugins list

ops plugins install <plugin>

ops plugins update

ops plugins remove <plugin>
```

Potential packages:

```text
@ops/plugin-system

@ops/plugin-youtube

@ops/plugin-cloud

@ops/plugin-ai
```

Plugins may eventually provide:

```text
commands
hooks
providers
workflows
TUI extensions
```

---

# Providers

Providers adapt external applications and APIs into Ops capabilities.

Potential providers:

```text
providers/
├── winget
├── apt
├── brew
│
├── mise
├── chezmoi
│
├── git
├── github
│
├── docker
│
├── ytdlp
├── ffmpeg
│
├── terraform
├── kubectl
├── helm
│
├── aws
├── oci
└── cloudflare
```

Provider example:

```ts
interface ToolProvider {
  detect(): Promise<boolean>

  version(): Promise<string | null>

  install(): Promise<void>

  update(): Promise<void>

  remove(): Promise<void>

  doctor(): Promise<DoctorResult>
}
```

---

# Process Execution

External commands should be executed through a common abstraction.

Prefer:

```ts
execa("git", ["status"])
```

over:

```ts
exec("git status")
```

The execution layer should eventually support:

```text
stdout streaming
stderr streaming
structured output
timeouts
AbortSignal
retries
environment overrides
working directories
dry-run
privilege escalation
execution tracing
```

---

# Configuration

```bash
ops config get <key>

ops config set <key> <value>

ops config edit

ops config path

ops config reset
```

Configuration precedence:

```text
Defaults
↓
Global config
↓
Profile
↓
Project config
↓
Environment variables
↓
CLI flags
```

Example:

```yaml
profile: developer

defaults:
  editor: nvim

youtube:
  quality: 1080p

  subtitles:
    - vi
    - en
```

---

# Secrets

Ops CLI should never store sensitive credentials directly in ordinary plaintext configuration.

Potential providers:

```text
1Password
Bitwarden
Infisical
SOPS
OS Keychain
Environment Variables
Cloud Secret Managers
```

Possible commands:

```bash
ops secret get <name>

ops secret inject

ops secret doctor
```

---

# Human & Machine Interfaces

Human output:

```bash
ops doctor
```

```text
✓ Git
✓ Docker
! Node outdated
✗ Terraform missing
```

Machine output:

```bash
ops doctor --json
```

```json
{
  "success": true,
  "checks": [
    {
      "name": "git",
      "status": "healthy"
    },
    {
      "name": "terraform",
      "status": "missing"
    }
  ]
}
```

Every important operation should eventually support:

```bash
--json
--yes
--non-interactive
```

This is essential for scripting and agent integration.

---

# AI & Agent Integration

AI is a future layer, not the foundation of Ops CLI.

Potential commands:

```bash
ops ai ask "..."

ops ai diagnose docker

ops ai explain <file>

ops ai fix docker

ops agent run <task>
```

Preferred architecture:

```text
AI / Agent
    │
    ▼
Ops Application API
    │
    ▼
Providers
    │
    ▼
System / External Tools
```

Rather than:

```text
AI
 │
 ▼
Arbitrary shell access
```

This provides a safer and more deterministic automation boundary.

---

# MCP

Future capability:

```bash
ops mcp serve
```

Ops CLI could expose tools such as:

```text
system_info

system_doctor

install_tool

setup_tool

download_youtube

docker_status

server_list

run_workflow
```

This would allow coding agents and personal AI systems to use Ops CLI as a structured system-operation layer.

---

# Proposed Repository Structure

```text
opsctl/
│
├── apps/
│   └── cli/
│
├── packages/
│   ├── core/
│   ├── domain/
│   ├── config/
│   ├── executor/
│   ├── ui/
│   └── sdk/
│
├── providers/
│   ├── winget/
│   ├── apt/
│   ├── brew/
│   │
│   ├── mise/
│   ├── chezmoi/
│   │
│   ├── git/
│   ├── docker/
│   │
│   ├── ytdlp/
│   └── ffmpeg/
│
├── plugins/
│   ├── system/
│   ├── youtube/
│   ├── cloud/
│   └── ai/
│
├── profiles/
│
├── docs/
│
├── tests/
│
├── package.json
├── pnpm-workspace.yaml
├── tsconfig.json
└── README.md
```

The exact structure will evolve as the architecture becomes clearer.

---

# Naming Convention

Prefer resource-oriented commands:

```text
noun + verb
```

Examples:

```bash
ops tool install

ops service restart

ops profile apply

ops workflow run
```

Avoid inconsistent names such as:

```bash
ops install-tool

ops restart-service
```

Prefer stable public abstractions over exposing implementation details.

For example:

```bash
ops youtube audio <url>
```

is preferred over:

```bash
ops ytdlp audio <url>
```

because `yt-dlp` is an implementation detail.

---

# Safety

Ops CLI may eventually manage privileged system operations, so safety is a first-class requirement.

Destructive operations should generally follow:

```text
Inspect
↓
Plan
↓
Show Changes
↓
Confirm
↓
Execute
↓
Verify
```

Important safeguards:

```text
dry-run

explicit confirmation

safe defaults

secret redaction

privilege boundaries

command validation

plugin trust

checksums/signatures

audit history
```

Example:

```bash
ops docker cleanup --dry-run
```

before:

```bash
ops docker cleanup
```

---

# Development Roadmap

## v0.1 — Foundation

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

## v0.2 — Machine Bootstrap

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

## v0.3 — CLI Wrappers

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

## v0.4 — Automation

```text
workflow engine

plan/apply

idempotency

history

backup/restore
```

---

## v0.5 — TUI

```text
React + Ink

dashboard

tool management

system health

workflow execution

command palette
```

---

## v0.6 — Plugin Platform

```text
oclif plugins

plugin SDK

hooks

plugin discovery

plugin lifecycle
```

---

## v0.7 — Remote & Cloud

```text
SSH

servers

AWS

Oracle Cloud

Cloudflare
```

---

## v0.8+ — AI & Agents

```text
AI diagnostics

agent-friendly APIs

MCP server

natural-language workflows

AI-assisted troubleshooting
```

---

# MVP

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

---

# Long-Term Vision

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