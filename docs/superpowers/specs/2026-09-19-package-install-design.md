# `ops package install` — Design

Date: 2026-09-19 · Status: approved in brainstorming, pending spec review

## Goal

First real Ops CLI command: `ops package install zsh` installs system packages through the platform package manager, idempotently, usable by both humans and agents. It also establishes the first layers (command → core → provider → executor), the TypeScript build, and the `PackageManager` contract later providers follow.

## Decisions

- Providers: **apt** and **yum/dnf** (Linux only).
- Privilege: when not root, prepend `sudo` automatically; under `--non-interactive` use `sudo -n` so it never blocks on a password prompt.
- Behaviors: skip already-installed packages, `--dry-run`, `--json`, `--yes`, `--non-interactive`.
- Structure: layer folders inside `apps/cli/src`. Extract to `packages/*` only when a second consumer (TUI, plugin) appears.

## Command

```
ops package install <package...> [--json] [--yes|-y] [--non-interactive] [--dry-run]
```

- `--json` uses oclif's `enableJsonFlag`: `run()` returns the result object and oclif prints it.
- `--non-interactive` implies no confirmation prompt (same as `--yes`) plus `sudo -n` and `DEBIAN_FRONTEND=noninteractive`.
- Package names starting with `-` are rejected (`INVALID_PACKAGE_NAME`) so they can never be read as package-manager options.

## Layout (`apps/cli/src`)

| File | Responsibility |
|---|---|
| `commands/package/install.ts` | oclif command: parse args/flags, build deps, call core, render human output, return result for `--json` |
| `core/package/install.ts` | `installPackages(options, deps)`: check → plan → confirm → execute → verify → `InstallResult` |
| `core/errors.ts` | `OpsError` with a `code` |
| `core/output.ts` | Human rendering of `InstallResult` |
| `providers/package-manager.ts` | `PackageManager` interface, `parseOsRelease()`, `detectPackageManager()` |
| `providers/apt.ts` | apt implementation |
| `providers/yum.ts` | yum/dnf implementation |
| `executor/exec.ts` | `Runner` interface and its execa implementation |

Dependency direction: `commands → core → providers → executor`. Core and providers receive a `Runner`; nothing below `commands` imports oclif.

## Interfaces

```ts
// executor/exec.ts
interface RunOptions {
  privileged?: boolean            // needs root: prepend sudo (sudo -n when nonInteractive) unless uid 0
  env?: Record<string, string>
}
interface Runner {
  /** Final argv after privilege handling — used for execution and for --dry-run display. */
  resolve(cmd: string, args: string[], opts?: RunOptions): string[]
  /** Never throws on non-zero exit; callers inspect exitCode. Streams output to the terminal when inherit is set. */
  run(cmd: string, args: string[], opts?: RunOptions & { inherit?: boolean }):
    Promise<{ stdout: string; stderr: string; exitCode: number }>
  commandExists(cmd: string): Promise<boolean>
}
// created with createRunner({ nonInteractive }) — uses execa with argument arrays, never a shell string

// providers/package-manager.ts
interface PackageManager {
  name: 'apt' | 'yum' | 'dnf'
  status(pkg: string): Promise<{ installed: boolean; version?: string }>
  installCommand(pkgs: string[]): { cmd: string; args: string[]; opts: RunOptions }
  install(pkgs: string[]): Promise<{ exitCode: number; stderr: string }>  // one call for all missing packages
}

// core/package/install.ts
type PackageStatus = 'already-installed' | 'installed' | 'would-install' | 'failed'
interface InstallResult {
  success: boolean
  action: 'install'
  manager: string
  dryRun: boolean
  command?: string[]              // resolved install argv (set when something needed installing)
  packages: { name: string; status: PackageStatus; version?: string }[]
}
```

## Providers

**apt** — status: `dpkg-query -W -f '${Status} ${Version}' <pkg>`; installed iff exit 0 and status starts with `install ok installed`. Install: `apt-get install -y <pkgs...>`, privileged, env `DEBIAN_FRONTEND=noninteractive` when non-interactive. No automatic `apt-get update` (out of scope).

**yum/dnf** — status: `rpm -q --qf '%{VERSION}-%{RELEASE}' <pkg>`; installed iff exit 0. Install: `dnf install -y <pkgs...>` when `dnf` exists, else `yum install -y <pkgs...>`, privileged. `name` reports which binary is used.

## Detection

`parseOsRelease(text)` reads `ID` and `ID_LIKE` from `/etc/os-release`. Tokens `debian`/`ubuntu` → apt (requires `apt-get`); `rhel`/`fedora`/`centos` → dnf if present, else yum. Anything else, a missing os-release file, or a missing binary → `UNSUPPORTED_PLATFORM`.

## Flow

1. Validate names; detect the package manager.
2. `status()` for every package (read-only, also under `--dry-run`).
3. Nothing missing → all `already-installed`, `success: true`.
4. Resolve the install argv via `runner.resolve(...installCommand(missing))` and set `command`.
5. `--dry-run` → missing packages become `would-install`, `success: true`, nothing executed.
6. Neither `--yes` nor `--non-interactive`: if stdin is a TTY, print the plan and confirm (`node:readline/promises`, default no; declining exits non-zero with `CONFIRMATION_DECLINED`); if not a TTY → `CONFIRMATION_REQUIRED`.
7. `install(missing)` with output streamed to the terminal (captured instead when `--json`).
8. If it failed and stderr shows `sudo` needs a password (non-interactive) → `SUDO_PASSWORD_REQUIRED`.
9. Re-check `status()` of the missing packages: now installed → `installed` + version; still missing → `failed`. `success` is true iff none failed.

## Errors and output

`OpsError` codes: `UNSUPPORTED_PLATFORM`, `INVALID_PACKAGE_NAME`, `CONFIRMATION_REQUIRED`, `CONFIRMATION_DECLINED`, `SUDO_PASSWORD_REQUIRED`.

- Any `OpsError` → exit code 1; with `--json` the output is `{ "success": false, "error": { "code", "message" } }`.
- A result with `success: false` (some package `failed`) → printed normally, exit code 1.

Human output:

```
Package manager: apt
✓ zsh      already installed (5.9-6ubuntu2)
+ ripgrep  installed (14.1.0)
~ sl       would install
✗ foo      failed
```

Dry run adds a line: `Would run: sudo apt-get install -y sl`.

## Build and tooling

- Dependencies: `execa` (runtime), `vitest` (dev).
- `apps/cli` scripts: `build` (`tsc`), `dev` (`tsc --watch`), `test` (`vitest run`). Root forwards `build`/`test` via `pnpm --filter @ops/cli`.
- oclif `commands: ./dist/commands`; `bin/run.js` unchanged. The dev symlink (`pnpm link:global`) needs a prior `pnpm build`.
- `release.yml`: run `pnpm --filter @ops/cli build` before `pnpm deploy` (`files` already includes `dist`).
- `CLAUDE.md`: document build, test, and single-test (`pnpm --filter @ops/cli exec vitest run <file>`) commands.

## Testing

Vitest, with a `FakeRunner` that records calls and returns scripted `{stdout, stderr, exitCode}` per command.

- `parseOsRelease` / detection: fixtures for ubuntu, debian, fedora, rocky, alpine (unsupported), missing binary.
- apt and yum/dnf: exact status/install argv and parsing of installed / not-installed output.
- Runner `resolve`: sudo prepended when not root, `sudo -n` when non-interactive, nothing when root.
- `installPackages`: all installed (no install call), dry-run (no install call, `would-install`, `command` set), `CONFIRMATION_REQUIRED` without TTY, install success, install partial failure → `success:false`, invalid package name.

Manual verification on this machine (Ubuntu on WSL, zsh already installed):

- `ops package install zsh` → `✓ zsh already installed`
- `ops package install sl --dry-run` → `Would run: sudo apt-get install -y sl`
- `ops package install zsh --json` → valid JSON
- Real install needs the user's sudo password: user runs `! ops package install sl`.

yum/dnf is covered by unit tests only (no container runtime in this WSL).

## Out of scope

brew/winget providers, `package remove|update|upgrade|search|list`, automatic `apt-get update`, a shared base command for global flags, Ink output.
