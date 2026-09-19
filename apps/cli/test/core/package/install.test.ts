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
