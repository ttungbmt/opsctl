# mise preflight — Design

Date: 2026-09-20 · Status: planned

Builds on [`2026-09-20-profile-bootstrap-design.md`](2026-09-20-profile-bootstrap-design.md)
and [`2026-09-20-apt-repo-design.md`](2026-09-20-apt-repo-design.md).
Supersedes that spec's **`--dry-run` needs mise** risk.

## Problem

`ops bootstrap` promises to turn a bare machine into a working one. It cannot,
because it runs on mise: every section's `plan()` shells out to it. On a machine
without mise the plan pass dies before anything is inspected.

```
$ ops bootstrap dev
 ›   Error: mise not found on PATH; install it from https://mise.jdx.dev
 ›   Code: MISE_BOOTSTRAP_UNAVAILABLE
```

The profile-bootstrap design saw this and accepted it:

> **`--dry-run` needs mise.** […] mise is the CLI's own prerequisite, so this is
> acceptable as long as the user sees that message rather than a stack trace.

The justification came from the first package spec: *"ops is itself installed
through mise, so mise is always present."* That is true only while ops has
exactly one install path. `README.md` documents exactly one, so the assumption
holds today — and that is the thing worth changing. ops ships as a self-contained
tarball with Node bundled; it can run the moment it is extracted. Requiring the
user to install mise first makes ops the second thing they install rather than
the first.

There is also an asymmetry worth naming. Phase 1 already fixed the case where a
*target* tool is missing at plan time — `assumeInstalled` exists so the `setup`
section can plan for a tool the same run will install. A missing *prerequisite*
still just fails.

## Goal

```
$ curl -L .../opsctl-linux-x64.tar.gz | tar xz
$ ./bin/ops bootstrap dev --yes
```

works on a machine with nothing on it. ops is the only thing you download.

## Decisions

### A preflight, not a section

`ops bootstrap` gains a preflight step that runs **before** the section plan
pass, with **its own confirmation gate**. It is deliberately not a section in
`SECTION_ORDER`.

The engine's defining invariant is that it plans every declared section before
applying any, which is what lets one confirmation cover the whole run. A
prerequisites *section* would have to apply before the later sections could
plan, breaking exactly that. Rather than weaken the invariant for one package,
the preflight sits outside the engine and owns its own small gate. `run.ts` and
`section.ts` are untouched.

That does mean a bare machine sees two gates: one for mise, one for the profile.
That is the honest shape of the problem — you cannot consent to a plan that
cannot be computed yet.

### Installed from mise's own apt repository

ops cannot install mise through `mise bootstrap packages`; that is the loop
itself. Three channels were checked live:

| Channel | Verdict |
|---|---|
| `https://mise.jdx.dev/deb` (200, `Suite: stable`, `Components: main`) | **Chosen** |
| `https://mise.jdx.dev/mise-latest-linux-x64` (200) | Rejected |
| `curl https://mise.run \| sh` | Rejected |

The apt repo wins because `src/providers/apt-repo.ts` already does all of it:
writes `/etc/apt/{keyrings,sources.list.d,preferences.d}/ops-mise.*`, runs
`apt-get update`, and proves with `apt-cache policy` that apt's candidate really
comes from the repo. Afterwards mise is an ordinary apt package with an ordinary
update path. Ubuntu ships no `mise` package, so no pin is needed.

The standalone binary was rejected because it would land in `~/.local/bin`,
which is not guaranteed to be on PATH — installing a tool the user then cannot
invoke is the exact failure this project keeps designing against.

`curl | sh` was rejected because it violates a hard project rule: processes run
through the executor with argv arrays, never shell strings. A tool whose job is
to make machine setup auditable should not normalise piping a remote script into
a shell, and ops could not describe what such a script would do under
`--dry-run`.

### Every command that needs mise

`bootstrap`, `tool install` and `tool uninstall` all reach for mise immediately,
so all three run the preflight. `tool setup` does not — it only runs a recipe's
`check`/`run` commands through the executor.

The cost is that `ops tool install jq` can now write under `/etc/apt`. The gate
is what keeps that from being a surprise, and when mise is already present the
preflight probes once and returns, so a normal machine sees no difference at
all.

### The repo needs a recipe to reference it

`recipeIndex` throws `CONFIG_INVALID` for any `repo.<name>` no recipe
references — that check is how a misspelled `repo:` key surfaces at all. So
`repo.mise` alone would break every command at config load. `tool.mise` ships
with it:

```yaml
repo:
  mise:
    uri: https://mise.jdx.dev/deb
    suite: stable
    components: [main]
    keyring: https://mise.jdx.dev/gpg-key.pub

tool:
  mise:
    summary: The tool and runtime manager ops itself runs on
    package: apt:mise
    repo: mise
```

This is not a workaround. The recipe is true — `apt:mise` really is the package,
served by that repo — and it makes `ops tool install mise` meaningful for a user
who installed mise by hand and wants it apt-managed. The preflight reads both
from the config through `recipeIndex` rather than hard-coding them, so the URLs
stay data.

### Absent, not broken

The probe is `mise --version`. `CommandNotFoundError` means absent; a non-zero
exit means mise is present but unhappy, which this preflight deliberately does
not touch. Installing over a broken mise would replace one confusing failure
with another.

### Verify by probing again

After `repos.ensure` and `system.install`, the preflight probes a second time and
throws `MISE_INSTALL_FAILED` if mise is still absent. An exit code is a claim;
the probe is the evidence. This is the same rule `installPackages` follows when
it re-reads `mise.status()` rather than trusting `apply`.

## Shape of the code

```ts
// src/providers/mise.ts
export interface MisePresence {present: boolean; version?: string}
export interface MiseProbe {probe(): Promise<MisePresence>}
export function createMiseProbe(runner: Runner): MiseProbe

// src/providers/system.ts -- added to SystemPackages
install(specs: PackageSpec[], opts: InstallOptions): Promise<{exitCode: number}>
describeInstall(specs: PackageSpec[]): string[]

// src/core/preflight/mise.ts
export interface PreflightResult {
  action: 'preflight'
  /** True when mise was already there; the caller prints nothing. */
  satisfied: boolean
  success: boolean
  changes: Change[]
  /** Dry run only. */
  commands?: string[]
}
export async function ensureMise(options: PreflightOptions, deps: PreflightDeps): Promise<PreflightResult>
```

`system.install`'s argv matches the path mise already uses, and puts `env` inside
the argv because `sudo` filters the environment:

```ts
['sudo', 'env', 'DEBIAN_FRONTEND=noninteractive', 'apt-get', 'install', '-y', '--', ...names]
```

`Change` and `ChangeStatus` move from `src/core/bootstrap/section.ts` to
`src/core/change.ts`, which `section.ts` re-exports. `tool install` must not
import from `core/bootstrap/` — it bootstraps nothing — and a unit of convergence
was never a bootstrap-specific idea.

### Flow

```
probe()
  ├─ present ────────────────────────────→ satisfied, print nothing, carry on
  └─ absent
       ├─ manager is not apt ────────────→ UNSUPPORTED_PLATFORM, with manual instructions
       ├─ --dry-run ─────────────────────→ "would install mise" + commands, stop, exit 0
       ├─ pending, no --yes, (--json or no TTY) → CONFIRMATION_REQUIRED
       ├─ --non-interactive without ready sudo  → SUDO_PASSWORD_REQUIRED
       │
       onPlan(changes)
       repos.ensure(repo.mise, "mise")   ← keyring, sources, pin, apt-get update, apt-cache policy
       system.install(["apt:mise"])
       probe()  ← still absent → MISE_INSTALL_FAILED
       └────────────────────────────────→ carry on to the profile plan
```

### Idempotency

The preflight is inspect → compare → plan → apply → verify like everything else,
and its compare step is a single cheap probe. On a machine that has mise — which
is every machine after the first run — it does nothing and says nothing.

### Error codes

New: `MISE_INSTALL_FAILED`, `INSTALL_UNAVAILABLE`.
Reused: `UNSUPPORTED_PLATFORM`, `CONFIRMATION_REQUIRED`, `SUDO_PASSWORD_REQUIRED`,
`REPO_SETUP_FAILED`, `REPO_PIN_UNSATISFIED`.

`system.ts`'s error wrapper currently hard-codes *"ops cannot remove {manager}
packages here"*. It takes the verb now, so install failures do not claim to be
removals.

## Rejected alternatives

**A `prerequisites` section at the head of `SECTION_ORDER`.** It would have to
apply before the other sections could plan, turning one plan pass into
plan-apply-plan and ending "one plan for the whole run".

**A separate `ops doctor --fix`.** It is on the roadmap and would be a fine home
for this eventually, but it does not exist, and building a command group to
answer "bootstrap should work on a bare machine" is the wrong order.

**Leaving it as a clear error.** That is today's behaviour, and it is defensible
— right up until ops is something you can download and run. Once the tarball path
is documented, the error is a dead end the tool could have walked past.

## Risks

**apt only.** mise publishes an rpm repo (`https://mise.jdx.dev/rpm`, verified
200) but ops has no dnf-repo provider, and writing one is a separate piece of
work. dnf machines get `UNSUPPORTED_PLATFORM` naming the manual install. This
keeps the preflight from being the thing that drags a whole new provider in.

**`--dry-run` cannot show the profile plan on a bare machine.** The preflight
reports what it would do and stops, because `plan()` needs mise. Exit 0 — nothing
failed, the picture is just incomplete, and ops says so rather than pretending.

**The preflight installs before the profile plan is shown.** It has its own gate,
so nothing is installed unseen, but it genuinely is a second gate and a partial
break of the one-plan promise. Confining it to exactly one package is what keeps
the cost proportionate.

**`ops tool install <x>` can now configure an apt repo.** A consequence of
running the preflight on every command that needs mise. Only ever for mise, only
when mise is absent, and only through the gate.

## Out of scope

- **mise present but too old.** `mise-bootstrap.ts` detects it with a stderr
  regex (`/unrecognized subcommand/`) rather than a version comparison, and
  `mise-tools.ts` has no such branch at all. Worth fixing; not this.
- **mise present but not shell-activated**, so a tool ops installs is not on the
  user's PATH. The likelier everyday failure, and a different design.
- A dnf repo provider.
- `ops doctor` / `ops system doctor`.
