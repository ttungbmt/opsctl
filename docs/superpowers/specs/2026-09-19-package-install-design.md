# `ops package install` — Design

Date: 2026-09-19 · Status: **superseded** by [`2026-09-20-tool-command-surface-design.md`](2026-09-20-tool-command-surface-design.md)

> The command described here now ships as **`ops tool install`**; `ops package install`
> no longer exists. Everything below about resolution, providers, layering and safety
> still holds — only the command name changed. Kept as the original record.

## Goal

First real Ops CLI command: `ops package install zsh` installs system packages idempotently, for humans and agents alike. It also establishes the first layers (command → core → provider → executor) and the TypeScript build.

## Decisions

- **Provider: `mise bootstrap packages`, declarative.** `ops package install zsh` runs `mise bootstrap packages use -g apt:zsh`, which records `"apt:zsh" = "latest"` under `[bootstrap.packages]` in `~/.config/mise/config.toml` and installs it. A new machine reproduces the set with `mise bootstrap`. ops is itself installed through mise, so mise is always present.
- **Managers:** the OS picks `apt` (Debian/Ubuntu) or `dnf` (RHEL/Fedora/CentOS). yum is not supported: dnf replaced it from RHEL 8, and mise has no built-in yum manager.
- **Explicit manager passthrough:** input already in `manager:package` form (e.g. `brew:jq`) is used unchanged.
- **Behaviors:** skip installed packages, `--dry-run`, `--json`, `--yes`, `--non-interactive`.
- **Structure:** layer folders inside `apps/cli/src`; extract to `packages/*` when a second consumer appears.

### Alternatives considered

- **Hand-written apt/yum providers** (first draft of this spec, commit c855b4b): `dpkg-query`/`rpm -q` status, `apt-get`/`yum` install, own sudo handling. Rejected — it duplicates what mise bootstrap already does (installed-check, sudo, dry-run, confirmation, more managers, prune/upgrade) and would not give a declarative record.
- **mise `apply` without saving** (imperative): rejected as the default because `status --json` only reports declared packages, and the declarative record is the foundation for a later `ops bootstrap` / `ops apply`.

## Command

```
ops package install <package...> [--json] [--yes|-y] [--non-interactive] [--dry-run]
```

- `--json` uses oclif's `enableJsonFlag`: `run()` returns the result object and oclif prints it.
- `--non-interactive` implies `--yes`, runs mise with stdin ignored, and never prompts.

## Layout (`apps/cli/src`)

| File | Responsibility |
|---|---|
| `commands/package/install.ts` | oclif command: parse args/flags, build deps, call core, render human output, return result for `--json` |
| `core/package/install.ts` | `installPackages(options, deps)`: normalize → declare → status → apply → status → `InstallResult` |
| `core/package/spec.ts` | `toPackageSpec(name, manager)` |
| `core/errors.ts` | `OpsError` with a `code` |
| `core/output.ts` | Human rendering of `InstallResult` |
| `providers/os.ts` | `parseOsRelease(text)`, `detectSystemManager()` |
| `providers/mise-bootstrap.ts` | The only file that knows mise's bootstrap CLI and JSON shape |
| `executor/exec.ts` | `Runner` interface and its execa implementation |

Dependency direction: `commands → core → providers → executor`. Nothing below `commands` imports oclif.

## Interfaces

```ts
// executor/exec.ts — execa with argument arrays, never a shell string
interface RunOptions {
  stdout?: 'capture' | 'inherit'  // capture (default) collects output; inherit streams stdout/stderr and lets mise/sudo prompt
  stdin?: 'inherit' | 'ignore'    // ignore under --non-interactive
}
interface RunResult { stdout: string; stderr: string; exitCode: number }
interface Runner {
  /** Never throws on non-zero exit; throws CommandNotFoundError only if the binary is missing. */
  run(cmd: string, args: string[], opts?: RunOptions): Promise<RunResult>
}
function sudoReady(runner: Runner, uid?: number): Promise<boolean>  // root, or `sudo -n true` succeeds

// core/package/spec.ts
type PackageSpec = `${string}:${string}`            // e.g. "apt:zsh"
function toPackageSpec(name: string, manager?: string): PackageSpec
// "zsh" + "apt" → "apt:zsh"; "brew:jq" → "brew:jq"; leading "-" or empty part → INVALID_PACKAGE_NAME

// providers/mise-bootstrap.ts
interface PackageState { spec: PackageSpec; installed: boolean; version?: string }
interface MiseBootstrap {
  declare(specs: PackageSpec[]): Promise<void>                     // use -g --no-install
  status(): Promise<PackageState[]>                                // status --json, Zod-validated
  apply(specs: PackageSpec[], opts: { yes: boolean; nonInteractive: boolean; capture: boolean }): Promise<{ exitCode: number }>
  dryRun(specs: PackageSpec[]): Promise<string[]>                  // use -g --dry-run → planned command lines
}

// core/package/install.ts
type PackageStatus = 'already-installed' | 'installed' | 'would-install' | 'failed'
interface InstallResult {
  success: boolean
  action: 'install'
  managers: string[]              // distinct manager prefixes, e.g. ["apt"]
  dryRun: boolean
  commands?: string[]             // dry-run only: commands mise would run
  packages: { spec: PackageSpec; status: PackageStatus; version?: string }[]
}
```

## mise commands used

| Purpose | Command |
|---|---|
| Record in global config (idempotent) | `mise bootstrap packages use -g --no-install <specs...>` |
| Current state | `mise bootstrap packages status --json` |
| Install missing | `mise bootstrap packages apply [--yes] <specs...>` |
| Preview | `mise bootstrap packages use -g --dry-run <specs...>` |

`status --json` shape (observed on mise 2026.9.11), keyed by manager:

```json
{ "apt": { "available": true, "packages": [
  { "package": "zsh", "requested_version": "latest", "desired_state": "present",
    "state": "installed", "installed_version": "5.9-6ubuntu2" } ] } }
```

A spec `apt:zsh` is installed iff `apt.packages[]` has `package == "zsh"` with `state == "installed"`; its version is `installed_version`. Unknown extra fields are ignored; a shape mismatch raises `MISE_BOOTSTRAP_UNAVAILABLE` with the Zod message.

## Resolution (plain names)

Revision 2026-09-19: mise tools are the default, because the registry covers many tools and gives newer builds (apt on Ubuntu has no `fastfetch`, for example).

1. On the system list `package.system` (defaults in `apps/cli/config/defaults.yaml`: zsh, bash, fish, git, curl, wget, unzip, build-essential, ca-certificates, openssh-client, tmux) → OS manager (`apt:`/`dnf:`). Shells and base packages belong at system paths even when the registry has them.
2. `mise registry <name>` exits 0 → mise tool `mise:<name>`, installed with `mise use -g <name>@latest` (recorded as `name = "latest"` in `[tools]`) by `providers/mise-tools.ts`.
3. Otherwise → OS manager.

The list is data, not code. `core/config.ts` loads the built-in `apps/cli/config/defaults.yaml` (shipped via `files` in `package.json`), then the user config (`$OPS_CONFIG`, else `$XDG_CONFIG_HOME/ops/config.yaml`, else `~/.config/ops/config.yaml`; missing = defaults only, bad content = `CONFIG_INVALID`). In the user config, a list replaces the defaults; `add`/`remove` adjusts them so new defaults still arrive:

```yaml
package:
  system:
    add: [htop]     # also via apt/dnf
    remove: [tmux]  # back to registry lookup
  # or: system: [zsh, git]   # replace the whole list
```

Explicit prefixes skip resolution: `mise:<tool>` (backend ids too, e.g. `mise:aqua:owner/repo`) is a tool; any other prefix is a `mise bootstrap packages` manager. OS detection runs only when a spec needs it. Tools need no confirmation (`mise use` does not prompt or use sudo); `CONFIRMATION_REQUIRED` and the sudo check apply to system packages only.

| Purpose (tools) | Command |
|---|---|
| Registry lookup | `mise registry <name>` (exit code) |
| Current state | `mise ls -g --json` |
| Declare + install | `mise use -g <name>@latest…` |
| Preview | `mise use -g --dry-run <name>@latest…` (plan on stderr and stdout) |

## Detection

`parseOsRelease` reads `ID` and `ID_LIKE` from `/etc/os-release`. Tokens `debian`/`ubuntu` → `apt`; `rhel`/`fedora`/`centos` → `dnf`. Anything else or a missing file → `UNSUPPORTED_PLATFORM`. Detection is skipped for inputs that all carry an explicit manager.

## Flow

1. Detect the manager; convert every name with `toPackageSpec`.
2. **`--dry-run`:** call `dryRun(specs)` and `status()` (read-only; nothing written or installed). Declared-and-installed specs → `already-installed`, the rest → `would-install`; `commands` holds mise's planned lines. `success: true`.
3. Neither `--yes` nor `--non-interactive`, and (stdin is not a TTY **or** `--json` is set — mise's prompt would be invisible while output is captured) → `CONFIRMATION_REQUIRED` (before anything is written).
4. `declare(specs)` — records all specs in the global config.
5. `status()` → specs already installed are `already-installed`.
6. Nothing missing → return, `success: true`, no `apply`.
7. Under `--non-interactive`, if any missing spec uses `apt`/`dnf` and the user is not root, run `sudo -n true` first; non-zero → `SUDO_PASSWORD_REQUIRED` (sudo reads passwords from the TTY, so ignoring stdin alone would not prevent a prompt).
8. `apply(missing, …)` — without `--yes`, mise shows its own confirmation prompt (stdio inherited). With `--json`, output is captured instead of streamed.
9. `status()` again: installed → `installed` + version; otherwise `failed`. `success` is true iff none failed.

A spec stays declared in config even if its install fails — the config records desired state; re-running retries it.

## Errors and output

`OpsError` codes: `UNSUPPORTED_PLATFORM`, `INVALID_PACKAGE_NAME`, `CONFIRMATION_REQUIRED`, `SUDO_PASSWORD_REQUIRED`, `MISE_BOOTSTRAP_UNAVAILABLE` (`mise` not on PATH, `mise bootstrap packages` not recognized by an older mise, or unexpected JSON), `MISE_COMMAND_FAILED` (any other non-zero mise exit; the message includes mise's stderr).

- Any `OpsError` → exit code 1; with `--json` the output is `{ "success": false, "error": { "code", "message" } }`.
- A result with `success: false` → printed normally, exit code 1.
- Declining mise's own prompt makes `apply` exit non-zero → the packages report `failed`.

Human output:

```
Package manager: apt
✓ apt:zsh      already installed (5.9-6ubuntu2)
+ apt:ripgrep  installed (14.1.0)
~ apt:sl       would install
✗ apt:foo      failed
```

## Build and tooling

- Dependencies: `execa`, `zod` (runtime); `vitest` (dev).
- `apps/cli` scripts: `build` (`tsc`), `dev` (`tsc --watch`), `test` (`vitest run`). Root forwards `build`/`test` via `pnpm --filter @ops/cli`.
- oclif `commands: ./dist/commands`; `bin/run.js` unchanged. The dev symlink (`pnpm link:global`) needs a prior `pnpm build`.
- `release.yml`: run `pnpm --filter @ops/cli build` before `pnpm deploy` (`files` already includes `dist`).
- `CLAUDE.md`: document build, test, and single-test (`pnpm --filter @ops/cli exec vitest run <file>`) commands.

## Testing

Vitest, with a `FakeRunner` that records calls and returns scripted `{stdout, stderr, exitCode}` per argv; `status --json` fixtures use the real shape above.

- `toPackageSpec`: plain name, explicit manager, leading `-`, empty parts.
- `parseOsRelease` / `detectSystemManager`: ubuntu, debian, fedora, rocky, alpine (unsupported), missing file.
- `MiseBootstrap`: exact argv per method; status parsing (installed, missing, unknown manager key, malformed JSON).
- `installPackages`: all installed → no `apply`; some missing → `apply` with only those; dry-run → no `declare`/`apply`; non-TTY without `--yes` → `CONFIRMATION_REQUIRED` and no `declare`; failed install → `success: false`; sudo password stderr → `SUDO_PASSWORD_REQUIRED`.

Manual verification (Ubuntu on WSL; `apt:zsh` already declared and installed in the global config):

- `ops package install zsh` → `✓ apt:zsh already installed`, config unchanged.
- `ops package install sl --dry-run` → planned command, config unchanged.
- `ops package install zsh --json` → valid JSON.
- Real install needs the user's sudo password: user runs `! ops package install sl`.

dnf is covered by unit tests only (no container runtime in this WSL).

## Trade-offs

- ops depends on mise's bootstrap CLI flags and JSON, a young feature that may change. All of it lives in `providers/mise-bootstrap.ts`, validated with Zod and surfaced as `MISE_BOOTSTRAP_UNAVAILABLE`.
- Every install is persisted to the user's global mise config — intentional (desired state), but it means `ops package install` is not a throwaway action.
- Package names that differ between distros remain the user's responsibility.

## Out of scope

`package remove` (later: `mise bootstrap packages prune`), `update|upgrade|search|list`, writing to a project-local config, a default manager on macOS/Windows, a shared base command for global flags, Ink output.
