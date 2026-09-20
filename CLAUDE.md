# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project status

Ops CLI (`ops` command, repo `opsctl`) is in the **early scaffolding phase**: a pnpm workspace with the oclif CLI in `apps/cli` (`bin/run.js`, oclif config in its `package.json`). Implemented: `ops --version`, `ops tool install` (routes to mise tools or `mise bootstrap packages`), `ops tool setup` (runs a recipe's configuration steps) and `ops tool uninstall` (removes the package and the declaration install wrote; `--purge` also deletes the recipe's purge paths); specs in `docs/superpowers/specs/2026-09-19-package-install-design.md`, `2026-09-20-tool-command-surface-design.md`, `2026-09-20-tool-recipes-design.md`, `2026-09-20-tool-setup-design.md` and `2026-09-20-tool-uninstall-design.md`. Run the CLI with `pnpm ops <args>` from the root (or `node apps/cli/bin/run.js <args>`). `pnpm link:global` symlinks `~/.local/bin/ops` to `apps/cli/bin/run.js` so `ops` works from any directory (dev install — source changes apply immediately). The source of truth for intent is:

- `README.md` — overview, install, links to detailed docs
- `docs/vision.md` — why, goals, long-term vision
- `docs/architecture.md` — stack, layers, principles, providers, execution, config, safety, repo structure
- `docs/commands.md` — command model, global flags, planned command groups
- `docs/roadmap.md` — roadmap (v0.1 → v0.8+), MVP scope
- `docs/features.md` — full planned feature list (partly Vietnamese)
- `docs/cheatsheet.md` — condensed stack, principles, naming/provider/execution/safety rules, development order

When scaffolding, follow these docs, and update this file with real build/lint/test commands once they exist.

Releases: pushing a `v*` tag runs `.github/workflows/release.yml`, which `pnpm deploy`s `apps/cli` outside the workspace (oclif pack can't install deps for a package nested in a pnpm workspace), runs `oclif pack tarballs` (Node bundled) and uploads them to a GitHub Release. Users install with `mise use -g github:ttungbmt/opsctl`. Bump `version` in `apps/cli/package.json` to match the tag.

Toolchain (Node LTS + pnpm 12) is pinned in `mise.toml`; run `mise install` after cloning.

## Commands

- `pnpm build` — clear `apps/cli/dist` and compile `apps/cli/src` (tsc); required before running the CLI
- `pnpm typecheck` — type-check `src` + `test` (`apps/cli/test/tsconfig.json`; Vitest and `pnpm build` don't type-check tests)
- `pnpm test` — all tests (Vitest); single file: `pnpm --filter @ops/cli exec vitest run test/core/package/install.test.ts`
- `pnpm ops <args>` — run the local build (the `ops` on PATH is the mise-installed release)
- `mise run docker:run <cmd>` — run against a throwaway Ubuntu box (`docker/Dockerfile`, unprivileged `ops` user + NOPASSWD sudo + mise, repo bind-mounted at `/workspace`, `ops` on PATH). The only way to exercise the real sudo/apt/mise paths — every test under `apps/cli/test` uses a fake runner. `mise run bash` for a shell, `mise run root-bash` for one as root. `mise run up` first when state must survive between commands (idempotency checks): the tasks then reuse that container instead of a fresh one. Tasks live in `.mise/tasks/docker/`; `mise tasks` lists them, README § Testing in a container explains them. `mise.toml` defines a `mr` shell alias for `mise run`, but it only exists in an interactive shell with `mise activate` — **write `mise run` in scripts, and use `mise run` yourself**; `mr` will not resolve.
- Code layout: `src/commands` (oclif, thin) → `src/core` → `src/providers` → `src/executor`; only `src/providers/*` run subprocesses or reach the network (`src/core/config.ts` and `src/core/tool/recipe.ts` read the config file and `$HOME`, through injectable defaults, so they stay testable without touching disk): `mise-bootstrap.ts` (system packages) and `mise-tools.ts` (mise tools) know mise's CLI/JSON, `deb.ts` knows HTTP and `apt-get`. `tool install` (`src/commands/tool/install.ts`) resolves plain names in `src/core/package/resolve.ts`: recipe → its package, else system-preferred list → apt/dnf, else mise registry → tool, else apt/dnf. A **recipe** (`tool.<name>` in config, indexed by `src/core/tool/recipe.ts`) names the real package and may carry a `prepare` step; `src/providers/deb.ts` runs the only kind there is — download an https `.deb` and `apt-get install` it — for tools no configured repo can supply yet (`google-chrome`). When a vendor ships no standalone `.deb`, the recipe instead names a **repo** (`repo.<name>` in config, `src/core/repo.ts`): `src/providers/apt-repo.ts` writes `/etc/apt/{keyrings,sources.list.d,preferences.d}/ops-<name>.*` (rendered to a temp file, then `sudo install -D`, because the executor takes argv not shell strings), runs `apt-get update`, and proves with `apt-cache policy` (under `LC_ALL=C`) that apt's candidate really comes from the repo — `apt:firefox` on Ubuntu is otherwise a 121 KB shim that installs the snap and still reports as installed. `prepare` and `repo` are opposites and mutually exclusive: `prepare` installs and stops, `repo` only makes the package reachable and the spec still goes to `mise.apply`. A package already installed from the wrong origin is `failed`, not `already-installed`; `--force` switches it. `recipeIndex(config.tool, {repos: config.repo})` checks every cross-reference eagerly — pass `repos` at all three call sites (`tool install|uninstall|setup`) or a valid config throws. A recipe may also carry `setup`: ordered steps of `check` (exit 0 = already done) and `run`, executed by `tool setup` (`src/commands/tool/setup.ts` → `src/core/tool/setup.ts`), which inspects every check, prints the plan, applies only the pending steps and re-runs each check to verify. A check must fail only for what its `run` repairs; nothing enforces that. Config: built-in defaults in `apps/cli/config/defaults.yaml` (keep default data there, not in code), overlaid by `~/.config/ops/config.yaml` (or `$OPS_CONFIG`); loaded and Zod-validated by `src/core/config.ts`. `package.system` is the system-preferred list (user: a list replaces it, `add`/`remove` adjusts it). Output: render functions in `src/core/output.ts` take an injected `Style` (`src/core/style.ts`, ansis) defaulting to `plainStyle`, and pad **before** painting so escape codes never skew columns; `styleFor(json)` picks the style and ansis honours `NO_COLOR`/`FORCE_COLOR`/TTY. `downloadProgress` takes `now` and `columns` as injected defaults so core never reads `process`; it fixes the bar width on the first tick (a per-tick width jitters) and sheds the bar, then speed and eta, rather than wrapping a narrow terminal. Core must never import `@oclif/core` (the Ink TUI shares it), so the spinner lives in the command layer and is enabled only when sudo will not prompt. `tool uninstall` (`src/commands/tool/uninstall.ts` → `src/core/package/uninstall.ts`) reuses `resolveSpecs`, then removes through `mise unuse -g` (tools) or `src/providers/system.ts` (apt/dnf, which also probes dpkg/rpm and simulates with `apt-get -s` to refuse removals that would take dependents); `src/providers/mise-config.ts` deletes the `[bootstrap.packages]` line install wrote — mise has no CLI to undeclare and cannot prune apt — by editing one line and verifying with `mise config get -g`, and `src/providers/paths.ts` is the only place that runs `rm -rf`, over paths `recipeIndex` validated at config load. Relative imports need `.js` extensions (NodeNext). TS 7 needs `"types": ["node"]` in tsconfig for Node typings.

## Planned stack

TypeScript, oclif (CLI + plugins), React + Ink (TUI), Zod (validation), execa (process execution), Vitest, pnpm workspace monorepo, tsup/esbuild (build), Biome (format/lint).

Planned layout: `apps/cli`, `packages/{core,domain,config,executor,ui,sdk}`, `providers/<tool>` (winget, apt, brew, mise, chezmoi, git, docker, ytdlp, ffmpeg…), `plugins/`, `profiles/`, `tests/`.

## Architecture rules

Layers: CLI (oclif) / TUI (Ink) → Application core → Domain → Providers / Workflows / Plugins → external CLIs, OS, APIs.

- **Command != business logic.** oclif commands and Ink screens are thin presentation layers that call the same application core. The TUI must never shell out to CLI commands.
- **Feature != provider.** Public commands name the capability, not the tool behind it (`ops youtube audio`, not `ops ytdlp audio`). `YouTubeAudio` is the feature; yt-dlp and ffmpeg are swappable providers.
- **Install != setup.** `tool install` makes sure a tool exists; `tool setup` configures it. Keep them separate.
- **Tool != package.** A package is installed by a platform package manager (auto-picked per OS). A tool is a higher-level concept with install, setup, update, and doctor. This boundary is **internal layering only** (`ToolProvider` over `PackageManager`): the public surface is `ops tool` alone. There is no `ops package` command group — making the user pick the layer leaks it the same way naming a command after its provider would.
- **Human output != machine output.** Every important command should support `--json`, `--yes`, and `--non-interactive` so scripts and agents can call it without prompts.
- Provider contracts (`ToolProvider`, `PackageManager`) are in `docs/cheatsheet.md` §34.
- Operations should be idempotent (inspect → compare → plan → apply → verify).
- When adding something, decide whether it is a command, a feature, a provider, a workflow, or config (cheatsheet §39).

## Conventions

- Command naming: `noun verb` with singular resources (`ops tool install`, `ops service restart`). `plugins` is the one exception. Avoid names like `install-tool`.
- Global flags to converge on: `--json --quiet --verbose --debug --yes --force --dry-run --non-interactive --profile <name> --config <path>`.
- Run external processes through the executor with execa and argument arrays (`execa("git", ["status"])`), never shell strings. Support timeout, abort, stdout/stderr, exit code, and dry-run.
- Destructive operations: inspect → show plan → confirm → execute → verify. Support `--dry-run` and `--yes`. Never print passwords, tokens, secrets, or private keys.
- Config precedence: defaults → global config → profile → project config → env vars → CLI flags.

## Scope

Build the MVP first (cheatsheet §37): core CLI, config, executor, doctor, package/tool abstractions, bootstrap, and the yt-dlp wrapper. MVP commands: `ops version`, `doctor`, `bootstrap`, `tool install|setup|doctor`, `youtube video|audio`, `config get|set` — of these `tool install|setup` are done; `tool uninstall` shipped alongside them without being on the list. Don't build TUI, plugins, cloud, or AI layers ahead of the roadmap.
