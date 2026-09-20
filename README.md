# Ops CLI

> **One command layer for your machines, tools, and workflows.**

**Ops CLI** is an opinionated, extensible command-line platform for bootstrapping machines, installing and configuring tools, simplifying complex CLIs, and composing repeatable automation workflows.

Instead of remembering dozens of commands, flags, configuration files, and setup steps, Ops CLI provides a consistent interface:

```bash
ops bootstrap dev
ops doctor

ops tool install docker
ops tool setup git

ops youtube audio <url>

ops docker cleanup

ops workflow run backup
```

> **Status:** early. What works today is `ops --version`, the `ops tool` group —
> [`install`](docs/commands.md#how-a-tool-gets-installed), [`setup`](docs/commands.md#how-setup-works) and
> [`uninstall`](docs/commands.md#removing-a-tool) — plus [`ops bootstrap`](docs/commands.md#bootstrap) and
> [`ops profile list|show`](docs/commands.md#profiles), which converge a machine to a named profile.
> Bootstrap's `services`, `shell` and `dotfiles` sections are defined in the profile schema but not yet
> implemented. Everything else above and below describes the planned design. See the
> [roadmap](docs/roadmap.md).

## Installation

Releases are self-contained tarballs (Node.js bundled) published to GitHub Releases. The usual way is through [mise](https://mise.jdx.dev):

```bash
curl https://mise.run | sh
mise use -g github:ttungbmt/opsctl

ops --version
```

If mise's `minimum_release_age` hides a fresh release, pin it explicitly: `mise use -g github:ttungbmt/opsctl@0.1.0`.

Or take ops on its own. The tarball bundles Node, so it runs the moment it is
extracted, and `ops bootstrap` installs mise for you on first run — ops is then the
only thing you download. The asset name carries the release's commit, so resolve it
rather than guessing:

```bash
url=$(curl -fsSL https://api.github.com/repos/ttungbmt/opsctl/releases/latest \
  | grep -o 'https://[^"]*linux-x64\.tar\.gz')
curl -fsSL "$url" | tar xz

./ops/bin/ops bootstrap --yes
```

`ops bootstrap` and `ops tool install` check for mise first and install it when it is
missing, into `/usr/local/bin`. Pass `--no-preflight` to turn that off.

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

## Testing in a container

`ops` installs packages with sudo, apt-get and mise, so trying it out means letting it change a
machine. `docker-compose.yml` provides a throwaway Ubuntu box for that: an unprivileged `ops`
account with passwordless sudo, mise on PATH, and this repo bind-mounted at `/workspace`, so
edits on the host apply immediately.

The `docker:*` mise tasks drive it, so there is nothing to memorise — `mise tasks` lists them.
`mise.toml` also defines `mr` as a shorthand for `mise run`, available in an interactive shell
inside this directory:

```bash
mr bash                                        # interactive shell in the container
mr docker:run ops tool install jq --dry-run    # one command, then gone
mr root-bash                                   # same, as root (via sudo)
```

`docker:run` is the primitive; `bash` and `root-bash` are it with a fixed command. Every
argument reaches the container untouched, flags included.

`mr` comes from mise's `[shell_alias]`, so it needs `mise activate` in your shell and it only
exists while you are in this directory. Scripts, CI and anything non-interactive have to spell
out `mise run` — shell aliases do not reach them.

By default each command gets a container of its own, starting from the image again — right for
testing a first-time install. To check that a command is idempotent, keep one container alive
and the tasks use it instead, so apt and mise state carries from one command to the next:

```bash
mr up                                    # start it; now the commands above reuse this container
mr docker:run ops tool install jq --yes  # run the same thing twice: the second
mr docker:run ops tool install jq --yes  # time must report it already installed
mr down                                  # stop it; the node_modules volumes survive
mr reset                                 # stop it and discard the volumes too
```

**Type `mr up`, never `mise up`.** mise ships its own `up`, an alias for `upgrade`, and it wins:
`mise up` upgrades the tools in `mise.toml` and says nothing about containers. `mr up` expands to
`mise run up`, which can only mean the task. The same holds for any task whose name mise already
uses. `mr docker:build` rebuilds the image.

Without mise, every task is a short `docker compose` command; read
`.mise/tasks/docker/run`. To reuse these tasks in another repo, copy `.mise/tasks/docker/`:
they name no service, falling back to the only service in the compose file, and
`COMPOSE_SERVICE` in `mise.toml` picks one when there are several.

Inside the container, `ops` runs the local checkout (`apps/cli/bin/run.js`). Source changes need
a `pnpm build` first, exactly as on the host. If your host account is not `1000:1000`, build with
`UID=$(id -u) GID=$(id -g) docker compose build` to keep the mounted repo writable.

The image answers every apt question in advance — debconf's frontend is set to `Noninteractive`
on disk and tzdata is preconfigured. That is deliberate and not redundant with
`DEBIAN_FRONTEND`: `sudo` resets the environment, so a variable set on the container never
reaches `sudo apt-get`, and a tool that runs apt on its own behalf (`ops tool setup
agent-browser` does, via `agent-browser install --with-deps`) would otherwise stop on a prompt
with nothing able to answer it. The timezone defaults to `Asia/Ho_Chi_Minh`; change it with
`docker compose build --build-arg TZ=Etc/UTC`.

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
