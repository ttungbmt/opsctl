import {CommandNotFoundError, OpsError} from '../core/errors.js'
import {type PackageSpec, toolName} from '../core/package/spec.js'
import type {Runner} from '../executor/exec.js'
import type {SystemManager} from './os.js'

export interface SystemPackageState {
  spec: PackageSpec
  installed: boolean
  version?: string
  /** dpkg "deinstall ok config-files": removed but not purged, so --purge still has work. */
  configFiles?: boolean
}

export interface RemoveOptions {
  purge: boolean
  nonInteractive: boolean
  /** Capture output instead of streaming it (used with --json). */
  capture: boolean
}

export interface SystemPackages {
  /** Probes dpkg/rpm, not the declaration: removal must be verifiable after undeclaring. */
  status(specs: PackageSpec[]): Promise<SystemPackageState[]>
  /** What the real run would take with it. Empty means "no opinion". */
  simulate(specs: PackageSpec[], opts: {purge: boolean}): Promise<{removes: string[]}>
  remove(specs: PackageSpec[], opts: RemoveOptions): Promise<{exitCode: number}>
  describe(specs: PackageSpec[], opts: {purge: boolean}): string[]
}

const REMOVED = /^The following packages will be REMOVED:$/

/** apt wraps the list over indented continuation lines and marks purges with "*". */
function removedNames(stdout: string): string[] {
  const lines = stdout.split('\n')
  const start = lines.findIndex((line) => REMOVED.test(line.trim()))
  if (start === -1) return []

  const names: string[] = []
  for (const line of lines.slice(start + 1)) {
    if (!/^\s/.test(line) || line.trim() === '') break
    names.push(...line.trim().split(/\s+/).map((name) => name.replace(/\*$/, '')))
  }

  return names.filter(Boolean)
}

export function createSystemPackages(runner: Runner, manager: SystemManager): SystemPackages {
  const names = (specs: PackageSpec[]) => specs.map((spec) => toolName(spec))

  async function run(cmd: string, args: string[], opts?: Parameters<Runner['run']>[2]) {
    try {
      return await runner.run(cmd, args, opts)
    } catch (error) {
      if (error instanceof CommandNotFoundError) {
        throw new OpsError('UNINSTALL_UNAVAILABLE', `${error.command} not found on PATH; ops cannot remove ${manager} packages here`)
      }

      throw error
    }
  }

  async function aptStatus(spec: PackageSpec): Promise<SystemPackageState> {
    const result = await run('dpkg-query', ['-W', '-f=${Status}|${Version}\n', toolName(spec)], {stdin: 'ignore'})
    if (result.exitCode !== 0) return {installed: false, spec}

    const [status, version] = result.stdout.trim().split('|')
    const state = status?.split(/\s+/)[2]
    if (state === 'installed') return {installed: true, spec, ...(version ? {version} : {})}
    // Removed but still holding its conffiles: absent, yet --purge has something to do.
    if (state === 'config-files') return {configFiles: true, installed: false, spec, ...(version ? {version} : {})}
    return {installed: false, spec}
  }

  async function rpmStatus(spec: PackageSpec): Promise<SystemPackageState> {
    const result = await run('rpm', ['-q', '--qf', '%{VERSION}-%{RELEASE}\n', toolName(spec)], {stdin: 'ignore'})
    if (result.exitCode !== 0) return {installed: false, spec}
    const version = result.stdout.trim()
    return {installed: true, spec, ...(version ? {version} : {})}
  }

  const verb = (purge: boolean) => (manager === 'apt' && purge ? 'purge' : 'remove')
  const argv = (specs: PackageSpec[], purge: boolean) =>
    manager === 'apt'
      ? ['apt-get', verb(purge), '-y', '--', ...names(specs)]
      : ['dnf', 'remove', '-y', '--', ...names(specs)]

  return {
    describe: (specs, {purge}) => [`sudo ${argv(specs, purge).join(' ')}`],

    async remove(specs, opts) {
      const result = await run('sudo', argv(specs, opts.purge), {
        stdin: opts.nonInteractive ? 'ignore' : 'inherit',
        stdout: opts.capture ? 'capture' : 'inherit',
      })
      return {exitCode: result.exitCode}
    },

    async simulate(specs, {purge}) {
      // dnf's simulate output is not worth parsing; no opinion beats a wrong one.
      if (manager !== 'apt') return {removes: []}

      // -s needs no root, so this can always run before the destructive command.
      const result = await run('apt-get', ['-s', verb(purge), '--', ...names(specs)], {stdin: 'ignore'})
      return {removes: removedNames(result.stdout)}
    },

    async status(specs) {
      const probe = manager === 'apt' ? aptStatus : rpmStatus
      const states: SystemPackageState[] = []
      for (const spec of specs) states.push(await probe(spec))
      return states
    },
  }
}
