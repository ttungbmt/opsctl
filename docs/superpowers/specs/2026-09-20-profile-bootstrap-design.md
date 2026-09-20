# `ops bootstrap` and profiles — Design

Date: 2026-09-20 · Status: planned

Builds on [`2026-09-20-tool-command-surface-design.md`](2026-09-20-tool-command-surface-design.md),
[`2026-09-20-tool-recipes-design.md`](2026-09-20-tool-recipes-design.md) and
[`2026-09-20-tool-setup-design.md`](2026-09-20-tool-setup-design.md).

## Problem

A freshly installed Ubuntu has nothing. No compiler, no `git`, no `curl`, no
`unzip`. Getting to a machine you can work on means remembering a list and
typing it out:

```
$ ops tool install build-essential ca-certificates curl git unzip wget
```

`ops tool install` is already variadic, so that works. What it cannot do is
**name** the list. Nothing records that this set is what a developer box needs,
nothing carries it to the next machine, and nothing tells you which parts are
already there. The fallback is a shell script, which is exactly the thing ops
exists to replace — it re-runs blindly, reports nothing, and converges on
nothing.

The gap is wider than packages. A usable machine also needs its tools
configured (`git` wants a user), its services running (`docker`), its login
shell set, and its dotfiles in place. Those live in five different places today
and in no place at all in ops.

v0.2 in `docs/roadmap.md` is named "Machine Bootstrap" and lists exactly two
unshipped items: **bootstrap** and **profiles**. `docs/commands.md` already
promises the syntax. Neither has a spec, a file format, or an implementation.

## Goal

```
$ ops bootstrap dev --yes
```

turns a bare machine into a working one, and running it a second time reports
that everything is already satisfied.

## Decisions

### A profile is config data

`profile.<name>` joins `package`, `repo` and `tool` as a top-level config key,
read by `loadConfig` and overlaid from `~/.config/ops/config.yaml` like
everything else. `config.ts` already anticipates this: *"Unknown keys are kept
so other areas can add their own sections."*

```yaml
profile:
  base:
    summary: What ops itself needs on any machine
    packages: [ca-certificates, curl, git, unzip]

  minimal:
    summary: A machine you can work on over ssh
    extends: base
    packages: [build-essential, openssh-client, tmux, wget]

  dev:
    summary: Local development box
    extends: minimal
    packages: [zsh]
    tools: [node, pnpm]
    setup: [git]
```

No `profiles/` directory, no second file format, no loader. A profile is data
in the file the user already edits.

Three profiles ship: `base`, `minimal` and `dev`. `docs/commands.md` lists
eight speculative names and `docs/features.md` a different seven; both lists
predate any implementation and disagree with each other. Only names that exist
belong in the docs, and the development profile is `dev`, not `developer` — it
is typed far more often than it is read.

`ProfileSchema` is **strict**, unlike the loose `RecipeSchema`. A misspelled
`serivces:` in a loose schema would be kept, silently converge the wrong
machine, and still report success. That is the same reason `SetupStepSchema`
and `RepoSchema` are strict: these keys drive privileged writes.

`mergeConfig` gains one line, `profile: {...defaults.profile, ...user.profile}`.
Without it a user's `profile:` block replaces the whole map and deletes every
built-in profile. Merging is by name, one level deep — the rule `repo` and
`tool` already follow. There is deliberately **no** deep merge inside a
profile, because that is what `extends` is for; two composition mechanisms for
one concept would make "where did this package come from" unanswerable.

### `extends` composes, driven by one table

```ts
const MERGE: Record<SectionName, 'list' | 'keyed-list' | 'object'> = {
  packages: 'list', tools: 'list', setup: 'list',
  services: 'keyed-list', shell: 'object', dotfiles: 'object',
}
```

Phases 2 and 3 add rows of data, not merge code.

- **Lists concatenate**, base first, then the child. A bare list in a child is
  *added* to what `extends` brought in. If it replaced, every child would have
  to restate its base and `extends` would only be useful for the object
  sections. `{add: [...], remove: [...]}` adjusts instead — the same vocabulary
  `package.system` already uses.
- **Deduplicated keeping the first occurrence's position** via
  `[...new Set(...)]`, the primitive `mergeConfig` and `resolveSpecs` already
  use. Base-first order is stable, so a plan diffs cleanly between runs.
- **Multiple parents** resolve left to right; the child always wins last,
  matching the config precedence chain `defaults → global → profile → flags`.
- **A diamond contributes its base once** — profiles are memoised and lists
  deduplicated.
- **Object sections** (`shell`, `dotfiles`) shallow-merge key by key, child
  wins. There is no way to delete an inherited key: the schemas are strict and
  their required fields reject `null`. A child that wants different values
  states them.
- **`services` is keyed by `name`**: a child entry replaces the parent's
  wholesale, in the parent's position. Not per-key, because Zod applies
  `scope`/`enabled`/`state` defaults at parse time — after parsing, what the
  child actually wrote is unrecoverable, and a per-key merge would silently
  resurrect parent values under defaults the child never typed.
- **`summary` is never inherited.** It describes this profile.

### Cross-references are checked eagerly

`profileIndex(profiles, {recipes})` validates the whole graph at construction,
the contract `recipeIndex` established: a bad config fails at load rather than
halfway through a privileged install.

- a dangling `extends` target → `CONFIG_INVALID`, naming the missing profile
- a cycle → `CONFIG_INVALID`, naming the chain (`profile.a → profile.b → profile.a`)
- a `setup:` entry naming a tool with no `tool.<name>.setup` → `CONFIG_INVALID`

`CONFIG_INVALID` is reused rather than joined by a `PROFILE_INVALID`.
`recipeIndex` already owns that code for this exact class of eagerly-detected
config bug; a second code for the same failure mode fragments the vocabulary.

Names in `packages:` and `tools:` are **not** validated. They resolve at run
time through `resolveSpecs`, and the mise registry is a network call.

### `packages:` and `tools:` differ by resolution, not by machinery

Both run through `installPackages`. The difference is one injected dependency:

| Section | `systemPreferred` |
|---|---|
| `packages` | `new Set(config.package.system)` — identical to `ops tool install` |
| `tools` | `new Set()` — a bare name prefers the mise registry |

So `packages: [git]` gives apt's git and `tools: [git]` gives mise's, and a
`tools:` entry may carry `@version`. `resolveSpecs` needs no change; recipes
still beat every heuristic in both.

### The engine is section-based

Adding a section in phase 2 or 3 must not touch the engine.

```ts
export const SECTION_ORDER = ['packages','tools','setup','services','shell','dotfiles'] as const

export type ChangeStatus = 'satisfied' | 'changed' | 'would-change' | 'skipped' | 'failed'

export interface Change {
  /** Stable within the section and across runs: "apt:git", "git/user.email", "docker.service". */
  id: string
  status: ChangeStatus
  detail?: string
  /** argv joined, for the "Would run:" block; set only on `would-change`. */
  command?: string
  error?: string
}

export interface SectionPlan {
  section: SectionName
  changes: Change[]
  commands: string[]
  /** Carried from plan() to apply() untouched by the engine. */
  state?: unknown
}

export interface SectionReport<D = unknown> {
  section: SectionName
  status: 'ok' | 'failed' | 'skipped'
  changes: Change[]
  commands?: string[]
  /** The section's native result (InstallResult, SetupResult, ...); --json only. */
  detail?: D
}

export interface Section<D = unknown> {
  readonly name: SectionName
  /** Inspect and compare only. Must not change the machine. */
  plan(ctx: SectionContext): Promise<SectionPlan>
  /** Apply what plan found pending, then verify. Consent is already collected:
      a section must never gate again. */
  apply(ctx: SectionContext, plan: SectionPlan): Promise<SectionReport<D>>
}

export type SectionRegistry = Partial<Record<SectionName, Section>>
```

**Two methods, not one `converge`.** One confirmation for the whole run is only
possible if every section can be inspected before any section writes.
`installPackages` and `setupTools` already split that way internally through
`dryRun`, so the adapters are nearly free.

**`Change` is uniform; `detail` is open.** The heterogeneity is real — a package
has a version, a service an enable-state, dotfiles a diff — but rendering it
uniformly is what keeps `output.ts` and the `--json` contract closed against new
sections. `Change` is what a human needs; `SectionReport.detail` carries the
section's full native result for `--json` consumers. A phase-2 section adds a
`detail` payload type and no renderer code.

The registry is built by `buildSections(deps)` in `src/core/bootstrap/registry.ts`.
It takes its providers as arguments rather than reaching for them, so it stays in
core and a test can assert exactly which sections a build supports without
loading oclif. Phases 2 and 3 add one entry here and nowhere else.

The engine iterates `SECTION_ORDER`, never the registry, so order is a property
of the run rather than of insertion order in the registry.

### Flow

```
resolve profile ──┬─ PROFILE_NOT_FOUND / CONFIG_INVALID / PROFILE_SECTION_UNSUPPORTED → exit 1
                  └─ ok
  plan(packages) → plan(tools) → plan(setup)    ← read-only; no writes, no declare
        │           (an OpsError here aborts: nothing has changed, so aborting is free)
        ├─ --dry-run ───────────────────────────→ print plan + "Would run:", exit 0
        ├─ pending == 0 ────────────────────────→ print "already satisfied", exit 0
        ├─ pending > 0, no --yes, and (--json or no TTY) → CONFIRMATION_REQUIRED, exit 1
        │
  onPlan(every plan)   ← one plan block, printed before anything runs
        │
  apply(packages) → apply(tools) → apply(setup) ← each applies, then verifies
        │           a failed section marks the rest `skipped` and stops the loop
  render + counts → exit 0, or 1 if any section failed
```

**One confirmation for the whole run**, not one per section — a fresh box would
otherwise ask four questions. The gate policy is copied from the shipped
commands: on a TTY without `--yes`, print the plan and proceed; under `--json`
or a non-TTY with pending changes, require `--yes`. The engine owns the gate and
passes `yes: true` down to `installPackages` and `setupTools` so nothing asks
twice.

**Fail-fast.** A failed section stops the run; every later section is reported
`skipped` and the exit code is 1. Note the granularity honestly:
`installPackages` applies system packages in a single `mise apply` batch, so the
stop happens at the **section boundary**, not at the first bad package. Stopping
mid-batch would mean rewriting the install engine.

`--dry-run` does **not** fail fast. It runs every section so the plan is
complete; stopping early while showing a plan is pointless.

**An undeclared section handler is an error, not a silent skip.** If a profile
declares `services:` and this build has no services section, the run throws
`PROFILE_SECTION_UNSUPPORTED`. Skipping silently means the machine does not
converge while the run still reports `success: true` — the same class of lie the
apt-repo `verify` step exists to prevent. `--skip services` is the explicit
opt-out. The error disappears on its own when phase 2 registers the handler.

### `setup` must not fail at plan time on a bare machine

This is the sharpest interaction in the design, and it breaks the exact case
this feature exists for.

At plan time `setupTools` probes `git --version`. On a fresh machine `git` is
absent, the probe throws `CommandNotFoundError`, and `core/tool/setup.ts`
translates it to *"run `ops tool install git` first"*. The plan reports a
failure, and a `plan()` failure aborts the run — so `ops bootstrap dev`
would die before installing anything.

`SetupDeps` gains one optional dependency:

```ts
/** Tools this run is about to install: a missing binary at probe time is
    pending, not an error. */
assumeInstalled?: ReadonlySet<string>
```

Bootstrap passes the names drawn from the profile's own `packages` and `tools`.
`ops tool setup` calls without it, so its behaviour is unchanged. This is the
only change to shipped logic.

## Command surface

```
ops bootstrap [PROFILE]              # no name → "minimal"
  --dry-run            inspect every section, print the plan, change nothing
  -y, --yes            skip the confirmation gate
  --non-interactive    never prompt (implies --yes)
  --force              switch a package installed from the wrong origin
  --only <section>...  run only these sections (repeatable; exclusive with --skip)
  --skip <section>...  skip these sections
  --json

ops profile list [--json]
ops profile show <NAME> [--json] [--raw]
```

`--only`/`--skip` use `Flags.string({multiple: true, options: [...SECTION_ORDER]})`,
so oclif rejects a misspelled section at parse time and core validates nothing.

`ops bootstrap` with no argument runs `minimal`. That name is a constant in the
command layer, not config data: it is fixed by design rather than tunable, so
there is no key to set and nothing for a user config to override. A user who
wants a different set redefines `profile.minimal`, which merges by name like
every other built-in.

`ops profile show` prints the profile after `extends` composition, with its
lineage; `--raw` prints the literal config entry.

**There is no `ops profile apply`.** It would be a second name for what
`ops bootstrap` does. `profile` is the read-only inspection group; `bootstrap`
is the verb that converges. This follows the precedent that rejected
`ops package` in the tool-command-surface design.

Exit codes: `0` every section ok, or a dry run, or nothing pending; `1` any
failed section or any `OpsError`; `2` an oclif usage error.

### Error codes

Phase 1: `PROFILE_NOT_FOUND`, `PROFILE_SECTION_UNSUPPORTED`.
Phase 2: `SERVICE_UNAVAILABLE`, `SERVICE_COMMAND_FAILED`, `SHELL_UNAVAILABLE`,
`SHELL_CHANGE_FAILED`.
Phase 3: `DOTFILES_UNAVAILABLE`, `DOTFILES_COMMAND_FAILED`.
Reused: `CONFIG_INVALID`, `CONFIRMATION_REQUIRED`.

## Layering

| File | Layer | Phase | Purpose |
|---|---|---|---|
| `config/defaults.yaml` | data | 1 | The built-in profiles |
| `src/core/config.ts` | core | 1 | Profile/service/shell/dotfiles schemas; one line in `mergeConfig` |
| `src/core/profile/resolve.ts` | core | 1 | `profileIndex`, `extends` composition, eager validation, `declaresSection` |
| `src/core/bootstrap/section.ts` | core | 1 | Types only |
| `src/core/bootstrap/run.ts` | core | 1 | The engine |
| `src/core/bootstrap/sections/install.ts` | core | 1 | Adapter over `installPackages`, shared by `packages` and `tools` |
| `src/core/bootstrap/sections/setup.ts` | core | 1 | Adapter over `setupTools` |
| `src/core/tool/setup.ts` | core | 1 | `assumeInstalled` |
| `src/core/output.ts` | core | 1 | Bootstrap and profile renderers; receives `stageReporter` |
| `src/core/errors.ts` | core | 1 | New codes |
| `src/core/bootstrap/registry.ts` | core | 1 | `buildSections` — the one place a phase adds a section |
| `src/commands/bootstrap.ts` | commands | 1 | Wiring, rendering, exit code |
| `src/commands/profile/{list,show}.ts` | commands | 1 | Read-only |
| `src/providers/systemd.ts` | providers | 2 | The only place that runs `systemctl` |
| `src/providers/shell.ts` | providers | 2 | The only place that runs `getent`/`chsh` |
| `src/core/bootstrap/sections/{services,shell}.ts` | core | 2 | Two sections |
| `src/providers/chezmoi.ts` | providers | 3 | The only place that runs `chezmoi` |
| `src/core/dotfiles/manage.ts` | core | 3 | Shared by the section and the `ops dotfiles` group |
| `src/core/bootstrap/sections/dotfiles.ts` | core | 3 | One section |
| `src/commands/dotfiles/{init,diff,apply,update}.ts` | commands | 3 | Four thin commands |

Phase 1 needs **no new provider**. Every call already has one:
`mise-bootstrap.ts`, `mise-tools.ts`, `os.ts`, `deb.ts`, `apt-repo.ts`, and the
executor. Phases 2 and 3 leave `run.ts`, `section.ts` and `profile/resolve.ts`
untouched; a phase-2 author edits `defaults.yaml`, one provider, one section,
one line of the registry, and `errors.ts`.

`src/core/dotfiles/manage.ts` is shared by the bootstrap section and the
`ops dotfiles` commands so neither shells out to the other — the same rule that
forbids the TUI from calling the CLI.

### Two refactors first

`stageReporter` must move from `src/commands/tool/install.ts` to
`src/core/output.ts`. `bootstrap.ts` needs it, and oclif treats every file under
`src/commands/` as a command, so a shared helper there registers as a phantom
command. It is already oclif-free — `write`, `start` and `stop` are injected.

`FakeMise`, `FakeTools`, `FakeDeb` and `FakeRepos` move from inside
`test/core/package/install.test.ts` to `test/helpers/fake-packages.ts`, so the
section tests reuse them instead of copying them.

### Idempotency

Every section is inspect → compare → plan → apply → verify, and the whole run is
the same shape one level up. A satisfied change is never re-applied, so a second
`ops bootstrap dev --yes` reports `satisfied` for everything and touches
nothing. That is the acceptance test, and it only runs honestly in the container
with `mise run up` keeping state between commands.

## Rejected alternatives

**A `profiles/<name>.yaml` directory.** Easier to share one profile over git,
but it needs a directory loader, a search order, filesystem injection into core
for tests, and a rule for a name that exists in both places. The config key
needs none of that and reuses the merge semantics already documented.

**`ops profile apply` alongside `ops bootstrap`.** Two names for one operation.

**`ops bootstrap` reading a default from a config key.** `docs/architecture.md`
sketches `profile: developer` as a scalar, which collides with `profile:` being
the map of profiles. A fixed `minimal` default needs no key and no collision.
That doc line must be corrected or dropped.

**Continuing past a failed section** (with `--fail-fast` opting into stopping).
It gives one complete diagnosis per run instead of one failure at a time, and
every section is independently idempotent so re-running is cheap. Fail-fast was
chosen anyway: a failed `packages` section usually makes the later sections'
output noise rather than signal. `--keep-going` can be added if practice
demands it.

**A dependency graph between sections.** `SECTION_ORDER` is fixed and total;
dependencies are expressed by that order, not declared.

## Risks

**The plan over-reports for `packages`.** `mise bootstrap packages status` only
reports packages already declared in `[bootstrap.packages]`, and the dry-run
branch of `installPackages` correctly does not declare. A package that is
installed but was never declared by ops therefore shows as `would-change` in the
plan and comes back `satisfied` after apply. The plan is advisory; the
apply-phase inspection is authoritative and the final report comes from apply.
Fixing it means probing dpkg directly at plan time, which `providers/system.ts`
can already do — a later refinement, not a blocker.

**Double inspection.** Each section inspects in `plan()` and again inside
`apply()`, because `installPackages` and `setupTools` own their own
inspect→apply→verify. That is the price of one confirmation for the whole run.
Inspection is `mise ls --json` and a few check commands, cheap next to apt, and
the second pass is exactly what makes apply's verify honest.

**`--dry-run` needs mise.** The plan shells out to `mise ... --dry-run`, so a
machine without mise gets `MISE_BOOTSTRAP_UNAVAILABLE` at plan time. mise is the
CLI's own prerequisite, so this is acceptable as long as the user sees that
message rather than a stack trace — which the `catch()` override guarantees.

**The container has no running systemd** (PID 1 is a shell). When phase 2
starts, the `services` section can only be exercised along its `--dry-run` and
`SERVICE_UNAVAILABLE` paths. Real coverage needs a systemd-enabled image
(`--cgroupns=host`, `/sys/fs/cgroup` mounted) or `scope: user`. Decide then;
do not pretend the current image covers it.

## Out of scope

- The global `--profile <name>` flag in its config-layer sense — a different
  concept that belongs with the config-layer work
- `--keep-going` and `--check`
- `ops plan` / `ops apply` across the whole machine (v0.4)
- `ops profile edit` / `ops profile new`
- Backup and restore of a machine's profile
