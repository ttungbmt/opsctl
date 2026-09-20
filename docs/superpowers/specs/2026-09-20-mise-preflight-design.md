# mise preflight — Design

Date: 2026-09-20 · Status: planned

Builds on [`2026-09-20-profile-bootstrap-design.md`](2026-09-20-profile-bootstrap-design.md).
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

The profile-bootstrap design saw this and accepted it, resting on the first
package spec's assumption: *"ops is itself installed through mise, so mise is
always present."* That holds only while ops has exactly one install path, and
`README.md` documents exactly one. ops ships as a self-contained tarball with
Node bundled; it runs the moment it is extracted. Requiring mise first makes ops
the second thing a user installs rather than the first.

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

`ops bootstrap` gains a preflight that runs **before** the section plan pass,
with **its own confirmation gate**. It is deliberately not a section in
`SECTION_ORDER`, and it lives in the command layer rather than inside
`bootstrapProfile`.

The engine's defining invariant is that it plans every declared section before
applying any, which is what lets one confirmation cover the whole run. A
prerequisites *section* would have to apply before the later sections could
plan, breaking exactly that. A `deps.preflight?` hook inside the engine would
keep the letter of the invariant and break its spirit — `bootstrapProfile` would
become a thing that installs software before planning anything. Keeping it in
the command makes the asymmetry visible at the one place that knows this is
`ops bootstrap`, and leaves `run.ts` and `test/core/bootstrap/run.test.ts`
untouched. That the existing engine tests still pass unedited is the evidence
the invariant held.

A bare machine therefore sees two gates. That is the honest shape of the
problem: you cannot consent to a plan that cannot be computed yet.

### Installed with mise's own installer, run as argv

ops cannot install mise through `mise bootstrap packages`; that is the loop
itself. Three channels were examined, and the installer script was read in full
(370 lines) rather than assumed about.

| Channel | Verdict |
|---|---|
| `https://mise.run`, downloaded then executed | **Chosen** |
| `https://mise.jdx.dev/deb` apt repository | Rejected — see below |
| `https://mise.jdx.dev/mise-latest-linux-x64` raw binary | Rejected — no checksum, no arch logic |

**No rule is bent to do this.** The project rule is *argv arrays, never shell
strings*. What violates it is the pipe, not the installer:

```
sh -c "curl https://mise.run | sh"        ← a shell string. Forbidden, rightly.
```

ops does not need the pipe. It downloads the script with `fetchDownload` — the
same HTTPS download, with progress, that `deb.ts` already uses — and then runs
it as argv:

```ts
['sudo', 'env', `MISE_INSTALL_PATH=${path}`, 'sh', downloaded]
```

Downloading before executing is the same trust decision and a strictly better
mechanism: `curl | sh` feeds a shell bytes as they arrive, so a connection that
drops mid-transfer executes half a script. A file that failed to download
completely simply does not run. `env` sits inside the argv because `sudo` resets
the environment.

**What the script does, verified by reading it:**

- **sha256 checksums** (lines 126-151): pinned constants for the current
  release, fetched from GitHub releases otherwise. Not an unverified download.
- **`MISE_INSTALL_PATH`** (line 282) overrides the `$HOME/.local/bin/mise`
  default, so ops can place mise where every shell will find it.
- **Platform coverage** (lines 49-80): linux and macOS; x64, arm64 and armv7;
  detects musl; handles Android/Termux. ops supports apt *and* dnf, and this
  covers both.
- **`MISE_INSTALL_SKIP_IF_EXISTS`** (lines 289-294): idempotency upstream.

**Why not the apt repository.** It was the first choice and it was wrong. Its
appeal was reusing `apt-repo.ts` wholesale, with GPG-signed packages and an
`apt-cache policy` proof that the candidate comes from the right origin — a
genuinely stronger integrity story than TLS. Against it: it covers apt only,
leaving every dnf machine with nothing; it needs a new `system.install()`; and
it cannot ship `repo.mise` without also shipping a `tool.mise` recipe, purely
because `recipeIndex` rejects a repo no recipe references. That last one is
config existing to satisfy an unrelated invariant. The installer route deletes
all three problems and adds no code beyond one small provider.

**Installed to `/usr/local/bin/mise`, with sudo.** It is on every default PATH,
so the rest of the bootstrap — and every later shell — finds mise immediately.
The alternative, `~/.local/bin`, avoids sudo but is only on PATH after a login
that saw the directory exist, which is the classic "installed but not reachable"
trap this project keeps designing against.

The cost is stated plainly: **ops runs a TLS-only script as root.** mise.run
carries no signature (the script itself notes `TODO: verify with minisign or gpg`
for its non-pinned path). Pinning the script's own hash is not viable — it
changes with every mise release, since it embeds that release's checksums. The
mitigations are that the URL is config data shown in the plan before the gate,
and that the download is complete-or-nothing. This was a deliberate choice, not
an oversight.

### Commands that get the preflight

| Command | Preflight | Why |
|---|---|---|
| `ops bootstrap` | **Yes** | It is the command that promises a working machine. |
| `ops tool install` | **Yes** | As dead as bootstrap on a bare machine: `installSystem`'s first statement is `mise.declare(specs)`, and `resolveSpecs` calls `tools.inRegistry` before that. For a tarball user this is the first thing they type. |
| `ops tool setup` | No | It never runs mise; every subprocess is a recipe's own `check`/`run` argv. |
| `ops tool uninstall` | **No** | It does reach for mise, but installing a tool in order to remove something is incoherent — with no mise on the machine, nothing mise-managed can be installed. The existing error is the honest answer. |

`--no-preflight` (`allowNo`, default true) restores today's behaviour on both
commands that have it, the same escape hatch `--skip <section>` gives for an
unsupported section.

### Absent, unhealthy, present

The probe is `mise --version`, spawned, with `stdin: 'ignore'`,
`stdout: 'capture'` and a timeout. Three states, not a boolean:

```ts
export type MiseState =
  | {state: 'present'; version: string}
  | {state: 'unhealthy'; exitCode: number; detail: string}
  | {state: 'absent'}
```

Only `CommandNotFoundError` means absent. A non-zero exit means mise exists and
is broken — installing over it would be the wrong repair, and whichever provider
needs it will fail in its own more specific words, including the
`unrecognized subcommand` heuristic already in `mise-bootstrap.ts:58-66`.

Spawning is the only faithful probe. A PATH walk in core answers a different
question: it cannot see the exec bit, a dangling shim, or an unreadable
interpreter. It also belongs in a provider, because providers own subprocesses.

It needs its own file. `mise-bootstrap.ts` and `mise-tools.ts` each hard-prefix
every call (`['bootstrap','packages',…]`, `['-C','/',…]`) and, more decisively,
both translate `CommandNotFoundError` into `MISE_BOOTSTRAP_UNAVAILABLE` at the
moment it happens — destroying the very missing-versus-broken distinction the
preflight needs. Those throw sites are correct for their callers and stay.

### Verify by probing again

After the installer runs, the preflight probes a second time and fails if mise
is still absent. An exit code is a claim; the probe is the evidence. This is the
rule `installPackages` already follows when it re-reads `mise.status()` rather
than trusting `apply`.

## Shape of the code

```ts
// src/providers/mise-presence.ts
export type MiseState = …
export const PROBE_TIMEOUT_MS = 10_000
export function probeMise(runner: Runner, timeout?: number): Promise<MiseState>

// src/providers/mise-install.ts
export interface MiseInstallOptions {
  nonInteractive: boolean
  capture: boolean
  onProgress?: OnProgress
  onStage?: (stage: Stage) => void
}
export interface MiseInstaller {
  /** What install would run, for --dry-run. No I/O. */
  describe(): string[]
  /** Downloads the installer, then runs it as argv. Never a shell string. */
  install(opts: MiseInstallOptions): Promise<void>
}
export function createMiseInstaller(runner: Runner, source: MiseSource): MiseInstaller

// src/core/change.ts  -- moved out of bootstrap/section.ts
export type ChangeStatus = 'satisfied' | 'changed' | 'would-change' | 'skipped' | 'failed'
export interface Change {…}

// src/core/preflight.ts
export interface PreflightResult {
  action: 'preflight'
  dryRun: boolean
  /** True when mise is on PATH now. False only after a dry run that would have installed it. */
  satisfied: boolean
  changes: Change[]
  commands?: string[]
}
export function ensureMise(options: PreflightOptions, deps: PreflightDeps): Promise<PreflightResult>
```

`Change` and `ChangeStatus` move from `src/core/bootstrap/section.ts` to
`src/core/change.ts`, which `section.ts` re-exports. `ChangeStatus`'s own comment
already calls itself the cross-cutting vocabulary, and a preflight maps onto it
exactly; what would be wrong is `tool install` importing from `core/bootstrap/`,
since it bootstraps nothing. Every existing import keeps compiling.

### Flow

```
probe()
  ├─ present ──────────────────────────────→ satisfied, print nothing, carry on
  ├─ unhealthy ────────────────────────────→ skipped, carry on; not this preflight's repair
  └─ absent
       ├─ --dry-run ─────────────────────────→ "would install mise" + commands, halt, exit 1
       ├─ no --yes and (--json or no TTY) ───→ CONFIRMATION_REQUIRED
       ├─ --non-interactive, sudo not ready ─→ SUDO_PASSWORD_REQUIRED
       │
       onPlan(changes)          ← the command is printed before it runs
       fetchDownload(installer) ← complete-or-nothing
       sudo env MISE_INSTALL_PATH=… sh <file>
       probe() again            ← still absent → MISE_BOOTSTRAP_UNAVAILABLE
       └─────────────────────────────────────→ carry on to the profile plan
```

`BootstrapResult` gains one optional `preflight?: PreflightResult`, attached by
the command layer, never by the engine — a preflight is not a section, so its
change never enters `counts`. A pure `haltedBeforePlan(profile, options, preflight)`
in `run.ts` builds the result for a run that stopped in preflight, so `--json`
stays a single document with one definition of its shape.

**`--dry-run` on a bare machine exits 1.** It cannot compute the section plans,
because every section probe is a mise call. `run.ts` already states the rule a
dry run follows — it fails when a plan could not be computed, because printing
findings beside exit 0 lies. Here *no* plan could be computed, so ops prints the
preflight plan, says plainly why the rest is missing, and exits 1.

### Idempotency

The preflight is inspect → compare → plan → apply → verify, and its compare step
is one cheap probe. On a machine that has mise — every machine after the first
run — it does nothing, calls nothing, and prints nothing.

### Error codes

No new codes. `CONFIRMATION_REQUIRED`, `SUDO_PASSWORD_REQUIRED`,
`DOWNLOAD_FAILED` (from `deb.ts`'s `fetchDownload`) and
`MISE_BOOTSTRAP_UNAVAILABLE` (for "installed, but mise is still not on PATH")
already mean exactly what is needed. A second code for an existing condition
would force callers to match two.

### Config data

```yaml
# defaults.yaml
mise:
  # Where ops gets mise when a machine has none. It cannot use `mise bootstrap
  # packages` for this -- that is the loop itself. ops downloads this script and
  # runs it as argv rather than piping it into a shell: same trust, but a
  # truncated download cannot half-execute.
  installer: https://mise.run
  # /usr/local/bin is on every default PATH, so the rest of the bootstrap and
  # every later shell find mise immediately. ~/.local/bin is only on PATH after a
  # login that saw the directory exist.
  path: /usr/local/bin/mise
```

## Rejected alternatives

**mise's apt repository.** Stronger integrity (GPG, `apt-cache policy`), but
apt-only, needs `system.install()`, and cannot ship without a `tool.mise` recipe
whose only job is to satisfy `recipeIndex`'s unreferenced-repo guard. See
*Decisions*.

**`curl https://mise.run | sh`.** Same script, worse mechanism: it is a shell
string, and it lets a partial download execute.

**The raw binary at `mise.jdx.dev/mise-latest-linux-x64`.** No checksum, no arch
or libc detection — ops would have to reimplement what the script already does.

**A `prerequisites` section at the head of `SECTION_ORDER`.** It would have to
apply before the other sections could plan, turning one plan pass into
plan-apply-plan and ending "one plan for the whole run".

**A separate `ops doctor --fix`.** On the roadmap and eventually the right home,
but building a command group to answer "bootstrap should work on a bare machine"
is the wrong order.

## Risks

**The installer needs `curl` or `wget`, and a minimal image has neither.**
Verified: `ubuntu:24.04` ships `sha256sum` but no `curl` and no `wget`, and the
script (lines 246-256) errors without one. Real Ubuntu, Debian and Fedora
installs include them, so the user-facing scenario is covered; container images
are the gap. ops downloads the *script* itself with Node's fetch, so this affects
only the tarball the script then pulls. The failure is loud and the message is
the script's own. This is the one place the apt route was genuinely more robust,
and it is the reason to revisit if minimal images become a target.

**ops runs a TLS-only script as root.** See *Decisions*. Not pinnable, mitigated
by showing the URL before the gate and by complete-or-nothing download.

**The `--dry-run` hole.** On a bare machine `ops bootstrap --dry-run` can never
show the section plan. The alternatives are worse: installing under `--dry-run`
breaks the flag; synthesising a plan from the profile's name lists would be a
fabrication; exiting 0 would tell a script "nothing to see". A cautious user
takes two steps on a bare machine, and `--no-preflight` restores today's
behaviour.

**Installing before the profile plan is shown.** The preflight has its own gate,
so nothing is installed unseen under `--json` or a pipe. But on a TTY this
project's house style treats *printing* the plan as consent — there is no
interactive prompt anywhere in the codebase — so an interactive user gets mise
installed without typing anything. The preflight inherits that weakness rather
than introducing it, and it is the sharpest instance of it. If ops ever grows a
real prompt, this is the first place it belongs.

**`ops tool install jq` can now install mise.** A consequence of putting the
preflight on every command that needs mise. Only ever mise, only when absent,
and only through the gate.

**Two mises.** A user whose mise came from `curl https://mise.run | sh` has one
at `~/.local/bin/mise`; ops installs to `/usr/local/bin/mise`. The probe would
find the existing one first and do nothing, so this only arises if the older one
is not on PATH — in which case installing is correct. Worth a README line.

**Stale messages elsewhere.** The three sites that say *"mise not found on PATH;
install it from https://mise.jdx.dev"* (`mise-bootstrap.ts:52-56`,
`mise-tools.ts:66-70`, `mise-config.ts:190-193`) now understate the options; they
should also mention `ops bootstrap`. Cheap, and it closes the loop for anyone who
reaches them via `--no-preflight` or `ops tool setup`.

**`ops tool uninstall mise` is not guarded.** Out of scope here, but it would
cheerfully remove the tool ops runs on.

## Out of scope

- **mise present but too old.** `mise-bootstrap.ts` detects it with a stderr
  regex rather than a version comparison, and `mise-tools.ts` has no such branch.
  Worth fixing; not this.
- **mise present but not shell-activated**, so tools ops installs are not on the
  user's PATH. The likelier everyday failure, and a different design. The
  preflight will print one advisory line after installing mise, and nothing more.
- A guard on removing mise.
- `ops doctor` / `ops system doctor`.
