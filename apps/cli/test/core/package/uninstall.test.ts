import {describe, expect, it} from 'vitest'
import {OpsError} from '../../../src/core/errors.js'
import {type UninstallDeps, type UninstallOptions, type UninstallPlan, uninstallPackages} from '../../../src/core/package/uninstall.js'
import type {PackageSpec} from '../../../src/core/package/spec.js'
import {recipeIndex} from '../../../src/core/tool/recipe.js'
import type {MiseDeclarations, MiseTable} from '../../../src/providers/mise-config.js'
import type {InstallToolOptions, MiseTools, ToolState} from '../../../src/providers/mise-tools.js'
import type {PathRemover, PathState} from '../../../src/providers/paths.js'
import type {RemoveOptions, SystemPackageState, SystemPackages} from '../../../src/providers/system.js'

/** One shared log across every fake, so ordering between providers can be asserted. */
type Log = string[]

class FakeSystem implements SystemPackages {
  installed = new Map<string, string>() // spec -> version
  configFiles = new Set<string>() // removed but still holding conffiles
  removes: {specs: PackageSpec[]; opts: RemoveOptions}[] = []
  dependents: string[] = []
  removeWorks = true

  constructor(private log: Log) {}

  async status(specs: PackageSpec[]): Promise<SystemPackageState[]> {
    this.log.push('system.status')
    return specs.map((spec) => ({
      installed: this.installed.has(spec),
      spec,
      ...(this.configFiles.has(spec) ? {configFiles: true} : {}),
      ...(this.installed.get(spec) ? {version: this.installed.get(spec)} : {}),
    }))
  }

  async simulate(specs: PackageSpec[]) {
    this.log.push('system.simulate')
    return {removes: [...specs.map((s) => s.split(':')[1]), ...this.dependents]}
  }

  async remove(specs: PackageSpec[], opts: RemoveOptions) {
    this.log.push('system.remove')
    this.removes.push({opts, specs})
    if (this.removeWorks) for (const s of specs) {
      this.installed.delete(s)
      this.configFiles.delete(s)
    }
    return {exitCode: this.removeWorks ? 0 : 1}
  }

  describe(specs: PackageSpec[], opts: {purge: boolean}) {
    return [`sudo apt-get ${opts.purge ? 'purge' : 'remove'} -y -- ${specs.map((s) => s.split(':')[1]).join(' ')}`]
  }
}

class FakeTools implements MiseTools {
  installed = new Map<string, string>() // name -> version
  registry = new Set<string>()
  removed: {names: string[]; opts: InstallToolOptions}[] = []
  removeWorks = true

  constructor(private log: Log) {}

  async inRegistry(name: string) {
    return this.registry.has(name)
  }

  async status(): Promise<ToolState[]> {
    this.log.push('tools.status')
    return [...this.installed].map(([name, version]) => ({installed: true, name, version}))
  }

  async install() {
    return {exitCode: 0}
  }

  async dryRun(names: string[]) {
    return names.map((n) => `would install ${n}`)
  }

  async remove(names: string[], opts: InstallToolOptions) {
    this.log.push('tools.remove')
    this.removed.push({names, opts})
    if (this.removeWorks) for (const n of names) this.installed.delete(n)
    return {exitCode: this.removeWorks ? 0 : 1}
  }

  describeRemove(names: string[]) {
    return names.map((n) => `mise unuse -g ${n}`)
  }
}

class FakeDeclarations implements MiseDeclarations {
  declared = new Set<string>() // `${table}.${key}`
  writes: string[] = []

  constructor(private log: Log) {}

  async isDeclared(table: MiseTable, key: string) {
    return this.declared.has(`${table}.${key}`)
  }

  async undeclare(table: MiseTable, key: string) {
    this.log.push('declarations.undeclare')
    const id = `${table}.${key}`
    if (!this.declared.has(id)) return false
    this.declared.delete(id)
    this.writes.push(id)
    return true
  }

  describe(table: MiseTable, key: string) {
    return `undeclare "${key}" from [${table}]`
  }

  path() {
    return '/home/t/.config/mise/config.toml'
  }
}

class FakePaths implements PathRemover {
  existing = new Set<string>()
  privileged = new Set<string>()
  removed: string[] = []
  removeLeavesBehind = false

  constructor(private log: Log) {}

  async stat(path: string): Promise<PathState> {
    return {exists: this.existing.has(path), path, privileged: this.privileged.has(path)}
  }

  async remove(path: string) {
    this.log.push('paths.remove')
    this.removed.push(path)
    if (!this.removeLeavesBehind) this.existing.delete(path)
  }

  describe(path: string, privileged: boolean) {
    return `${privileged ? 'sudo ' : ''}rm -rf -- ${path}`
  }
}

const RECIPES = {
  'google-chrome': {
    package: 'apt:google-chrome-stable',
    uninstall: {purge: {paths: ['/etc/apt/sources.list.d/google-chrome.sources', '~/.config/google-chrome']}},
  },
}
const CHROME: PackageSpec = 'apt:google-chrome-stable'
const SOURCES = '/etc/apt/sources.list.d/google-chrome.sources'
const PROFILE = '/home/t/.config/google-chrome'

function setup(overrides: Partial<UninstallDeps> = {}) {
  const log: Log = []
  const system = new FakeSystem(log)
  const tools = new FakeTools(log)
  const declarations = new FakeDeclarations(log)
  const paths = new FakePaths(log)
  const plans: UninstallPlan[] = []
  const deps: UninstallDeps = {
    declarations,
    detectManager: async () => 'apt',
    isTTY: true,
    onPlan: (plan) => plans.push(plan),
    paths,
    recipes: recipeIndex(RECIPES, {home: '/home/t'}),
    sudoReady: async () => true,
    system,
    systemPreferred: new Set(),
    tools,
    ...overrides,
  }
  return {declarations, deps, log, paths, plans, system, tools}
}

const run = (packages: string[], options: Partial<UninstallOptions> = {}, deps?: UninstallDeps) =>
  uninstallPackages(
    {dryRun: false, force: false, json: false, nonInteractive: false, packages, purge: false, yes: true, ...options},
    deps ?? setup().deps,
  )

async function errorOf(promise: Promise<unknown>) {
  const error = await promise.then(() => undefined, (e: unknown) => e)
  expect(error).toBeInstanceOf(OpsError)
  return error as OpsError
}

describe('uninstallPackages', () => {
  it('removes an installed, declared system package and clears its declaration', async () => {
    const t = setup()
    t.system.installed.set(CHROME, '153.0')
    t.declarations.declared.add(`bootstrap.packages.${CHROME}`)

    const result = await run(['google-chrome'], {}, t.deps)
    expect(result.success).toBe(true)
    expect(result.action).toBe('uninstall')
    expect(result.packages).toEqual([{spec: CHROME, status: 'uninstalled', version: '153.0', undeclared: true}])
    expect(t.system.removes[0].specs).toEqual([CHROME])
    expect(t.declarations.writes).toEqual([`bootstrap.packages.${CHROME}`])
  })

  // The state this machine is actually in: declared, never installed.
  it('clears a declaration for a package that was never installed', async () => {
    const t = setup()
    t.declarations.declared.add(`bootstrap.packages.${CHROME}`)

    const result = await run(['google-chrome'], {}, t.deps)
    expect(result.packages[0]).toMatchObject({status: 'uninstalled', undeclared: true})
    expect(t.system.removes).toEqual([])
  })

  it('is a no-op when nothing is installed and nothing is declared', async () => {
    const t = setup()
    const result = await run(['google-chrome'], {}, t.deps)
    expect(result.packages).toEqual([{spec: CHROME, status: 'already-absent'}])
    expect(result.success).toBe(true)
    expect(t.system.removes).toEqual([])
    expect(t.declarations.writes).toEqual([])
    expect(t.plans).toEqual([])
  })

  it('is idempotent: a second run changes nothing', async () => {
    const t = setup()
    t.system.installed.set(CHROME, '153.0')
    t.declarations.declared.add(`bootstrap.packages.${CHROME}`)

    await run(['google-chrome'], {}, t.deps)
    const removesAfterFirst = t.system.removes.length
    const second = await run(['google-chrome'], {}, t.deps)

    expect(second.packages).toEqual([{spec: CHROME, status: 'already-absent'}])
    expect(t.system.removes).toHaveLength(removesAfterFirst)
    expect(t.declarations.writes).toHaveLength(1)
  })

  // An installed package ops never declared: remove it, write nothing.
  it('removes without touching the config when the package was never declared', async () => {
    const t = setup()
    t.system.installed.set(CHROME, '153.0')

    const result = await run(['google-chrome'], {}, t.deps)
    expect(result.packages[0]).toMatchObject({status: 'uninstalled'})
    expect(result.packages[0].undeclared).toBeUndefined()
    expect(t.declarations.writes).toEqual([])
  })

  // Un-declaring last: a failed removal must leave the declaration to restore from.
  it('removes, verifies, then undeclares, in that order', async () => {
    const t = setup()
    t.system.installed.set(CHROME, '153.0')
    t.declarations.declared.add(`bootstrap.packages.${CHROME}`)

    await run(['google-chrome'], {}, t.deps)
    expect(t.log).toEqual(['system.status', 'system.simulate', 'system.remove', 'system.status', 'declarations.undeclare'])
  })

  it('reports failure and keeps the declaration when the package survives removal', async () => {
    const t = setup()
    t.system.installed.set(CHROME, '153.0')
    t.declarations.declared.add(`bootstrap.packages.${CHROME}`)
    t.system.removeWorks = false

    const result = await run(['google-chrome'], {}, t.deps)
    expect(result.success).toBe(false)
    expect(result.packages[0]).toMatchObject({status: 'failed'})
    expect(t.declarations.writes).toEqual([])
    expect(t.declarations.declared.has(`bootstrap.packages.${CHROME}`)).toBe(true)
  })

  it('refuses when removal would take dependents with it, and removes nothing', async () => {
    const t = setup()
    t.system.installed.set(CHROME, '153.0')
    t.system.dependents = ['some-plugin']

    const error = await errorOf(run(['google-chrome'], {}, t.deps))
    expect(error.code).toBe('UNINSTALL_WOULD_REMOVE_DEPENDENTS')
    expect(error.message).toContain('some-plugin')
    expect(t.system.removes).toEqual([])
  })

  it('removes a mise tool with unuse and reports it', async () => {
    const t = setup()
    t.tools.installed.set('fastfetch', '2.0')
    t.tools.registry.add('fastfetch')

    const result = await run(['fastfetch'], {}, t.deps)
    expect(result.packages).toEqual([{spec: 'mise:fastfetch', status: 'uninstalled', version: '2.0'}])
    expect(t.tools.removed[0].names).toEqual(['fastfetch'])
  })

  it('refuses a manager it cannot remove, before any I/O', async () => {
    const t = setup()
    const error = await errorOf(run(['brew:antidote'], {}, t.deps))
    expect(error.code).toBe('UNINSTALL_UNAVAILABLE')
    expect(error.message).toContain('antidote')
    expect(t.log).toEqual([])
  })

  it('rejects an empty package list', async () => {
    expect((await errorOf(run([]))).code).toBe('INVALID_PACKAGE_NAME')
  })

  describe('--dry-run', () => {
    it('lists every command in execution order and mutates nothing', async () => {
      const t = setup()
      t.system.installed.set(CHROME, '153.0')
      t.declarations.declared.add(`bootstrap.packages.${CHROME}`)
      t.tools.installed.set('fastfetch', '2.0')
      t.tools.registry.add('fastfetch')
      t.declarations.declared.add('tools.fastfetch')
      t.paths.existing.add(SOURCES).add(PROFILE)
      t.paths.privileged.add(SOURCES)

      const result = await run(['fastfetch', 'google-chrome'], {dryRun: true, purge: true, yes: false}, t.deps)

      expect(result.commands).toEqual([
        'mise unuse -g fastfetch',
        'sudo apt-get purge -y -- google-chrome-stable',
        'undeclare "fastfetch" from [tools]',
        `undeclare "${CHROME}" from [bootstrap.packages]`,
        `sudo rm -rf -- ${SOURCES}`,
        `rm -rf -- ${PROFILE}`,
      ])
      expect(result.packages.every((p) => p.status === 'would-uninstall')).toBe(true)
      expect(t.system.removes).toEqual([])
      expect(t.tools.removed).toEqual([])
      expect(t.declarations.writes).toEqual([])
      expect(t.paths.removed).toEqual([])
    })

    it('needs no confirmation and prints no plan', async () => {
      const t = setup()
      t.system.installed.set(CHROME, '153.0')
      const result = await run(['google-chrome'], {dryRun: true, json: true, yes: false}, t.deps)
      expect(result.success).toBe(true)
      expect(t.plans).toEqual([])
    })
  })

  describe('confirmation', () => {
    it('requires --yes when nobody can read the plan', async () => {
      const t = setup({isTTY: false})
      t.system.installed.set(CHROME, '153.0')
      expect((await errorOf(run(['google-chrome'], {yes: false}, t.deps))).code).toBe('CONFIRMATION_REQUIRED')
      expect(t.system.removes).toEqual([])
    })

    it('requires --yes with --json even on a terminal', async () => {
      const t = setup()
      t.system.installed.set(CHROME, '153.0')
      expect((await errorOf(run(['google-chrome'], {json: true, yes: false}, t.deps))).code).toBe('CONFIRMATION_REQUIRED')
    })

    // --purge deletes files no package manager owns: consent is asked twice.
    it('requires --yes for --purge even on a terminal', async () => {
      const t = setup()
      t.system.installed.set(CHROME, '153.0')
      t.paths.existing.add(PROFILE)
      const error = await errorOf(run(['google-chrome'], {purge: true, yes: false}, t.deps))
      expect(error.code).toBe('CONFIRMATION_REQUIRED')
      expect(error.message).toContain('--purge')
      expect(t.paths.removed).toEqual([])
    })

    it('asks nothing when there is nothing to do', async () => {
      const t = setup({isTTY: false})
      const result = await run(['google-chrome'], {yes: false}, t.deps)
      expect(result.success).toBe(true)
    })

    it('shows the plan before the first removal', async () => {
      const t = setup()
      t.system.installed.set(CHROME, '153.0')
      await run(['google-chrome'], {}, t.deps)
      expect(t.plans).toHaveLength(1)
      expect(t.plans[0].packages).toEqual([{spec: CHROME, status: 'would-uninstall', version: '153.0'}])
    })
  })

  describe('--purge', () => {
    it('deletes the recipe paths that exist and verifies each one', async () => {
      const t = setup()
      t.system.installed.set(CHROME, '153.0')
      t.paths.existing.add(SOURCES).add(PROFILE)
      t.paths.privileged.add(SOURCES)

      const result = await run(['google-chrome'], {purge: true}, t.deps)
      expect(result.paths).toEqual([
        {tool: 'google-chrome', path: SOURCES, status: 'removed', privileged: true},
        {tool: 'google-chrome', path: PROFILE, status: 'removed', privileged: false},
      ])
      expect(t.paths.removed).toEqual([SOURCES, PROFILE])
      expect(t.system.removes[0].opts.purge).toBe(true)
    })

    it('reports a path that survives deletion as failed', async () => {
      const t = setup()
      t.system.installed.set(CHROME, '153.0')
      t.paths.existing.add(PROFILE)
      t.paths.removeLeavesBehind = true

      const result = await run(['google-chrome'], {purge: true}, t.deps)
      expect(result.success).toBe(false)
      expect(result.paths?.find((p) => p.path === PROFILE)).toMatchObject({status: 'failed'})
    })

    it('reports a missing path as already absent without deleting anything', async () => {
      const t = setup()
      t.system.installed.set(CHROME, '153.0')
      const result = await run(['google-chrome'], {purge: true}, t.deps)
      expect(result.paths?.every((p) => p.status === 'already-absent')).toBe(true)
      expect(t.paths.removed).toEqual([])
    })

    it('carries no paths at all without --purge', async () => {
      const t = setup()
      t.system.installed.set(CHROME, '153.0')
      t.paths.existing.add(PROFILE)
      const result = await run(['google-chrome'], {}, t.deps)
      expect(result.paths).toBeUndefined()
      expect(t.paths.removed).toEqual([])
      expect(t.system.removes[0].opts.purge).toBe(false)
    })
  })

  describe('sudo', () => {
    it('checks sudo before removing a system package when non-interactive', async () => {
      const t = setup({sudoReady: async () => false})
      t.system.installed.set(CHROME, '153.0')
      const error = await errorOf(run(['google-chrome'], {nonInteractive: true}, t.deps))
      expect(error.code).toBe('SUDO_PASSWORD_REQUIRED')
      expect(t.system.removes).toEqual([])
    })

    it('skips the sudo check for a tools-only run', async () => {
      const t = setup({sudoReady: async () => false})
      t.tools.installed.set('fastfetch', '2.0')
      t.tools.registry.add('fastfetch')
      const result = await run(['fastfetch'], {nonInteractive: true}, t.deps)
      expect(result.success).toBe(true)
    })
  })

  // dpkg "deinstall ok config-files": gone, but --purge still has conffiles to clear.
  describe('a package removed but not purged', () => {
    it('plans and runs apt-get purge, and the dry-run says so', async () => {
      const t = setup()
      t.system.configFiles.add(CHROME)

      const dry = await run(['google-chrome'], {dryRun: true, purge: true}, t.deps)
      expect(dry.commands).toContain('sudo apt-get purge -y -- google-chrome-stable')

      const real = await run(['google-chrome'], {purge: true}, t.deps)
      expect(t.system.removes[0].opts.purge).toBe(true)
      expect(real.packages[0]).toMatchObject({status: 'uninstalled'})
    })

    it('is left alone without --purge, since remove has nothing to do', async () => {
      const t = setup()
      t.system.configFiles.add(CHROME)
      const result = await run(['google-chrome'], {}, t.deps)
      expect(result.packages).toEqual([{spec: CHROME, status: 'already-absent'}])
      expect(t.system.removes).toEqual([])
    })
  })
})

describe('removing mise', () => {
  it('refuses, because mise is what ops runs on', async () => {
    const error = await errorOf(run(['mise']))
    expect(error.code).toBe('UNINSTALL_WOULD_BREAK_OPS')
    expect(error.message).toContain('--force')
  })

  it('refuses whichever manager owns it', async () => {
    expect((await errorOf(run(['apt:mise']))).code).toBe('UNINSTALL_WOULD_BREAK_OPS')
    expect((await errorOf(run(['mise:mise']))).code).toBe('UNINSTALL_WOULD_BREAK_OPS')
  })

  it('refuses before any I/O, dry run included', async () => {
    // A dry run shows what would happen, and what would happen is a refusal.
    const t = setup()
    expect((await errorOf(run(['mise'], {dryRun: true}, t.deps))).code).toBe('UNINSTALL_WOULD_BREAK_OPS')
    expect(t.log).toEqual([])
  })

  it('goes ahead with --force', async () => {
    const t = setup()
    const result = await run(['mise'], {force: true}, t.deps)
    expect(result.packages[0].spec).toBe('apt:mise')
  })

  it('leaves a package that merely contains "mise" alone', async () => {
    const t = setup()
    await expect(run(['promise'], {}, t.deps)).resolves.toBeTruthy()
  })
})
