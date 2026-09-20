# mise Preflight Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `ops bootstrap` and `ops tool install` install mise themselves when a machine has none, so ops is the only thing a user downloads.

**Architecture:** A preflight in the command layer, before the section plan pass, with its own confirmation gate. It probes `mise --version` (three states: present / unhealthy / absent), and when absent downloads mise's official installer and runs it as argv — never a shell pipe. The bootstrap engine is untouched; a run that stops in preflight returns a `BootstrapResult` built by a pure helper so `--json` stays one document.

**Tech Stack:** TypeScript (NodeNext — relative imports need `.js`), oclif, Zod v4, Vitest, pnpm workspace. No new runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-09-20-mise-preflight-design.md`

## Global Constraints

- **Layers.** `src/commands` (thin oclif) → `src/core` → `src/providers` → `src/executor`. Only `src/providers/*` may run subprocesses or reach the network. Core must never import `@oclif/core`.
- **Subprocesses take argv arrays, never shell strings.** This is the whole reason the installer is downloaded and then run as `['sudo','env',…,'sh',file]` rather than piped. Do not "simplify" it back into `sh -c`.
- **Only `CommandNotFoundError` means mise is absent.** A non-zero exit means mise exists and is broken; the preflight must not install over it.
- **Verify by state, not by exit code.** The installer's exit code is reported, never trusted; the preflight re-probes and decides from that.
- **Default data lives in `apps/cli/config/defaults.yaml`**, not in TypeScript constants. The installer URL and install path are config.
- **Render functions take an injected `Style`** defaulting to `plainStyle`, and **pad before painting** — escape codes count toward `.length`.
- **Every test uses a fake runner or fake provider.** Nothing under `apps/cli/test` starts a subprocess or touches the network.
- **`src/core/bootstrap/run.ts`'s `bootstrapProfile` body must not change.** `test/core/bootstrap/run.test.ts`'s existing cases passing unedited is the evidence the engine invariant held.
- **Commands:** `pnpm build`, `pnpm typecheck`, `pnpm test`. Single file: `pnpm --filter @ops/cli exec vitest run <path>`. Container: `mise run docker:run <cmd>`; `mise run up` first when state must survive.
- **Baseline: 407 tests passing.** Commit after every task; messages end with `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`.

---

## File Structure

**Created**

| File | Responsibility |
|---|---|
| `apps/cli/src/core/change.ts` | `Change` / `ChangeStatus` — the convergence vocabulary, no longer a bootstrap concept |
| `apps/cli/src/providers/mise-presence.ts` | `probeMise` — the only place that asks whether mise exists |
| `apps/cli/src/providers/mise-install.ts` | `createMiseInstaller` — download the official installer, run it as argv |
| `apps/cli/src/core/preflight.ts` | `ensureMise` — inspect → plan → confirm → install → verify |

**Modified**

| File | Change |
|---|---|
| `apps/cli/src/core/bootstrap/section.ts` | Delete the two declarations, re-export them from `../change.js` |
| `apps/cli/src/core/config.ts` | `MiseSchema`; `mise` on `DefaultsSchema` and `UserSchema`; one line in `mergeConfig` |
| `apps/cli/config/defaults.yaml` | `mise.installer`, `mise.path` |
| `apps/cli/src/core/bootstrap/run.ts` | `BootstrapResult.preflight?`; `haltedBeforePlan()` |
| `apps/cli/src/core/package/install.ts` | `InstallResult.preflight?`; `haltedBeforeInstall()` |
| `apps/cli/src/core/output.ts` | `renderPreflight`, `renderPreflightPlan` |
| `apps/cli/src/commands/bootstrap.ts` | `--preflight` (allowNo), call `ensureMise`, halt or continue |
| `apps/cli/src/commands/tool/install.ts` | same |
| `apps/cli/src/providers/{mise-bootstrap,mise-tools,mise-config}.ts` | the stale "install it from …" messages also mention `ops bootstrap` |
| `apps/cli/test/helpers/fake-runner.ts` | `missing(cmd)` — makes `run` throw `CommandNotFoundError` |
| `README.md`, `docs/commands.md`, `CLAUDE.md` | tarball install path; preflight documented |

---

### Task 1: Move `Change` and `ChangeStatus` out of the bootstrap namespace

`ops tool install` is about to need this vocabulary, and it must not import from `core/bootstrap/` — it bootstraps nothing. Pure move; the existing suite is the test.

**Files:**
- Create: `apps/cli/src/core/change.ts`
- Modify: `apps/cli/src/core/bootstrap/section.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `ChangeStatus` and `Change` exported from `src/core/change.js`, and still re-exported from `src/core/bootstrap/section.js` so `run.ts`, `output.ts`, `sections/install.ts`, `sections/setup.ts` and `test/core/bootstrap/run.test.ts` keep compiling unchanged.

- [ ] **Step 1: Create the new module**

Create `apps/cli/src/core/change.ts` with the two declarations moved verbatim from `section.ts`, the doc comment widened from "every section" to "every convergeable area":

```ts
/**
 * The five outcomes every convergeable area collapses into. Deliberately the union of what
 * PackageStatus and SetupStatus already say, so a new area's own vocabulary (already-enabled
 * / enabled / would-enable) maps in without widening this type -- which is what lets one
 * renderer and one --json shape cover all of them.
 */
export type ChangeStatus = 'satisfied' | 'changed' | 'would-change' | 'skipped' | 'failed'

export interface Change {
  /** Stable within its area and across runs: "apt:git", "git/user.email", "mise". */
  id: string
  status: ChangeStatus
  /** One line of human detail: a version, a target, a reason. */
  detail?: string
  /** argv joined; set on `would-change`, collected into the run's "Would run:" block. */
  command?: string
  error?: string
}
```

- [ ] **Step 2: Re-export from `section.ts`**

In `apps/cli/src/core/bootstrap/section.ts`, delete the `ChangeStatus` and `Change` declarations (with their comments) and add near the top:

```ts
// A change is not a bootstrap concept -- the mise preflight reports them too, and
// `ops tool install` must not import from core/bootstrap/.
export type {Change, ChangeStatus} from '../change.js'
```

`section.ts` uses `Change` in `SectionPlan` and `SectionReport`, so also add the type import it now needs:

```ts
import type {Change} from '../change.js'
```

- [ ] **Step 3: Verify nothing else changed**

Run: `pnpm typecheck && pnpm test`
Expected: PASS, 407 tests, no test file edited.

- [ ] **Step 4: Commit**

```bash
git add apps/cli/src/core/change.ts apps/cli/src/core/bootstrap/section.ts
git commit -m "refactor: move Change out of the bootstrap namespace

The mise preflight reports changes too, and ops tool install must not import
from core/bootstrap -- it bootstraps nothing.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: `probeMise`

**Files:**
- Create: `apps/cli/src/providers/mise-presence.ts`
- Modify: `apps/cli/test/helpers/fake-runner.ts`
- Test: `apps/cli/test/providers/mise-presence.test.ts`

**Interfaces:**
- Consumes: `Runner`, `CommandNotFoundError`.
- Produces: `type MiseState`, `const PROBE_TIMEOUT_MS = 10_000`, `probeMise(runner: Runner, timeout?: number): Promise<MiseState>`, and `FakeRunner.missing(cmd: string): this`.

- [ ] **Step 1: Teach `FakeRunner` to be missing a binary**

In `apps/cli/test/helpers/fake-runner.ts`, add the import and a set, and check it first in `run`:

```ts
import {CommandNotFoundError} from '../../src/core/errors.js'
```

```ts
  private absent = new Set<string>()

  /** Makes `cmd` behave as if it is not on PATH, the way execa reports ENOENT. */
  missing(cmd: string): this {
    this.absent.add(cmd)
    return this
  }
```

and as the first two lines of `run`, before `this.calls.push(...)`:

```ts
    if (this.absent.has(cmd)) throw new CommandNotFoundError(cmd)
```

- [ ] **Step 2: Write the failing tests**

Create `apps/cli/test/providers/mise-presence.test.ts`:

```ts
import {describe, expect, it} from 'vitest'
import {CommandNotFoundError} from '../../src/core/errors.js'
import {PROBE_TIMEOUT_MS, probeMise} from '../../src/providers/mise-presence.js'
import {FakeRunner} from '../helpers/fake-runner.js'

describe('probeMise', () => {
  it('is absent only when the binary is not on PATH', async () => {
    expect(await probeMise(new FakeRunner().missing('mise'))).toEqual({state: 'absent'})
  })

  it('reports the version from the first token of the output', async () => {
    const runner = new FakeRunner().on('mise --version', {stdout: '2026.9.11 linux-x64 (abc 2026-09-11)\n'})
    expect(await probeMise(runner)).toEqual({state: 'present', version: '2026.9.11'})
  })

  it('treats a non-zero exit as unhealthy, never as absent', async () => {
    // mise exists and is broken. Installing over it would be the wrong repair.
    const runner = new FakeRunner().on('mise --version', {exitCode: 1, stderr: 'config error\n'})
    expect(await probeMise(runner)).toEqual({state: 'unhealthy', exitCode: 1, detail: 'config error'})
  })

  it('synthesises a detail when a failing mise says nothing', async () => {
    const runner = new FakeRunner().on('mise --version', {exitCode: 2})
    expect(await probeMise(runner)).toEqual({state: 'unhealthy', exitCode: 2, detail: 'mise --version exited 2'})
  })

  it('probes without prompting, printing or hanging', async () => {
    const runner = new FakeRunner().on('mise --version', {stdout: '2026.9.11\n'})
    await probeMise(runner)
    expect(runner.calls[0]).toEqual({
      cmd: 'mise',
      args: ['--version'],
      opts: {stdin: 'ignore', stdout: 'capture', timeout: PROBE_TIMEOUT_MS},
    })
  })

  it('lets an unrelated error through', async () => {
    const boom = new Error('boom')
    const runner = {
      async run() {
        throw boom
      },
    }
    await expect(probeMise(runner)).rejects.toThrow(boom)
  })
})
```

- [ ] **Step 3: Run to verify they fail**

Run: `pnpm --filter @ops/cli exec vitest run test/providers/mise-presence.test.ts`
Expected: FAIL — cannot resolve `src/providers/mise-presence.js`.

- [ ] **Step 4: Implement**

Create `apps/cli/src/providers/mise-presence.ts`:

```ts
import {CommandNotFoundError} from '../core/errors.js'
import type {Runner} from '../executor/exec.js'

/**
 * Whether the `mise` binary is where a subprocess would find it. Three states rather than a
 * boolean: "missing" and "there but not answering" call for opposite responses, and the
 * preflight installs only for the first.
 */
export type MiseState =
  | {state: 'present'; version: string}
  | {state: 'unhealthy'; exitCode: number; detail: string}
  | {state: 'absent'}

/** A wedged mise must not hold the CLI open; a healthy one answers in milliseconds. */
export const PROBE_TIMEOUT_MS = 10_000

/**
 * Asks exactly the question execa will ask later: is there a `mise` on PATH, and does it run?
 * Spawning is the only faithful probe -- walking PATH in core answers a different question,
 * since it cannot see the exec bit, a dangling shim, or an unreadable interpreter.
 *
 * CommandNotFoundError is the ONLY signal for "absent". A non-zero exit means mise exists and
 * is broken, which is a different repair: installing over it would be the wrong one, and the
 * provider that needs it fails in its own, more specific words.
 */
export async function probeMise(runner: Runner, timeout: number = PROBE_TIMEOUT_MS): Promise<MiseState> {
  let result
  try {
    result = await runner.run('mise', ['--version'], {stdin: 'ignore', stdout: 'capture', timeout})
  } catch (error) {
    if (error instanceof CommandNotFoundError) return {state: 'absent'}
    throw error
  }

  if (result.exitCode !== 0) {
    return {
      detail: result.stderr.trim() || result.stdout.trim() || `mise --version exited ${result.exitCode}`,
      exitCode: result.exitCode,
      state: 'unhealthy',
    }
  }

  // "2026.9.11 linux-x64 (a1b2c3d 2026-09-11)" -- the first token is the version.
  return {state: 'present', version: result.stdout.trim().split(/\s+/)[0] ?? ''}
}
```

- [ ] **Step 5: Run to verify they pass**

Run: `pnpm --filter @ops/cli exec vitest run test/providers/mise-presence.test.ts && pnpm typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/cli/src/providers/mise-presence.ts apps/cli/test/providers/mise-presence.test.ts apps/cli/test/helpers/fake-runner.ts
git commit -m "feat(mise): probe whether mise is present, absent or broken

Three states, not a boolean: only ENOENT means absent, because installing over
a mise that exists and is misbehaving would be the wrong repair.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: `mise.installer` and `mise.path` as config

**Files:**
- Modify: `apps/cli/src/core/config.ts`, `apps/cli/config/defaults.yaml`
- Test: `apps/cli/test/core/config.test.ts`

**Interfaces:**
- Produces: `type MiseConfig = {installer: string; path: string}` exported from `src/core/config.js`, and `Config['mise']: MiseConfig | undefined`.

Deliberately optional rather than given a TypeScript default: a default in code would contradict "default data lives in `defaults.yaml`", and the existing config tests build minimal defaults that carry no `mise` block. The preflight reports the missing config rather than guessing a URL.

- [ ] **Step 1: Write the failing tests**

Append to `apps/cli/test/core/config.test.ts`:

```ts
describe('mise', () => {
  it('reads the installer and install path', async () => {
    const config = await load(undefined, DEFAULTS + 'mise:\n  installer: https://mise.run\n  path: /usr/local/bin/mise\n')
    expect(config.mise).toEqual({installer: 'https://mise.run', path: '/usr/local/bin/mise'})
  })

  it('is undefined when the config says nothing', async () => {
    expect((await load()).mise).toBeUndefined()
  })

  it('rejects a non-https installer', async () => {
    // The script is downloaded and run as root; plain http is not negotiable.
    const error = await errorOf(load(undefined, DEFAULTS + 'mise:\n  installer: http://mise.run\n  path: /usr/local/bin/mise\n'))
    expect(error.code).toBe('CONFIG_INVALID')
  })

  it('rejects a relative install path', async () => {
    const error = await errorOf(load(undefined, DEFAULTS + 'mise:\n  installer: https://mise.run\n  path: bin/mise\n'))
    expect(error.code).toBe('CONFIG_INVALID')
  })

  it('lets a user override the installer wholesale', async () => {
    const defaults = DEFAULTS + 'mise:\n  installer: https://mise.run\n  path: /usr/local/bin/mise\n'
    const config = await load('mise:\n  installer: https://mirror.test/mise.sh\n  path: /opt/mise\n', defaults)
    expect(config.mise).toEqual({installer: 'https://mirror.test/mise.sh', path: '/opt/mise'})
  })

  it('ships an installer and a path in the real defaults', async () => {
    const config = await loadConfig(async (path) => readFile(path, 'utf8'), '/nonexistent/ops.yaml', defaultsPath())
    expect(config.mise).toEqual({installer: 'https://mise.run', path: '/usr/local/bin/mise'})
  })
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @ops/cli exec vitest run test/core/config.test.ts`
Expected: FAIL — `config.mise` is undefined for the first test.

- [ ] **Step 3: Add the schema**

In `apps/cli/src/core/config.ts`, after `ProfileSchema` and before `DefaultsSchema`:

```ts
/**
 * Where ops gets mise on a machine that has none. Strict, and https-only: the script is
 * downloaded and run as root, so the protocol check belongs at the config boundary rather
 * than in the provider that runs it.
 */
const MiseSchema = z.strictObject({
  installer: HttpsUrl,
  path: z.string().min(1).refine((value) => value.startsWith('/'), {message: 'must be an absolute path'}),
})

export type MiseConfig = z.infer<typeof MiseSchema>
```

Add to `DefaultsSchema`:

```ts
  /** Where ops gets mise when a machine has none; the preflight reads it. */
  mise: MiseSchema.optional(),
```

Add to `UserSchema`:

```ts
  /** Replaced wholesale, like a repo or a recipe: both fields belong together. */
  mise: MiseSchema.optional(),
```

And one line in `mergeConfig`'s returned object, beside `profile`:

```ts
    ...(user.mise || defaults.mise ? {mise: user.mise ?? defaults.mise} : {}),
```

- [ ] **Step 4: Ship the data**

Append to `apps/cli/config/defaults.yaml`:

```yaml
# Where ops gets mise when a machine has none. It cannot use `mise bootstrap packages`
# for this -- that is the loop itself. ops downloads this script and runs it as argv
# rather than piping it into a shell: the same trust, but a truncated download cannot
# half-execute, which `curl | sh` permits. The script verifies sha256 checksums and
# detects OS, architecture and libc itself.
mise:
  installer: https://mise.run
  # /usr/local/bin is on every default PATH, so the rest of the run and every later
  # shell find mise immediately. ~/.local/bin is only on PATH after a login that saw
  # the directory already exist.
  path: /usr/local/bin/mise
```

- [ ] **Step 5: Run to verify they pass**

Run: `pnpm --filter @ops/cli exec vitest run test/core/config.test.ts && pnpm typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/cli/src/core/config.ts apps/cli/config/defaults.yaml apps/cli/test/core/config.test.ts
git commit -m "feat(config): add mise.installer and mise.path

https-only at the config boundary, because the script is downloaded and run as
root; optional rather than defaulted in TypeScript, because default data belongs
in defaults.yaml.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: The mise installer provider

**Files:**
- Create: `apps/cli/src/providers/mise-install.ts`
- Test: `apps/cli/test/providers/mise-install.test.ts`

**Interfaces:**
- Consumes: `Download`, `fetchDownload`, `OnProgress` from `src/providers/deb.js`; `Stage` from `src/core/stage.js`; `MiseConfig` from `src/core/config.js`.
- Produces:

```ts
export interface MiseInstallOptions {
  nonInteractive: boolean
  capture: boolean
  onProgress?: OnProgress
  onStage?: (stage: Stage) => void
}
export interface MiseInstaller {
  describe(): string[]
  install(opts: MiseInstallOptions): Promise<{exitCode: number}>
}
export function createMiseInstaller(runner: Runner, source: MiseConfig, download?: Download): MiseInstaller
```

`install` returns the exit code rather than throwing on it: the preflight verifies by probing, never by trusting a status. The https check lives in the config schema (Task 3), so this provider does not repeat it.

- [ ] **Step 1: Write the failing tests**

Create `apps/cli/test/providers/mise-install.test.ts`:

```ts
import {describe, expect, it} from 'vitest'
import type {Stage} from '../../src/core/stage.js'
import {createMiseInstaller} from '../../src/providers/mise-install.js'
import {FakeRunner} from '../helpers/fake-runner.js'

const SOURCE = {installer: 'https://mise.run', path: '/usr/local/bin/mise'}

/** Records what would have been downloaded and writes nothing. */
function fakeDownload() {
  const calls: {url: string; dest: string}[] = []
  return {calls, download: async (url: string, dest: string) => void calls.push({dest, url})}
}

const opts = (o: Partial<Parameters<ReturnType<typeof createMiseInstaller>['install']>[0]> = {}) => ({
  capture: false,
  nonInteractive: false,
  ...o,
})

describe('createMiseInstaller', () => {
  it('runs the downloaded script as argv, never as a shell string', async () => {
    // A pipe is what the argv rule forbids; the official installer is not.
    const runner = new FakeRunner().on('sudo', {exitCode: 0})
    const d = fakeDownload()
    await createMiseInstaller(runner, SOURCE, d.download).install(opts())

    expect(d.calls).toHaveLength(1)
    expect(d.calls[0].url).toBe('https://mise.run')
    const call = runner.calls[0]
    expect(call.cmd).toBe('sudo')
    expect(call.args.slice(0, 3)).toEqual(['env', 'MISE_INSTALL_PATH=/usr/local/bin/mise', 'sh'])
    expect(call.args[3]).toBe(d.calls[0].dest)
    expect(call.args).toHaveLength(4)
  })

  it('reports a non-zero exit instead of throwing', async () => {
    // The preflight verifies by probing; a status is a claim, not evidence.
    const runner = new FakeRunner().on('sudo', {exitCode: 3, stderr: 'no space'})
    const d = fakeDownload()
    expect(await createMiseInstaller(runner, SOURCE, d.download).install(opts())).toEqual({exitCode: 3})
  })

  it('announces downloading then installing', async () => {
    const stages: Stage[] = []
    const runner = new FakeRunner().on('sudo', {exitCode: 0})
    const d = fakeDownload()
    await createMiseInstaller(runner, SOURCE, d.download).install(opts({onStage: (s) => stages.push(s)}))
    expect(stages).toEqual(['downloading', 'installing'])
  })

  it('passes nonInteractive and capture through to the run', async () => {
    const runner = new FakeRunner().on('sudo', {exitCode: 0})
    const d = fakeDownload()
    await createMiseInstaller(runner, SOURCE, d.download).install(opts({capture: true, nonInteractive: true}))
    expect(runner.calls[0].opts).toEqual({stdin: 'ignore', stdout: 'capture'})
  })

  it('deletes the downloaded script even when the run fails', async () => {
    const runner = {
      async run() {
        throw new Error('boom')
      },
    }
    const d = fakeDownload()
    await expect(createMiseInstaller(runner, SOURCE, d.download).install(opts())).rejects.toThrow('boom')
    // The fake download never created the file, so this asserts the code path, not the fs:
    // reaching here without an unhandled rejection means the finally block ran.
    expect(d.calls).toHaveLength(1)
  })

  it('describes what it would do without any I/O', async () => {
    const d = fakeDownload()
    expect(createMiseInstaller(new FakeRunner(), SOURCE, d.download).describe()).toEqual([
      'download https://mise.run',
      'sudo env MISE_INSTALL_PATH=/usr/local/bin/mise sh <downloaded installer>',
    ])
    expect(d.calls).toEqual([])
  })
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @ops/cli exec vitest run test/providers/mise-install.test.ts`
Expected: FAIL — cannot resolve `src/providers/mise-install.js`.

- [ ] **Step 3: Implement**

Create `apps/cli/src/providers/mise-install.ts`:

```ts
import {randomBytes} from 'node:crypto'
import {rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import type {MiseConfig} from '../core/config.js'
import type {Stage} from '../core/stage.js'
import type {RunOptions, Runner} from '../executor/exec.js'
import {type Download, type OnProgress, fetchDownload} from './deb.js'

export interface MiseInstallOptions {
  nonInteractive: boolean
  /** Capture the installer's output instead of streaming it (used with --json). */
  capture: boolean
  /** Called while the script downloads; the caller decides whether to show anything. */
  onProgress?: OnProgress
  /** Called as each stage begins, so a caller can drive a spinner. */
  onStage?: (stage: Stage) => void
}

export interface MiseInstaller {
  /** What install would do, for --dry-run. No I/O. */
  describe(): string[]
  /**
   * Downloads mise's official installer and runs it. The exit code is returned rather than
   * thrown on: the caller verifies by probing for mise afterwards, because a status is a
   * claim and the probe is the evidence.
   */
  install(opts: MiseInstallOptions): Promise<{exitCode: number}>
}

/**
 * Installs mise the way its vendor does -- the script detects OS, architecture and libc and
 * verifies sha256 checksums, none of which ops should reimplement.
 *
 * The script is downloaded first and then run as argv. Piping it (`curl | sh`) would be a
 * shell string, which this project forbids, and it feeds a shell bytes as they arrive: a
 * connection that drops mid-transfer executes half a script. A file that failed to download
 * completely simply does not run. `env` sits inside the argv because sudo resets the
 * environment. The https check lives in the config schema, before any of this is reached.
 */
export function createMiseInstaller(runner: Runner, source: MiseConfig, download: Download = fetchDownload): MiseInstaller {
  const argv = (file: string) => ['env', `MISE_INSTALL_PATH=${source.path}`, 'sh', file]

  return {
    describe: () => [`download ${source.installer}`, `sudo ${argv('<downloaded installer>').join(' ')}`],

    async install(opts) {
      const file = join(tmpdir(), `ops-mise-${randomBytes(8).toString('hex')}.sh`)

      try {
        opts.onStage?.('downloading')
        await download(source.installer, file, opts.onProgress)

        const runOpts: RunOptions = {
          stdin: opts.nonInteractive ? 'ignore' : 'inherit',
          stdout: opts.capture ? 'capture' : 'inherit',
        }

        opts.onStage?.('installing')
        const result = await runner.run('sudo', argv(file), runOpts)
        return {exitCode: result.exitCode}
      } finally {
        await rm(file, {force: true})
      }
    },
  }
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `pnpm --filter @ops/cli exec vitest run test/providers/mise-install.test.ts && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/providers/mise-install.ts apps/cli/test/providers/mise-install.test.ts
git commit -m "feat(mise): install mise with its own installer, run as argv

Downloaded first, then executed. A pipe is what the argv rule forbids, and it
lets a truncated download half-execute; a file that did not finish downloading
simply does not run.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: `ensureMise`

The heart of the change. Tested entirely with a stub probe and a fake installer — no runner, no network.

**Files:**
- Create: `apps/cli/src/core/preflight.ts`
- Test: `apps/cli/test/core/preflight.test.ts`

**Interfaces:**
- Consumes: `Change` from `src/core/change.js`; `MiseState` from `src/providers/mise-presence.js`; `MiseInstaller` from `src/providers/mise-install.js`; `OnProgress` from `src/providers/deb.js`; `Stage` from `src/core/stage.js`; `OpsError`.
- Produces: `const MISE = 'mise'`, `PreflightOptions`, `PreflightResult`, `PreflightDeps`, `ensureMise(options, deps): Promise<PreflightResult>`.

- [ ] **Step 1: Write the failing tests**

Create `apps/cli/test/core/preflight.test.ts`:

```ts
import {describe, expect, it, vi} from 'vitest'
import {OpsError} from '../../src/core/errors.js'
import {type PreflightDeps, type PreflightOptions, ensureMise} from '../../src/core/preflight.js'
import type {Stage} from '../../src/core/stage.js'
import type {MiseInstaller} from '../../src/providers/mise-install.js'
import type {MiseState} from '../../src/providers/mise-presence.js'

/** Answers each probe from a queue; the last answer repeats. */
function stubProbe(...answers: MiseState[]) {
  const calls: number[] = []
  return {
    calls,
    probe: async () => {
      calls.push(calls.length)
      return answers[Math.min(calls.length - 1, answers.length - 1)]
    },
  }
}

function fakeInstaller(exitCode = 0) {
  const installs: {capture: boolean; nonInteractive: boolean}[] = []
  const installer: MiseInstaller = {
    describe: () => ['download https://mise.run', 'sudo env MISE_INSTALL_PATH=/usr/local/bin/mise sh <downloaded installer>'],
    async install(opts) {
      installs.push({capture: opts.capture, nonInteractive: opts.nonInteractive})
      opts.onStage?.('downloading')
      opts.onStage?.('installing')
      return {exitCode}
    },
  }
  return {installer, installs}
}

const opts = (o: Partial<PreflightOptions> = {}): PreflightOptions => ({
  dryRun: false,
  json: false,
  nonInteractive: false,
  yes: true,
  ...o,
})

function deps(over: Partial<PreflightDeps> = {}): PreflightDeps {
  return {
    installer: fakeInstaller().installer,
    isTTY: true,
    onPlan: () => {},
    probe: async () => ({state: 'absent'}),
    sudoReady: async () => true,
    ...over,
  }
}

describe('ensureMise when mise is there', () => {
  it('is satisfied, and touches nothing else', async () => {
    const p = stubProbe({state: 'present', version: '2026.9.11'})
    const f = fakeInstaller()
    const result = await ensureMise(opts(), deps({installer: f.installer, probe: p.probe}))
    expect(result).toEqual({
      action: 'preflight',
      dryRun: false,
      satisfied: true,
      changes: [{id: 'mise', status: 'satisfied', detail: '2026.9.11'}],
    })
    // The common path must cost nothing: one probe, no install.
    expect(p.calls).toHaveLength(1)
    expect(f.installs).toEqual([])
  })

  it('leaves a broken mise alone rather than installing over it', async () => {
    const f = fakeInstaller()
    const p = stubProbe({state: 'unhealthy', exitCode: 1, detail: 'config error'})
    const result = await ensureMise(opts(), deps({installer: f.installer, probe: p.probe}))
    expect(result.satisfied).toBe(true)
    expect(result.changes[0].status).toBe('skipped')
    expect(result.changes[0].detail).toContain('config error')
    expect(f.installs).toEqual([])
  })
})

describe('ensureMise dry run', () => {
  it('reports what it would do and installs nothing', async () => {
    const f = fakeInstaller()
    const result = await ensureMise(opts({dryRun: true}), deps({installer: f.installer}))
    expect(result.satisfied).toBe(false)
    expect(result.dryRun).toBe(true)
    expect(result.changes).toEqual([
      {id: 'mise', status: 'would-change', detail: 'not installed', command: 'sudo env MISE_INSTALL_PATH=/usr/local/bin/mise sh <downloaded installer>'},
    ])
    expect(result.commands).toEqual([
      'download https://mise.run',
      'sudo env MISE_INSTALL_PATH=/usr/local/bin/mise sh <downloaded installer>',
    ])
    expect(f.installs).toEqual([])
  })

  it('never gates, because nothing is applied', async () => {
    await expect(ensureMise(opts({dryRun: true, json: true, yes: false}), deps())).resolves.toBeTruthy()
  })
})

describe('ensureMise gate', () => {
  it('throws under --json without --yes, before installing anything', async () => {
    const f = fakeInstaller()
    const run = ensureMise(opts({json: true, yes: false}), deps({installer: f.installer}))
    await expect(run).rejects.toThrow(OpsError)
    await expect(run).rejects.toThrow(/--yes/)
    expect(f.installs).toEqual([])
  })

  it('throws when stdout is not a TTY', async () => {
    await expect(ensureMise(opts({yes: false}), deps({isTTY: false}))).rejects.toThrow(OpsError)
  })

  it('does not throw with --non-interactive', async () => {
    const p = stubProbe({state: 'absent'}, {state: 'present', version: '1.0'})
    await expect(ensureMise(opts({json: true, nonInteractive: true, yes: false}), deps({probe: p.probe}))).resolves.toBeTruthy()
  })

  it('demands passwordless sudo under --non-interactive, before installing', async () => {
    const f = fakeInstaller()
    const run = ensureMise(opts({nonInteractive: true}), deps({installer: f.installer, sudoReady: async () => false}))
    await expect(run).rejects.toThrow(/sudo/)
    expect(f.installs).toEqual([])
  })

  it('prints the plan exactly once before installing', async () => {
    const onPlan = vi.fn()
    const p = stubProbe({state: 'absent'}, {state: 'present', version: '1.0'})
    await ensureMise(opts(), deps({onPlan, probe: p.probe}))
    expect(onPlan).toHaveBeenCalledTimes(1)
    expect(onPlan.mock.calls[0][0][0]).toMatchObject({id: 'mise', status: 'would-change'})
  })
})

describe('ensureMise install', () => {
  it('installs, then verifies by probing again', async () => {
    const f = fakeInstaller()
    const p = stubProbe({state: 'absent'}, {state: 'present', version: '2026.9.11'})
    const result = await ensureMise(opts(), deps({installer: f.installer, probe: p.probe}))
    expect(p.calls).toHaveLength(2)
    expect(f.installs).toEqual([{capture: false, nonInteractive: false}])
    expect(result).toMatchObject({satisfied: true, changes: [{id: 'mise', status: 'changed', detail: '2026.9.11'}]})
  })

  it('captures output under --json', async () => {
    const f = fakeInstaller()
    const p = stubProbe({state: 'absent'}, {state: 'present', version: '1.0'})
    await ensureMise(opts({json: true}), deps({installer: f.installer, probe: p.probe}))
    expect(f.installs[0].capture).toBe(true)
  })

  it('captures output when a spinner owns the terminal', async () => {
    const f = fakeInstaller()
    const p = stubProbe({state: 'absent'}, {state: 'present', version: '1.0'})
    await ensureMise(opts(), deps({captureOutput: true, installer: f.installer, probe: p.probe}))
    expect(f.installs[0].capture).toBe(true)
  })

  it('forwards stages with mise as the subject', async () => {
    const seen: [Stage, string][] = []
    const p = stubProbe({state: 'absent'}, {state: 'present', version: '1.0'})
    await ensureMise(opts(), deps({onStage: (stage, subject) => seen.push([stage, subject]), probe: p.probe}))
    expect(seen).toEqual([['downloading', 'mise'], ['installing', 'mise']])
  })

  it('fails when mise is still absent after the installer ran', async () => {
    // A status is a claim; the probe is the evidence.
    const f = fakeInstaller(3)
    const p = stubProbe({state: 'absent'})
    const run = ensureMise(opts(), deps({installer: f.installer, probe: p.probe}))
    await expect(run).rejects.toThrow(/still not on PATH/)
    await expect(run).rejects.toThrow(/exit 3/)
  })

  it('fails clearly when the config says nothing about mise', async () => {
    const run = ensureMise(opts(), deps({installer: undefined}))
    await expect(run).rejects.toThrow(/"mise:"/)
  })
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @ops/cli exec vitest run test/core/preflight.test.ts`
Expected: FAIL — cannot resolve `src/core/preflight.js`.

- [ ] **Step 3: Implement**

Create `apps/cli/src/core/preflight.ts`:

```ts
import type {OnProgress} from '../providers/deb.js'
import type {MiseInstaller} from '../providers/mise-install.js'
import type {MiseState} from '../providers/mise-presence.js'
import type {Change} from './change.js'
import {OpsError} from './errors.js'
import type {Stage} from './stage.js'

/** The one id the preflight reports under. */
export const MISE = 'mise'

/** The four run flags a preflight cares about; a subset of both BootstrapOptions and InstallOptions. */
export interface PreflightOptions {
  dryRun: boolean
  yes: boolean
  nonInteractive: boolean
  json: boolean
}

export interface PreflightResult {
  action: 'preflight'
  dryRun: boolean
  /** True when mise is on PATH now. False only after a dry run that would have installed it. */
  satisfied: boolean
  /** One entry, id "mise", in the same vocabulary a section reports. */
  changes: Change[]
  /** Dry run only: everything the preflight would run, in order. */
  commands?: string[]
}

export interface PreflightDeps {
  probe: () => Promise<MiseState>
  /** undefined when the config carries no `mise:` block saying where to get it. */
  installer: MiseInstaller | undefined
  /** True when a human can read the plan. */
  isTTY: boolean
  /** True when privileged commands can run without a password prompt. */
  sudoReady: () => Promise<boolean>
  /** Called once with the pending change, before anything is written. */
  onPlan: (changes: Change[]) => void
  onStage?: (stage: Stage, subject: string) => void
  onProgress?: OnProgress
  /** Capture the installer's output instead of streaming it, when a spinner owns the terminal. */
  captureOutput?: boolean
}

/**
 * Makes sure mise exists before anything that needs it runs: inspect -> plan -> confirm ->
 * install -> verify, the same five beats as every other privileged area, compressed into one
 * package because there is only ever one thing to do.
 *
 * Lives outside the bootstrap engine on purpose. The engine's invariant is that it plans
 * every section before applying any, and a prerequisite has to be applied before any section
 * can even be inspected -- so it is the caller, which knows it is `ops bootstrap`, that runs
 * this first and owns the extra gate.
 */
export async function ensureMise(options: PreflightOptions, deps: PreflightDeps): Promise<PreflightResult> {
  const base = {action: 'preflight' as const, dryRun: options.dryRun}
  const state = await deps.probe()

  // The overwhelmingly common path: one exec, nothing printed, nothing else touched.
  if (state.state === 'present') {
    return {...base, changes: [{detail: state.version, id: MISE, status: 'satisfied'}], satisfied: true}
  }

  // mise EXISTS and is misbehaving. Installing over it would be the wrong repair, and
  // whichever provider needs it will fail with a message about what it actually ran.
  if (state.state === 'unhealthy') {
    const detail = `on PATH but did not answer --version: ${state.detail}`
    return {...base, changes: [{detail, id: MISE, status: 'skipped'}], satisfied: true}
  }

  if (!deps.installer) {
    throw new OpsError(
      'MISE_BOOTSTRAP_UNAVAILABLE',
      'mise is not installed and this config has no "mise:" block saying where to get it; install it from https://mise.jdx.dev and re-run',
    )
  }

  const commands = deps.installer.describe()
  const command = commands.at(-1)!

  if (options.dryRun) {
    return {...base, changes: [{command, detail: 'not installed', id: MISE, status: 'would-change'}], commands, satisfied: false}
  }

  // The same gate the engine applies to a section plan, on the same terms -- taken here
  // because this install has to happen before any section can be inspected.
  if (!(options.yes || options.nonInteractive) && (options.json || !deps.isTTY)) {
    throw new OpsError(
      'CONFIRMATION_REQUIRED',
      'Confirmation required: mise is not installed and ops must install it before it can continue; re-run with --yes (or --non-interactive)',
    )
  }

  deps.onPlan([{command, id: MISE, status: 'would-change'}])

  if (options.nonInteractive && !(await deps.sudoReady())) {
    throw new OpsError(
      'SUDO_PASSWORD_REQUIRED',
      'sudo needs a password; run without --non-interactive or configure passwordless sudo',
    )
  }

  const {exitCode} = await deps.installer.install({
    capture: options.json || deps.captureOutput === true,
    nonInteractive: options.nonInteractive,
    onProgress: deps.onProgress,
    onStage: (stage) => deps.onStage?.(stage, MISE),
  })

  // Verify by asking the machine again, never by trusting an exit code.
  const after = await deps.probe()
  if (after.state === 'absent') {
    throw new OpsError(
      'MISE_BOOTSTRAP_UNAVAILABLE',
      `Ran the mise installer${exitCode === 0 ? '' : ` (exit ${exitCode})`} but mise is still not on PATH; install it from https://mise.jdx.dev`,
    )
  }

  return {...base, changes: [{detail: after.state === 'present' ? after.version : 'installed', id: MISE, status: 'changed'}], satisfied: true}
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `pnpm --filter @ops/cli exec vitest run test/core/preflight.test.ts && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/core/preflight.ts apps/cli/test/core/preflight.test.ts
git commit -m "feat(preflight): ensure mise exists before anything needs it

Inspect, plan, confirm, install, verify -- with its own gate, because a
prerequisite has to be applied before any section can even be inspected. Only
an absent mise is installed; a broken one is left for the provider that will
fail in more specific words.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Preflight renderers

**Files:**
- Modify: `apps/cli/src/core/output.ts`
- Test: `apps/cli/test/core/output.test.ts`

**Interfaces:**
- Produces: `renderPreflight(result: PreflightResult, style?: Style): string[]` and `renderPreflightPlan(changes: Change[], style?: Style): string[]`.

- [ ] **Step 1: Write the failing tests**

Append to `apps/cli/test/core/output.test.ts` (and add `renderPreflight`, `renderPreflightPlan` to the existing `core/output.js` import, plus `import type {PreflightResult} from '../../src/core/preflight.js'`):

```ts
const preflight = (over: Partial<PreflightResult> = {}): PreflightResult => ({
  action: 'preflight',
  changes: [{id: 'mise', status: 'satisfied', detail: '2026.9.11'}],
  dryRun: false,
  satisfied: true,
  ...over,
})

describe('renderPreflight', () => {
  it('says nothing at all when mise was already there', () => {
    // The common path must cost the reader nothing.
    expect(renderPreflight(preflight())).toEqual([])
  })

  it('reports an install', () => {
    expect(renderPreflight(preflight({changes: [{id: 'mise', status: 'changed', detail: '2026.9.11'}]}))).toEqual([
      'preflight',
      '+ mise  changed (2026.9.11)',
      '',
    ])
  })

  it('explains why a dry run can go no further', () => {
    const lines = renderPreflight(
      preflight({
        changes: [{id: 'mise', status: 'would-change', detail: 'not installed', command: 'sudo env ... sh <installer>'}],
        commands: ['download https://mise.run', 'sudo env ... sh <installer>'],
        dryRun: true,
        satisfied: false,
      }),
    )
    expect(lines).toContain('~ mise  would change (not installed)')
    expect(lines).toContain('Would run:')
    expect(lines).toContain('  download https://mise.run')
    expect(lines.some((l) => l.includes('nothing further can be planned'))).toBe(true)
  })

  it('reports a broken mise without claiming to have fixed it', () => {
    const lines = renderPreflight(preflight({changes: [{id: 'mise', status: 'skipped', detail: 'on PATH but did not answer --version: boom'}]}))
    expect(lines).toContain('· mise  skipped (on PATH but did not answer --version: boom)')
  })
})

describe('renderPreflightPlan', () => {
  it('heads differently from a section plan, since a bare machine prints both', () => {
    expect(renderPreflightPlan([{id: 'mise', status: 'would-change', command: 'sudo env ... sh <installer>'}])).toEqual([
      'Preflight:',
      '  mise  sudo env ... sh <installer>',
      '',
    ])
  })
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @ops/cli exec vitest run test/core/output.test.ts`
Expected: FAIL — the two render functions do not exist.

- [ ] **Step 3: Implement**

Add the type import at the top of `apps/cli/src/core/output.ts`:

```ts
import type {PreflightResult} from './preflight.js'
```

and append:

```ts
/**
 * The preflight block. Empty when mise was already there: the common case must cost the
 * reader nothing. --json carries the same data structurally and never calls this.
 */
export function renderPreflight(result: PreflightResult, style: Style = plainStyle): string[] {
  if (result.changes.every((c) => c.status === 'satisfied')) return []

  const lines = [style.heading('preflight'), ...changeLines(result.changes, style)]
  if (result.commands && result.commands.length > 0) {
    lines.push('', style.heading('Would run:'), ...result.commands.map((c) => style.muted(`  ${c}`)))
  }

  // The hole a dry run cannot fill: everything downstream is a mise call.
  if (!result.satisfied) {
    lines.push('', 'mise is not installed, so nothing further can be planned; re-run without --dry-run to install it.')
  }

  return [...lines, '']
}

/**
 * Shown before mise is installed, so nothing runs unseen. Headed differently from a section
 * plan, because a run on a bare machine prints both.
 */
export function renderPreflightPlan(changes: Change[], style: Style = plainStyle): string[] {
  const width = column(changes.map((c) => c.id))
  const rows = changes.map((c) => `  ${c.id.padEnd(width)}  ${style.muted(c.command ?? '')}`.trimEnd())
  return [style.heading('Preflight:'), ...rows, '']
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `pnpm --filter @ops/cli exec vitest run test/core/output.test.ts && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/core/output.ts apps/cli/test/core/output.test.ts
git commit -m "feat(output): render the preflight, and nothing when mise was already there

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Results for a run that stopped in preflight

Both commands need a well-typed result when the preflight halts them, so `--json` stays one document with one definition of its shape.

**Files:**
- Modify: `apps/cli/src/core/bootstrap/run.ts`, `apps/cli/src/core/package/install.ts`
- Test: `apps/cli/test/core/bootstrap/run.test.ts` (additions only)

**Interfaces:**
- Produces: `BootstrapResult.preflight?: PreflightResult`, `haltedBeforePlan(profile: ResolvedProfile, options: BootstrapOptions, preflight: PreflightResult): BootstrapResult`; `InstallResult.preflight?: PreflightResult`, `haltedBeforeInstall(options: InstallOptions, preflight: PreflightResult): InstallResult`.

- [ ] **Step 1: Write the failing test**

Append to `apps/cli/test/core/bootstrap/run.test.ts` (add `haltedBeforePlan` to the existing `bootstrap/run.js` import, and `import type {PreflightResult} from '../../../src/core/preflight.js'`):

```ts
describe('haltedBeforePlan', () => {
  it('reports a run that never got to plan anything', () => {
    const stopped: PreflightResult = {
      action: 'preflight',
      changes: [{id: 'mise', status: 'would-change', command: 'sudo env ... sh <installer>'}],
      commands: ['download https://mise.run'],
      dryRun: true,
      satisfied: false,
    }
    const profile = profileIndex({base: {packages: ['git']}, p: {extends: 'base'}}).resolve('p')
    expect(haltedBeforePlan(profile, opts({dryRun: true}), stopped)).toEqual({
      action: 'bootstrap',
      commands: ['download https://mise.run'],
      counts: {changed: 0, failed: 0, satisfied: 0, skipped: 0, 'would-change': 0},
      dryRun: true,
      lineage: ['base', 'p'],
      preflight: stopped,
      profile: 'p',
      sections: [],
      success: false,
    })
  })
})
```

- [ ] **Step 2: Run to verify it fails and nothing else broke**

Run: `pnpm --filter @ops/cli exec vitest run test/core/bootstrap/run.test.ts`
Expected: FAIL on the new case only. **Every pre-existing case must still pass** — that is the evidence the engine invariant held.

- [ ] **Step 3: Implement in `run.ts`**

Add the type imports:

```ts
import type {PreflightResult} from '../preflight.js'
import type {ResolvedProfile} from '../profile/resolve.js'
```

(`declaresSection` is already imported from `../profile/resolve.js`; extend that import rather than adding a second one.)

Add to `BootstrapResult`:

```ts
  /**
   * What the mise preflight did. Attached by the command layer, never by the engine: a
   * preflight is not a section, so its change never enters `counts`.
   */
  preflight?: PreflightResult
```

Append the helper — a function rather than an object literal in the command layer, so the `--json` shape has one definition:

```ts
/**
 * The result of a run that stopped in preflight: no section plans to report, because
 * computing one needs the tool the preflight was about to install.
 */
export function haltedBeforePlan(
  profile: ResolvedProfile,
  options: BootstrapOptions,
  preflight: PreflightResult,
): BootstrapResult {
  return {
    action: 'bootstrap',
    commands: preflight.commands ?? [],
    counts: {changed: 0, failed: 0, satisfied: 0, skipped: 0, 'would-change': 0},
    dryRun: options.dryRun,
    lineage: profile.lineage,
    preflight,
    profile: profile.name,
    sections: [],
    success: false,
  }
}
```

**`bootstrapProfile`'s body must not change.**

- [ ] **Step 4: Implement in `install.ts`**

Add `import type {PreflightResult} from '../preflight.js'`, add to `InstallResult`:

```ts
  /** What the mise preflight did; attached by the command layer. */
  preflight?: PreflightResult
```

and append the mirror helper:

```ts
/** The result of an install that stopped in preflight: nothing was resolved, so nothing is reported. */
export function haltedBeforeInstall(options: InstallOptions, preflight: PreflightResult): InstallResult {
  return {
    action: 'install',
    commands: preflight.commands ?? [],
    dryRun: options.dryRun,
    managers: [],
    packages: [],
    preflight,
    success: false,
  }
}
```

- [ ] **Step 5: Run the whole suite**

Run: `pnpm typecheck && pnpm test`
Expected: PASS, with `test/core/bootstrap/run.test.ts`'s pre-existing cases untouched.

- [ ] **Step 6: Commit**

```bash
git add apps/cli/src/core/bootstrap/run.ts apps/cli/src/core/package/install.ts apps/cli/test/core/bootstrap/run.test.ts
git commit -m "feat: report a run that stopped in preflight

One definition of the --json shape for a run that never got to plan anything.
bootstrapProfile is untouched; its existing tests passing unedited is what says
the plan-everything-first invariant held.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: Wire the preflight into `ops bootstrap`

**Files:**
- Modify: `apps/cli/src/commands/bootstrap.ts`
- Test: `apps/cli/test/commands/bootstrap.test.ts`

**Interfaces:**
- Consumes: `ensureMise`, `PreflightResult` from `src/core/preflight.js`; `probeMise` from `src/providers/mise-presence.js`; `createMiseInstaller` from `src/providers/mise-install.js`; `renderPreflight`, `renderPreflightPlan` from `src/core/output.js`; `haltedBeforePlan` from `src/core/bootstrap/run.js`.

- [ ] **Step 1: Write the failing flag test**

Append to `apps/cli/test/commands/bootstrap.test.ts`:

```ts
describe('Bootstrap preflight flag', () => {
  it('runs the preflight by default and can be turned off', () => {
    // --no-preflight restores today's behaviour: the run dies at plan time.
    expect(Bootstrap.flags.preflight.allowNo).toBe(true)
    expect(Bootstrap.flags.preflight.default).toBe(true)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @ops/cli exec vitest run test/commands/bootstrap.test.ts`
Expected: FAIL — `Bootstrap.flags.preflight` is undefined.

- [ ] **Step 3: Add the flag**

In `apps/cli/src/commands/bootstrap.ts`, add to `static override flags`:

```ts
    preflight: Flags.boolean({
      allowNo: true,
      default: true,
      summary: 'Install mise first when it is missing (--no-preflight to skip)',
    }),
```

- [ ] **Step 4: Restructure `run()` so the preflight can share the wiring**

Three named values have to exist before the preflight runs, where two of them are currently built inline. Replace the body of `run()` from `const result = await bootstrapProfile(` down to `return result` with:

```ts
    const options: BootstrapOptions = {
      dryRun: flags['dry-run'],
      force: flags.force,
      json: this.jsonEnabled(),
      nonInteractive: flags['non-interactive'],
      only: flags.only as SectionName[],
      profile: args.profile ?? DEFAULT_PROFILE,
      skip: flags.skip as SectionName[],
      yes: flags.yes,
    }

    // Named, because the preflight drives the same spinner the sections do.
    const onStage =
      spin || onProgress
        ? stageReporter(
            (text) => process.stderr.write(text),
            Boolean(onProgress),
            spin ? (label) => ux.action.start(label) : undefined,
            spin ? stopSpinner : undefined,
          )
        : undefined

    const profiles = profileIndex(config.profile, {recipes})
    // Resolved before the preflight: a mistyped profile name is more useful to hear about
    // than a prerequisite install, and resolving needs no mise.
    const profile = profiles.resolve(options.profile)

    let preflight: PreflightResult | undefined
    if (flags.preflight) {
      preflight = await ensureMise(options, {
        captureOutput: spin,
        installer: config.mise && createMiseInstaller(execaRunner, config.mise),
        isTTY: Boolean(process.stdout.isTTY),
        onPlan: (changes) => {
          if (!this.jsonEnabled()) for (const line of renderPreflightPlan(changes, styleFor(false))) this.log(line)
        },
        onProgress,
        onStage,
        probe: () => probeMise(execaRunner),
        sudoReady: () => sudoReady(execaRunner),
      })

      stopSpinner()
      if (!this.jsonEnabled()) for (const line of renderPreflight(preflight, styleFor(false))) this.log(line)

      // Without mise no section can even be inspected, so there is no plan to show. Exit 1:
      // printing a partial picture beside exit 0 would tell a script it saw everything.
      if (!preflight.satisfied) {
        process.exitCode = 1
        return haltedBeforePlan(profile, options, preflight)
      }
    }

    const result = await bootstrapProfile(options, {
      isTTY: Boolean(process.stdout.isTTY),
      onPlan: (plans) => {
        if (!this.jsonEnabled()) for (const line of renderBootstrapPlan(plans, styleFor(false))) this.log(line)
      },
      onSection: stopSpinner,
      profiles,
      sections: buildSections({
        install: {
          captureOutput: spin,
          deb: createDebInstaller(execaRunner),
          detectManager: () => detectSystemManager(),
          isTTY: Boolean(process.stdin.isTTY),
          mise: createMiseBootstrap(execaRunner),
          onProgress,
          onStage,
          recipes,
          repos: createAptRepoProvider(execaRunner),
          sudoReady: () => sudoReady(execaRunner),
          systemPreferred: new Set(config.package.system),
          tools: createMiseTools(execaRunner),
        },
        setup: {isTTY: Boolean(process.stdout.isTTY), recipes, runner: execaRunner},
      }),
    })

    stopSpinner()
    if (preflight) result.preflight = preflight
    if (!this.jsonEnabled()) for (const line of renderBootstrapResult(result, styleFor(this.jsonEnabled()))) this.log(line)
    if (!result.success) process.exitCode = 1
    return result
```

Add the imports:

```ts
import {type BootstrapResult, type BootstrapOptions, bootstrapProfile, haltedBeforePlan} from '../core/bootstrap/run.js'
import {type PreflightResult, ensureMise} from '../core/preflight.js'
import {downloadProgress, renderBootstrapPlan, renderBootstrapResult, renderPreflight, renderPreflightPlan, stageReporter} from '../core/output.js'
import {createMiseInstaller} from '../providers/mise-install.js'
import {probeMise} from '../providers/mise-presence.js'
```

- [ ] **Step 5: Verify, build and smoke-test**

Run: `pnpm --filter @ops/cli exec vitest run && pnpm typecheck && pnpm build`
Then, on this machine (which has mise, so the preflight must be silent):

```bash
pnpm ops bootstrap dev --dry-run          # no "preflight" block at all
pnpm ops bootstrap dev --dry-run --json | head -20
pnpm ops bootstrap --help                 # lists --[no-]preflight
```
Expected: output identical to before this task, plus the flag in help.

- [ ] **Step 6: Commit**

```bash
git add apps/cli/src/commands/bootstrap.ts apps/cli/test/commands/bootstrap.test.ts
git commit -m "feat(cli): run the mise preflight before ops bootstrap plans

Resolves the profile first, so a mistyped name is reported before a
prerequisite install. A machine that has mise sees nothing new.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: Wire the preflight into `ops tool install`

For a tarball user this is the first command they type, and it is as dead as `bootstrap` on a bare machine: `installSystem`'s first statement is `mise.declare(specs)`, and `resolveSpecs` calls `tools.inRegistry` before that.

`ops tool setup` gets nothing — it never runs mise. `ops tool uninstall` gets nothing either: installing a tool in order to remove something is incoherent, and with no mise on the machine nothing mise-managed can be installed.

**Files:**
- Modify: `apps/cli/src/commands/tool/install.ts`
- Test: `apps/cli/test/commands/tool/install.test.ts`

**Interfaces:**
- Consumes: the same as Task 8, plus `haltedBeforeInstall` from `src/core/package/install.js`.

- [ ] **Step 1: Write the failing flag test**

Append to `apps/cli/test/commands/tool/install.test.ts`:

```ts
describe('ToolInstall preflight flag', () => {
  it('runs the preflight by default and can be turned off', () => {
    expect(ToolInstall.flags.preflight.allowNo).toBe(true)
    expect(ToolInstall.flags.preflight.default).toBe(true)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @ops/cli exec vitest run test/commands/tool/install.test.ts`
Expected: FAIL — `ToolInstall.flags.preflight` is undefined.

- [ ] **Step 3: Add the flag**

In `apps/cli/src/commands/tool/install.ts`, add to `static override flags`:

```ts
    preflight: Flags.boolean({
      allowNo: true,
      default: true,
      summary: 'Install mise first when it is missing (--no-preflight to skip)',
    }),
```

- [ ] **Step 4: Name the options and the stage reporter, then run the preflight**

In `run()`, replace the inline options object and inline `onStage` with named values, and insert the preflight before `installPackages`:

```ts
    const options: InstallOptions = {
      dryRun: flags['dry-run'],
      force: flags.force,
      json: this.jsonEnabled(),
      nonInteractive: flags['non-interactive'],
      packages: argv as string[],
      yes: flags.yes,
    }

    const onStage =
      spin || onProgress
        ? stageReporter(
            (text) => process.stderr.write(text),
            Boolean(onProgress),
            spin ? (label) => ux.action.start(label) : undefined,
            spin
              ? () => {
                  if (ux.action.running) ux.action.stop()
                }
              : undefined,
          )
        : undefined

    let preflight: PreflightResult | undefined
    if (flags.preflight) {
      preflight = await ensureMise(options, {
        captureOutput: spin,
        installer: config.mise && createMiseInstaller(execaRunner, config.mise),
        isTTY: Boolean(process.stdout.isTTY),
        onPlan: (changes) => {
          if (!this.jsonEnabled()) for (const line of renderPreflightPlan(changes, styleFor(false))) this.log(line)
        },
        onProgress,
        onStage,
        probe: () => probeMise(execaRunner),
        sudoReady: () => sudoReady(execaRunner),
      })

      if (ux.action.running) ux.action.stop()
      if (!this.jsonEnabled()) for (const line of renderPreflight(preflight, styleFor(false))) this.log(line)

      // Nothing can be resolved without mise: resolveSpecs asks the mise registry.
      if (!preflight.satisfied) {
        process.exitCode = 1
        return haltedBeforeInstall(options, preflight)
      }
    }

    const result = await installPackages(options, {
      // …the existing deps object, with `onStage` now referring to the named const…
    })

    if (ux.action.running) ux.action.stop()
    if (preflight) result.preflight = preflight
    if (!this.jsonEnabled()) for (const line of renderInstallResult(result, styleFor(this.jsonEnabled()))) this.log(line)
    if (!result.success) process.exitCode = 1
    return result
```

Add the imports:

```ts
import {type InstallOptions, type InstallResult, haltedBeforeInstall, installPackages} from '../../core/package/install.js'
import {type PreflightResult, ensureMise} from '../../core/preflight.js'
import {downloadProgress, renderInstallResult, renderPreflight, renderPreflightPlan, stageReporter} from '../../core/output.js'
import {createMiseInstaller} from '../../providers/mise-install.js'
import {probeMise} from '../../providers/mise-presence.js'
```

- [ ] **Step 5: Verify, build and smoke-test**

Run: `pnpm --filter @ops/cli exec vitest run && pnpm typecheck && pnpm build`
Then:

```bash
pnpm ops tool install jq --dry-run        # unchanged output; mise is present here
pnpm ops tool install --help              # lists --[no-]preflight
```

- [ ] **Step 6: Commit**

```bash
git add apps/cli/src/commands/tool/install.ts apps/cli/test/commands/tool/install.test.ts
git commit -m "feat(cli): run the mise preflight before ops tool install

For a tarball user this is the first command they type, and resolveSpecs asks
the mise registry before anything else happens.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 10: Documentation, stale messages, and the container proof

Every unit test above uses a fake. The container is the only place the real download, the real `sudo sh`, and the real handover to the engine happen.

**Files:**
- Modify: `README.md`, `docs/commands.md`, `CLAUDE.md`, `docs/superpowers/specs/2026-09-20-profile-bootstrap-design.md`
- Modify: `apps/cli/src/providers/{mise-bootstrap,mise-tools,mise-config}.ts`

- [ ] **Step 1: Document the tarball install path**

The preflight is unreachable code until a user can get ops without mise. In `README.md`'s Installation section, keep the mise path as the recommended one and add, after it:

```markdown
Or take ops on its own — the tarball bundles Node, and `ops bootstrap` installs mise
for you on first run:

```bash
curl -fsSL https://github.com/ttungbmt/opsctl/releases/latest/download/ops-linux-x64.tar.gz | tar xz
./ops/bin/ops bootstrap --yes
```
```

Check the real asset name from the latest GitHub release before writing it down; `.github/workflows/release.yml` runs `oclif pack tarballs`, and the filename it produces is what belongs here.

- [ ] **Step 2: Document the preflight**

In `docs/commands.md` § Bootstrap, add to the flag table:

```markdown
| `--no-preflight` | Do not install mise when it is missing; fail instead |
```

and after the "How a run is shaped" section:

```markdown
### The mise preflight

ops runs on mise, so every section's plan is a mise call. On a machine that has
none, `ops bootstrap` and `ops tool install` install it first: they download
mise's official installer over https and run it as a file (never piped into a
shell, which would let a truncated download half-execute), placing mise in
`/usr/local/bin` so every shell finds it.

This has its own confirmation gate, separate from the profile's: you cannot
consent to a plan that cannot be computed yet. On a machine that already has
mise the preflight is one `mise --version` and prints nothing.

`--dry-run` on a machine without mise reports what the preflight would do and
stops with exit 1 — the section plans genuinely cannot be computed. `--no-preflight`
turns the whole thing off.

Where mise comes from is config, under `mise:` in `config/defaults.yaml`.
```

- [ ] **Step 3: Update `CLAUDE.md`**

Add to the project-status paragraph, after the `tool` and `bootstrap` sentence:

> `ops bootstrap` and `ops tool install` first run a **preflight** (`src/core/preflight.ts`) that installs mise when the machine has none — it downloads `mise.installer` from the config and runs it as argv (`sudo env MISE_INSTALL_PATH=… sh <file>`), never piped into a shell, then verifies by re-probing. It deliberately sits in the command layer, not in the bootstrap engine: a prerequisite must be applied before any section can be inspected, so it owns a second confirmation gate rather than weakening the engine's plan-everything-first invariant. Only `CommandNotFoundError` counts as "mise absent"; a mise that exists and misbehaves is left alone. `--no-preflight` restores the old behaviour.

- [ ] **Step 4: Retire the superseded risk**

In `docs/superpowers/specs/2026-09-20-profile-bootstrap-design.md`, replace the **`--dry-run` needs mise** risk paragraph with:

```markdown
**`--dry-run` needs mise.** Superseded by
[`2026-09-20-mise-preflight-design.md`](2026-09-20-mise-preflight-design.md),
which installs mise first when a machine has none.
```

- [ ] **Step 5: Fix the three stale messages**

`mise-bootstrap.ts`, `mise-tools.ts` and `mise-config.ts` each say
`mise not found on PATH; install it from https://mise.jdx.dev`. They are now
reachable only via `--no-preflight` or `ops tool setup`/`uninstall`, and they
understate the options. Change each to:

```ts
'mise not found on PATH; run `ops bootstrap` to install it, or install it from https://mise.jdx.dev'
```

Update any test asserting the old text.

- [ ] **Step 6: Prove it in the container**

The image installs mise via `curl https://mise.run | sh` into `~/.local/bin`, and **node comes from mise's shims**, so deleting mise would take the interpreter ops runs on. The honest fixture is to hide mise from `PATH` while keeping node by absolute path. `/usr/local/bin` stays on the scrubbed PATH, so the post-install re-probe is a real verification rather than a rigged one.

```bash
mise run up

# Regression: mise present -> no preflight block, output exactly as before.
mise run docker:run ops bootstrap minimal --dry-run

# The fixture. Everything below runs with mise off PATH.
BARE='n="$(command -v node)"; exec env PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin "$n" /workspace/apps/cli/bin/run.js'

mise run docker:run bash -c "$BARE bootstrap minimal --dry-run; echo exit=\$?"
mise run docker:run bash -c 'ls /usr/local/bin/mise 2>&1'          # must still be absent
mise run docker:run bash -c "$BARE bootstrap minimal --json; echo exit=\$?"
mise run docker:run bash -c "$BARE bootstrap minimal --yes; echo exit=\$?"
mise run docker:run bash -c '/usr/local/bin/mise --version'
mise run docker:run bash -c "$BARE bootstrap minimal --yes; echo exit=\$?"
mise run docker:run bash -c "$BARE tool install jq --yes; echo exit=\$?"
mise run docker:run bash -c "$BARE bootstrap minimal --no-preflight; echo exit=\$?"
mise run down
```

| Command | Must show |
|---|---|
| `--dry-run` with mise hidden | preflight `~ mise would change`, the `Would run:` block, "nothing further can be planned", **exit 1**, and `/usr/local/bin/mise` still absent |
| `--json` with mise hidden, no `--yes` | `CONFIRMATION_REQUIRED`, exit 1, **still nothing installed** — the gate is the whole point |
| `--yes` with mise hidden | real download, real `sudo sh`, `/usr/local/bin/mise --version` answers, then the profile converges through the engine |
| the second `--yes` | preflight prints nothing, sections `already satisfied`, exit 0 |
| `tool install jq --yes` | preflight installs mise, then jq installs — the tarball user's first command |
| `--no-preflight` with mise hidden | `MISE_BOOTSTRAP_UNAVAILABLE`, exit 1 — today's behaviour, on demand |

- [ ] **Step 7: Commit**

```bash
git add README.md docs CLAUDE.md apps/cli/src/providers apps/cli/test
git commit -m "docs: document the mise preflight and the tarball install path

The preflight is unreachable code until a user can get ops without mise, so the
README change is part of the feature rather than a nicety.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage.** Preflight-not-a-section → Tasks 5, 7, 8. Official installer run as argv → Task 4. Three-state probe → Task 2. `Change` moved out of the bootstrap namespace → Task 1. Commands that get it (`bootstrap`, `tool install`; not `setup`, not `uninstall`) → Tasks 8, 9, with the reasoning restated in Task 9. `--no-preflight` → Tasks 8, 9. Verify-by-probing → Task 5. Config data for installer and path, https-only at the boundary → Task 3. `/usr/local/bin` and why → Task 3's comment and Task 10's docs. No new error codes → Tasks 4, 5 (the installer returns its exit code instead of throwing, so `MISE_INSTALL_FAILED` was never needed). Dry-run halt with exit 1 → Tasks 5, 7, 8. `renderPreflight` silent when satisfied → Task 6. Stale messages, superseded risk, tarball README → Task 10. The spec's `curl`/`wget` caveat needs no code: the script's own error is the right one, and Task 10's container run exercises the path where curl exists.

**Placeholder scan.** No "TBD", no "similar to Task N", no "add error handling". Task 9's `installPackages` deps object is the one elision — it is an existing literal that only gains a reference to the now-named `onStage`, and the surrounding code is quoted in full.

**Type consistency.** `MiseState` (Task 2) is consumed by `PreflightDeps.probe` (Task 5). `MiseInstaller`/`MiseInstallOptions` (Task 4) are consumed by `PreflightDeps.installer` (Task 5) and faked identically in Task 5's tests. `MiseConfig` (Task 3) is the parameter of `createMiseInstaller` (Task 4) and the type of `config.mise` used in Tasks 8 and 9. `Change` (Task 1) is used by `PreflightResult.changes` (Task 5) and both renderers (Task 6). `PreflightResult` (Task 5) is consumed by Tasks 6, 7, 8, 9. `install()` returns `{exitCode: number}` in Task 4 and is destructured as `{exitCode}` in Task 5. `PreflightOptions` is a structural subset of both `BootstrapOptions` and `InstallOptions`, which is what lets Tasks 8 and 9 pass `options` straight through.

**Ordering.** 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9 → 10 is a strict dependency chain. Task 1 must come first because Task 5 imports `Change` from its new home; Task 3 before Task 4 because `createMiseInstaller` takes `MiseConfig`; Task 7 before Tasks 8 and 9 because both return its helpers.
