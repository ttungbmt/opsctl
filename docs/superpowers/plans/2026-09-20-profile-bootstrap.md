# Profile + Bootstrap (Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `ops bootstrap dev --yes` converges a fresh Ubuntu to a named profile, and a second run reports everything already satisfied.

**Architecture:** `profile.<name>` is config data alongside `package`/`repo`/`tool`, composed with `extends` and validated eagerly by `profileIndex` the way `recipeIndex` validates recipes. `bootstrapProfile` is a section engine: it asks every declared section to `plan()` (read-only), gates consent once for the whole run, then `apply()`s each section in a fixed order, stopping at the first failed section. Phase-1 sections are thin adapters over the shipped `installPackages` and `setupTools`.

**Tech Stack:** TypeScript (NodeNext — relative imports need `.js`), oclif, Zod v4, Vitest, pnpm workspace. No new runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-09-20-profile-bootstrap-design.md`

## Global Constraints

- **Layering.** `src/commands` (thin oclif) → `src/core` → `src/providers` → `src/executor`. Only `src/providers/*` may run subprocesses or reach the network. Core must never import `@oclif/core`.
- **Phase 1 adds no new provider.** Every call already has one: `mise-bootstrap.ts`, `mise-tools.ts`, `os.ts`, `deb.ts`, `apt-repo.ts`, `executor/exec.ts`.
- **Relative imports carry `.js`** (NodeNext). Type-only imports use `import type`.
- **Default data lives in `apps/cli/config/defaults.yaml`**, not in TypeScript constants. The one exception, stated in the spec: the fallback profile name `minimal` is a command-layer constant because it is fixed by design, not tunable.
- **Render functions take an injected `Style`** (`src/core/style.ts`) defaulting to `plainStyle`, and **pad before painting** — escape codes count toward `.length` and skew columns.
- **Every test uses a fake runner or fake provider.** Nothing under `apps/cli/test` starts a subprocess or touches disk.
- **Idempotent:** inspect → compare → plan → apply → verify.
- **Error codes** are added to the `OpsErrorCode` union in `src/core/errors.ts`. Phase 1 adds exactly `PROFILE_NOT_FOUND` and `PROFILE_SECTION_UNSUPPORTED`; every config-shaped failure reuses `CONFIG_INVALID`.
- **Commands:** `pnpm build`, `pnpm typecheck`, `pnpm test`. Single file: `pnpm --filter @ops/cli exec vitest run <path>`. Container: `mise run docker:run <cmd>`, `mise run up` first when state must survive.
- **Commit after every task.** Commit messages end with `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`.

---

## File Structure

**Created**

| File | Responsibility |
|---|---|
| `apps/cli/src/core/profile/resolve.ts` | Index profiles, compose `extends`, validate eagerly, expose `resolve`/`list`/`raw` |
| `apps/cli/src/core/bootstrap/section.ts` | Section vocabulary — types only, no logic |
| `apps/cli/src/core/bootstrap/run.ts` | The engine: plan all → gate once → apply in order → aggregate |
| `apps/cli/src/core/bootstrap/sections/install.ts` | One adapter over `installPackages`, parameterised into `packages` and `tools` |
| `apps/cli/src/core/bootstrap/sections/setup.ts` | Adapter over `setupTools` |
| `apps/cli/src/core/bootstrap/registry.ts` | `buildSections` — the one place a later phase registers a section |
| `apps/cli/src/commands/bootstrap.ts` | `ops bootstrap` |
| `apps/cli/src/commands/profile/list.ts` | `ops profile list` |
| `apps/cli/src/commands/profile/show.ts` | `ops profile show` |
| `apps/cli/test/helpers/fake-packages.ts` | `FakeMise`/`FakeTools`/`FakeDeb`/`FakeRepos`, shared by install and section tests |

**Modified**

| File | Change |
|---|---|
| `apps/cli/config/defaults.yaml` | `profile:` block — `base`, `minimal`, `dev` |
| `apps/cli/src/core/config.ts` | Profile/service/shell/dotfiles schemas, `SECTION_ORDER`, one line in `mergeConfig` |
| `apps/cli/src/core/tool/setup.ts` | `assumeInstalled?` on `SetupDeps` |
| `apps/cli/src/core/output.ts` | Bootstrap and profile renderers; receives `stageReporter` |
| `apps/cli/src/core/errors.ts` | Two codes |
| `apps/cli/src/commands/tool/install.ts` | `stageReporter` moves out; import it from core |
| `apps/cli/package.json` | `oclif.topics.profile` |
| `apps/cli/test/core/package/install.test.ts` | Import fakes instead of declaring them |
| `apps/cli/test/commands/tool/install.test.ts` | `stageReporter` tests move to `test/core/output.test.ts` |

---

### Task 1: Groundwork — share the fakes, move `stageReporter`

Two refactors that unblock everything after. Neither changes behaviour, so the existing suite is the test.

`stageReporter` must leave `src/commands/tool/install.ts` because `bootstrap.ts` needs it too and oclif registers **every file under `src/commands/` as a command** — a shared helper there becomes a phantom command. It is already oclif-free: `write`, `start` and `stop` are injected.

**Files:**
- Create: `apps/cli/test/helpers/fake-packages.ts`
- Modify: `apps/cli/src/core/output.ts`, `apps/cli/src/commands/tool/install.ts`
- Modify: `apps/cli/test/core/package/install.test.ts`, `apps/cli/test/commands/tool/install.test.ts`, `apps/cli/test/core/output.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `stageReporter(write, showsProgress, start?, stop?)` exported from `src/core/output.js`; `FakeMise`, `FakeTools`, `FakeDeb`, `FakeRepos` exported from `test/helpers/fake-packages.js`.

- [ ] **Step 1: Move the fake classes into a shared helper**

Cut `FakeRepos`, `FakeDeb`, `FakeMise` and `FakeTools` **verbatim** from `apps/cli/test/core/package/install.test.ts` (they sit between the imports and `function setup(...)`) into a new `apps/cli/test/helpers/fake-packages.ts`. Add `export` to each class and give the file the imports the classes need:

```ts
import type {PackageSpec} from '../../src/core/package/spec.js'
import type {AptRepo} from '../../src/core/repo.js'
import type {AptRepoProvider, EnsureRepoOptions, VerifyResult} from '../../src/providers/apt-repo.js'
import type {DebInstaller, InstallDebOptions} from '../../src/providers/deb.js'
import type {ApplyOptions, MiseBootstrap, PackageState} from '../../src/providers/mise-bootstrap.js'
import type {InstallToolOptions, MiseTools, ToolState} from '../../src/providers/mise-tools.js'
```

In `install.test.ts`, delete the four class bodies and the now-unused provider type imports, and add:

```ts
import {FakeDeb, FakeMise, FakeRepos, FakeTools} from '../../helpers/fake-packages.js'
```

- [ ] **Step 2: Run the install tests to prove the move changed nothing**

Run: `pnpm --filter @ops/cli exec vitest run test/core/package/install.test.ts`
Expected: PASS, same number of tests as before.

- [ ] **Step 3: Move `stageReporter` into core**

Cut `stageReporter` and its doc comment **verbatim** from `apps/cli/src/commands/tool/install.ts` (it sits above the class) and paste it at the end of `apps/cli/src/core/output.ts`. Add to `output.ts`:

```ts
import {type Stage, stageLabel} from './stage.js'
```

In `tool/install.ts`, delete the function, drop the now-unused `import {type Stage, stageLabel} from '../../core/stage.js'`, and extend the existing output import:

```ts
import {downloadProgress, renderInstallResult, stageReporter} from '../../core/output.js'
```

- [ ] **Step 4: Move its tests**

Move every `stageReporter` test from `apps/cli/test/commands/tool/install.test.ts` into `apps/cli/test/core/output.test.ts`, changing the import to `from '../../src/core/output.js'`. Remove the import of `stageReporter` from the command test if nothing else there uses it.

- [ ] **Step 5: Verify the whole suite and the build**

Run: `pnpm typecheck && pnpm test && pnpm build`
Expected: PASS, no test count change.

- [ ] **Step 6: Commit**

```bash
git add apps/cli/src/core/output.ts apps/cli/src/commands/tool/install.ts apps/cli/test
git commit -m "refactor: share package fakes and move stageReporter into core

bootstrap needs stageReporter too, and oclif registers every file under
src/commands as a command, so a shared helper cannot live there.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Profile schema and the built-in profiles

**Files:**
- Modify: `apps/cli/src/core/config.ts`, `apps/cli/config/defaults.yaml`
- Test: `apps/cli/test/core/config.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: from `src/core/config.js` — `SECTION_ORDER: readonly SectionName[]`, `type SectionName = 'packages'|'tools'|'setup'|'services'|'shell'|'dotfiles'`, `type Profile`, `type ServiceSpec`, `type ShellSpec`, `type DotfilesSpec`, and `Config['profile']: Record<string, Profile>`.

- [ ] **Step 1: Write the failing tests**

Append to `apps/cli/test/core/config.test.ts`. Match the file's existing style for building a fake `readFile` — read the top of the file first and reuse its helper rather than inventing a second one.

```ts
describe('profiles', () => {
  it('merges profiles by name, replacing a built-in wholesale', async () => {
    const config = await load(
      'profile:\n  base:\n    packages: [git]\n  dev:\n    extends: base\n    packages: [zsh]\n',
      'profile:\n  dev:\n    packages: [fish]\n',
    )
    expect(config.profile.base).toEqual({packages: ['git']})
    // The user entry replaced the built-in: `extends` is gone, not merged away.
    expect(config.profile.dev).toEqual({packages: ['fish']})
  })

  it('accepts extends as a string or a list', async () => {
    const config = await load('profile:\n  a:\n    extends: base\n  b:\n    extends: [base, a]\n', '')
    expect(config.profile.a.extends).toBe('base')
    expect(config.profile.b.extends).toEqual(['base', 'a'])
  })

  it('accepts the add/remove form of a list section', async () => {
    const config = await load('profile:\n  a:\n    packages: {add: [git], remove: [zsh]}\n', '')
    expect(config.profile.a.packages).toEqual({add: ['git'], remove: ['zsh']})
  })

  it('applies service defaults', async () => {
    const config = await load('profile:\n  a:\n    services: [{name: docker}]\n', '')
    expect(config.profile.a.services).toEqual([{name: 'docker', scope: 'system', enabled: true, state: 'started'}])
  })

  it('rejects an unknown key in a profile', async () => {
    // Strict, unlike a recipe: a misspelled section would converge the wrong
    // machine and still report success.
    await expect(load('profile:\n  a:\n    serivces: [docker]\n', '')).rejects.toThrow(/CONFIG_INVALID|Invalid config/)
  })

  it('defaults to an empty map when the file has no profiles', async () => {
    const config = await load('package:\n  system: [git]\n', '')
    expect(config.profile).toEqual({})
  })
})
```

Define `load(defaultsYaml, userYaml)` next to the tests if the file has no equivalent helper:

```ts
const load = (defaults: string, user: string) =>
  loadConfig(async (path) => (path === '/defaults.yaml' ? defaults : user), '/user.yaml', '/defaults.yaml')
```

Every `load` call must include a `package.system` key when the defaults string is the defaults file, since `DefaultsSchema` requires it. Use `'package:\n  system: []\n' + yaml` for the defaults argument in each test above.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @ops/cli exec vitest run test/core/config.test.ts`
Expected: FAIL — `config.profile` is undefined.

- [ ] **Step 3: Add the schemas**

In `apps/cli/src/core/config.ts`, after `RecipeSchema` and before `DefaultsSchema`:

```ts
/** Every section a profile may declare, in the order `ops bootstrap` runs them. */
export const SECTION_ORDER = ['packages', 'tools', 'setup', 'services', 'shell', 'dotfiles'] as const
export type SectionName = (typeof SECTION_ORDER)[number]

/** A profile name is a config key and appears in output; keep it to the same shape as a repo name. */
const ProfileName = z.string().regex(/^[a-z0-9][a-z0-9._-]*$/, 'must match [a-z0-9][a-z0-9._-]*')

/** A list section. A bare list ADDS to what `extends` brought in; add/remove adjusts it. */
const NameSection = z.union([NameList, z.strictObject({add: NameList.optional(), remove: NameList.optional()})])

/** profile.<name>.services[]. Phase 2 implements it; the shape is fixed now so profiles need no rewrite. */
const ServiceSchema = z.strictObject({
  /** systemd unit name; ".service" is implied when absent. */
  name: z.string().regex(/^[A-Za-z0-9@._-]+$/, 'must be a systemd unit name'),
  scope: z.enum(['system', 'user']).default('system'),
  enabled: z.boolean().default(true),
  state: z.enum(['started', 'stopped', 'ignore']).default('started'),
})

const ServiceSection = z.union([
  z.array(ServiceSchema),
  z.strictObject({add: z.array(ServiceSchema).optional(), remove: NameList.optional()}),
])

/** profile.<name>.shell. Phase 2. */
const ShellSchema = z.strictObject({
  /** A tool or package name ops can resolve to a shell binary, or an absolute path. */
  name: z.string().min(1),
  /** "current" means whoever runs ops; anything else is a login name. */
  user: z.string().min(1).default('current'),
})

/** profile.<name>.dotfiles. Phase 3. */
const DotfilesSchema = z.strictObject({
  repo: z.string().min(1),
  branch: z.string().min(1).optional(),
  apply: z.boolean().default(true),
  sourceDir: z.string().min(1).optional(),
})

/**
 * profile.<name>: a machine `ops bootstrap` converges to. Strict, unlike a recipe:
 * a misspelled `serivces:` would be kept, silently converge the wrong machine, and
 * still report success -- the same reason SetupStepSchema and RepoSchema are strict.
 */
const ProfileSchema = z.strictObject({
  summary: z.string().optional(),
  /** Profiles this one composes over, left to right; this profile always wins last. */
  extends: z.union([ProfileName, z.array(ProfileName)]).optional(),
  packages: NameSection.optional(),
  tools: NameSection.optional(),
  setup: NameSection.optional(),
  services: ServiceSection.optional(),
  shell: ShellSchema.optional(),
  dotfiles: DotfilesSchema.optional(),
})

export type Profile = z.infer<typeof ProfileSchema>
export type ServiceSpec = z.infer<typeof ServiceSchema>
export type ShellSpec = z.infer<typeof ShellSchema>
export type DotfilesSpec = z.infer<typeof DotfilesSchema>
```

Add to `DefaultsSchema`:

```ts
  /** Named machine profiles; `ops bootstrap <name>` converges to one. */
  profile: z.record(ProfileName, ProfileSchema).default({}),
```

Add to `UserSchema`:

```ts
  /** Profiles merge by name; a user profile replaces the built-in of the same name. */
  profile: z.record(ProfileName, ProfileSchema).optional(),
```

Add one line to the returned object in `mergeConfig`, beside `repo` and `tool`:

```ts
    profile: {...defaults.profile, ...user.profile},
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @ops/cli exec vitest run test/core/config.test.ts`
Expected: PASS.

- [ ] **Step 5: Ship the built-in profiles**

Append to `apps/cli/config/defaults.yaml`. `dev` deliberately declares no `setup:`, because the only recipe with setup steps today is `agent-browser` and a default profile must not download a browser.

```yaml
# Named machine profiles. `ops bootstrap <name>` converges the machine to one, and
# `ops bootstrap` with no name runs `minimal`. `extends` composes: list sections are
# concatenated base-first and deduplicated, so a profile states what it adds rather
# than restating its base. A user profile of the same name replaces the built-in
# wholesale -- build on one with `extends` instead of retyping it.
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
```

- [ ] **Step 6: Prove the shipped file parses**

Add to `apps/cli/test/core/config.test.ts`:

```ts
it('parses the shipped defaults, including the profiles', async () => {
  const config = await loadConfig(undefined, '/nonexistent/ops.yaml')
  expect(Object.keys(config.profile)).toEqual(['base', 'minimal', 'dev'])
  expect(config.profile.dev.extends).toBe('minimal')
})
```

Run: `pnpm --filter @ops/cli exec vitest run test/core/config.test.ts`
Expected: PASS. (`loadConfig` with a missing user path returns the defaults untouched.)

- [ ] **Step 7: Commit**

```bash
git add apps/cli/src/core/config.ts apps/cli/config/defaults.yaml apps/cli/test/core/config.test.ts
git commit -m "feat(config): add profile.<name> and the built-in profiles

Profiles join package/repo/tool as config data, merged by name. The schema is
strict and covers all six sections now, so services/shell/dotfiles land in
later phases without rewriting anyone's config.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: `profileIndex` — compose `extends`, validate eagerly

**Files:**
- Create: `apps/cli/src/core/profile/resolve.ts`
- Modify: `apps/cli/src/core/errors.ts`
- Test: `apps/cli/test/core/profile/resolve.test.ts`

**Interfaces:**
- Consumes: `Profile`, `ServiceSpec`, `ShellSpec`, `DotfilesSpec`, `SectionName`, `SECTION_ORDER` from `src/core/config.js`; `RecipeIndex` from `src/core/tool/recipe.js`.
- Produces:

```ts
export interface ResolvedProfile {
  name: string
  summary?: string
  /** Every profile visited, base first, `name` last. */
  lineage: string[]
  packages: string[]
  tools: string[]
  setup: string[]
  services: ServiceSpec[]
  shell?: ShellSpec
  dotfiles?: DotfilesSpec
}
export interface ProfileSummary {name: string; summary?: string; extends: string[]; sections: SectionName[]}
export interface ProfileIndex {
  names(): string[]
  list(): ProfileSummary[]
  raw(name: string): Profile | undefined
  resolve(name: string): ResolvedProfile
}
export interface ProfileContext {recipes?: RecipeIndex}
export function profileIndex(profiles?: Record<string, Profile>, ctx?: ProfileContext): ProfileIndex
export function declaresSection(profile: ResolvedProfile, section: SectionName): boolean
```

- [ ] **Step 1: Add the error code**

In `apps/cli/src/core/errors.ts`, extend the `OpsErrorCode` union:

```ts
  /** `ops bootstrap <name>` named a profile the config does not define. */
  | 'PROFILE_NOT_FOUND'
  /** The profile declares a section this build of ops has no implementation for. */
  | 'PROFILE_SECTION_UNSUPPORTED'
```

- [ ] **Step 2: Write the failing tests**

Create `apps/cli/test/core/profile/resolve.test.ts`:

```ts
import {describe, expect, it} from 'vitest'
import type {Profile} from '../../../src/core/config.js'
import {OpsError} from '../../../src/core/errors.js'
import {declaresSection, profileIndex} from '../../../src/core/profile/resolve.js'
import {recipeIndex} from '../../../src/core/tool/recipe.js'

const index = (profiles: Record<string, Profile>, recipes = recipeIndex()) => profileIndex(profiles, {recipes})

describe('profileIndex.resolve', () => {
  it('returns a profile with every list present and empty when nothing is declared', () => {
    const p = index({a: {}}).resolve('a')
    expect(p).toEqual({name: 'a', lineage: ['a'], packages: [], tools: [], setup: [], services: []})
  })

  it('concatenates lists base first', () => {
    const p = index({base: {packages: ['git']}, a: {extends: 'base', packages: ['zsh']}}).resolve('a')
    expect(p.packages).toEqual(['git', 'zsh'])
    expect(p.lineage).toEqual(['base', 'a'])
  })

  it('deduplicates keeping the first occurrence position', () => {
    const p = index({base: {packages: ['git', 'curl']}, a: {extends: 'base', packages: ['git', 'zsh']}}).resolve('a')
    expect(p.packages).toEqual(['git', 'curl', 'zsh'])
  })

  it('contributes a shared base once through a diamond', () => {
    const p = index({
      base: {packages: ['git']},
      l: {extends: 'base', packages: ['a']},
      r: {extends: 'base', packages: ['b']},
      c: {extends: ['l', 'r']},
    }).resolve('c')
    expect(p.packages).toEqual(['git', 'a', 'b'])
    expect(p.lineage).toEqual(['base', 'l', 'r', 'c'])
  })

  it('resolves multiple parents left to right', () => {
    const p = index({a: {packages: ['a']}, b: {packages: ['b']}, c: {extends: ['a', 'b'], packages: ['c']}}).resolve('c')
    expect(p.packages).toEqual(['a', 'b', 'c'])
  })

  it('removes an inherited entry and appends the additions', () => {
    const p = index({
      base: {packages: ['git', 'zsh']},
      a: {extends: 'base', packages: {remove: ['zsh'], add: ['fish']}},
    }).resolve('a')
    expect(p.packages).toEqual(['git', 'fish'])
  })

  it('merges shell key by key with the child winning', () => {
    const p = index({
      base: {shell: {name: 'bash', user: 'ops'}},
      a: {extends: 'base', shell: {name: 'zsh', user: 'current'}},
    }).resolve('a')
    expect(p.shell).toEqual({name: 'zsh', user: 'current'})
  })

  it('replaces a service by name in the parent position', () => {
    const svc = (name: string, state: 'started' | 'stopped') =>
      ({name, state, scope: 'system' as const, enabled: true})
    const p = index({
      base: {services: [svc('docker', 'started'), svc('nginx', 'started')]},
      a: {extends: 'base', services: [svc('docker', 'stopped')]},
    }).resolve('a')
    expect(p.services.map((s) => s.name)).toEqual(['docker', 'nginx'])
    expect(p.services[0].state).toBe('stopped')
  })

  it('does not inherit summary', () => {
    const p = index({base: {summary: 'base box'}, a: {extends: 'base'}}).resolve('a')
    expect(p.summary).toBeUndefined()
  })

  it('throws PROFILE_NOT_FOUND for an unknown name', () => {
    expect(() => index({a: {}}).resolve('nope')).toThrow(OpsError)
    try {
      index({a: {}}).resolve('nope')
    } catch (error) {
      expect((error as OpsError).code).toBe('PROFILE_NOT_FOUND')
      // The message has to be actionable: the whole point is you mistyped a name.
      expect((error as OpsError).message).toContain('a')
    }
  })
})

describe('profileIndex validation', () => {
  it('rejects a dangling extends at construction', () => {
    expect(() => index({a: {extends: 'nope'}})).toThrow(/unknown profile "nope"/)
  })

  it('rejects a cycle and names the chain', () => {
    try {
      index({a: {extends: 'b'}, b: {extends: 'a'}})
      throw new Error('expected a throw')
    } catch (error) {
      expect((error as OpsError).code).toBe('CONFIG_INVALID')
      expect((error as OpsError).message).toContain('profile.a')
      expect((error as OpsError).message).toContain('profile.b')
    }
  })

  it('rejects a self-referencing profile', () => {
    expect(() => index({a: {extends: 'a'}})).toThrow(/circular/)
  })

  it('rejects a setup entry naming a tool with no setup steps', () => {
    const recipes = recipeIndex({git: {package: 'apt:git'}})
    expect(() => index({a: {setup: ['git']}}, recipes)).toThrow(/tool.git.setup/)
  })

  it('accepts a setup entry whose tool has steps', () => {
    const recipes = recipeIndex({ab: {package: 'mise:ab', setup: [{name: 's', check: ['ab', 'ok'], run: ['ab', 'go']}]}})
    expect(index({a: {setup: ['ab']}}, recipes).resolve('a').setup).toEqual(['ab'])
  })

  it('does not validate package or tool names', () => {
    // They resolve at run time through resolveSpecs, and the mise registry is a network call.
    expect(() => index({a: {packages: ['no-such-thing'], tools: ['nor-this']}})).not.toThrow()
  })
})

describe('profileIndex.list and raw', () => {
  it('lists names sorted with their summary, parents and declared sections', () => {
    const list = index({b: {summary: 'B', extends: 'a', tools: ['node']}, a: {packages: ['git']}}).list()
    expect(list).toEqual([
      {name: 'a', summary: undefined, extends: [], sections: ['packages']},
      {name: 'b', summary: 'B', extends: ['a'], sections: ['packages', 'tools']},
    ])
  })

  it('raw returns the literal entry, before composition', () => {
    expect(index({base: {packages: ['git']}, a: {extends: 'base'}}).raw('a')).toEqual({extends: 'base'})
  })
})

describe('declaresSection', () => {
  const p = index({
    a: {packages: ['git'], shell: {name: 'zsh', user: 'current'}},
  }).resolve('a')

  it('is true for a non-empty list and for a present object', () => {
    expect(declaresSection(p, 'packages')).toBe(true)
    expect(declaresSection(p, 'shell')).toBe(true)
  })

  it('is false for an empty list and an absent object', () => {
    expect(declaresSection(p, 'tools')).toBe(false)
    expect(declaresSection(p, 'setup')).toBe(false)
    expect(declaresSection(p, 'services')).toBe(false)
    expect(declaresSection(p, 'dotfiles')).toBe(false)
  })
})
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm --filter @ops/cli exec vitest run test/core/profile/resolve.test.ts`
Expected: FAIL — cannot resolve `src/core/profile/resolve.js`.

- [ ] **Step 4: Implement**

Create `apps/cli/src/core/profile/resolve.ts`:

```ts
import {SECTION_ORDER, type DotfilesSpec, type Profile, type SectionName, type ServiceSpec, type ShellSpec} from '../config.js'
import {OpsError} from '../errors.js'
import type {RecipeIndex} from '../tool/recipe.js'

/** A profile after `extends` composition: every list present, no add/remove left. */
export interface ResolvedProfile {
  name: string
  summary?: string
  /** Every profile visited, base first, `name` last. */
  lineage: string[]
  packages: string[]
  tools: string[]
  setup: string[]
  services: ServiceSpec[]
  shell?: ShellSpec
  dotfiles?: DotfilesSpec
}

export interface ProfileSummary {
  name: string
  summary?: string
  /** Direct parents, in declaration order. */
  extends: string[]
  /** Sections this profile declares once composed. */
  sections: SectionName[]
}

export interface ProfileIndex {
  names(): string[]
  list(): ProfileSummary[]
  /** The literal config entry, before composition. */
  raw(name: string): Profile | undefined
  /** Fully composed. Throws PROFILE_NOT_FOUND for an unknown name. */
  resolve(name: string): ResolvedProfile
}

export interface ProfileContext {
  /** Recipes, so a `setup:` entry naming a tool with no steps fails at load. */
  recipes?: RecipeIndex
}

type ListSection = string[] | {add?: string[]; remove?: string[]}
type ServiceSection = ServiceSpec[] | {add?: ServiceSpec[]; remove?: string[]}

const parentsOf = (profile: Profile): string[] =>
  profile.extends === undefined ? [] : Array.isArray(profile.extends) ? profile.extends : [profile.extends]

/** First occurrence wins its position, so a plan stays diffable between runs. */
const dedupe = (names: string[]): string[] => [...new Set(names)]

/** A bare list adds to what `extends` brought in; remove applies to the inherited names only. */
function mergeList(base: string[], section: ListSection | undefined): string[] {
  if (section === undefined) return base
  if (Array.isArray(section)) return dedupe([...base, ...section])
  const removed = new Set(section.remove ?? [])
  return dedupe([...base.filter((name) => !removed.has(name)), ...(section.add ?? [])])
}

/**
 * Services are keyed by unit name. A child entry replaces the parent's wholesale, in the
 * parent's position -- not key by key, because Zod applies scope/enabled/state defaults at
 * parse time, so after parsing there is no way to tell what the child actually wrote.
 */
function mergeServices(base: ServiceSpec[], section: ServiceSection | undefined): ServiceSpec[] {
  if (section === undefined) return base
  const additions = Array.isArray(section) ? section : (section.add ?? [])
  const removed = new Set(Array.isArray(section) ? [] : (section.remove ?? []))
  const merged = base.filter((service) => !removed.has(service.name))
  for (const service of additions) {
    const at = merged.findIndex((existing) => existing.name === service.name)
    if (at === -1) merged.push(service)
    else merged[at] = service
  }

  return merged
}

/**
 * Indexes profiles and checks every cross-reference eagerly -- dangling `extends`, cycles,
 * and a `setup:` entry naming a tool with no steps -- so a bad config fails at load rather
 * than halfway through a privileged bootstrap. The same contract as recipeIndex.
 */
export function profileIndex(profiles: Record<string, Profile> = {}, ctx: ProfileContext = {}): ProfileIndex {
  const resolved = new Map<string, ResolvedProfile>()

  const compose = (name: string, path: string[]): ResolvedProfile => {
    const cached = resolved.get(name)
    if (cached) return cached

    const at = path.indexOf(name)
    if (at !== -1) {
      const chain = [...path.slice(at), name].map((n) => `profile.${n}`).join(' -> ')
      throw new OpsError('CONFIG_INVALID', `Profile chain ${chain} is circular`)
    }

    const profile = profiles[name]
    if (!profile) {
      const from = path.at(-1)
      // At the top of the chain this is a user typo; deeper it is a dangling reference.
      throw from === undefined
        ? new OpsError('PROFILE_NOT_FOUND', `No profile "${name}"; available: ${Object.keys(profiles).sort().join(', ') || '(none)'}`)
        : new OpsError('CONFIG_INVALID', `Profile profile.${from}: unknown profile "${name}"; define profile.${name}`)
    }

    const base: ResolvedProfile = {name, lineage: [], packages: [], tools: [], setup: [], services: []}
    for (const parent of parentsOf(profile)) {
      const composed = compose(parent, [...path, name])
      base.lineage = dedupe([...base.lineage, ...composed.lineage])
      base.packages = dedupe([...base.packages, ...composed.packages])
      base.tools = dedupe([...base.tools, ...composed.tools])
      base.setup = dedupe([...base.setup, ...composed.setup])
      base.services = mergeServices(base.services, composed.services)
      if (composed.shell) base.shell = {...base.shell, ...composed.shell}
      if (composed.dotfiles) base.dotfiles = {...base.dotfiles, ...composed.dotfiles}
    }

    const result: ResolvedProfile = {
      name,
      // Deliberately not inherited: a summary describes this profile.
      summary: profile.summary,
      lineage: [...base.lineage, name],
      packages: mergeList(base.packages, profile.packages),
      tools: mergeList(base.tools, profile.tools),
      setup: mergeList(base.setup, profile.setup),
      services: mergeServices(base.services, profile.services),
      ...(profile.shell || base.shell ? {shell: {...base.shell, ...profile.shell} as ShellSpec} : {}),
      ...(profile.dotfiles || base.dotfiles ? {dotfiles: {...base.dotfiles, ...profile.dotfiles} as DotfilesSpec} : {}),
    }

    resolved.set(name, result)
    return result
  }

  // Eagerly: every profile composes, so a cycle or a dangling parent fails at load.
  for (const name of Object.keys(profiles)) {
    const profile = compose(name, [])
    for (const tool of profile.setup) {
      if (ctx.recipes?.setupFor(tool)) continue
      throw new OpsError(
        'CONFIG_INVALID',
        `Profile profile.${name}: setup names "${tool}", which has no steps; add tool.${tool}.setup`,
      )
    }
  }

  return {
    names: () => Object.keys(profiles).sort(),
    list: () =>
      Object.keys(profiles)
        .sort()
        .map((name) => ({
          name,
          summary: profiles[name].summary,
          extends: parentsOf(profiles[name]),
          sections: SECTION_ORDER.filter((section) => declaresSection(compose(name, []), section)),
        })),
    raw: (name) => profiles[name],
    resolve: (name) => compose(name, []),
  }
}

/** True when the profile declares anything for this section. The only place that knows. */
export function declaresSection(profile: ResolvedProfile, section: SectionName): boolean {
  switch (section) {
    case 'packages':
    case 'tools':
    case 'setup': {
      return profile[section].length > 0
    }

    case 'services': {
      return profile.services.length > 0
    }

    case 'shell': {
      return profile.shell !== undefined
    }

    case 'dotfiles': {
      return profile.dotfiles !== undefined
    }
  }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @ops/cli exec vitest run test/core/profile/resolve.test.ts`
Expected: PASS.

If the "empty profile" test fails on shape, note that `summary: undefined` is present as a key. Use `toMatchObject` there, or assert field by field — do not add a key-stripping branch to production code to satisfy a test.

- [ ] **Step 6: Commit**

```bash
git add apps/cli/src/core/profile apps/cli/src/core/errors.ts apps/cli/test/core/profile
git commit -m "feat(profile): compose profiles with extends, validated eagerly

Cycles, dangling parents and a setup entry naming a tool with no steps all
fail at config load, the contract recipeIndex established -- never halfway
through a privileged bootstrap.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Section vocabulary and the engine

The load-bearing task. Every assertion here is about choreography, so it is tested entirely with **stub sections** — no providers, no runner.

**Files:**
- Create: `apps/cli/src/core/bootstrap/section.ts`, `apps/cli/src/core/bootstrap/run.ts`
- Modify: `docs/superpowers/specs/2026-09-20-profile-bootstrap-design.md`
- Test: `apps/cli/test/core/bootstrap/run.test.ts`

**Interfaces:**
- Consumes: `SECTION_ORDER`, `SectionName` from `src/core/config.js`; `ProfileIndex`, `ResolvedProfile`, `declaresSection` from `src/core/profile/resolve.js`.
- Produces: from `src/core/bootstrap/section.js` — `ChangeStatus`, `Change`, `SectionPlan`, `SectionReport<D>`, `SectionContext`, `Section<D>`, `SectionRegistry`, `BootstrapOptions`, `pendingIn(plan)`. From `src/core/bootstrap/run.js` — `BootstrapDeps`, `BootstrapResult`, `bootstrapProfile(options, deps)`.

- [ ] **Step 1: Write the types**

Create `apps/cli/src/core/bootstrap/section.ts`:

```ts
import type {SectionName} from '../config.js'
import type {ResolvedProfile} from '../profile/resolve.js'

/**
 * The five outcomes every section collapses into. Deliberately the union of what
 * PackageStatus and SetupStatus already say, so a later section's own vocabulary
 * (already-enabled / enabled / would-enable) maps in without widening this type --
 * which is what lets one renderer and one --json shape cover every section.
 */
export type ChangeStatus = 'satisfied' | 'changed' | 'would-change' | 'skipped' | 'failed'

export interface Change {
  /** Stable within the section and across runs: "apt:git", "git/user.email", "docker.service". */
  id: string
  status: ChangeStatus
  /** One line of human detail: a version, a target, a reason. */
  detail?: string
  /** argv joined; set on `would-change`, collected into the run's "Would run:" block. */
  command?: string
  error?: string
}

export interface SectionPlan {
  section: SectionName
  changes: Change[]
  /** Everything this section would run, in order, for --dry-run output. */
  commands: string[]
  /** Carried from plan() to apply() untouched by the engine: the section's own notes. */
  state?: unknown
}

export interface SectionReport<D = unknown> {
  section: SectionName
  status: 'ok' | 'failed' | 'skipped'
  changes: Change[]
  /** Dry run only. */
  commands?: string[]
  /** The section's native result (InstallResult, SetupResult, ...); --json only. */
  detail?: D
}

export interface BootstrapOptions {
  /** Profile name; the command resolves the fallback before calling. */
  profile: string
  /** Run only these sections; empty means all of them. Exclusive with `skip`. */
  only: SectionName[]
  skip: SectionName[]
  yes: boolean
  force: boolean
  nonInteractive: boolean
  dryRun: boolean
  json: boolean
}

export interface SectionContext {
  profile: ResolvedProfile
  /** The run's flags. A section never re-reads process, env or config. */
  options: BootstrapOptions
}

/**
 * One convergeable area of a machine. Inspect -> compare -> plan, then apply -> verify,
 * split across two calls so the engine can plan the WHOLE run before it changes anything
 * and ask for consent once.
 */
export interface Section<D = unknown> {
  readonly name: SectionName
  /** Inspect and compare only. Must not change the machine; read-only subprocesses are fine. */
  plan(ctx: SectionContext): Promise<SectionPlan>
  /**
   * Apply what `plan` found pending, then verify. Consent is already collected:
   * a section must never gate again.
   */
  apply(ctx: SectionContext, plan: SectionPlan): Promise<SectionReport<D>>
}

/** The sections a build can run. A later phase adds an entry; the engine is untouched. */
export type SectionRegistry = Partial<Record<SectionName, Section>>

/** How many changes a plan would actually make. */
export const pendingIn = (plan: SectionPlan): number => plan.changes.filter((c) => c.status === 'would-change').length
```

- [ ] **Step 2: Write the failing engine tests**

Create `apps/cli/test/core/bootstrap/run.test.ts`:

```ts
import {describe, expect, it, vi} from 'vitest'
import type {SectionName} from '../../../src/core/config.js'
import {OpsError} from '../../../src/core/errors.js'
import type {Change, Section, SectionPlan, SectionRegistry} from '../../../src/core/bootstrap/section.js'
import {type BootstrapDeps, bootstrapProfile} from '../../../src/core/bootstrap/run.js'
import type {BootstrapOptions} from '../../../src/core/bootstrap/section.js'
import {profileIndex} from '../../../src/core/profile/resolve.js'

/** Records plan/apply order across every section in one shared log. */
function stub(
  name: SectionName,
  log: string[],
  over: {changes?: Change[]; commands?: string[]; fails?: boolean; planThrows?: Error} = {},
): Section {
  const changes = over.changes ?? [{id: `${name}-1`, status: 'would-change' as const, command: `do ${name}`}]
  return {
    name,
    async plan() {
      log.push(`plan:${name}`)
      if (over.planThrows) throw over.planThrows
      return {section: name, changes, commands: over.commands ?? [`do ${name}`]}
    },
    async apply() {
      log.push(`apply:${name}`)
      return {
        section: name,
        status: over.fails ? ('failed' as const) : ('ok' as const),
        changes: changes.map((c) => ({...c, status: over.fails ? ('failed' as const) : ('changed' as const)})),
      }
    },
  }
}

const opts = (o: Partial<BootstrapOptions> = {}): BootstrapOptions => ({
  dryRun: false,
  force: false,
  json: false,
  nonInteractive: false,
  only: [],
  profile: 'p',
  skip: [],
  yes: true,
  ...o,
})

function deps(sections: SectionRegistry, over: Partial<BootstrapDeps> = {}): BootstrapDeps {
  return {
    isTTY: true,
    onPlan: () => {},
    profiles: profileIndex({p: {packages: ['git'], tools: ['node'], setup: [], services: [{name: 'docker', scope: 'system', enabled: true, state: 'started'}]}}),
    sections,
    ...over,
  }
}

describe('bootstrapProfile choreography', () => {
  it('plans every section before applying any', async () => {
    const log: string[] = []
    await bootstrapProfile(opts(), deps({packages: stub('packages', log), tools: stub('tools', log), services: stub('services', log)}))
    expect(log).toEqual(['plan:packages', 'plan:tools', 'plan:services', 'apply:packages', 'apply:tools', 'apply:services'])
  })

  it('runs sections in SECTION_ORDER regardless of registry insertion order', async () => {
    const log: string[] = []
    const registry: SectionRegistry = {}
    registry.services = stub('services', log)
    registry.packages = stub('packages', log)
    registry.tools = stub('tools', log)
    const result = await bootstrapProfile(opts(), deps(registry))
    expect(result.sections.map((s) => s.section)).toEqual(['packages', 'tools', 'services'])
  })

  it('never touches a section the profile does not declare', async () => {
    const log: string[] = []
    // `setup` is declared empty, so it must not run even though the registry has it.
    await bootstrapProfile(opts(), deps({packages: stub('packages', log), setup: stub('setup', log)}))
    expect(log).toEqual(['plan:packages', 'apply:packages'])
  })

  it('throws PROFILE_SECTION_UNSUPPORTED when a declared section has no handler', async () => {
    // Silently skipping would leave the machine unconverged while reporting success.
    const log: string[] = []
    const run = bootstrapProfile(opts(), deps({packages: stub('packages', log), tools: stub('tools', log)}))
    await expect(run).rejects.toThrow(OpsError)
    await expect(run).rejects.toThrow(/--skip services/)
    expect(log).toEqual([])
  })

  it('--skip suppresses an unsupported section', async () => {
    const log: string[] = []
    const result = await bootstrapProfile(opts({skip: ['services']}), deps({packages: stub('packages', log), tools: stub('tools', log)}))
    expect(result.sections.map((s) => s.section)).toEqual(['packages', 'tools'])
  })

  it('--only narrows to the named sections', async () => {
    const log: string[] = []
    const result = await bootstrapProfile(opts({only: ['tools']}), deps({packages: stub('packages', log), tools: stub('tools', log), services: stub('services', log)}))
    expect(result.sections.map((s) => s.section)).toEqual(['tools'])
    expect(log).toEqual(['plan:tools', 'apply:tools'])
  })

  it('aborts before any apply when a plan throws', async () => {
    const log: string[] = []
    const boom = new OpsError('MISE_COMMAND_FAILED', 'mise exploded')
    const run = bootstrapProfile(
      opts({skip: ['services']}),
      deps({packages: stub('packages', log), tools: stub('tools', log, {planThrows: boom})}),
    )
    await expect(run).rejects.toThrow('mise exploded')
    expect(log).toEqual(['plan:packages', 'plan:tools'])
  })
})

describe('bootstrapProfile dry run', () => {
  it('plans every section and applies none', async () => {
    const log: string[] = []
    const result = await bootstrapProfile(opts({dryRun: true, skip: ['services']}), deps({packages: stub('packages', log), tools: stub('tools', log)}))
    expect(log).toEqual(['plan:packages', 'plan:tools'])
    expect(result.dryRun).toBe(true)
    expect(result.success).toBe(true)
  })

  it('concatenates commands in section order', async () => {
    const log: string[] = []
    const result = await bootstrapProfile(
      opts({dryRun: true, skip: ['services']}),
      deps({packages: stub('packages', log, {commands: ['apt install git']}), tools: stub('tools', log, {commands: ['mise use node']})}),
    )
    expect(result.commands).toEqual(['apt install git', 'mise use node'])
  })

  it('does not fail fast: a failing section still lets the rest plan', async () => {
    const log: string[] = []
    const failed: Change[] = [{id: 'x', status: 'failed', error: 'nope'}]
    await bootstrapProfile(
      opts({dryRun: true, skip: ['services']}),
      deps({packages: stub('packages', log, {changes: failed}), tools: stub('tools', log)}),
    )
    expect(log).toEqual(['plan:packages', 'plan:tools'])
  })
})

describe('bootstrapProfile confirmation gate', () => {
  const twoSections = (log: string[]) => ({packages: stub('packages', log), tools: stub('tools', log)})

  it('throws once for the whole run under --json with pending changes', async () => {
    const log: string[] = []
    const run = bootstrapProfile(opts({json: true, skip: ['services'], yes: false}), deps(twoSections(log)))
    await expect(run).rejects.toThrow(/2 changes across 2 sections/)
    expect(log).toEqual(['plan:packages', 'plan:tools'])
  })

  it('throws when stdout is not a TTY', async () => {
    const log: string[] = []
    const run = bootstrapProfile(opts({skip: ['services'], yes: false}), deps(twoSections(log), {isTTY: false}))
    await expect(run).rejects.toThrow(OpsError)
  })

  it('does not throw with --yes', async () => {
    const log: string[] = []
    await expect(bootstrapProfile(opts({json: true, skip: ['services']}), deps(twoSections(log)))).resolves.toBeTruthy()
  })

  it('does not throw with --non-interactive', async () => {
    const log: string[] = []
    await expect(
      bootstrapProfile(opts({json: true, nonInteractive: true, skip: ['services'], yes: false}), deps(twoSections(log))),
    ).resolves.toBeTruthy()
  })

  it('does not throw when nothing is pending', async () => {
    const log: string[] = []
    const satisfied: Change[] = [{id: 'x', status: 'satisfied'}]
    const sections = {packages: stub('packages', log, {changes: satisfied}), tools: stub('tools', log, {changes: satisfied})}
    await expect(bootstrapProfile(opts({json: true, skip: ['services'], yes: false}), deps(sections))).resolves.toBeTruthy()
  })

  it('calls onPlan exactly once with every plan', async () => {
    const log: string[] = []
    const onPlan = vi.fn<(plans: SectionPlan[]) => void>()
    await bootstrapProfile(opts({skip: ['services']}), deps(twoSections(log), {onPlan}))
    expect(onPlan).toHaveBeenCalledTimes(1)
    expect(onPlan.mock.calls[0][0].map((p) => p.section)).toEqual(['packages', 'tools'])
  })

  it('does not call onPlan when nothing is pending', async () => {
    const log: string[] = []
    const onPlan = vi.fn()
    const satisfied: Change[] = [{id: 'x', status: 'satisfied'}]
    await bootstrapProfile(opts({skip: ['services']}), deps({packages: stub('packages', log, {changes: satisfied})}, {onPlan}))
    expect(onPlan).not.toHaveBeenCalled()
  })
})

describe('bootstrapProfile failure handling', () => {
  it('fails fast: a failed section skips every later one', async () => {
    const log: string[] = []
    const result = await bootstrapProfile(
      opts(),
      deps({packages: stub('packages', log, {fails: true}), tools: stub('tools', log), services: stub('services', log)}),
    )
    expect(log).toEqual(['plan:packages', 'plan:tools', 'plan:services', 'apply:packages'])
    expect(result.sections.map((s) => [s.section, s.status])).toEqual([
      ['packages', 'failed'],
      ['tools', 'skipped'],
      ['services', 'skipped'],
    ])
    expect(result.success).toBe(false)
  })

  it('reports lineage and counts', async () => {
    const log: string[] = []
    const profiles = profileIndex({base: {packages: ['git']}, p: {extends: 'base', tools: ['node']}})
    const result = await bootstrapProfile(opts(), deps({packages: stub('packages', log), tools: stub('tools', log)}, {profiles}))
    expect(result.lineage).toEqual(['base', 'p'])
    expect(result.counts).toEqual({satisfied: 0, changed: 2, 'would-change': 0, skipped: 0, failed: 0})
    expect(result.action).toBe('bootstrap')
  })

  it('announces each section as it begins applying', async () => {
    const log: string[] = []
    const onSection = vi.fn()
    await bootstrapProfile(opts({skip: ['services']}), deps({packages: stub('packages', log), tools: stub('tools', log)}, {onSection}))
    expect(onSection.mock.calls.map((c) => c[0])).toEqual(['packages', 'tools'])
  })
})
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm --filter @ops/cli exec vitest run test/core/bootstrap/run.test.ts`
Expected: FAIL — cannot resolve `src/core/bootstrap/run.js`.

- [ ] **Step 4: Implement the engine**

Create `apps/cli/src/core/bootstrap/run.ts`:

```ts
import {SECTION_ORDER, type SectionName} from '../config.js'
import {OpsError} from '../errors.js'
import {type ProfileIndex, declaresSection} from '../profile/resolve.js'
import {
  type BootstrapOptions,
  type Change,
  type ChangeStatus,
  type Section,
  type SectionContext,
  type SectionPlan,
  type SectionRegistry,
  type SectionReport,
  pendingIn,
} from './section.js'

export type {BootstrapOptions} from './section.js'

export interface BootstrapDeps {
  profiles: ProfileIndex
  /** The sections this build can run. The engine never constructs one. */
  sections: SectionRegistry
  /** True when a human can read the plan. */
  isTTY: boolean
  /** Called once with every section's plan before the first apply; never under --dry-run. */
  onPlan: (plans: SectionPlan[]) => void
  /** Called as each section begins applying, so the command layer can print a heading. */
  onSection?: (section: SectionName) => void
}

export interface BootstrapResult {
  success: boolean
  action: 'bootstrap'
  profile: string
  /** Every profile in the extends chain, base first, the requested one last. */
  lineage: string[]
  dryRun: boolean
  /** Only the sections that actually ran, in SECTION_ORDER. */
  sections: SectionReport[]
  /** Dry run only: every command the run would execute, in section order. */
  commands?: string[]
  counts: Record<ChangeStatus, number>
}

function tally(reports: {changes: Change[]}[]): Record<ChangeStatus, number> {
  const counts: Record<ChangeStatus, number> = {changed: 0, failed: 0, satisfied: 0, skipped: 0, 'would-change': 0}
  for (const report of reports) for (const change of report.changes) counts[change.status] += 1
  return counts
}

/**
 * Converges the machine to a profile: plan every declared section, take consent once,
 * then apply in a fixed order. A failed section stops the run -- the sections after it
 * are reported skipped rather than left unexplained.
 */
export async function bootstrapProfile(options: BootstrapOptions, deps: BootstrapDeps): Promise<BootstrapResult> {
  const profile = deps.profiles.resolve(options.profile)
  const only = new Set(options.only)
  const skip = new Set(options.skip)

  // SECTION_ORDER drives the run, not the registry: order is a property of bootstrapping
  // a machine, not of whichever key happened to be inserted first.
  const wanted = SECTION_ORDER.filter(
    (name) => declaresSection(profile, name) && (only.size === 0 || only.has(name)) && !skip.has(name),
  )

  const active: Section[] = []
  for (const name of wanted) {
    const section = deps.sections[name]
    if (!section) {
      throw new OpsError(
        'PROFILE_SECTION_UNSUPPORTED',
        `Profile "${profile.name}" declares a "${name}" section, which this version of ops cannot run; upgrade ops or re-run with --skip ${name}`,
      )
    }

    active.push(section)
  }

  const ctx: SectionContext = {options, profile}
  const base = {action: 'bootstrap' as const, dryRun: options.dryRun, lineage: profile.lineage, profile: profile.name}

  // Plan the whole run before anything writes: that is what makes one confirmation
  // possible. A throw here costs nothing, because nothing has changed yet.
  const plans: SectionPlan[] = []
  for (const section of active) plans.push(await section.plan(ctx))

  if (options.dryRun) {
    const sections: SectionReport[] = plans.map((plan) => ({
      changes: plan.changes,
      commands: plan.commands,
      section: plan.section,
      status: 'ok',
    }))
    return {...base, commands: plans.flatMap((plan) => plan.commands), counts: tally(sections), sections, success: true}
  }

  const pending = plans.reduce((total, plan) => total + pendingIn(plan), 0)
  if (pending > 0 && !(options.yes || options.nonInteractive) && (options.json || !deps.isTTY)) {
    throw new OpsError(
      'CONFIRMATION_REQUIRED',
      `Confirmation required: ${pending} change${pending === 1 ? '' : 's'} across ${plans.length} section${plans.length === 1 ? '' : 's'}; re-run with --yes (or --non-interactive)`,
    )
  }

  if (pending > 0) deps.onPlan(plans)

  const reports: SectionReport[] = []
  let stopped = false
  for (const [at, section] of active.entries()) {
    if (stopped) {
      reports.push({changes: [], section: section.name, status: 'skipped'})
      continue
    }

    deps.onSection?.(section.name)
    const report = await section.apply(ctx, plans[at])
    reports.push(report)
    if (report.status === 'failed') stopped = true
  }

  return {...base, counts: tally(reports), sections: reports, success: reports.every((r) => r.status !== 'failed')}
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @ops/cli exec vitest run test/core/bootstrap/run.test.ts`
Expected: PASS.

- [ ] **Step 6: Correct the spec's flow diagram**

The spec's flow shows `pending == 0` exiting early. The engine deliberately still applies: for `packages`, `apply` calls `mise.declare`, which records the set so a later machine can reproduce it — skipping that would drop the declaration on an already-installed machine. In `docs/superpowers/specs/2026-09-20-profile-bootstrap-design.md`, replace the line

```
        ├─ pending == 0 ────────────────────────→ print "already satisfied", exit 0
```

with

```
        │  (pending == 0 still applies: apply is what declares the set to mise)
```

- [ ] **Step 7: Verify and commit**

Run: `pnpm typecheck && pnpm test`

```bash
git add apps/cli/src/core/bootstrap apps/cli/test/core/bootstrap docs/superpowers/specs
git commit -m "feat(bootstrap): add the section engine

Plans every declared section before applying any, so one confirmation covers
the whole run, then applies in a fixed order and stops at the first failure.
A declared section with no handler is an error, not a silent skip: skipping
would leave the machine unconverged while still reporting success.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: The `packages` and `tools` sections

One adapter, parameterised. The only difference is `systemPreferred`: `packages` resolves exactly like `ops tool install`, while `tools` clears the list so a bare name prefers the mise registry.

**Files:**
- Create: `apps/cli/src/core/bootstrap/sections/install.ts`
- Test: `apps/cli/test/core/bootstrap/sections/install.test.ts`

**Interfaces:**
- Consumes: `installPackages`, `InstallDeps`, `InstallResult`, `PackageStatus` from `src/core/package/install.js`; `Section`, `Change`, `ChangeStatus`, `SectionContext` from `../section.js`.
- Produces: `createInstallSection(name: 'packages' | 'tools', deps: InstallDeps): Section<InstallResult>`.

- [ ] **Step 1: Write the failing tests**

Create `apps/cli/test/core/bootstrap/sections/install.test.ts`:

```ts
import {describe, expect, it} from 'vitest'
import {createInstallSection} from '../../../../src/core/bootstrap/sections/install.js'
import type {BootstrapOptions, SectionContext} from '../../../../src/core/bootstrap/section.js'
import type {InstallDeps} from '../../../../src/core/package/install.js'
import {profileIndex} from '../../../../src/core/profile/resolve.js'
import {recipeIndex} from '../../../../src/core/tool/recipe.js'
import {FakeDeb, FakeMise, FakeRepos, FakeTools} from '../../../helpers/fake-packages.js'

function setup() {
  const mise = new FakeMise()
  const tools = new FakeTools()
  tools.registry.add('jq')
  tools.registry.add('node')
  const deps: InstallDeps = {
    deb: new FakeDeb(),
    detectManager: async () => 'apt',
    isTTY: true,
    mise,
    recipes: recipeIndex(),
    repos: new FakeRepos(),
    sudoReady: async () => true,
    // `jq` is system-preferred, so `packages: [jq]` must go to apt even though mise has it.
    systemPreferred: new Set(['jq']),
    tools,
  }
  return {deps, mise, tools}
}

const ctx = (profile: {packages?: string[]; tools?: string[]}, over: Partial<BootstrapOptions> = {}): SectionContext => ({
  options: {dryRun: false, force: false, json: false, nonInteractive: false, only: [], profile: 'p', skip: [], yes: false, ...over},
  profile: profileIndex({p: profile}).resolve('p'),
})

describe('packages section', () => {
  it('resolves through the system-preferred list', async () => {
    const {deps, mise} = setup()
    const section = createInstallSection('packages', deps)
    await section.apply(ctx({packages: ['jq']}), {section: 'packages', changes: [], commands: []})
    expect([...mise.declared]).toEqual(['apt:jq'])
  })

  it('plan writes nothing', async () => {
    const {deps, mise} = setup()
    const plan = await createInstallSection('packages', deps).plan(ctx({packages: ['jq']}))
    expect(mise.calls).not.toContain('declare')
    expect(mise.calls).not.toContain('apply')
    expect(plan.section).toBe('packages')
    expect(plan.changes).toEqual([{id: 'apt:jq', status: 'would-change'}])
    expect(plan.commands).toEqual(['would install apt:jq'])
  })

  it('maps package statuses onto change statuses', async () => {
    const {deps, mise} = setup()
    mise.installed.set('apt:jq', '1.7')
    mise.declared.add('apt:jq')
    const report = await createInstallSection('packages', deps).apply(ctx({packages: ['jq']}), {section: 'packages', changes: [], commands: []})
    expect(report.status).toBe('ok')
    expect(report.changes).toEqual([{id: 'apt:jq', status: 'satisfied', detail: '1.7'}])
    expect(report.detail?.action).toBe('install')
  })

  it('reports a failed install as a failed section', async () => {
    const {deps, mise} = setup()
    mise.installOnApply = false
    const report = await createInstallSection('packages', deps).apply(ctx({packages: ['jq']}), {section: 'packages', changes: [], commands: []})
    expect(report.status).toBe('failed')
    expect(report.changes[0].status).toBe('failed')
  })

  it('applies with yes: true even when the run did not pass --yes', async () => {
    // The engine already took consent for the whole run; a section must not gate again.
    const {deps, mise} = setup()
    await createInstallSection('packages', deps).apply(ctx({packages: ['jq']}, {json: true, yes: false}), {section: 'packages', changes: [], commands: []})
    expect(mise.applied[0].specs).toEqual(['apt:jq'])
  })
})

describe('tools section', () => {
  it('ignores the system-preferred list so a bare name prefers the mise registry', async () => {
    const {deps, tools} = setup()
    await createInstallSection('tools', deps).apply(ctx({tools: ['jq']}), {section: 'tools', changes: [], commands: []})
    expect(tools.installs[0].names).toEqual(['jq'])
  })

  it('reads the profile tools list, not packages', async () => {
    const {deps, tools} = setup()
    const plan = await createInstallSection('tools', deps).plan(ctx({packages: ['jq'], tools: ['node']}))
    expect(plan.changes.map((c) => c.id)).toEqual(['mise:node'])
    expect(tools.calls).not.toContain('install')
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @ops/cli exec vitest run test/core/bootstrap/sections/install.test.ts`
Expected: FAIL — cannot resolve `sections/install.js`.

- [ ] **Step 3: Implement**

Create `apps/cli/src/core/bootstrap/sections/install.ts`:

```ts
import {type InstallDeps, type InstallOptions, type InstallResult, type PackageStatus, installPackages} from '../../package/install.js'
import type {Change, ChangeStatus, Section, SectionContext} from '../section.js'

const STATUS: Record<PackageStatus, ChangeStatus> = {
  'already-installed': 'satisfied',
  failed: 'failed',
  installed: 'changed',
  'would-install': 'would-change',
}

const toChange = (p: InstallResult['packages'][number]): Change => ({
  id: p.spec,
  status: STATUS[p.status],
  ...(p.version === undefined ? {} : {detail: p.version}),
  ...(p.error === undefined ? {} : {error: p.error}),
})

function optionsFor(ctx: SectionContext, packages: string[], dryRun: boolean): InstallOptions {
  return {
    dryRun,
    force: ctx.options.force,
    json: ctx.options.json,
    nonInteractive: ctx.options.nonInteractive,
    packages,
    // The engine already gated for the whole run; gating again would ask twice.
    yes: true,
  }
}

/**
 * The `packages` and `tools` sections. They share every mechanism and differ in one
 * dependency: `packages` resolves exactly as `ops tool install` does, while `tools`
 * clears the system-preferred list so a bare name prefers the mise registry.
 */
export function createInstallSection(name: 'packages' | 'tools', deps: InstallDeps): Section<InstallResult> {
  const sectionDeps: InstallDeps = name === 'tools' ? {...deps, systemPreferred: new Set()} : deps
  const listFor = (ctx: SectionContext) => (name === 'packages' ? ctx.profile.packages : ctx.profile.tools)

  return {
    name,
    async plan(ctx) {
      const result = await installPackages(optionsFor(ctx, listFor(ctx), true), sectionDeps)
      return {changes: result.packages.map(toChange), commands: result.commands ?? [], section: name}
    },
    async apply(ctx) {
      const result = await installPackages(optionsFor(ctx, listFor(ctx), false), sectionDeps)
      return {changes: result.packages.map(toChange), detail: result, section: name, status: result.success ? 'ok' : 'failed'}
    },
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @ops/cli exec vitest run test/core/bootstrap/sections/install.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/core/bootstrap/sections apps/cli/test/core/bootstrap/sections
git commit -m "feat(bootstrap): add the packages and tools sections

One adapter over installPackages. The sections differ only in the injected
system-preferred set, so resolveSpecs needs no change: packages resolves as
ops tool install does, tools prefers the mise registry.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: `assumeInstalled` and the `setup` section

Without this, `ops bootstrap dev` on a fresh machine dies at plan time: `setupTools` probes `git --version`, `git` is not installed yet, `probe` turns `CommandNotFoundError` into *"run `ops tool install git` first"*, the plan reports a failure, and a failing plan aborts the run — before the `packages` section that would have installed `git` ever applies.

**Files:**
- Modify: `apps/cli/src/core/tool/setup.ts`
- Create: `apps/cli/src/core/bootstrap/sections/setup.ts`
- Test: `apps/cli/test/core/tool/setup.test.ts` (extend), `apps/cli/test/core/bootstrap/sections/setup.test.ts`

**Interfaces:**
- Consumes: `setupTools`, `SetupDeps`, `SetupResult`, `SetupStatus` from `src/core/tool/setup.js`; `RecipeIndex` from `src/core/tool/recipe.js`; `Runner` from `src/executor/exec.js`.
- Produces: `SetupDeps.assumeInstalled?: ReadonlySet<string>`; `createSetupSection(deps: SetupSectionDeps): Section<SetupResult>` where `SetupSectionDeps = {recipes: RecipeIndex; runner: Runner; isTTY: boolean}`.

- [ ] **Step 1: Write the failing test for `assumeInstalled`**

Append to `apps/cli/test/core/tool/setup.test.ts`. Reuse the file's existing `setup()`/`opts()` helpers and its `FakeRunner` wiring — read the top of the file and follow it rather than inventing new fixtures.

```ts
describe('assumeInstalled', () => {
  const recipes = recipeIndex({ab: {package: 'mise:ab', setup: [{name: 'browsers', check: ['ab', 'doctor'], run: ['ab', 'install']}]}})

  it('treats a missing binary as pending when the run is about to install it', async () => {
    const runner = new FakeRunner()
    // The tool does not exist yet: the packages section installs it earlier in this run.
    runner.on('ab doctor', {exitCode: 0})
    const throwing = {
      calls: runner.calls,
      async run(cmd: string, args: string[]) {
        if (cmd === 'ab') throw new CommandNotFoundError('ab')
        return runner.run(cmd, args)
      },
    }
    const result = await setupTools(
      {dryRun: true, json: false, nonInteractive: false, tools: ['ab'], yes: true},
      {assumeInstalled: new Set(['ab']), isTTY: true, onPlan: () => {}, recipes, runner: throwing},
    )
    expect(result.steps[0].status).toBe('would-configure')
    expect(result.steps[0].error).toBeUndefined()
  })

  it('still reports a missing binary as failed when nothing will install it', async () => {
    const throwing = {
      async run(cmd: string) {
        throw new CommandNotFoundError(cmd)
      },
    }
    const result = await setupTools(
      {dryRun: true, json: false, nonInteractive: false, tools: ['ab'], yes: true},
      {isTTY: true, onPlan: () => {}, recipes, runner: throwing},
    )
    expect(result.steps[0].status).toBe('failed')
    expect(result.steps[0].error).toContain('ops tool install ab')
  })
})
```

Add `import {CommandNotFoundError} from '../../../src/core/errors.js'` if the file does not already import it.

- [ ] **Step 2: Run to verify the first test fails**

Run: `pnpm --filter @ops/cli exec vitest run test/core/tool/setup.test.ts`
Expected: FAIL on "treats a missing binary as pending" — status is `failed`.

- [ ] **Step 3: Implement `assumeInstalled`**

In `apps/cli/src/core/tool/setup.ts`, add to `SetupDeps`:

```ts
  /**
   * Tools something else in this run is about to install. A binary missing at probe
   * time is then pending, not an error: on a fresh machine `ops bootstrap` plans the
   * setup section before the packages section has installed anything.
   */
  assumeInstalled?: ReadonlySet<string>
```

In `probe`, change the `CommandNotFoundError` branch:

```ts
    if (error instanceof CommandNotFoundError) {
      if (deps.assumeInstalled?.has(tool)) return {satisfied: false}
      return {satisfied: false, error: `${error.command} not found on PATH; run \`ops tool install ${tool}\` first`}
    }
```

- [ ] **Step 4: Run to verify both tests pass**

Run: `pnpm --filter @ops/cli exec vitest run test/core/tool/setup.test.ts`
Expected: PASS, including every pre-existing test — `ops tool setup` passes no `assumeInstalled`, so its behaviour is unchanged.

- [ ] **Step 5: Write the failing section tests**

Create `apps/cli/test/core/bootstrap/sections/setup.test.ts`:

```ts
import {describe, expect, it} from 'vitest'
import type {BootstrapOptions, SectionContext} from '../../../../src/core/bootstrap/section.js'
import {createSetupSection} from '../../../../src/core/bootstrap/sections/setup.js'
import {profileIndex} from '../../../../src/core/profile/resolve.js'
import {recipeIndex} from '../../../../src/core/tool/recipe.js'
import {FakeRunner} from '../../../helpers/fake-runner.js'

const recipes = recipeIndex({
  ab: {package: 'mise:ab', setup: [{name: 'browsers', check: ['ab', 'doctor'], run: ['ab', 'install']}]},
})

const ctx = (over: Partial<BootstrapOptions> = {}): SectionContext => ({
  options: {dryRun: false, force: false, json: false, nonInteractive: false, only: [], profile: 'p', skip: [], yes: false, ...over},
  profile: profileIndex({p: {tools: ['ab@1.2'], setup: ['ab']}}, {recipes}).resolve('p'),
})

const emptyPlan = {section: 'setup' as const, changes: [], commands: []}

describe('setup section', () => {
  it('plan runs only checks, never a run command', async () => {
    const runner = new FakeRunner().on('ab doctor', {exitCode: 1})
    const plan = await createSetupSection({isTTY: true, recipes, runner}).plan(ctx())
    expect(runner.calls.map((c) => [c.cmd, ...c.args].join(' '))).toEqual(['ab doctor'])
    expect(plan.changes).toEqual([{id: 'ab/browsers', status: 'would-change', command: 'ab install'}])
    expect(plan.commands).toEqual(['ab install'])
  })

  it('reports a satisfied check as satisfied', async () => {
    const runner = new FakeRunner().on('ab doctor', {exitCode: 0})
    const plan = await createSetupSection({isTTY: true, recipes, runner}).plan(ctx())
    expect(plan.changes).toEqual([{id: 'ab/browsers', status: 'satisfied'}])
    expect(plan.commands).toEqual([])
  })

  it('apply checks, runs, then re-checks', async () => {
    const runner = new FakeRunner().on('ab doctor', {exitCode: 1}, {exitCode: 0}).on('ab install', {exitCode: 0})
    const report = await createSetupSection({isTTY: true, recipes, runner}).apply(ctx(), emptyPlan)
    expect(runner.calls.map((c) => [c.cmd, ...c.args].join(' '))).toEqual(['ab doctor', 'ab install', 'ab doctor'])
    expect(report.status).toBe('ok')
    expect(report.changes).toEqual([{id: 'ab/browsers', status: 'changed'}])
    expect(report.detail?.action).toBe('setup')
  })

  it('reports a failed step as a failed section', async () => {
    const runner = new FakeRunner().on('ab doctor', {exitCode: 1}).on('ab install', {exitCode: 3, stderr: 'no disk'})
    const report = await createSetupSection({isTTY: true, recipes, runner}).apply(ctx(), emptyPlan)
    expect(report.status).toBe('failed')
    expect(report.changes[0].error).toContain('no disk')
  })

  it('assumes the profile will install its own tools, stripping version and manager', async () => {
    // `ab` is absent, but `tools: [ab@1.2]` earlier in the run installs it.
    const runner = {
      async run(cmd: string) {
        throw new CommandNotFoundError(cmd)
      },
    }
    const plan = await createSetupSection({isTTY: true, recipes, runner}).plan(ctx())
    expect(plan.changes[0].status).toBe('would-change')
  })
})
```

Add `import {CommandNotFoundError} from '../../../../src/core/errors.js'` to that file.

- [ ] **Step 6: Run to verify they fail**

Run: `pnpm --filter @ops/cli exec vitest run test/core/bootstrap/sections/setup.test.ts`
Expected: FAIL — cannot resolve `sections/setup.js`.

- [ ] **Step 7: Implement the section**

Create `apps/cli/src/core/bootstrap/sections/setup.ts`:

```ts
import type {Runner} from '../../../executor/exec.js'
import type {RecipeIndex} from '../../tool/recipe.js'
import {type SetupOptions, type SetupResult, type SetupStatus, setupTools} from '../../tool/setup.js'
import type {Change, ChangeStatus, Section, SectionContext} from '../section.js'

export interface SetupSectionDeps {
  recipes: RecipeIndex
  runner: Runner
  isTTY: boolean
}

const STATUS: Record<SetupStatus, ChangeStatus> = {
  'already-configured': 'satisfied',
  configured: 'changed',
  failed: 'failed',
  skipped: 'skipped',
  'would-configure': 'would-change',
}

const toChange = (s: SetupResult['steps'][number]): Change => ({
  id: `${s.tool}/${s.step}`,
  status: STATUS[s.status],
  ...(s.command === undefined ? {} : {command: s.command}),
  ...(s.error === undefined ? {} : {error: s.error}),
})

/** "mise:node@22" and "node@22" both name the tool "node". */
const bareName = (entry: string): string => entry.replace(/^[^:]+:/, '').replace(/@.*$/, '')

function optionsFor(ctx: SectionContext, dryRun: boolean): SetupOptions {
  return {
    dryRun,
    json: ctx.options.json,
    nonInteractive: ctx.options.nonInteractive,
    tools: ctx.profile.setup,
    // The engine already gated for the whole run.
    yes: true,
  }
}

/**
 * The `setup` section. `assumeInstalled` is what makes a bare machine work: at plan time
 * the tools this profile installs do not exist yet, and a probe that cannot find one must
 * report the step pending rather than failing the whole run.
 */
export function createSetupSection(deps: SetupSectionDeps): Section<SetupResult> {
  const run = async (ctx: SectionContext, dryRun: boolean): Promise<SetupResult> =>
    setupTools(optionsFor(ctx, dryRun), {
      assumeInstalled: new Set([...ctx.profile.packages, ...ctx.profile.tools].map(bareName)),
      isTTY: deps.isTTY,
      // The engine prints one plan for the whole run; a second one here would repeat it.
      onPlan: () => {},
      recipes: deps.recipes,
      runner: deps.runner,
    })

  return {
    name: 'setup',
    async plan(ctx) {
      const result = await run(ctx, true)
      const changes = result.steps.map(toChange)
      return {changes, commands: changes.map((c) => c.command).filter((c) => c !== undefined), section: 'setup'}
    },
    async apply(ctx) {
      const result = await run(ctx, false)
      return {changes: result.steps.map(toChange), detail: result, section: 'setup', status: result.success ? 'ok' : 'failed'}
    },
  }
}
```

- [ ] **Step 8: Run and commit**

Run: `pnpm typecheck && pnpm test`

```bash
git add apps/cli/src/core/tool/setup.ts apps/cli/src/core/bootstrap/sections/setup.ts apps/cli/test
git commit -m "feat(bootstrap): add the setup section, with assumeInstalled

On a bare machine the setup section plans before the packages section has
installed anything, so a probe for a tool this very run will install must
report the step pending rather than aborting the run.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: The section registry

Small, but it is the seam: phases 2 and 3 add exactly one line here and nothing else.

**Files:**
- Create: `apps/cli/src/core/bootstrap/registry.ts`
- Test: `apps/cli/test/core/bootstrap/registry.test.ts`

**Interfaces:**
- Produces: `buildSections(deps: RegistryDeps): SectionRegistry`, `RegistryDeps = {install: InstallDeps; setup: SetupSectionDeps}`.

- [ ] **Step 1: Write the failing test**

Create `apps/cli/test/core/bootstrap/registry.test.ts`:

```ts
import {describe, expect, it} from 'vitest'
import {buildSections} from '../../../src/core/bootstrap/registry.js'
import {recipeIndex} from '../../../src/core/tool/recipe.js'
import {FakeRunner} from '../../helpers/fake-runner.js'
import {FakeDeb, FakeMise, FakeRepos, FakeTools} from '../../helpers/fake-packages.js'

describe('buildSections', () => {
  it('registers exactly the sections this phase implements', () => {
    const sections = buildSections({
      install: {
        deb: new FakeDeb(),
        detectManager: async () => 'apt',
        isTTY: true,
        mise: new FakeMise(),
        recipes: recipeIndex(),
        repos: new FakeRepos(),
        sudoReady: async () => true,
        systemPreferred: new Set(),
        tools: new FakeTools(),
      },
      setup: {isTTY: true, recipes: recipeIndex(), runner: new FakeRunner()},
    })
    // This guard goes red the moment a phase-2 section lands without its own tests.
    expect(Object.keys(sections).sort()).toEqual(['packages', 'setup', 'tools'])
    expect(sections.packages?.name).toBe('packages')
    expect(sections.tools?.name).toBe('tools')
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @ops/cli exec vitest run test/core/bootstrap/registry.test.ts`
Expected: FAIL — cannot resolve `bootstrap/registry.js`.

- [ ] **Step 3: Implement**

Create `apps/cli/src/core/bootstrap/registry.ts`:

```ts
import type {InstallDeps} from '../package/install.js'
import type {SectionRegistry} from './section.js'
import {createInstallSection} from './sections/install.js'
import {type SetupSectionDeps, createSetupSection} from './sections/setup.js'

export interface RegistryDeps {
  install: InstallDeps
  setup: SetupSectionDeps
}

/**
 * The sections this build can run. Providers arrive as arguments rather than being
 * reached for, so this stays in core and a test can assert the list without oclif.
 * A later phase adds one entry here and touches nothing in run.ts.
 */
export function buildSections(deps: RegistryDeps): SectionRegistry {
  return {
    packages: createInstallSection('packages', deps.install),
    setup: createSetupSection(deps.setup),
    tools: createInstallSection('tools', deps.install),
  }
}
```

- [ ] **Step 4: Run and commit**

Run: `pnpm --filter @ops/cli exec vitest run test/core/bootstrap/registry.test.ts`
Expected: PASS.

```bash
git add apps/cli/src/core/bootstrap/registry.ts apps/cli/test/core/bootstrap/registry.test.ts
git commit -m "feat(bootstrap): add the section registry

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: Renderers

**Files:**
- Modify: `apps/cli/src/core/output.ts`
- Test: `apps/cli/test/core/output.test.ts`

**Interfaces:**
- Produces: `renderBootstrapResult(result, style?)`, `renderBootstrapPlan(plans, style?)`, `renderProfileList(profiles, style?)`, `renderProfileShow(profile, style?)`, each returning `string[]`.

- [ ] **Step 1: Write the failing tests**

Append to `apps/cli/test/core/output.test.ts`:

```ts
import {renderBootstrapPlan, renderBootstrapResult, renderProfileList, renderProfileShow} from '../../src/core/output.js'
import type {BootstrapResult} from '../../src/core/bootstrap/run.js'

const result = (over: Partial<BootstrapResult> = {}): BootstrapResult => ({
  action: 'bootstrap',
  counts: {changed: 1, failed: 0, satisfied: 1, skipped: 0, 'would-change': 0},
  dryRun: false,
  lineage: ['base', 'dev'],
  profile: 'dev',
  sections: [
    {section: 'packages', status: 'ok', changes: [{id: 'apt:git', status: 'satisfied', detail: '2.43.0'}]},
    {section: 'tools', status: 'ok', changes: [{id: 'mise:node', status: 'changed', detail: '22.11.0'}]},
  ],
  success: true,
  ...over,
})

describe('renderBootstrapResult', () => {
  it('heads with the profile and its lineage, then groups by section', () => {
    expect(renderBootstrapResult(result())).toEqual([
      'Profile: dev  (base -> dev)',
      '',
      'packages',
      '✓ apt:git  already satisfied (2.43.0)',
      '',
      'tools',
      '+ mise:node  changed (22.11.0)',
      '',
      '1 changed · 1 already satisfied',
    ])
  })

  it('omits the lineage when a profile extends nothing', () => {
    expect(renderBootstrapResult(result({lineage: ['dev']}))[0]).toBe('Profile: dev')
  })

  it('shows an error beside the change that failed', () => {
    const lines = renderBootstrapResult(
      result({sections: [{section: 'packages', status: 'failed', changes: [{id: 'apt:nope', status: 'failed', error: 'no candidate'}]}]}),
    )
    expect(lines).toContain('✗ apt:nope  failed: no candidate')
  })

  it('names a skipped section instead of leaving it blank', () => {
    const lines = renderBootstrapResult(result({sections: [{section: 'tools', status: 'skipped', changes: []}]}))
    expect(lines).toContain('tools')
    expect(lines).toContain('· skipped')
  })

  it('appends the would-run block on a dry run', () => {
    const lines = renderBootstrapResult(result({commands: ['apt-get install git'], dryRun: true}))
    expect(lines.slice(-2)).toEqual(['Would run:', '  apt-get install git'])
  })

  it('pads before painting, so colour never skews the columns', () => {
    const wide = result({
      sections: [
        {
          section: 'packages',
          status: 'ok',
          changes: [
            {id: 'apt:git', status: 'satisfied'},
            {id: 'apt:build-essential', status: 'changed'},
          ],
        },
      ],
    })
    const plain = renderBootstrapResult(wide)
    const painted = renderBootstrapResult(wide, ansiStyle)
    const column = (line: string) => line.replace(/\u001B\[[\d;]*m/g, '').indexOf('  ')
    expect(column(painted[3])).toBe(column(plain[3]))
    expect(column(painted[4])).toBe(column(plain[4]))
  })
})

describe('renderBootstrapPlan', () => {
  it('lists the pending changes grouped by section', () => {
    expect(
      renderBootstrapPlan([
        {section: 'packages', commands: [], changes: [{id: 'apt:git', status: 'would-change', command: 'apt-get install git'}, {id: 'apt:curl', status: 'satisfied'}]},
      ]),
    ).toEqual(['Plan:', '  packages  apt:git  apt-get install git', ''])
  })
})

describe('renderProfileList', () => {
  it('shows name, summary and parents', () => {
    expect(
      renderProfileList([
        {name: 'base', summary: 'Essentials', extends: [], sections: ['packages']},
        {name: 'dev', summary: 'Local dev box', extends: ['base'], sections: ['packages', 'tools']},
      ]),
    ).toEqual(['base  Essentials', 'dev   Local dev box  (extends base)'])
  })
})

describe('renderProfileShow', () => {
  it('lists each declared section, and nothing for the empty ones', () => {
    expect(
      renderProfileShow({name: 'dev', summary: 'Local dev box', lineage: ['base', 'dev'], packages: ['git'], tools: ['node'], setup: [], services: []}),
    ).toEqual(['Profile: dev  (base -> dev)', 'Local dev box', '', 'packages  git', 'tools     node'])
  })
})
```

Ensure `ansiStyle` is imported in that test file (`import {ansiStyle} from '../../src/core/style.js'`).

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @ops/cli exec vitest run test/core/output.test.ts`
Expected: FAIL — the four render functions do not exist.

- [ ] **Step 3: Implement**

Append to `apps/cli/src/core/output.ts` (and add the type imports at the top):

```ts
import type {BootstrapResult} from './bootstrap/run.js'
import type {Change, ChangeStatus, SectionPlan} from './bootstrap/section.js'
import type {ProfileSummary, ResolvedProfile} from './profile/resolve.js'
```

```ts
const CHANGE_LABELS: Record<ChangeStatus, [symbol: string, text: string, paint: Paint]> = {
  changed: ['+', 'changed', 'add'],
  failed: ['✗', 'failed', 'fail'],
  satisfied: ['✓', 'already satisfied', 'ok'],
  skipped: ['·', 'skipped', 'muted'],
  'would-change': ['~', 'would change', 'warn'],
}

/** "base -> dev", or nothing when a profile extends nothing. */
function lineageOf(name: string, lineage: string[], style: Style): string {
  const heading = `${style.heading('Profile:')} ${name}`
  return lineage.length > 1 ? `${heading}  ${style.muted(`(${lineage.join(' -> ')})`)}` : heading
}

function changeLines(changes: Change[], style: Style): string[] {
  const width = column(changes.map((c) => c.id))
  return changes.map((c) => {
    const [symbol, text, paint] = CHANGE_LABELS[c.status]
    const label = `${text}${c.detail ? ` (${c.detail})` : ''}${c.error ? `: ${c.error}` : ''}`
    // Pad before painting: escape codes count towards .length and would skew the columns.
    return `${style[paint](symbol)} ${c.id.padEnd(width)}  ${c.error ? style.fail(label) : style.muted(label)}`
  })
}

export function renderBootstrapResult(result: BootstrapResult, style: Style = plainStyle): string[] {
  const lines = [lineageOf(result.profile, result.lineage, style)]

  for (const section of result.sections) {
    lines.push('', style.heading(section.section))
    lines.push(...(section.changes.length > 0 ? changeLines(section.changes, style) : [style.muted('· skipped')]))
  }

  const counts = result.counts
  const summary = [
    counts.changed > 0 ? `${counts.changed} changed` : '',
    counts['would-change'] > 0 ? `${counts['would-change']} would change` : '',
    counts.satisfied > 0 ? `${counts.satisfied} already satisfied` : '',
    counts.failed > 0 ? `${counts.failed} failed` : '',
    counts.skipped > 0 ? `${counts.skipped} skipped` : '',
  ].filter(Boolean)
  if (summary.length > 0) lines.push('', summary.join(' · '))

  if (result.commands && result.commands.length > 0) {
    lines.push('', style.heading('Would run:'), ...result.commands.map((c) => style.muted(`  ${c}`)))
  }

  return lines
}

/** Shown before the first section applies, so nothing runs unseen. */
export function renderBootstrapPlan(plans: SectionPlan[], style: Style = plainStyle): string[] {
  const pending = plans.flatMap((plan) => plan.changes.filter((c) => c.status === 'would-change').map((c) => ({change: c, section: plan.section})))
  const section = column(pending.map((p) => p.section))
  const id = column(pending.map((p) => p.change.id))
  const rows = pending.map((p) => `  ${p.section.padEnd(section)}  ${p.change.id.padEnd(id)}  ${style.muted(p.change.command ?? '')}`.trimEnd())
  return [style.heading('Plan:'), ...rows, '']
}

export function renderProfileList(profiles: ProfileSummary[], style: Style = plainStyle): string[] {
  const width = column(profiles.map((p) => p.name))
  return profiles.map((p) => {
    const parents = p.extends.length > 0 ? `  ${style.muted(`(extends ${p.extends.join(', ')})`)}` : ''
    return `${p.name.padEnd(width)}  ${p.summary ?? ''}${parents}`.trimEnd()
  })
}

export function renderProfileShow(profile: ResolvedProfile, style: Style = plainStyle): string[] {
  const sections: [string, string][] = [
    ['packages', profile.packages.join(' ')],
    ['tools', profile.tools.join(' ')],
    ['setup', profile.setup.join(' ')],
    ['services', profile.services.map((s) => s.name).join(' ')],
    ['shell', profile.shell?.name ?? ''],
    ['dotfiles', profile.dotfiles?.repo ?? ''],
  ].filter(([, value]) => value !== '') as [string, string][]

  const width = column(sections.map(([name]) => name))
  return [
    lineageOf(profile.name, profile.lineage, style),
    ...(profile.summary ? [profile.summary] : []),
    '',
    ...sections.map(([name, value]) => `${style.heading(name.padEnd(width))}  ${value}`),
  ]
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `pnpm --filter @ops/cli exec vitest run test/core/output.test.ts`
Expected: PASS. Expect to adjust exact spacing in the test or the renderer once — settle it by making the **test** match a deliberate layout, never by loosening an assertion to `expect.stringContaining`.

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/core/output.ts apps/cli/test/core/output.test.ts
git commit -m "feat(output): render bootstrap results, plans and profiles

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: `ops bootstrap`

**Files:**
- Create: `apps/cli/src/commands/bootstrap.ts`
- Test: `apps/cli/test/commands/bootstrap.test.ts`

**Interfaces:**
- Consumes: `bootstrapProfile`, `BootstrapResult` from `src/core/bootstrap/run.js`; `buildSections` from `src/core/bootstrap/registry.js`; `profileIndex` from `src/core/profile/resolve.js`; `SECTION_ORDER` from `src/core/config.js`; the renderers from `src/core/output.js`.
- Produces: the default-exported oclif command.

- [ ] **Step 1: Write the failing tests**

Create `apps/cli/test/commands/bootstrap.test.ts`, mirroring `test/commands/tool/install.test.ts`:

```ts
import {ux} from '@oclif/core'
import {afterEach, describe, expect, it} from 'vitest'
import Bootstrap from '../../src/commands/bootstrap.js'
import {SECTION_ORDER} from '../../src/core/config.js'
import {OpsError} from '../../src/core/errors.js'

/** The command with just enough oclif around it to call catch() directly. */
function command(json = false): Bootstrap {
  const cmd = new Bootstrap([], {runHook: async () => ({successes: [], failures: []})} as never)
  Object.defineProperty(cmd, 'jsonEnabled', {value: () => json})
  Object.defineProperty(cmd, 'error', {value: () => undefined})
  return cmd
}

const runCatch = (cmd: Bootstrap, error: Error) =>
  (cmd as unknown as {catch(e: Error): Promise<unknown>}).catch(error).catch(() => undefined)

afterEach(() => {
  if (ux.action.running) ux.action.stop()
})

describe('Bootstrap flags', () => {
  it('offers --only and --skip restricted to real section names', () => {
    expect(Bootstrap.flags.only.options).toEqual([...SECTION_ORDER])
    expect(Bootstrap.flags.skip.options).toEqual([...SECTION_ORDER])
    // Letting both through would make the intersection meaningless.
    expect(Bootstrap.flags.only.exclusive).toEqual(['skip'])
  })

  it('takes one optional positional profile', () => {
    expect(Bootstrap.strict).toBe(true)
    expect(Bootstrap.args.profile.required).toBeFalsy()
  })
})

describe('Bootstrap.catch', () => {
  it('stops a running spinner before reporting an OpsError', async () => {
    ux.action.start('installing apt:git')
    await runCatch(command(), new OpsError('PROFILE_NOT_FOUND', 'No profile "nope"'))
    expect(ux.action.running).toBe(false)
  })

  it('stops the spinner on the --json path as well', async () => {
    ux.action.start('installing apt:git')
    await runCatch(command(true), new OpsError('PROFILE_SECTION_UNSUPPORTED', 'no services yet'))
    expect(ux.action.running).toBe(false)
  })

  it('stops the spinner for ordinary errors too', async () => {
    ux.action.start('installing apt:git')
    await runCatch(command(), new Error('boom'))
    expect(ux.action.running).toBe(false)
  })
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @ops/cli exec vitest run test/commands/bootstrap.test.ts`
Expected: FAIL — cannot resolve `src/commands/bootstrap.js`.

- [ ] **Step 3: Implement**

Create `apps/cli/src/commands/bootstrap.ts`:

```ts
import {Args, Command, Flags, ux} from '@oclif/core'

import {buildSections} from '../core/bootstrap/registry.js'
import {type BootstrapResult, bootstrapProfile} from '../core/bootstrap/run.js'
import type {SectionName} from '../core/config.js'
import {SECTION_ORDER, loadConfig} from '../core/config.js'
import {OpsError} from '../core/errors.js'
import {downloadProgress, renderBootstrapPlan, renderBootstrapResult, stageReporter} from '../core/output.js'
import {profileIndex} from '../core/profile/resolve.js'
import {styleFor} from '../core/style.js'
import {recipeIndex} from '../core/tool/recipe.js'
import {execaRunner, sudoReady} from '../executor/exec.js'
import {createAptRepoProvider} from '../providers/apt-repo.js'
import {createDebInstaller} from '../providers/deb.js'
import {createMiseBootstrap} from '../providers/mise-bootstrap.js'
import {createMiseTools} from '../providers/mise-tools.js'
import {detectSystemManager} from '../providers/os.js'

/**
 * What `ops bootstrap` runs with no argument. A constant rather than config data
 * because it is fixed by design: a user who wants a different set redefines
 * profile.minimal, which merges by name like every other built-in.
 */
const DEFAULT_PROFILE = 'minimal'

export default class Bootstrap extends Command {
  static override summary = 'Converge this machine to a profile'
  static override description =
    'A profile names what a machine should have: packages, mise tools, and tool setup steps. `ops bootstrap <profile>` inspects every section first, shows one plan for the whole run, then applies only what is missing and verifies it -- so running it twice reports that everything is already satisfied. Profiles are `profile.<name>` in config/defaults.yaml, extended or replaced in ~/.config/ops/config.yaml (or $OPS_CONFIG); `extends` composes them. With no name it runs "minimal". Note that the plan is advisory for system packages: a package installed but never declared to ops shows as pending and comes back already satisfied once the run declares it.'
  static override examples = [
    '<%= config.bin %> bootstrap',
    '<%= config.bin %> bootstrap dev --dry-run',
    '<%= config.bin %> bootstrap dev --yes',
    '<%= config.bin %> bootstrap dev --only tools --yes',
    '<%= config.bin %> bootstrap dev --json --non-interactive',
  ]
  static override enableJsonFlag = true
  // One optional positional; unlike `tool install` there is nothing variadic to accept.
  static override strict = true
  static override args = {
    profile: Args.string({description: 'Profile name (see `ops profile list`)', required: false}),
  }
  static override flags = {
    'dry-run': Flags.boolean({default: false, summary: 'Inspect every section and show the plan, without changing anything'}),
    force: Flags.boolean({default: false, summary: "Reinstall through a recipe's repo even when a build from elsewhere is installed"}),
    'non-interactive': Flags.boolean({default: false, summary: 'Never prompt (implies --yes)'}),
    only: Flags.string({default: [], exclusive: ['skip'], multiple: true, options: [...SECTION_ORDER], summary: 'Run only these sections'}),
    skip: Flags.string({default: [], multiple: true, options: [...SECTION_ORDER], summary: 'Skip these sections'}),
    yes: Flags.boolean({char: 'y', default: false, summary: 'Skip the confirmation prompt'}),
  }

  async run(): Promise<BootstrapResult> {
    const {args, flags} = await this.parse(Bootstrap)
    const config = await loadConfig()
    const recipes = recipeIndex(config.tool, {repos: config.repo})

    // Progress goes to stderr so --json stdout stays clean, and only when someone is watching.
    const onProgress =
      this.jsonEnabled() || !process.stderr.isTTY
        ? undefined
        : downloadProgress(
            (line) => process.stderr.write(`\r\u001B[K${line}`),
            Date.now,
            () => process.stderr.columns || 80,
          )

    // A spinner and sudo's password prompt would fight over the terminal.
    const mayInstall = !flags['dry-run'] && !this.jsonEnabled() && process.stderr.isTTY
    const spin = mayInstall && (await sudoReady(execaRunner))

    const result = await bootstrapProfile(
      {
        dryRun: flags['dry-run'],
        force: flags.force,
        json: this.jsonEnabled(),
        nonInteractive: flags['non-interactive'],
        only: flags.only as SectionName[],
        profile: args.profile ?? DEFAULT_PROFILE,
        skip: flags.skip as SectionName[],
        yes: flags.yes,
      },
      {
        isTTY: Boolean(process.stdout.isTTY),
        onPlan: (plans) => {
          if (!this.jsonEnabled()) for (const line of renderBootstrapPlan(plans, styleFor(false))) this.log(line)
        },
        onSection: () => {
          // A section is about to run its own subprocesses; the spinner must let go of the row.
          if (ux.action.running) ux.action.stop()
        },
        profiles: profileIndex(config.profile, {recipes}),
        sections: buildSections({
          install: {
            captureOutput: spin,
            deb: createDebInstaller(execaRunner),
            detectManager: () => detectSystemManager(),
            isTTY: Boolean(process.stdin.isTTY),
            mise: createMiseBootstrap(execaRunner),
            onProgress,
            onStage:
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
                : undefined,
            recipes,
            repos: createAptRepoProvider(execaRunner),
            sudoReady: () => sudoReady(execaRunner),
            systemPreferred: new Set(config.package.system),
            tools: createMiseTools(execaRunner),
          },
          setup: {isTTY: Boolean(process.stdout.isTTY), recipes, runner: execaRunner},
        }),
      },
    )

    if (ux.action.running) ux.action.stop()
    if (!this.jsonEnabled()) for (const line of renderBootstrapResult(result, styleFor(this.jsonEnabled()))) this.log(line)
    if (!result.success) process.exitCode = 1
    return result
  }

  protected override async catch(error: Error & {exitCode?: number}): Promise<unknown> {
    // oclif only stops the spinner inside super.catch(), which the OpsError branch skips;
    // a spinner left running scribbles over the very message the user needs to read.
    if (ux.action.running) ux.action.stop('failed')
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

- [ ] **Step 4: Run, build, smoke-test**

Run: `pnpm --filter @ops/cli exec vitest run test/commands/bootstrap.test.ts && pnpm typecheck && pnpm build`
Then: `pnpm ops bootstrap --help` and `pnpm ops bootstrap dev --dry-run --json`
Expected: help lists the flags; the dry run prints a `BootstrapResult` with `lineage: ["base","minimal","dev"]` and exits 0.

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/commands/bootstrap.ts apps/cli/test/commands/bootstrap.test.ts
git commit -m "feat(cli): add ops bootstrap

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 10: `ops profile list` and `ops profile show`

Read-only. There is no `ops profile apply`: `ops bootstrap` is the verb that converges, and two names for one operation is what the tool-command-surface design rejected.

**Files:**
- Create: `apps/cli/src/commands/profile/list.ts`, `apps/cli/src/commands/profile/show.ts`
- Modify: `apps/cli/package.json`
- Test: `apps/cli/test/commands/profile/show.test.ts`

**Interfaces:**
- Consumes: `profileIndex`, `ProfileSummary`, `ResolvedProfile` from `src/core/profile/resolve.js`; `renderProfileList`, `renderProfileShow` from `src/core/output.js`.

- [ ] **Step 1: Register the topic**

In `apps/cli/package.json`, add to `oclif.topics` beside `tool`:

```json
      "profile": {
        "description": "Inspect machine profiles"
      }
```

- [ ] **Step 2: Write `ops profile list`**

Create `apps/cli/src/commands/profile/list.ts`:

```ts
import {Command} from '@oclif/core'

import {loadConfig} from '../../core/config.js'
import {OpsError} from '../../core/errors.js'
import {renderProfileList} from '../../core/output.js'
import {type ProfileSummary, profileIndex} from '../../core/profile/resolve.js'
import {styleFor} from '../../core/style.js'
import {recipeIndex} from '../../core/tool/recipe.js'

export default class ProfileList extends Command {
  static override summary = 'List the machine profiles this config defines'
  static override description =
    'Profiles are `profile.<name>` in config/defaults.yaml, extended or replaced in ~/.config/ops/config.yaml (or $OPS_CONFIG). `ops bootstrap <name>` converges the machine to one.'
  static override examples = ['<%= config.bin %> profile list', '<%= config.bin %> profile list --json']
  static override enableJsonFlag = true

  async run(): Promise<ProfileSummary[]> {
    const config = await loadConfig()
    const profiles = profileIndex(config.profile, {recipes: recipeIndex(config.tool, {repos: config.repo})}).list()
    if (!this.jsonEnabled()) for (const line of renderProfileList(profiles, styleFor(false))) this.log(line)
    return profiles
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

- [ ] **Step 3: Write the failing test for `show`**

Create `apps/cli/test/commands/profile/show.test.ts`:

```ts
import {describe, expect, it} from 'vitest'
import ProfileShow from '../../../src/commands/profile/show.js'

describe('ProfileShow', () => {
  it('takes a required profile name and a --raw flag', () => {
    expect(ProfileShow.args.name.required).toBe(true)
    expect(ProfileShow.flags.raw.allowNo).toBeFalsy()
    // The default is the composed profile: the literal entry is the special case.
    expect(ProfileShow.flags.raw.default).toBe(false)
  })
})
```

- [ ] **Step 4: Write `ops profile show`**

Create `apps/cli/src/commands/profile/show.ts`:

```ts
import {Args, Command, Flags} from '@oclif/core'

import {type Profile, loadConfig} from '../../core/config.js'
import {OpsError} from '../../core/errors.js'
import {renderProfileShow} from '../../core/output.js'
import {type ResolvedProfile, profileIndex} from '../../core/profile/resolve.js'
import {styleFor} from '../../core/style.js'
import {recipeIndex} from '../../core/tool/recipe.js'

export default class ProfileShow extends Command {
  static override summary = 'Show a profile, composed through its extends chain'
  static override description =
    'By default this prints what `ops bootstrap <name>` would actually work from: every section after `extends` composition, with the profiles that contributed. `--raw` prints the literal profile.<name> entry instead.'
  static override examples = [
    '<%= config.bin %> profile show dev',
    '<%= config.bin %> profile show dev --raw',
    '<%= config.bin %> profile show dev --json',
  ]
  static override enableJsonFlag = true
  static override strict = true
  static override args = {
    name: Args.string({description: 'Profile name', required: true}),
  }
  static override flags = {
    raw: Flags.boolean({default: false, summary: 'Print the literal config entry, before extends composition'}),
  }

  async run(): Promise<ResolvedProfile | Profile> {
    const {args, flags} = await this.parse(ProfileShow)
    const config = await loadConfig()
    const profiles = profileIndex(config.profile, {recipes: recipeIndex(config.tool, {repos: config.repo})})

    if (flags.raw) {
      const raw = profiles.raw(args.name)
      if (!raw) throw new OpsError('PROFILE_NOT_FOUND', `No profile "${args.name}"; available: ${profiles.names().join(', ') || '(none)'}`)
      if (!this.jsonEnabled()) this.log(JSON.stringify(raw, undefined, 2))
      return raw
    }

    const profile = profiles.resolve(args.name)
    if (!this.jsonEnabled()) for (const line of renderProfileShow(profile, styleFor(false))) this.log(line)
    return profile
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

- [ ] **Step 5: Verify end to end**

Run: `pnpm typecheck && pnpm test && pnpm build`
Then:
```bash
pnpm ops profile list
pnpm ops profile show dev
pnpm ops profile show dev --raw
pnpm ops profile show nope   # exit 1, names the available profiles
```

- [ ] **Step 6: Commit**

```bash
git add apps/cli/src/commands/profile apps/cli/package.json apps/cli/test/commands/profile
git commit -m "feat(cli): add ops profile list and ops profile show

Read-only inspection. ops bootstrap stays the only verb that converges a
machine, so there is no ops profile apply.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 11: Documentation and container verification

Nothing here is optional: the docs currently promise a command surface this plan deliberately changes, and every unit test uses a fake runner, so the container is the only place the real sudo/apt/mise paths run at all.

**Files:**
- Modify: `docs/commands.md`, `docs/architecture.md`, `docs/roadmap.md`, `README.md`, `CLAUDE.md`, `docs/superpowers/specs/2026-09-20-profile-bootstrap-design.md`

- [ ] **Step 1: Fix the contradiction in `docs/architecture.md`**

`docs/architecture.md:249` shows `profile: developer` as a scalar config key. That collides with `profile:` being the map of profiles, and anyone copying it into their config now gets a Zod failure. Remove that line from the example, and in the config-precedence note (`docs/architecture.md:226-244`) state that the `Profile` layer and the global `--profile` flag remain planned and are a different concept from `profile.<name>`.

- [ ] **Step 2: Rewrite `docs/commands.md` §Bootstrap and §Profiles**

- Bootstrap: document `ops bootstrap [profile]` with the real flags (`--dry-run --yes --non-interactive --force --only --skip --json`), the section order, the one-confirmation gate, fail-fast, and the profile file format with a worked `extends` example.
- Profiles: `ops profile list` and `ops profile show <name> [--raw]` only. **Delete `ops profile apply`** and add a sentence saying `ops bootstrap` is the verb that applies a profile.
- Replace both speculative name lists (`docs/commands.md:118-129` has eight, `docs/features.md:75-85` has a different seven) with the three that ship: `base`, `minimal`, `dev`.

- [ ] **Step 3: Update `docs/roadmap.md`, `README.md` and `CLAUDE.md`**

- `docs/roadmap.md`: mark bootstrap and profiles shipped in v0.2; update the "Where we are" paragraph.
- `README.md`: replace the `ops bootstrap` line in the headline example with a real one, and narrow the status paragraph to what is now unimplemented.
- `CLAUDE.md`: add `ops bootstrap` and `ops profile list|show` to the project-status paragraph; add `src/core/profile/resolve.ts` to the list of core files exempted as "reads config through injectable defaults" beside `config.ts` and `tool/recipe.ts`; note that `buildSections` in `src/core/bootstrap/registry.ts` is the single place a new section is registered.

- [ ] **Step 4: Mark the spec implemented**

In `docs/superpowers/specs/2026-09-20-profile-bootstrap-design.md`, change `Status: planned` to `Status: phase 1 implemented`.

- [ ] **Step 5: Verify in the container**

These are the claims no fake can prove. Run them in order; `mise run up` first so state survives between commands.

```bash
mise run up
mise run docker:run ops profile list
mise run docker:run ops profile show dev
mise run docker:run ops profile show dev --raw
```

```bash
# The single most important claim of the design: the plan phase writes nothing.
mise run docker:run ops bootstrap minimal --dry-run
mise run docker:run dpkg -l tmux          # expect: not installed
mise run docker:run mise bootstrap packages status   # expect: unchanged
```

```bash
# The gate, under --json with no TTY.
mise run docker:run ops bootstrap minimal --json      # expect exit 1, CONFIRMATION_REQUIRED, clean JSON
mise run docker:run ops bootstrap minimal --yes       # expect exit 0, real apt + mise
mise run docker:run ops bootstrap minimal --yes       # expect exit 0, every change "already satisfied"
```

The second `--yes` run is the idempotency proof: it must report `already satisfied` for everything and invoke no apt install.

```bash
mise run docker:run ops bootstrap dev --yes --json    # lineage ["base","minimal","dev"], counts, sections[].detail
mise run docker:run ops bootstrap dev --only tools --yes
mise run docker:run ops bootstrap dev --skip tools --dry-run
```

Fail-fast, with a throwaway config:

```bash
mise run docker:run bash -c 'printf "profile:\n  broken:\n    packages: [no-such-pkg-xyz]\n    tools: [jq]\n" > /tmp/ops.yaml && OPS_CONFIG=/tmp/ops.yaml ops bootstrap broken --yes --json; echo "exit=$?"'
```
Expect: `exit=1`, the `packages` section `failed`, and the `tools` section reported `skipped` — not attempted.

An unsupported section:

```bash
mise run docker:run bash -c 'printf "profile:\n  svc:\n    packages: [curl]\n    services: [{name: docker}]\n" > /tmp/ops.yaml && OPS_CONFIG=/tmp/ops.yaml ops bootstrap svc --dry-run; echo "exit=$?"'
```
Expect: `exit=1`, `PROFILE_SECTION_UNSUPPORTED`, message naming `--skip services`. The same command with `--skip services` must succeed.

The bare-machine case — the whole point of the feature. Start a **fresh** container (not the reused one) so nothing is pre-installed, with a profile whose `setup` names a tool the same run installs, and confirm the run does not die at plan time:

```bash
mise run down && mise run docker:run bash -c 'printf "tool:\n  jq:\n    package: apt:jq\n    setup:\n      - name: present\n        check: [jq, --version]\n        run: [true]\n" > /tmp/ops.yaml && printf "profile:\n  t:\n    packages: [jq]\n    setup: [jq]\n" >> /tmp/ops.yaml && OPS_CONFIG=/tmp/ops.yaml ops bootstrap t --dry-run; echo "exit=$?"'
```
Expect: `exit=0`, the `setup` section showing `would change` rather than a `jq not found on PATH` failure.

- [ ] **Step 6: Commit**

```bash
git add docs README.md CLAUDE.md
git commit -m "docs: document ops bootstrap and profiles

Drops ops profile apply, replaces the two speculative profile name lists with
the three that ship, and removes the scalar `profile:` config key from the
architecture example -- it collided with profile.<name> and would now fail
validation for anyone who copied it.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage.** Every section of the spec maps to a task: profile-as-config-data → Task 2; `extends` table and eager validation → Task 3; section engine, two-method `Section`, one gate, fail-fast, unsupported-section error → Task 4; `packages`/`tools` resolution difference → Task 5; the plan-time `setup` hazard and `assumeInstalled` → Task 6; the registry seam → Task 7; the uniform `Change` renderer and open `detail` → Task 8; the command surface and exit codes → Tasks 9 and 10; the two refactors → Task 1; the risks and the docs contradictions → Task 11. The three "known limitations" in the spec need no code: the plan-over-reports caveat is stated in the `ops bootstrap` description (Task 9, Step 3), double inspection is inherent to the two-method `Section`, and the mise prerequisite surfaces through the existing `catch()` override.

**Phase boundaries hold.** Nothing in phase 1 writes a provider. `run.ts`, `section.ts` and `profile/resolve.ts` are complete for all six sections; a phase-2 author edits `defaults.yaml`, one provider, one section file, one line of `buildSections`, and `errors.ts`. Task 7's registry test is the guard that makes that claim testable.

**Type consistency.** `Section`, `SectionPlan`, `SectionReport`, `Change`, `ChangeStatus`, `SectionContext`, `BootstrapOptions` and `pendingIn` are defined once in `section.ts` (Task 4) and imported everywhere after. `BootstrapOptions` lives in `section.ts` rather than `run.ts` so `SectionContext` can reference it without a cycle; `run.ts` re-exports it. `ResolvedProfile`, `ProfileSummary` and `declaresSection` come from `profile/resolve.ts` (Task 3). `SetupSectionDeps` is exported from `sections/setup.ts` (Task 6) and consumed by `registry.ts` (Task 7). `SECTION_ORDER` and `SectionName` live in `config.ts` (Task 2) because both the schema and the engine need them.

**Ordering.** Tasks 2→3→4→5→6→7→8→9→10 is a strict dependency chain; Task 1 precedes all of them because Task 5 imports the extracted fakes and Task 9 imports the moved `stageReporter`. Task 11 is last because it documents what the earlier tasks actually built.
