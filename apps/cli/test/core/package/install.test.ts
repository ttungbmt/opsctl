import {describe, expect, it} from 'vitest'
import {OpsError} from '../../../src/core/errors.js'
import {type InstallDeps, type InstallOptions, installPackages} from '../../../src/core/package/install.js'
import type {PackageSpec} from '../../../src/core/package/spec.js'
import type {ApplyOptions, MiseBootstrap, PackageState} from '../../../src/providers/mise-bootstrap.js'
import type {InstallToolOptions, MiseTools, ToolState} from '../../../src/providers/mise-tools.js'

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

class FakeTools implements MiseTools {
  calls: string[] = []
  installs: {names: string[]; opts: InstallToolOptions}[] = []
  registry = new Set<string>()
  installed = new Map<string, string>() // tool name -> version
  installOnUse = true

  async inRegistry(name: string) {
    return this.registry.has(name)
  }

  async status(): Promise<ToolState[]> {
    this.calls.push('status')
    return [...this.installed].map(([name, version]) => ({installed: true, name, version}))
  }

  async install(names: string[], opts: InstallToolOptions) {
    this.calls.push('install')
    this.installs.push({names, opts})
    if (this.installOnUse) for (const n of names) this.installed.set(n.replace(/@.*/, ''), '2.0')
    return {exitCode: this.installOnUse ? 0 : 1}
  }

  async dryRun(names: string[]) {
    this.calls.push('dryRun')
    return names.map((n) => `would use ${n}`)
  }
}

function setup(overrides: Partial<InstallDeps> = {}) {
  const mise = new FakeMise()
  const tools = new FakeTools()
  const deps: InstallDeps = {
    detectManager: async () => 'apt',
    isTTY: true,
    mise,
    sudoReady: async () => true,
    systemPreferred: new Set(['zsh']),
    tools,
    ...overrides,
  }
  return {deps, mise, tools}
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

  it('installs registry tools with mise use and system-preferred names with the OS manager', async () => {
    const {deps, mise, tools} = setup()
    tools.registry.add('fastfetch').add('zsh')
    const result = await installPackages(opts({packages: ['fastfetch', 'zsh'], yes: true}), deps)
    expect(tools.installs).toEqual([{names: ['fastfetch'], opts: {capture: false, nonInteractive: false}}])
    expect(mise.applied.map((a) => a.specs)).toEqual([['apt:zsh']])
    expect(result).toMatchObject({managers: ['mise', 'apt'], success: true})
    expect(result.packages).toEqual([
      {spec: 'mise:fastfetch', status: 'installed', version: '2.0'},
      {spec: 'apt:zsh', status: 'installed', version: '1.0'},
    ])
  })

  it('skips mise use for installed tools and keeps the version suffix out of the lookup', async () => {
    const {deps, mise, tools} = setup()
    tools.installed.set('jq', '1.8')
    const result = await installPackages(opts({packages: ['mise:jq@1'], yes: true}), deps)
    expect(tools.calls).toEqual(['status'])
    expect(mise.calls).toEqual([])
    expect(result.packages).toEqual([{spec: 'mise:jq@1', status: 'already-installed', version: '1.8'}])
  })

  it('marks tools still missing after mise use as failed', async () => {
    const {deps, tools} = setup()
    tools.registry.add('fastfetch')
    tools.installOnUse = false
    const result = await installPackages(opts({packages: ['fastfetch'], yes: true}), deps)
    expect(result.packages).toEqual([{spec: 'mise:fastfetch', status: 'failed'}])
    expect(result.success).toBe(false)
  })

  it('needs no confirmation or OS detection for tools only', async () => {
    const {deps, tools} = setup({
      detectManager: async () => {
        throw new OpsError('UNSUPPORTED_PLATFORM', 'nope')
      },
      isTTY: false,
    })
    tools.registry.add('fastfetch')
    const result = await installPackages(opts({json: true, packages: ['fastfetch']}), deps)
    expect(result.success).toBe(true)
    expect(tools.installs[0].opts).toEqual({capture: true, nonInteractive: false})
  })

  it('dry-run plans tools and system packages without writing', async () => {
    const {deps, mise, tools} = setup()
    tools.registry.add('fastfetch')
    const result = await installPackages(opts({dryRun: true, packages: ['fastfetch', 'sl']}), deps)
    expect(tools.calls).toEqual(['dryRun', 'status'])
    expect(mise.calls).toEqual(['dryRun', 'status'])
    expect(result.commands).toEqual(['would use fastfetch', 'would install apt:sl'])
    expect(result.packages.map((p) => p.status)).toEqual(['would-install', 'would-install'])
  })
})
