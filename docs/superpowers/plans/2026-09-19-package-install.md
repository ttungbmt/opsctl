# `ops package install` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `ops package install <pkg...>` declares packages in `[bootstrap.packages]` of the global mise config and installs the missing ones via `mise bootstrap packages`, with `--dry-run`, `--json`, `--yes`, `--non-interactive`.

**Architecture:** Layer folders inside `apps/cli/src`: `commands` (oclif, thin) → `core` (use case, specs, errors, rendering) → `providers` (OS detection, mise bootstrap wrapper) → `executor` (execa runner). Only `providers/mise-bootstrap.ts` knows mise's CLI and JSON shape. Core is tested with a fake `MiseBootstrap`; providers with a `FakeRunner`.

**Tech Stack:** TypeScript 7 (`tsc`, NodeNext ESM), oclif `@oclif/core` 5, execa 10, zod 4, Vitest 5, pnpm 12 workspace, Node 24 (mise).

**Spec:** `docs/superpowers/specs/2026-09-19-package-install-design.md`

## Global Constraints

- All CLI code lives in `apps/cli/src`; tests in `apps/cli/test`. Nothing below `src/commands` imports `@oclif/core`.
- ESM + `moduleResolution: NodeNext`: relative imports end in `.js` (e.g. `../core/errors.js`), also in tests.
- External processes only through `Runner` (`execa` with argument arrays, never a shell string).
- Package specs have the form `manager:package`; plain names get the OS manager: Debian/Ubuntu → `apt`, RHEL/Fedora/CentOS → `dnf`. No yum.
- mise commands used (exact): `mise bootstrap packages use -g --no-install <specs>`, `mise bootstrap packages status --json`, `mise bootstrap packages apply [--yes] <specs>`, `mise bootstrap packages use -g --dry-run <specs>`.
- `OpsError` codes: `UNSUPPORTED_PLATFORM`, `INVALID_PACKAGE_NAME`, `CONFIRMATION_REQUIRED`, `SUDO_PASSWORD_REQUIRED`, `MISE_BOOTSTRAP_UNAVAILABLE`, `MISE_COMMAND_FAILED`.
- `--json` error output: `{ "success": false, "error": { "code", "message" } }`, exit code 1.
- Only `git add` the files a task names. The user has unrelated uncommitted edits (`CLAUDE.md`, `README.md`, `docs/*.md`) — never stage those except where Task 7 edits `CLAUDE.md` (stage with `git add -p` limited to the new hunk, or ask the user).
- Commit messages end with `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`.
- Run commands from the repo root `/home/ubuntu/workspace/personal/opsctl` unless stated.

## Spec clarifications (applied in Task 1, Step 1)

Found while planning; the spec is updated so spec and plan agree:

1. **`--json` needs `--yes` or `--non-interactive`** for a real install (mise's prompt would be invisible while output is captured) → otherwise `CONFIRMATION_REQUIRED`.
2. **Sudo pre-check replaces stderr sniffing:** `sudo` reads passwords from the TTY, not stdin, so ignoring stdin does not prevent a prompt. Under `--non-interactive`, when a missing spec uses `apt`/`dnf` and the user is not root, ops runs `sudo -n true` first; failure → `SUDO_PASSWORD_REQUIRED`.
3. **New code `MISE_COMMAND_FAILED`** for a mise call that exits non-zero for any other reason (message includes mise's stderr). `MISE_BOOTSTRAP_UNAVAILABLE` is reserved for missing mise / old mise / unexpected JSON.
4. **Result field `managers: string[]`** (distinct manager prefixes of the specs) instead of `manager: string`, since explicit specs like `brew:jq` can mix managers.

## File Structure

| File | Responsibility |
|---|---|
| `apps/cli/src/core/errors.ts` | `OpsError`, `OpsErrorCode` |
| `apps/cli/src/core/package/spec.ts` | `PackageSpec`, `toPackageSpec`, `managerOf` |
| `apps/cli/src/providers/os.ts` | `parseOsRelease`, `managerFor`, `detectSystemManager` |
| `apps/cli/src/executor/exec.ts` | `Runner`, `execaRunner`, `CommandNotFoundError`, `sudoReady` |
| `apps/cli/src/providers/mise-bootstrap.ts` | `MiseBootstrap`, `createMiseBootstrap` |
| `apps/cli/src/core/package/install.ts` | `installPackages`, `InstallResult` |
| `apps/cli/src/core/output.ts` | `renderInstallResult` |
| `apps/cli/src/commands/package/install.ts` | oclif command |
| `apps/cli/test/**` | Vitest tests; `test/helpers/fake-runner.ts` |

---

### Task 1: Tooling, errors, and package specs

**Files:**
- Modify: `docs/superpowers/specs/2026-09-19-package-install-design.md`
- Modify: `apps/cli/package.json`, `package.json` (root), `pnpm-lock.yaml`
- Create: `apps/cli/src/core/errors.ts`, `apps/cli/src/core/package/spec.ts`
- Test: `apps/cli/test/core/package/spec.test.ts`

**Interfaces:**
- Produces: `class OpsError extends Error { code: OpsErrorCode }`; `type PackageSpec = \`${string}:${string}\``; `toPackageSpec(input: string, manager?: string): PackageSpec`; `managerOf(spec: PackageSpec): string`.

- [ ] **Step 1: Apply the four spec clarifications**

Edit the spec:
- In **Flow** step 3, change to: "Neither `--yes` nor `--non-interactive`, and (stdin is not a TTY **or** `--json` is set) → `CONFIRMATION_REQUIRED` (before anything is written)."
- Replace **Flow** step 8 with: "Under `--non-interactive`, if any missing spec uses `apt`/`dnf` and the user is not root, run `sudo -n true` before `apply`; non-zero → `SUDO_PASSWORD_REQUIRED`." (Move it before step 7 `apply`.)
- In **Errors and output**, add `MISE_COMMAND_FAILED` (a mise call exited non-zero; message includes mise's stderr) and narrow `MISE_BOOTSTRAP_UNAVAILABLE` to "mise not on PATH, `bootstrap packages` not recognized, or unexpected JSON".
- In **Interfaces**, replace `manager: string` in `InstallResult` with `managers: string[]   // distinct manager prefixes, e.g. ["apt"]`, and the `Runner`/`RunOptions` block with the one from Task 3 of this plan.

- [ ] **Step 2: Add dependencies and scripts**

Run:
```bash
pnpm --filter @ops/cli add execa@^10.0.1 zod@^4.6.5
pnpm --filter @ops/cli add -D vitest@^5.0.1
```

Edit `apps/cli/package.json` — replace `"scripts": {}` with:
```json
"scripts": {
  "build": "tsc",
  "dev": "tsc --watch",
  "test": "vitest run"
},
```

Edit root `package.json` `scripts` to:
```json
"scripts": {
  "build": "pnpm --filter @ops/cli build",
  "test": "pnpm --filter @ops/cli test",
  "ops": "node apps/cli/bin/run.js",
  "link:global": "ln -sf \"$PWD/apps/cli/bin/run.js\" \"$HOME/.local/bin/ops\""
}
```

- [ ] **Step 3: Write the failing test**

`apps/cli/test/core/package/spec.test.ts`:
```ts
import {describe, expect, it} from 'vitest'
import {OpsError} from '../../../src/core/errors.js'
import {managerOf, toPackageSpec} from '../../../src/core/package/spec.js'

describe('toPackageSpec', () => {
  it('prefixes a plain name with the given manager', () => {
    expect(toPackageSpec('zsh', 'apt')).toBe('apt:zsh')
  })

  it('keeps an explicit manager', () => {
    expect(toPackageSpec('brew:jq', 'apt')).toBe('brew:jq')
    expect(toPackageSpec('brew:postgresql@17')).toBe('brew:postgresql@17')
  })

  it.each(['-y', 'apt:-y', '', 'apt:', ':zsh', 'has space'])('rejects %j', (input) => {
    expect(() => toPackageSpec(input, 'apt')).toThrow(OpsError)
    try {
      toPackageSpec(input, 'apt')
    } catch (error) {
      expect((error as OpsError).code).toBe('INVALID_PACKAGE_NAME')
    }
  })

  it('rejects a plain name when no manager is known', () => {
    expect(() => toPackageSpec('zsh')).toThrow(OpsError)
  })
})

describe('managerOf', () => {
  it('returns the prefix', () => {
    expect(managerOf('apt:zsh')).toBe('apt')
  })
})
```

- [ ] **Step 4: Run test to verify it fails**

Run: `pnpm --filter @ops/cli exec vitest run test/core/package/spec.test.ts`
Expected: FAIL — cannot resolve `../../../src/core/errors.js`.

- [ ] **Step 5: Implement**

`apps/cli/src/core/errors.ts`:
```ts
export type OpsErrorCode =
  | 'UNSUPPORTED_PLATFORM'
  | 'INVALID_PACKAGE_NAME'
  | 'CONFIRMATION_REQUIRED'
  | 'SUDO_PASSWORD_REQUIRED'
  | 'MISE_BOOTSTRAP_UNAVAILABLE'
  | 'MISE_COMMAND_FAILED'

export class OpsError extends Error {
  readonly code: OpsErrorCode

  constructor(code: OpsErrorCode, message: string) {
    super(message)
    this.name = 'OpsError'
    this.code = code
  }
}
```

`apps/cli/src/core/package/spec.ts`:
```ts
import {OpsError} from '../errors.js'

export type PackageSpec = `${string}:${string}`

// A part must be non-empty, contain no whitespace, and not start with "-"
// (so it can never be read as an option by mise or the package manager).
const PART = /^[^\s-]\S*$/

export function toPackageSpec(input: string, manager?: string): PackageSpec {
  const colon = input.indexOf(':')
  const [mgr, name] = colon === -1 ? [manager, input] : [input.slice(0, colon), input.slice(colon + 1)]

  if (mgr === undefined) {
    throw new OpsError('INVALID_PACKAGE_NAME', `No package manager for "${input}"; use manager:package`)
  }

  if (!PART.test(mgr) || !PART.test(name)) {
    throw new OpsError('INVALID_PACKAGE_NAME', `Invalid package name: "${input}"`)
  }

  return `${mgr}:${name}`
}

export function managerOf(spec: PackageSpec): string {
  return spec.slice(0, spec.indexOf(':'))
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `pnpm --filter @ops/cli exec vitest run test/core/package/spec.test.ts`
Expected: PASS (all cases).

- [ ] **Step 7: Build compiles**

Run: `pnpm build`
Expected: exit 0, `apps/cli/dist/core/errors.js` and `apps/cli/dist/core/package/spec.js` exist.

- [ ] **Step 8: Commit**

```bash
git add docs/superpowers/specs/2026-09-19-package-install-design.md apps/cli/package.json package.json pnpm-lock.yaml apps/cli/src/core apps/cli/test/core/package/spec.test.ts
git commit -m "Add build/test tooling, OpsError and package specs

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: OS detection

**Files:**
- Create: `apps/cli/src/providers/os.ts`
- Test: `apps/cli/test/providers/os.test.ts`

**Interfaces:**
- Consumes: `OpsError` (Task 1).
- Produces: `type SystemManager = 'apt' | 'dnf'`; `parseOsRelease(text: string): OsRelease` where `interface OsRelease { id: string; idLike: string[] }`; `managerFor(os: OsRelease): SystemManager`; `detectSystemManager(readFile?: (path: string) => Promise<string>): Promise<SystemManager>`.

- [ ] **Step 1: Write the failing test**

`apps/cli/test/providers/os.test.ts`:
```ts
import {describe, expect, it} from 'vitest'
import {OpsError} from '../../src/core/errors.js'
import {detectSystemManager, managerFor, parseOsRelease} from '../../src/providers/os.js'

const UBUNTU = 'PRETTY_NAME="Ubuntu 24.04 LTS"\nID=ubuntu\nID_LIKE=debian\n'
const DEBIAN = 'ID=debian\n'
const FEDORA = 'ID=fedora\n'
const ROCKY = 'ID="rocky"\nID_LIKE="rhel centos fedora"\n'
const ALPINE = 'ID=alpine\n'

describe('parseOsRelease', () => {
  it('reads ID and ID_LIKE, stripping quotes', () => {
    expect(parseOsRelease(ROCKY)).toEqual({id: 'rocky', idLike: ['rhel', 'centos', 'fedora']})
    expect(parseOsRelease(DEBIAN)).toEqual({id: 'debian', idLike: []})
  })
})

describe('managerFor', () => {
  it.each([
    [UBUNTU, 'apt'],
    [DEBIAN, 'apt'],
    [FEDORA, 'dnf'],
    [ROCKY, 'dnf'],
  ])('maps %j to %s', (text, manager) => {
    expect(managerFor(parseOsRelease(text))).toBe(manager)
  })

  it('rejects unsupported distros', () => {
    expect(() => managerFor(parseOsRelease(ALPINE))).toThrow(/Unsupported platform: alpine/)
  })
})

describe('detectSystemManager', () => {
  it('reads /etc/os-release', async () => {
    let asked = ''
    const manager = await detectSystemManager(async (path) => {
      asked = path
      return UBUNTU
    })
    expect(asked).toBe('/etc/os-release')
    expect(manager).toBe('apt')
  })

  it('fails with UNSUPPORTED_PLATFORM when the file is missing', async () => {
    const error = await detectSystemManager(async () => {
      throw new Error('ENOENT')
    }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(OpsError)
    expect((error as OpsError).code).toBe('UNSUPPORTED_PLATFORM')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @ops/cli exec vitest run test/providers/os.test.ts`
Expected: FAIL — cannot resolve `../../src/providers/os.js`.

- [ ] **Step 3: Implement**

`apps/cli/src/providers/os.ts`:
```ts
import {readFile as fsReadFile} from 'node:fs/promises'

import {OpsError} from '../core/errors.js'

export type SystemManager = 'apt' | 'dnf'

export interface OsRelease {
  id: string
  idLike: string[]
}

const MANAGERS: Record<string, SystemManager> = {
  centos: 'dnf',
  debian: 'apt',
  fedora: 'dnf',
  rhel: 'dnf',
  ubuntu: 'apt',
}

export function parseOsRelease(text: string): OsRelease {
  const values: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const match = /^([A-Z_]+)=(.*)$/.exec(line.trim())
    if (match) values[match[1]] = match[2].replace(/^["']|["']$/g, '')
  }

  return {id: values.ID ?? '', idLike: (values.ID_LIKE ?? '').split(/\s+/).filter(Boolean)}
}

export function managerFor(os: OsRelease): SystemManager {
  for (const token of [os.id, ...os.idLike]) {
    const manager = MANAGERS[token]
    if (manager) return manager
  }

  throw new OpsError('UNSUPPORTED_PLATFORM', `Unsupported platform: ${os.id || 'unknown'} (supported: Debian/Ubuntu via apt, RHEL/Fedora/CentOS via dnf)`)
}

export async function detectSystemManager(
  readFile: (path: string) => Promise<string> = (path) => fsReadFile(path, 'utf8'),
): Promise<SystemManager> {
  let text: string
  try {
    text = await readFile('/etc/os-release')
  } catch {
    throw new OpsError('UNSUPPORTED_PLATFORM', 'Cannot read /etc/os-release; use manager:package (e.g. brew:jq)')
  }

  return managerFor(parseOsRelease(text))
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @ops/cli exec vitest run test/providers/os.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/providers/os.ts apps/cli/test/providers/os.test.ts
git commit -m "Detect the system package manager from /etc/os-release

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Executor

**Files:**
- Create: `apps/cli/src/executor/exec.ts`, `apps/cli/test/helpers/fake-runner.ts`
- Test: `apps/cli/test/executor/exec.test.ts`

**Interfaces:**
- Produces:
  ```ts
  interface RunOptions { stdout?: 'capture' | 'inherit'; stdin?: 'inherit' | 'ignore' }
  interface RunResult { stdout: string; stderr: string; exitCode: number }
  interface Runner { run(cmd: string, args: string[], opts?: RunOptions): Promise<RunResult> }
  class CommandNotFoundError extends Error { command: string }
  const execaRunner: Runner
  function sudoReady(runner: Runner, uid?: number): Promise<boolean>
  // test helper
  class FakeRunner implements Runner { calls: {cmd, args, opts}[]; on(prefix: string, ...results: Partial<RunResult>[]): this }
  ```
- `run` never throws on non-zero exit; it throws `CommandNotFoundError` only when the binary does not exist. With `stdout: 'inherit'`, stdout and stderr stream to the terminal and the returned `stdout`/`stderr` are `''`.

- [ ] **Step 1: Write the failing test**

`apps/cli/test/executor/exec.test.ts`:
```ts
import {describe, expect, it} from 'vitest'
import {CommandNotFoundError, execaRunner, sudoReady} from '../../src/executor/exec.js'
import {FakeRunner} from '../helpers/fake-runner.js'

describe('execaRunner', () => {
  it('captures stdout, stderr and a non-zero exit code without throwing', async () => {
    const result = await execaRunner.run('node', ['-e', 'process.stdout.write("out");process.stderr.write("err");process.exit(3)'])
    expect(result).toEqual({stdout: 'out', stderr: 'err', exitCode: 3})
  })

  it('passes arguments verbatim (no shell)', async () => {
    const result = await execaRunner.run('node', ['-e', 'process.stdout.write(process.argv[1])', '$HOME; echo hi'])
    expect(result.stdout).toBe('$HOME; echo hi')
  })

  it('throws CommandNotFoundError for a missing binary', async () => {
    await expect(execaRunner.run('definitely-not-a-command-xyz', [])).rejects.toBeInstanceOf(CommandNotFoundError)
  })
})

describe('sudoReady', () => {
  it('is true for root without running sudo', async () => {
    const runner = new FakeRunner()
    expect(await sudoReady(runner, 0)).toBe(true)
    expect(runner.calls).toEqual([])
  })

  it('runs sudo -n true for a normal user', async () => {
    const runner = new FakeRunner().on('sudo -n true', {exitCode: 1})
    expect(await sudoReady(runner, 1000)).toBe(false)
    expect(runner.calls[0]).toMatchObject({cmd: 'sudo', args: ['-n', 'true']})
  })

  it('is false when sudo is not installed', async () => {
    const runner: FakeRunner = new FakeRunner()
    runner.run = async () => {
      throw new CommandNotFoundError('sudo')
    }
    expect(await sudoReady(runner, 1000)).toBe(false)
  })
})
```

`apps/cli/test/helpers/fake-runner.ts`:
```ts
import type {RunOptions, RunResult, Runner} from '../../src/executor/exec.js'

interface Response {
  prefix: string
  results: Partial<RunResult>[]
}

/**
 * Records calls and answers by command-line prefix ("cmd arg1 arg2 ...").
 * Results for one prefix are consumed in order; the last one repeats.
 * Later `on()` calls take precedence over earlier ones for overlapping prefixes.
 */
export class FakeRunner implements Runner {
  calls: {cmd: string; args: string[]; opts?: RunOptions}[] = []
  private responses: Response[] = []

  on(prefix: string, ...results: Partial<RunResult>[]): this {
    this.responses.push({prefix, results: results.length > 0 ? results : [{}]})
    return this
  }

  async run(cmd: string, args: string[], opts?: RunOptions): Promise<RunResult> {
    this.calls.push({cmd, args, opts})
    const line = [cmd, ...args].join(' ')
    const response = [...this.responses].reverse().find((r) => line.startsWith(r.prefix))
    if (!response) throw new Error(`FakeRunner: no response for "${line}"`)
    const result = response.results.length > 1 ? response.results.shift()! : response.results[0]
    return {stdout: '', stderr: '', exitCode: 0, ...result}
  }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @ops/cli exec vitest run test/executor/exec.test.ts`
Expected: FAIL — cannot resolve `../../src/executor/exec.js`.

- [ ] **Step 3: Implement**

`apps/cli/src/executor/exec.ts`:
```ts
import {execa} from 'execa'

export interface RunOptions {
  /** capture (default): collect output; inherit: stream stdout/stderr to the terminal. */
  stdout?: 'capture' | 'inherit'
  stdin?: 'inherit' | 'ignore'
}

export interface RunResult {
  stdout: string
  stderr: string
  exitCode: number
}

export interface Runner {
  /** Never throws on a non-zero exit; throws CommandNotFoundError if the binary does not exist. */
  run(cmd: string, args: string[], opts?: RunOptions): Promise<RunResult>
}

export class CommandNotFoundError extends Error {
  readonly command: string

  constructor(command: string) {
    super(`Command not found: ${command}`)
    this.name = 'CommandNotFoundError'
    this.command = command
  }
}

export const execaRunner: Runner = {
  async run(cmd, args, opts = {}) {
    const output = opts.stdout === 'inherit' ? 'inherit' : 'pipe'
    const result = await execa(cmd, args, {
      reject: false,
      stderr: output,
      stdin: opts.stdin ?? 'inherit',
      stdout: output,
    })

    if ((result as {code?: string}).code === 'ENOENT') throw new CommandNotFoundError(cmd)

    return {
      exitCode: result.exitCode ?? 1,
      stderr: typeof result.stderr === 'string' ? result.stderr : '',
      stdout: typeof result.stdout === 'string' ? result.stdout : '',
    }
  },
}

/** True when privileged commands can run without a password prompt. */
export async function sudoReady(runner: Runner, uid: number | undefined = process.getuid?.()): Promise<boolean> {
  if (uid === 0) return true
  try {
    const result = await runner.run('sudo', ['-n', 'true'], {stdin: 'ignore'})
    return result.exitCode === 0
  } catch {
    return false
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @ops/cli exec vitest run test/executor/exec.test.ts`
Expected: PASS. If the ENOENT test fails, log the resolved `result` for a missing binary and adjust the ENOENT check to the property execa 10 actually sets (e.g. `result.cause?.code`), keeping the test unchanged.

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/executor/exec.ts apps/cli/test/executor/exec.test.ts apps/cli/test/helpers/fake-runner.ts
git commit -m "Add execa-based Runner with sudo readiness check

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: mise bootstrap provider

**Files:**
- Create: `apps/cli/src/providers/mise-bootstrap.ts`
- Test: `apps/cli/test/providers/mise-bootstrap.test.ts`

**Interfaces:**
- Consumes: `Runner`, `CommandNotFoundError` (Task 3); `OpsError` (Task 1); `PackageSpec` (Task 1); `FakeRunner` (Task 3).
- Produces:
  ```ts
  interface PackageState { spec: PackageSpec; installed: boolean; version?: string }
  interface ApplyOptions { yes: boolean; nonInteractive: boolean; capture: boolean }
  interface MiseBootstrap {
    declare(specs: PackageSpec[]): Promise<void>
    status(): Promise<PackageState[]>
    apply(specs: PackageSpec[], opts: ApplyOptions): Promise<{exitCode: number}>
    dryRun(specs: PackageSpec[]): Promise<string[]>
  }
  function createMiseBootstrap(runner: Runner): MiseBootstrap
  ```

- [ ] **Step 1: Write the failing test**

`apps/cli/test/providers/mise-bootstrap.test.ts`:
```ts
import {describe, expect, it} from 'vitest'
import {OpsError} from '../../src/core/errors.js'
import {CommandNotFoundError} from '../../src/executor/exec.js'
import {createMiseBootstrap} from '../../src/providers/mise-bootstrap.js'
import {FakeRunner} from '../helpers/fake-runner.js'

// Shape observed from `mise bootstrap packages status --json` on mise 2026.9.11.
const STATUS = JSON.stringify({
  apt: {
    available: true,
    packages: [
      {desired_state: 'present', installed_version: '5.9-6ubuntu2', package: 'zsh', requested_version: 'latest', state: 'installed'},
      {desired_state: 'present', installed_version: null, package: 'sl', requested_version: 'latest', state: 'missing'},
    ],
  },
  brew: {available: false, packages: []},
})

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  const error = await promise.then(() => undefined, (e: unknown) => e)
  expect(error).toBeInstanceOf(OpsError)
  return (error as OpsError).code
}

describe('createMiseBootstrap', () => {
  it('declare runs use -g --no-install', async () => {
    const runner = new FakeRunner().on('mise')
    await createMiseBootstrap(runner).declare(['apt:zsh', 'apt:sl'])
    expect(runner.calls[0]).toMatchObject({cmd: 'mise', args: ['bootstrap', 'packages', 'use', '-g', '--no-install', 'apt:zsh', 'apt:sl']})
  })

  it('status parses JSON into package states', async () => {
    const runner = new FakeRunner().on('mise bootstrap packages status --json', {stdout: STATUS})
    expect(await createMiseBootstrap(runner).status()).toEqual([
      {installed: true, spec: 'apt:zsh', version: '5.9-6ubuntu2'},
      {installed: false, spec: 'apt:sl', version: undefined},
    ])
  })

  it('status rejects unexpected JSON with MISE_BOOTSTRAP_UNAVAILABLE', async () => {
    const runner = new FakeRunner().on('mise', {stdout: '{"apt": {"packages": "nope"}}'})
    expect(await codeOf(createMiseBootstrap(runner).status())).toBe('MISE_BOOTSTRAP_UNAVAILABLE')
    const garbage = new FakeRunner().on('mise', {stdout: 'not json'})
    expect(await codeOf(createMiseBootstrap(garbage).status())).toBe('MISE_BOOTSTRAP_UNAVAILABLE')
  })

  it('apply passes --yes and streams output unless capturing', async () => {
    const runner = new FakeRunner().on('mise', {exitCode: 0})
    const mise = createMiseBootstrap(runner)
    await mise.apply(['apt:sl'], {capture: false, nonInteractive: false, yes: true})
    await mise.apply(['apt:sl'], {capture: true, nonInteractive: true, yes: false})
    expect(runner.calls[0]).toMatchObject({args: ['bootstrap', 'packages', 'apply', '--yes', 'apt:sl'], opts: {stdin: 'inherit', stdout: 'inherit'}})
    expect(runner.calls[1]).toMatchObject({args: ['bootstrap', 'packages', 'apply', 'apt:sl'], opts: {stdin: 'ignore', stdout: 'capture'}})
  })

  it('apply returns a non-zero exit code instead of throwing', async () => {
    const runner = new FakeRunner().on('mise', {exitCode: 100})
    expect(await createMiseBootstrap(runner).apply(['apt:sl'], {capture: true, nonInteractive: true, yes: true})).toEqual({exitCode: 100})
  })

  it('dryRun returns the planned lines from stdout', async () => {
    const stdout = '~/.config/mise/config.toml: "apt:sl" = "latest"\nsudo env DEBIAN_FRONTEND=noninteractive apt-get install -y -- sl\n'
    const runner = new FakeRunner().on('mise', {stdout})
    expect(await createMiseBootstrap(runner).dryRun(['apt:sl'])).toEqual([
      '~/.config/mise/config.toml: "apt:sl" = "latest"',
      'sudo env DEBIAN_FRONTEND=noninteractive apt-get install -y -- sl',
    ])
    expect(runner.calls[0].args).toEqual(['bootstrap', 'packages', 'use', '-g', '--dry-run', 'apt:sl'])
  })

  it('maps a missing mise binary to MISE_BOOTSTRAP_UNAVAILABLE', async () => {
    const runner = new FakeRunner()
    runner.run = async () => {
      throw new CommandNotFoundError('mise')
    }
    expect(await codeOf(createMiseBootstrap(runner).declare(['apt:zsh']))).toBe('MISE_BOOTSTRAP_UNAVAILABLE')
  })

  it('maps an old mise without bootstrap to MISE_BOOTSTRAP_UNAVAILABLE', async () => {
    const runner = new FakeRunner().on('mise', {exitCode: 2, stderr: "error: unrecognized subcommand 'bootstrap'"})
    expect(await codeOf(createMiseBootstrap(runner).status())).toBe('MISE_BOOTSTRAP_UNAVAILABLE')
  })

  it('maps other mise failures to MISE_COMMAND_FAILED with stderr', async () => {
    const runner = new FakeRunner().on('mise', {exitCode: 1, stderr: "unknown bootstrap package manager 'yum'"})
    const error = await createMiseBootstrap(runner).declare(['yum:zsh']).catch((e: unknown) => e)
    expect((error as OpsError).code).toBe('MISE_COMMAND_FAILED')
    expect((error as OpsError).message).toContain("unknown bootstrap package manager 'yum'")
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @ops/cli exec vitest run test/providers/mise-bootstrap.test.ts`
Expected: FAIL — cannot resolve `../../src/providers/mise-bootstrap.js`.

- [ ] **Step 3: Implement**

`apps/cli/src/providers/mise-bootstrap.ts`:
```ts
import {z} from 'zod'

import {OpsError} from '../core/errors.js'
import type {PackageSpec} from '../core/package/spec.js'
import {CommandNotFoundError, type RunOptions, type RunResult, type Runner} from '../executor/exec.js'

export interface PackageState {
  spec: PackageSpec
  installed: boolean
  version?: string
}

export interface ApplyOptions {
  yes: boolean
  nonInteractive: boolean
  /** Capture mise's output instead of streaming it (used with --json). */
  capture: boolean
}

export interface MiseBootstrap {
  declare(specs: PackageSpec[]): Promise<void>
  status(): Promise<PackageState[]>
  apply(specs: PackageSpec[], opts: ApplyOptions): Promise<{exitCode: number}>
  dryRun(specs: PackageSpec[]): Promise<string[]>
}

// Only the fields ops relies on; unknown fields are ignored.
const StatusSchema = z.record(
  z.string(),
  z.object({
    packages: z
      .array(
        z.object({
          installed_version: z.string().nullish(),
          package: z.string(),
          state: z.string(),
        }),
      )
      .default([]),
  }),
)

const BASE = ['bootstrap', 'packages']

export function createMiseBootstrap(runner: Runner): MiseBootstrap {
  async function mise(args: string[], opts?: RunOptions): Promise<RunResult> {
    try {
      return await runner.run('mise', [...BASE, ...args], opts)
    } catch (error) {
      if (error instanceof CommandNotFoundError) {
        throw new OpsError('MISE_BOOTSTRAP_UNAVAILABLE', 'mise not found on PATH; install it from https://mise.jdx.dev')
      }

      throw error
    }
  }

  async function checked(args: string[]): Promise<RunResult> {
    const result = await mise(args)
    if (result.exitCode === 0) return result
    if (/unrecognized subcommand/.test(result.stderr)) {
      throw new OpsError('MISE_BOOTSTRAP_UNAVAILABLE', 'This mise version has no `mise bootstrap packages`; upgrade mise (mise self-update)')
    }

    throw new OpsError('MISE_COMMAND_FAILED', `mise ${[...BASE, ...args].join(' ')} failed: ${result.stderr.trim()}`)
  }

  return {
    async apply(specs, opts) {
      const result = await mise(['apply', ...(opts.yes ? ['--yes'] : []), ...specs], {
        stdin: opts.nonInteractive ? 'ignore' : 'inherit',
        stdout: opts.capture ? 'capture' : 'inherit',
      })
      return {exitCode: result.exitCode}
    },

    async declare(specs) {
      await checked(['use', '-g', '--no-install', ...specs])
    },

    async dryRun(specs) {
      const {stdout} = await checked(['use', '-g', '--dry-run', ...specs])
      return stdout.split('\n').map((line) => line.trim()).filter(Boolean)
    },

    async status() {
      const {stdout} = await checked(['status', '--json'])
      let parsed: z.infer<typeof StatusSchema>
      try {
        parsed = StatusSchema.parse(JSON.parse(stdout))
      } catch (error) {
        throw new OpsError('MISE_BOOTSTRAP_UNAVAILABLE', `Unexpected output from mise bootstrap packages status --json: ${(error as Error).message}`)
      }

      return Object.entries(parsed).flatMap(([manager, {packages}]) =>
        packages.map((p) => ({
          installed: p.state === 'installed',
          spec: `${manager}:${p.package}` as PackageSpec,
          version: p.installed_version ?? undefined,
        })),
      )
    },
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @ops/cli exec vitest run test/providers/mise-bootstrap.test.ts`
Expected: PASS.

- [ ] **Step 5: Check against real mise (read-only)**

Run:
```bash
pnpm build && node --input-type=module -e "
import {createMiseBootstrap} from './apps/cli/dist/providers/mise-bootstrap.js'
import {execaRunner} from './apps/cli/dist/executor/exec.js'
const m = createMiseBootstrap(execaRunner)
console.log(await m.status())
console.log(await m.dryRun(['apt:sl']))"
```
Expected: `status()` lists `apt:zsh` as `installed: true` with version `5.9-6ubuntu2`; `dryRun` prints the config line and `sudo env DEBIAN_FRONTEND=noninteractive apt-get install -y -- sl`. Nothing is written or installed.

- [ ] **Step 6: Commit**

```bash
git add apps/cli/src/providers/mise-bootstrap.ts apps/cli/test/providers/mise-bootstrap.test.ts
git commit -m "Wrap mise bootstrap packages as the package provider

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Install use case

**Files:**
- Create: `apps/cli/src/core/package/install.ts`
- Test: `apps/cli/test/core/package/install.test.ts`

**Interfaces:**
- Consumes: `toPackageSpec`, `managerOf`, `PackageSpec` (Task 1); `OpsError` (Task 1); `SystemManager` (Task 2); `MiseBootstrap`, `PackageState` (Task 4).
- Produces:
  ```ts
  type PackageStatus = 'already-installed' | 'installed' | 'would-install' | 'failed'
  interface InstallResult {
    success: boolean; action: 'install'; managers: string[]; dryRun: boolean
    commands?: string[]
    packages: {spec: PackageSpec; status: PackageStatus; version?: string}[]
  }
  interface InstallOptions { packages: string[]; yes: boolean; nonInteractive: boolean; dryRun: boolean; json: boolean }
  interface InstallDeps {
    mise: MiseBootstrap
    detectManager: () => Promise<SystemManager>
    isTTY: boolean
    sudoReady: () => Promise<boolean>
  }
  function installPackages(options: InstallOptions, deps: InstallDeps): Promise<InstallResult>
  ```

- [ ] **Step 1: Write the failing test**

`apps/cli/test/core/package/install.test.ts`:
```ts
import {describe, expect, it} from 'vitest'
import {OpsError} from '../../../src/core/errors.js'
import {type InstallDeps, type InstallOptions, installPackages} from '../../../src/core/package/install.js'
import type {PackageSpec} from '../../../src/core/package/spec.js'
import type {ApplyOptions, MiseBootstrap, PackageState} from '../../../src/providers/mise-bootstrap.js'

class FakeMise implements MiseBootstrap {
  calls: string[] = []
  applied: {specs: PackageSpec[]; opts: ApplyOptions}[] = []
  declared = new Set<string>()
  installed = new Map<string, string>() // spec -> version
  installOnApply = true

  async declare(specs: PackageSpec[]) {
    this.calls.push('declare')
    for (const s of specs) this.declared.add(s)
  }

  async status(): Promise<PackageState[]> {
    this.calls.push('status')
    return [...this.declared].map((s) => ({
      installed: this.installed.has(s),
      spec: s as PackageSpec,
      version: this.installed.get(s),
    }))
  }

  async apply(specs: PackageSpec[], opts: ApplyOptions) {
    this.calls.push('apply')
    this.applied.push({opts, specs})
    if (this.installOnApply) for (const s of specs) this.installed.set(s, '1.0')
    return {exitCode: this.installOnApply ? 0 : 100}
  }

  async dryRun(specs: PackageSpec[]) {
    this.calls.push('dryRun')
    return specs.map((s) => `would install ${s}`)
  }
}

function setup(overrides: Partial<InstallDeps> = {}) {
  const mise = new FakeMise()
  const deps: InstallDeps = {
    detectManager: async () => 'apt',
    isTTY: true,
    mise,
    sudoReady: async () => true,
    ...overrides,
  }
  return {deps, mise}
}

const opts = (o: Partial<InstallOptions>): InstallOptions => ({dryRun: false, json: false, nonInteractive: false, packages: [], yes: false, ...o})

async function codeOf(promise: Promise<unknown>) {
  const error = await promise.then(() => undefined, (e: unknown) => e)
  expect(error).toBeInstanceOf(OpsError)
  return (error as OpsError).code
}

describe('installPackages', () => {
  it('reports already-installed packages without calling apply', async () => {
    const {deps, mise} = setup()
    mise.installed.set('apt:zsh', '5.9')
    const result = await installPackages(opts({packages: ['zsh'], yes: true}), deps)
    expect(result).toEqual({
      action: 'install',
      dryRun: false,
      managers: ['apt'],
      packages: [{spec: 'apt:zsh', status: 'already-installed', version: '5.9'}],
      success: true,
    })
    expect(mise.calls).toEqual(['declare', 'status'])
  })

  it('declares everything but applies only missing packages', async () => {
    const {deps, mise} = setup()
    mise.installed.set('apt:zsh', '5.9')
    const result = await installPackages(opts({packages: ['zsh', 'sl', 'zsh'], yes: true}), deps)
    expect([...mise.declared]).toEqual(['apt:zsh', 'apt:sl'])
    expect(mise.applied).toEqual([{opts: {capture: false, nonInteractive: false, yes: true}, specs: ['apt:sl']}])
    expect(result.packages).toEqual([
      {spec: 'apt:zsh', status: 'already-installed', version: '5.9'},
      {spec: 'apt:sl', status: 'installed', version: '1.0'},
    ])
    expect(result.success).toBe(true)
  })

  it('marks packages still missing after apply as failed', async () => {
    const {deps, mise} = setup()
    mise.installOnApply = false
    const result = await installPackages(opts({packages: ['nope'], yes: true}), deps)
    expect(result.packages).toEqual([{spec: 'apt:nope', status: 'failed'}])
    expect(result.success).toBe(false)
  })

  it('dry-run writes nothing and reports would-install', async () => {
    const {deps, mise} = setup()
    const result = await installPackages(opts({dryRun: true, packages: ['sl']}), deps)
    expect(mise.calls).toEqual(['dryRun', 'status'])
    expect(result).toMatchObject({commands: ['would install apt:sl'], dryRun: true, success: true})
    expect(result.packages).toEqual([{spec: 'apt:sl', status: 'would-install'}])
  })

  it('requires confirmation flags without a TTY or with --json', async () => {
    const noTty = setup({isTTY: false})
    expect(await codeOf(installPackages(opts({packages: ['sl']}), noTty.deps))).toBe('CONFIRMATION_REQUIRED')
    expect(noTty.mise.calls).toEqual([])

    const json = setup()
    expect(await codeOf(installPackages(opts({json: true, packages: ['sl']}), json.deps))).toBe('CONFIRMATION_REQUIRED')
  })

  it('lets mise prompt on a TTY without --yes', async () => {
    const {deps, mise} = setup()
    await installPackages(opts({packages: ['sl']}), deps)
    expect(mise.applied[0].opts).toEqual({capture: false, nonInteractive: false, yes: false})
  })

  it('non-interactive implies yes and checks sudo first', async () => {
    const {deps, mise} = setup({sudoReady: async () => false})
    expect(await codeOf(installPackages(opts({nonInteractive: true, packages: ['sl']}), deps))).toBe('SUDO_PASSWORD_REQUIRED')
    expect(mise.calls).not.toContain('apply')

    const ok = setup()
    await installPackages(opts({json: true, nonInteractive: true, packages: ['sl']}), ok.deps)
    expect(ok.mise.applied[0].opts).toEqual({capture: true, nonInteractive: true, yes: true})
  })

  it('skips the sudo check for managers that do not need root', async () => {
    let checked = false
    const {deps} = setup({sudoReady: async () => (checked = true)})
    await installPackages(opts({nonInteractive: true, packages: ['brew:jq']}), deps)
    expect(checked).toBe(false)
  })

  it('does not detect the OS when every package names its manager', async () => {
    const {deps} = setup({
      detectManager: async () => {
        throw new OpsError('UNSUPPORTED_PLATFORM', 'nope')
      },
    })
    const result = await installPackages(opts({packages: ['brew:jq'], yes: true}), deps)
    expect(result.managers).toEqual(['brew'])
  })

  it('rejects an empty package list and invalid names', async () => {
    const {deps} = setup()
    expect(await codeOf(installPackages(opts({packages: [], yes: true}), deps))).toBe('INVALID_PACKAGE_NAME')
    expect(await codeOf(installPackages(opts({packages: ['--force'], yes: true}), deps))).toBe('INVALID_PACKAGE_NAME')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @ops/cli exec vitest run test/core/package/install.test.ts`
Expected: FAIL — cannot resolve `../../../src/core/package/install.js`.

- [ ] **Step 3: Implement**

`apps/cli/src/core/package/install.ts`:
```ts
import type {MiseBootstrap, PackageState} from '../../providers/mise-bootstrap.js'
import type {SystemManager} from '../../providers/os.js'
import {OpsError} from '../errors.js'
import {type PackageSpec, managerOf, toPackageSpec} from './spec.js'

export type PackageStatus = 'already-installed' | 'installed' | 'would-install' | 'failed'

export interface InstallResult {
  success: boolean
  action: 'install'
  /** Distinct manager prefixes of the requested specs, e.g. ["apt"]. */
  managers: string[]
  dryRun: boolean
  /** Dry run only: what mise would do. */
  commands?: string[]
  packages: {spec: PackageSpec; status: PackageStatus; version?: string}[]
}

export interface InstallOptions {
  packages: string[]
  yes: boolean
  nonInteractive: boolean
  dryRun: boolean
  json: boolean
}

export interface InstallDeps {
  mise: MiseBootstrap
  detectManager: () => Promise<SystemManager>
  isTTY: boolean
  /** True when privileged commands can run without a password prompt. */
  sudoReady: () => Promise<boolean>
}

const PRIVILEGED_MANAGERS = new Set(['apt', 'dnf'])

export async function installPackages(options: InstallOptions, deps: InstallDeps): Promise<InstallResult> {
  if (options.packages.length === 0) throw new OpsError('INVALID_PACKAGE_NAME', 'No packages given')

  const needsDetection = options.packages.some((p) => !p.includes(':'))
  const manager = needsDetection ? await deps.detectManager() : undefined
  const specs = [...new Set(options.packages.map((p) => toPackageSpec(p, manager)))]
  const managers = [...new Set(specs.map(managerOf))]
  const base = {action: 'install' as const, dryRun: options.dryRun, managers}

  if (options.dryRun) {
    const commands = await deps.mise.dryRun(specs)
    const state = byspec(await deps.mise.status())
    return {
      ...base,
      commands,
      packages: specs.map((spec) =>
        state.get(spec)?.installed
          ? {spec, status: 'already-installed', version: state.get(spec)?.version}
          : {spec, status: 'would-install'},
      ),
      success: true,
    }
  }

  const autoYes = options.yes || options.nonInteractive
  if (!autoYes && (options.json || !deps.isTTY)) {
    throw new OpsError('CONFIRMATION_REQUIRED', 'Confirmation required: re-run with --yes (or --non-interactive)')
  }

  await deps.mise.declare(specs)
  const before = byspec(await deps.mise.status())
  const missing = specs.filter((spec) => !before.get(spec)?.installed)

  let after = before
  if (missing.length > 0) {
    const needsRoot = missing.some((spec) => PRIVILEGED_MANAGERS.has(managerOf(spec)))
    if (options.nonInteractive && needsRoot && !(await deps.sudoReady())) {
      throw new OpsError('SUDO_PASSWORD_REQUIRED', 'sudo needs a password; run without --non-interactive or configure passwordless sudo')
    }

    await deps.mise.apply(missing, {capture: options.json, nonInteractive: options.nonInteractive, yes: autoYes})
    after = byspec(await deps.mise.status())
  }

  const packages = specs.map((spec): InstallResult['packages'][number] => {
    if (before.get(spec)?.installed) return {spec, status: 'already-installed', version: before.get(spec)?.version}
    if (after.get(spec)?.installed) return {spec, status: 'installed', version: after.get(spec)?.version}
    return {spec, status: 'failed'}
  })

  return {...base, packages, success: packages.every((p) => p.status !== 'failed')}
}

function byspec(states: PackageState[]): Map<string, PackageState> {
  return new Map(states.map((s) => [s.spec, s]))
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @ops/cli exec vitest run test/core/package/install.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/core/package/install.ts apps/cli/test/core/package/install.test.ts
git commit -m "Add installPackages use case (declare, check, apply, verify)

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Output rendering and the oclif command

**Files:**
- Create: `apps/cli/src/core/output.ts`, `apps/cli/src/commands/package/install.ts`
- Test: `apps/cli/test/core/output.test.ts`

**Interfaces:**
- Consumes: `InstallResult`, `installPackages` (Task 5); `createMiseBootstrap` (Task 4); `detectSystemManager` (Task 2); `execaRunner`, `sudoReady` (Task 3); `OpsError` (Task 1).
- Produces: `renderInstallResult(result: InstallResult): string[]`; the `ops package install` command.

- [ ] **Step 1: Write the failing test**

`apps/cli/test/core/output.test.ts`:
```ts
import {describe, expect, it} from 'vitest'
import {renderInstallResult} from '../../src/core/output.js'

describe('renderInstallResult', () => {
  it('renders one aligned line per package', () => {
    expect(
      renderInstallResult({
        action: 'install',
        dryRun: false,
        managers: ['apt'],
        packages: [
          {spec: 'apt:zsh', status: 'already-installed', version: '5.9-6ubuntu2'},
          {spec: 'apt:ripgrep', status: 'installed', version: '14.1.0'},
          {spec: 'apt:foo', status: 'failed'},
        ],
        success: false,
      }),
    ).toEqual([
      'Package manager: apt',
      '✓ apt:zsh      already installed (5.9-6ubuntu2)',
      '+ apt:ripgrep  installed (14.1.0)',
      '✗ apt:foo      failed',
    ])
  })

  it('shows planned commands for a dry run', () => {
    expect(
      renderInstallResult({
        action: 'install',
        commands: ['sudo apt-get install -y -- sl'],
        dryRun: true,
        managers: ['apt'],
        packages: [{spec: 'apt:sl', status: 'would-install'}],
        success: true,
      }),
    ).toEqual(['Package manager: apt', '~ apt:sl  would install', '', 'Would run:', '  sudo apt-get install -y -- sl'])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @ops/cli exec vitest run test/core/output.test.ts`
Expected: FAIL — cannot resolve `../../src/core/output.js`.

- [ ] **Step 3: Implement rendering**

`apps/cli/src/core/output.ts`:
```ts
import type {InstallResult, PackageStatus} from './package/install.js'

const LABELS: Record<PackageStatus, [symbol: string, text: string]> = {
  'already-installed': ['✓', 'already installed'],
  failed: ['✗', 'failed'],
  installed: ['+', 'installed'],
  'would-install': ['~', 'would install'],
}

export function renderInstallResult(result: InstallResult): string[] {
  const width = Math.max(...result.packages.map((p) => p.spec.length))
  const lines = [`Package manager: ${result.managers.join(', ')}`]

  for (const p of result.packages) {
    const [symbol, text] = LABELS[p.status]
    lines.push(`${symbol} ${p.spec.padEnd(width)}  ${text}${p.version ? ` (${p.version})` : ''}`)
  }

  if (result.commands && result.commands.length > 0) {
    lines.push('', 'Would run:', ...result.commands.map((c) => `  ${c}`))
  }

  return lines
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @ops/cli exec vitest run test/core/output.test.ts`
Expected: PASS.

- [ ] **Step 5: Implement the command**

`apps/cli/src/commands/package/install.ts`:
```ts
import {Command, Flags} from '@oclif/core'

import {OpsError} from '../../core/errors.js'
import {renderInstallResult} from '../../core/output.js'
import {type InstallResult, installPackages} from '../../core/package/install.js'
import {execaRunner, sudoReady} from '../../executor/exec.js'
import {createMiseBootstrap} from '../../providers/mise-bootstrap.js'
import {detectSystemManager} from '../../providers/os.js'

export default class PackageInstall extends Command {
  static override summary = 'Install system packages'
  static override description =
    'Records packages in [bootstrap.packages] of the global mise config and installs the missing ones via `mise bootstrap packages`. Plain names use the OS package manager (apt or dnf); use manager:package to pick one (e.g. brew:jq).'
  static override examples = [
    '<%= config.bin %> package install zsh',
    '<%= config.bin %> package install zsh git --yes',
    '<%= config.bin %> package install sl --dry-run',
    '<%= config.bin %> package install brew:jq --json --non-interactive',
  ]
  static override enableJsonFlag = true
  // Variadic package names; anything that looks like an unknown flag is rejected by toPackageSpec.
  static override strict = false
  static override flags = {
    'dry-run': Flags.boolean({summary: 'Show what would be installed without writing config or installing'}),
    'non-interactive': Flags.boolean({summary: 'Never prompt (implies --yes); fail if sudo needs a password'}),
    yes: Flags.boolean({char: 'y', summary: 'Skip the confirmation prompt'}),
  }

  async run(): Promise<InstallResult> {
    const {argv, flags} = await this.parse(PackageInstall)
    const result = await installPackages(
      {
        dryRun: flags['dry-run'],
        json: this.jsonEnabled(),
        nonInteractive: flags['non-interactive'],
        packages: argv as string[],
        yes: flags.yes,
      },
      {
        detectManager: () => detectSystemManager(),
        isTTY: Boolean(process.stdin.isTTY),
        mise: createMiseBootstrap(execaRunner),
        sudoReady: () => sudoReady(execaRunner),
      },
    )

    if (!this.jsonEnabled()) for (const line of renderInstallResult(result)) this.log(line)
    if (!result.success) process.exitCode = 1
    return result
  }

  protected override async catch(error: Error & {exitCode?: number}): Promise<unknown> {
    if (!(error instanceof OpsError)) return super.catch(error)
    if (this.jsonEnabled()) {
      process.exitCode = 1
      this.logJson({error: {code: error.code, message: error.message}, success: false})
      return
    }

    this.error(error.message, {code: error.code, exit: 1})
  }
}
```

- [ ] **Step 6: Build and run the whole suite**

Run: `pnpm build && pnpm test`
Expected: tsc exit 0; all test files pass. If tsc rejects `override` on `summary`/`catch` or the `catch` parameter type, match the signature in `node_modules/@oclif/core/lib/command.d.ts` (`protected catch(err: CommandError): Promise<any>`, `CommandError` importable from `@oclif/core/interfaces`).

- [ ] **Step 7: Manual verification (repo root, uses the local build — the `ops` on PATH is the released 0.1.0)**

```bash
pnpm ops package install --help
pnpm ops package install zsh --yes
pnpm ops package install sl --dry-run
pnpm ops package install zsh --json --yes
pnpm ops package install zsh --json ; echo "exit=$?"
pnpm ops package install -- --force ; echo "exit=$?"
grep -n '"apt:' ~/.config/mise/config.toml
```
Expected:
- help lists the flags and examples.
- `zsh --yes` → `Package manager: apt` / `✓ apt:zsh  already installed (5.9-6ubuntu2)`; `apt:zsh` already in `~/.config/mise/config.toml`, so the config is unchanged.
- `sl --dry-run` → `~ apt:sl  would install` plus `Would run:` with the `apt-get install` line; `grep` shows no `apt:sl` in the config.
- `--json --yes` → a JSON object with `"success": true`.
- `--json` without `--yes` → `{"success": false, "error": {"code": "CONFIRMATION_REQUIRED", ...}}`, `exit=1`.
- `-- --force` → `INVALID_PACKAGE_NAME`, `exit=1`.

A real install needs the user's sudo password — ask the user to run `! pnpm ops package install sl` (and afterwards remove it with `! mise bootstrap packages prune` or by deleting the line, if unwanted).

- [ ] **Step 8: Commit**

```bash
git add apps/cli/src/core/output.ts apps/cli/src/commands/package/install.ts apps/cli/test/core/output.test.ts
git commit -m "Add ops package install command

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Release pipeline and docs

**Files:**
- Modify: `.github/workflows/release.yml`
- Modify: `CLAUDE.md` (only the "Project status" paragraph and a new "Commands" section — the file has unrelated uncommitted user edits)

**Interfaces:**
- Consumes: root scripts `build`/`test` (Task 1).

- [ ] **Step 1: Build before deploy in CI**

In `.github/workflows/release.yml`, insert after the `pnpm install --frozen-lockfile` step:
```yaml
      - run: pnpm build

      - run: pnpm test
```

- [ ] **Step 2: Verify the release packaging locally (same steps as CI, linux-x64 only)**

```bash
T=$(mktemp -d) && pnpm build && pnpm --filter @ops/cli deploy "$T/ops" \
  && mise exec -C "$PWD" -- "$T/ops/node_modules/.bin/oclif" pack tarballs --root "$T/ops" --no-xz --targets linux-x64 --sha "$(git rev-parse --short HEAD)" \
  && mkdir "$T/x" && tar -xzf "$T"/ops/dist/*.tar.gz -C "$T/x" \
  && (cd ~ && env PATH=/usr/bin:/bin "$T/x/ops/bin/ops" package install zsh --dry-run)
```
Expected: the bundled binary prints `✓ apt:zsh  already installed (...)`. (`PATH=/usr/bin:/bin` hides mise; if it reports `MISE_BOOTSTRAP_UNAVAILABLE`, rerun without the `env PATH=...` override — the point is that `dist/commands` is inside the tarball.) Remove `$T` afterwards.

- [ ] **Step 3: Update CLAUDE.md**

Replace the sentence "Only `ops --version` / `-v` works so far; there are no commands, build script, lint, or tests yet." with "Implemented: `ops --version` and `ops package install` (delegates to `mise bootstrap packages`; spec in `docs/superpowers/specs/2026-09-19-package-install-design.md`)."

Add after the "Project status" section:
```markdown
## Commands

- `pnpm build` — compile `apps/cli/src` → `apps/cli/dist` (tsc); required before running the CLI
- `pnpm test` — all tests (Vitest); single file: `pnpm --filter @ops/cli exec vitest run test/core/package/install.test.ts`
- `pnpm ops <args>` — run the local build (the `ops` on PATH is the mise-installed release)
- Code layout: `src/commands` (oclif, thin) → `src/core` → `src/providers` → `src/executor`; only `src/providers/mise-bootstrap.ts` knows mise's CLI/JSON. Relative imports need `.js` extensions (NodeNext).
```

- [ ] **Step 4: Commit**

Stage `.github/workflows/release.yml` fully. For `CLAUDE.md`, stage only the hunks from Step 3 with `git add -p CLAUDE.md` (answer `n` to hunks that aren't yours); if the hunks can't be separated, leave `CLAUDE.md` unstaged and tell the user.
```bash
git add .github/workflows/release.yml
git add -p CLAUDE.md
git commit -m "Build and test in the release workflow; document commands

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

Do not push or tag — releasing is the user's call.

---

## Self-review notes

- Spec coverage: command + flags (T6), layout (T1–T6), interfaces (T3–T5), mise commands (T4), status JSON shape (T4 fixture), detection (T2), flow steps 1–9 (T5), errors/JSON error shape (T1, T4, T6), human output (T6), build/tooling + release + CLAUDE.md (T1, T7), testing incl. manual (T1–T7). Out-of-scope items have no tasks.
- Deviations from the spec are listed in "Spec clarifications" and applied to the spec in T1 Step 1.
