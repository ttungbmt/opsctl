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
├── tool
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
ops tool install docker \
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

## Tool Management

A **tool** is a capability you want available on the machine — `git`, `node`, `docker`, `ripgrep`. `ops tool` is the single surface for managing them.

```bash
ops tool list

ops tool install node

ops tool setup git

ops tool update terraform

ops tool status docker

ops tool doctor mise

ops tool uninstall node

ops tool uninstall google-chrome --purge
```

### How a tool gets installed

Ops picks the provider; the user should normally not need to care which one is used.

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

Cross-platform
└── mise (registry tools)
```

A plain name becomes a mise tool when the mise registry has it. Shells and base
system packages (`zsh`, `git`, `curl`, …) and names missing from the registry go
to the OS package manager. Prefix a name to force a provider:

```bash
ops tool install apt:git
ops tool install brew:jq
ops tool install mise:aqua:BurntSushi/ripgrep
```

### Recipes

Some tools are not installable by name: `google-chrome` is neither a mise tool
nor an apt package (the package is `google-chrome-stable`, and it only exists
once Google's apt repository is configured). A **recipe** gives ops the real
package name and, when needed, a `prepare` step that makes it installable on a
machine that has never seen it.

```yaml
# ~/.config/ops/config.yaml — or the built-in config/defaults.yaml
tool:
  google-chrome:
    summary: Google Chrome
    package: apt:google-chrome-stable
    prepare:
      deb: https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
```

A recipe name resolves to its package ahead of every heuristic, so
`ops tool install google-chrome` works on a fresh machine. `prepare` runs only when the
tool is missing, must use `https`, and is shown by `--dry-run` before anything is
downloaded.

---

> **Note — package is a layer, not a command group.** Internally a *package* is
> one entry of an OS package manager and a *tool* is the higher-level concept
> layered on top of it (see [architecture](architecture.md)). That boundary is
> real in the code, but it is not exposed as a second command group: there is no
> `ops package`. Making the user choose the layer would be the same mistake as
> naming a command after its provider.

### Initial tool candidates

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

### How setup works

Setup steps are recipe data, not code. Each step pairs a `check` with the `run`
that makes it pass:

```yaml
tool:
  agent-browser:
    package: mise:agent-browser
    setup:
      - name: browser binaries
        check: [agent-browser, doctor, --quick, --offline]
        run: [agent-browser, install, --with-deps]
```

`ops tool setup agent-browser` runs every `check` first, prints the steps it is
about to apply, runs only those, then re-runs each `check` to verify it. A step
already satisfied is never run again, so setup converges instead of repeating
work:

```bash
ops tool setup agent-browser --dry-run   # what is missing, without changing anything
ops tool setup agent-browser             # apply the missing steps
ops tool setup agent-browser --json --yes
```

Because a step runs an arbitrary command from a file the user can write, the
plan is always printed before anything runs, and `--json` or a non-terminal
requires `--yes`. A `check` must fail only for what its `run` can repair —
nothing enforces that, so it is the recipe author's job.

## Removing a tool

`ops tool uninstall <name>` is the inverse of `install`, and it undoes both halves
of what install did: the package, and the declaration install wrote.

```bash
ops tool uninstall node                          # remove the package
ops tool uninstall google-chrome --purge --yes   # and its config, cache and repo files
ops tool uninstall node --dry-run                # what would happen, changing nothing
```

That second half matters. `install` records every system package in
`[bootstrap.packages]` in mise's global config, so removing a package with
`apt remove` alone leaves the declaration behind and the next `ops bootstrap`
reinstalls it. `uninstall` deletes that line — and only that line, leaving the
rest of the file, comments included, byte for byte as it was.

How each kind is removed:

| Kind | Command |
|------|---------|
| mise tool | `mise unuse -g <tool>` — drops the request and prunes the installation |
| apt/dnf package | `apt-get remove\|purge` or `dnf remove`, then the declaration |
| anything else | refused, naming the command that would work |

mise cannot remove apt packages itself (`mise bootstrap packages prune` supports
brew and plugin-backed managers, not apt), which is why ops runs the package
manager directly here while still going through mise everywhere else.

Being destructive, it inspects first, prints the plan, then acts and verifies:
every package is re-probed with `dpkg-query`/`rpm` afterwards, and every purged
path is re-checked. Before removing anything it runs `apt-get -s` and **refuses**
if the removal would take packages with it that you did not name — apt reports
dependents but does not refuse them, so ops does.

### `--purge`

`--purge` deletes what no package manager owns: the apt source and keyring a
vendor `.deb` wrote, and the tool's own config and cache. Those paths are data,
listed per recipe:

```yaml
tool:
  google-chrome:
    package: apt:google-chrome-stable
    uninstall:
      purge:
        paths:
          - /etc/apt/sources.list.d/google-chrome.sources
          - ~/.config/google-chrome
```

Paths only — never commands, so a config file can never run something as root.
Each is validated when the config loads, not when it is deleted: it must be
absolute or `~/`-rooted, contain no `..`, name nothing shallower than two
directories deep, and not be a shared root such as `~/.config`. A glob is
rejected rather than passed to `rm`, which would not expand it. A path that does
not exist is simply absent, so a recipe can list every known variant.

Because these files sit outside any package manager, `--purge` always requires
`--yes`, on a terminal as well.

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
