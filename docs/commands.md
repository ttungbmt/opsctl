# Commands

> Part of the [Ops CLI](../README.md) docs. Planned command surface — most commands are not implemented yet.

## Command Model

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

## Global Flags

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

## Bootstrap

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

## Package Management

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

## Tool Management

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

## Install vs Setup

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

## System Management

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

## Doctor

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

## YouTube & Media

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

## Docker

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

## Git & GitHub

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

## SSH & Servers

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

## Cloud

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

## Profiles

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

## Workflow Engine

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

## Plan & Apply

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

## TUI

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

## Plugin Platform

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

## Configuration

```bash
ops config get <key>

ops config set <key> <value>

ops config edit

ops config path

ops config reset
```

Precedence and file format: see [Architecture → Configuration](architecture.md#configuration).

---

## AI & Agent Integration

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

## MCP

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
