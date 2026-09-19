## Cheatsheet

# Ops CLI Cheatsheet

> **One command layer for your machines, tools, and workflows.**

## 1. Stack

```text
Language        TypeScript
CLI Framework   oclif
TUI             React + Ink
Validation      Zod
Process         execa
Config          cosmiconfig / custom config layer
Logging         consola / structured logger
Testing         Vitest
Package Manager pnpm
Build           tsup / esbuild
Monorepo        pnpm workspace
```

---

## 2. Core Principles

```text
Command != Business Logic
Feature != Provider
CLI != TUI
Human Output != Machine Output
Install != Setup
Tool != Workflow
```

Architecture:

```text
CLI / TUI
   ↓
Application
   ↓
Domain
   ↓
Providers
   ↓
External Tools / OS / APIs
```

Example:

```text
ops youtube audio
        ↓
YouTubeAudioUseCase
        ↓
yt-dlp provider
+
ffmpeg provider
```

---

## 3. Main Command Structure

```bash
ops
├── bootstrap
├── doctor
├── system
├── package
├── tool
├── setup
├── env
├── service
├── docker
├── git
├── github
├── ssh
├── server
├── cloud
├── youtube
├── media
├── workflow
├── profile
├── project
├── task
├── config
├── secret
├── plugin
├── history
├── backup
├── ai
└── tui
```

---

## 4. Global Flags

```bash
--help
--version

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

Rule:

```text
Human
→ pretty output

Script / Agent
→ --json --non-interactive
```

---

# 5. Bootstrap

```bash
ops bootstrap

ops bootstrap workstation
ops bootstrap developer
ops bootstrap server
ops bootstrap minimal
```

Profiles:

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

Expected flow:

```text
Detect
→ Check
→ Install
→ Configure
→ Verify
→ Report
```

---

# 6. System

```bash
ops system info
ops system status

ops system doctor
ops system update
ops system cleanup

ops system env
ops system path
```

Examples:

```bash
ops system doctor

ops system doctor --json

ops system cleanup --dry-run
```

---

# 7. Packages

Unified abstraction:

```text
Windows → winget
macOS   → brew
Debian  → apt
Fedora  → dnf
Arch    → pacman
```

Commands:

```bash
ops package search docker

ops package install docker
ops package remove docker

ops package update
ops package upgrade

ops package list
ops package outdated
```

Do not expose package manager unless needed:

```bash
ops package install docker
```

instead of:

```bash
winget install ...
apt install ...
brew install ...
```

---

# 8. Tools

Tools are higher-level than packages.

```bash
ops tool list

ops tool install node
ops tool install terraform

ops tool update node

ops tool status docker

ops tool doctor git
```

Initial providers:

```text
git
gh
mise

node
python
go
rust
bun
pnpm

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

# 9. Setup

Install:

```bash
ops tool install git
```

Configure:

```bash
ops setup git
```

Examples:

```bash
ops setup git
ops setup ssh
ops setup mise
ops setup docker
ops setup shell
```

Rule:

```text
install
→ software exists

setup
→ software behaves the way I want
```

---

# 10. Environment

```bash
ops env status
ops env doctor

ops env sync
ops env apply
```

Dotfiles:

```bash
ops dotfiles init
ops dotfiles diff
ops dotfiles apply
ops dotfiles update
```

Underlying provider:

```text
chezmoi
```

Runtime management:

```text
mise
```

---

# 11. Services

```bash
ops service list

ops service status docker

ops service start docker
ops service stop docker
ops service restart docker

ops service enable docker
ops service disable docker
```

Providers:

```text
systemd
launchd
Windows Service
Docker
```

---

# 12. YouTube Wrapper

Instead of:

```bash
yt-dlp \
  --extract-audio \
  --audio-format mp3 \
  --embed-thumbnail \
  --embed-metadata \
  ...
```

Use:

```bash
ops youtube audio URL
```

Commands:

```bash
ops youtube download URL

ops youtube video URL
ops youtube audio URL

ops youtube playlist URL

ops youtube subtitles URL

ops youtube metadata URL

ops youtube archive URL
```

Presets:

```text
best
1080p
720p
audio
podcast
mobile
archive
```

Examples:

```bash
ops youtube video URL --preset 1080p

ops youtube audio URL --preset podcast

ops youtube playlist URL --archive
```

Providers:

```text
yt-dlp
ffmpeg
filesystem
metadata
```

---

# 13. Docker

```bash
ops docker status

ops docker ps
ops docker logs <container>

ops docker restart <container>

ops docker cleanup

ops docker cleanup --safe

ops docker doctor
```

---

# 14. Git

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

ops github clone <repo>

ops github pr list

ops github issue list
```

Underlying:

```text
git
gh
```

---

# 15. SSH / Servers

```bash
ops ssh list

ops ssh connect oracle

ops ssh test oracle

ops ssh copy file oracle:/tmp
```

Servers:

```bash
ops server list

ops server status oracle

ops server doctor oracle

ops server update oracle
```

Example inventory:

```text
oracle
aws
homelab
work
personal
```

---

# 16. Cloud

```bash
ops cloud aws ...
ops cloud oracle ...
ops cloud cloudflare ...
ops cloud gcp ...
ops cloud azure ...
```

Examples:

```bash
ops cloud oracle instances

ops cloud aws ec2 list

ops cloud cloudflare dns list
```

Rule:

```text
Do not replace cloud CLIs.

Wrap frequent workflows.
```

---

# 17. Workflows

```bash
ops workflow list

ops workflow run bootstrap

ops workflow run backup

ops workflow run youtube-archive

ops workflow run deploy
```

Workflow model:

```text
Step
├── command
├── condition
├── retry
├── timeout
├── parallel
└── rollback
```

Typical:

```text
detect
→ install
→ configure
→ execute
→ verify
→ report
```

---

# 18. Profiles

```bash
ops profile list

ops profile show developer

ops profile apply developer
```

Example:

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

---

# 19. Plan / Apply

Future desired-state model:

```bash
ops plan

ops apply
```

Output:

```text
✓ git             installed
+ docker          install
↑ node            22 → 24
~ ~/.gitconfig    update
```

Core rule:

```text
Inspect
→ Compare
→ Plan
→ Apply
→ Verify
```

Operations should be idempotent.

---

# 20. Doctor

```bash
ops doctor

ops doctor system
ops doctor docker
ops doctor dev
ops doctor cloud
```

Possible fix mode:

```bash
ops doctor --fix
```

Output:

```text
✓ Git
✓ Docker
! Node outdated
✗ Terraform missing
```

---

# 21. Config

```bash
ops config get profile

ops config set profile developer

ops config edit

ops config path

ops config reset
```

Priority:

```text
defaults
  ↓
global config
  ↓
profile
  ↓
project config
  ↓
environment
  ↓
CLI flags
```

---

# 22. Secrets

Never store secrets in plaintext config.

```bash
ops secret get github-token

ops secret inject

ops secret doctor
```

Possible providers:

```text
1Password
Bitwarden
Infisical
SOPS
OS Keychain
Environment Variables
Cloud Secret Managers
```

---

# 23. TUI

Default:

```bash
ops
```

or:

```bash
ops tui
```

Main screens:

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

Stack:

```text
React
+
Ink
```

Important:

```text
TUI
  ↓
Application Core

NOT

TUI
  ↓
CLI command
```

---

# 24. Plugins

```bash
ops plugins list

ops plugins install <plugin>

ops plugins update

ops plugins remove <plugin>
```

Potential structure:

```text
@ops/plugin-system
@ops/plugin-cloud
@ops/plugin-youtube
@ops/plugin-ai
```

Use oclif for:

```text
commands
hooks
plugins
manifest
JIT plugins
```

---

# 25. Project Automation

```bash
ops project init

ops project setup

ops project doctor

ops project dev

ops project build

ops project clean
```

Auto detect:

```text
Node
Python
Go
Rust
Docker
Terraform
```

---

# 26. Tasks

```bash
ops task list

ops task run dev

ops task run deploy
```

Possible providers:

```text
mise tasks
just
npm scripts
Makefile
Taskfile
```

---

# 27. History

```bash
ops history

ops history show <id>
```

Track:

```text
command
workflow
package install
upgrade
config change
failure
duration
```

---

# 28. Backup / Restore

```bash
ops backup

ops restore
```

Backup:

```text
configs
dotfiles
profiles
tool inventory
package inventory
ops settings
```

Typical migration:

```text
Old Machine
    ↓
ops backup
    ↓
New Machine
    ↓
ops bootstrap
ops restore
```

---

# 29. AI

Future:

```bash
ops ai ask "..."

ops ai diagnose docker

ops ai explain error.log

ops ai fix docker

ops agent run <task>
```

Preferred architecture:

```text
AI
 ↓
Application Actions
 ↓
Providers
 ↓
System
```

Avoid:

```text
AI
 ↓
arbitrary shell
```

unless explicitly approved.

---

# 30. MCP

Future:

```bash
ops mcp serve
```

Expose:

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

---

# 31. Agent-Friendly Rules

Every important command should work without prompts.

Human:

```bash
ops tool install docker
```

Agent:

```bash
ops tool install docker \
  --yes \
  --json \
  --non-interactive
```

Output contract:

```json
{
  "success": true,
  "action": "install",
  "tool": "docker"
}
```

---

# 32. Repo Structure

```text
ops/
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
│   ├── mise/
│   ├── chezmoi/
│   ├── docker/
│   ├── git/
│   ├── ytdlp/
│   └── ffmpeg/
│
├── plugins/
│   ├── system/
│   ├── cloud/
│   ├── youtube/
│   └── ai/
│
├── profiles/
├── docs/
└── tests/
```

---

# 33. Naming Rules

Commands:

```text
noun verb
```

Prefer:

```bash
ops tool install
ops service restart
ops profile apply
```

Avoid inconsistent patterns:

```bash
ops install-tool
ops restart-service
```

Use singular resource names:

```text
tool
service
profile
package
workflow
```

except conventional names:

```text
plugins
```

---

# 34. Provider Contract

Example:

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

Package provider:

```ts
interface PackageManager {
  search(query: string): Promise<Package[]>

  install(packages: string[]): Promise<void>

  remove(packages: string[]): Promise<void>

  update(): Promise<void>
}
```

---

# 35. Execution Rules

Prefer:

```ts
execa("git", ["status"])
```

over:

```ts
exec("git status")
```

Reasons:

```text
safer args
better escaping
cross-platform
structured output
```

Always support:

```text
timeout
abort
stderr
stdout
exit code
dry-run
```

---

# 36. Safety Rules

Destructive operation:

```bash
ops docker cleanup
```

should:

```text
Inspect
→ Show Plan
→ Confirm
→ Execute
→ Verify
```

Support:

```bash
--dry-run
--yes
```

Never print:

```text
password
token
secret
private key
```

---

# 37. MVP

Do not build everything first.

Start with:

```text
1. CLI Core
2. Config
3. Executor
4. Doctor
5. Tool abstraction
6. Package provider
7. Bootstrap
8. yt-dlp wrapper
```

MVP commands:

```bash
ops version

ops doctor

ops bootstrap

ops package install

ops tool install
ops tool setup
ops tool doctor

ops youtube video
ops youtube audio

ops config get
ops config set
```

---

# 38. Development Order

```text
V0.1
Core CLI
+ config
+ executor
+ doctor

V0.2
package/tool providers
+ bootstrap

V0.3
yt-dlp
+ ffmpeg
+ Docker
+ Git wrappers

V0.4
profiles
+ workflow

V0.5
Ink TUI

V0.6
plugin architecture

V0.7
servers/cloud

V0.8
AI/MCP
```

---

# 39. Mental Model

When adding a feature, ask:

```text
Is this a command?
Is this a feature?
Is this a provider?
Is this a workflow?
Is this config?
```

Example:

```text
"Download YouTube audio"

Command:
ops youtube audio

Feature:
YouTubeAudio

Providers:
yt-dlp
ffmpeg

Workflow:
download
→ extract
→ embed metadata
→ verify
```

---

# 40. Golden Rule

```text
Simple command outside.

Powerful orchestration inside.
```

User should remember:

```bash
ops youtube audio URL
```

not:

```bash
yt-dlp --extract-audio \
       --audio-format mp3 \
       --embed-thumbnail \
       --embed-metadata \
       ...
```

That abstraction is the main value of Ops CLI.