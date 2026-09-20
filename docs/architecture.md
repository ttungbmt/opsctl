# Architecture

> Part of the [Ops CLI](../README.md) docs.

## Technology Stack

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

## Architecture

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

## Core Principles

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

## Providers

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

  setup(): Promise<void>

  update(): Promise<void>

  remove(): Promise<void>

  doctor(): Promise<DoctorResult>
}
```

`setup` ships today as config data (`tool.<name>.setup`) run by
`src/core/tool/setup.ts`, not as a provider method; the interface is the target
shape.

---

## Process Execution

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

## Configuration

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

> Today only two of these layers exist: the built-in `config/defaults.yaml` is
> overlaid by `~/.config/ops/config.yaml` (relocatable with `$OPS_CONFIG`).
> Profiles, project-local config and per-key environment overrides are planned.

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

## Secrets

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

## Human & Machine Interfaces

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

## Naming Convention

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

## Safety

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

## Proposed Repository Structure

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
