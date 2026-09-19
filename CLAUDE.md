# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project status

Ops CLI (`ops` command, repo `opsctl`) is in the **early scaffolding phase**: a pnpm workspace with the oclif CLI in `apps/cli` (`bin/run.js`, oclif config in its `package.json`). Only `ops --version` / `-v` works so far; there are no commands, build script, lint, or tests yet. Run the CLI with `pnpm ops <args>` from the root (or `node apps/cli/bin/run.js <args>`). `pnpm link:global` symlinks `~/.local/bin/ops` to `apps/cli/bin/run.js` so `ops` works from any directory (dev install — source changes apply immediately). The source of truth for intent is:

- `README.md` — vision, architecture, command model, roadmap (v0.1 → v0.8+), MVP scope
- `docs/features.md` — full planned feature list (partly Vietnamese)
- `docs/cheatsheet.md` — condensed stack, principles, naming/provider/execution/safety rules, development order

When scaffolding, follow these docs, and update this file with real build/lint/test commands once they exist.

Releases: pushing a `v*` tag runs `.github/workflows/release.yml`, which `pnpm deploy`s `apps/cli` outside the workspace (oclif pack can't install deps for a package nested in a pnpm workspace), runs `oclif pack tarballs` (Node bundled) and uploads them to a GitHub Release. Users install with `mise use -g github:ttungbmt/opsctl`. Bump `version` in `apps/cli/package.json` to match the tag.

Toolchain (Node LTS + pnpm 12) is pinned in `mise.toml`; run `mise install` after cloning.

## Planned stack

TypeScript, oclif (CLI + plugins), React + Ink (TUI), Zod (validation), execa (process execution), Vitest, pnpm workspace monorepo, tsup/esbuild (build), Biome (format/lint).

Planned layout: `apps/cli`, `packages/{core,domain,config,executor,ui,sdk}`, `providers/<tool>` (winget, apt, brew, mise, chezmoi, git, docker, ytdlp, ffmpeg…), `plugins/`, `profiles/`, `tests/`.

## Architecture rules

Layers: CLI (oclif) / TUI (Ink) → Application core → Domain → Providers / Workflows / Plugins → external CLIs, OS, APIs.

- **Command != business logic.** oclif commands and Ink screens are thin presentation layers that call the same application core. The TUI must never shell out to CLI commands.
- **Feature != provider.** Public commands name the capability, not the tool behind it (`ops youtube audio`, not `ops ytdlp audio`). `YouTubeAudio` is the feature; yt-dlp and ffmpeg are swappable providers.
- **Install != setup.** `tool install` makes sure a tool exists; `tool setup` configures it. Keep them separate.
- **Tool != package.** A package is installed by a platform package manager (auto-picked per OS). A tool is a higher-level concept with install, setup, update, and doctor.
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

Build the MVP first (cheatsheet §37): core CLI, config, executor, doctor, package/tool abstractions, bootstrap, and the yt-dlp wrapper. MVP commands: `ops version`, `doctor`, `bootstrap`, `package install`, `tool install|setup|doctor`, `youtube video|audio`, `config get|set`. Don't build TUI, plugins, cloud, or AI layers ahead of the roadmap.
