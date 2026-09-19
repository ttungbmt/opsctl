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
    const state = bySpec(await deps.mise.status())
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
  const before = bySpec(await deps.mise.status())
  const missing = specs.filter((spec) => !before.get(spec)?.installed)

  let after = before
  if (missing.length > 0) {
    const needsRoot = missing.some((spec) => PRIVILEGED_MANAGERS.has(managerOf(spec)))
    if (options.nonInteractive && needsRoot && !(await deps.sudoReady())) {
      throw new OpsError('SUDO_PASSWORD_REQUIRED', 'sudo needs a password; run without --non-interactive or configure passwordless sudo')
    }

    await deps.mise.apply(missing, {capture: options.json, nonInteractive: options.nonInteractive, yes: autoYes})
    after = bySpec(await deps.mise.status())
  }

  const packages = specs.map((spec): InstallResult['packages'][number] => {
    if (before.get(spec)?.installed) return {spec, status: 'already-installed', version: before.get(spec)?.version}
    if (after.get(spec)?.installed) return {spec, status: 'installed', version: after.get(spec)?.version}
    return {spec, status: 'failed'}
  })

  return {...base, packages, success: packages.every((p) => p.status !== 'failed')}
}

function bySpec(states: PackageState[]): Map<string, PackageState> {
  return new Map(states.map((s) => [s.spec, s]))
}
