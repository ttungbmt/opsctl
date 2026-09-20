import type {MiseBootstrap, PackageState} from '../../providers/mise-bootstrap.js'
import type {MiseTools} from '../../providers/mise-tools.js'
import type {SystemManager} from '../../providers/os.js'
import {OpsError} from '../errors.js'
import {resolveSpecs} from './resolve.js'
import {type PackageSpec, isToolSpec, managerOf, toolKey, toolName} from './spec.js'

export type PackageStatus = 'already-installed' | 'installed' | 'would-install' | 'failed'

export interface InstallResult {
  success: boolean
  action: 'install'
  /** Distinct manager prefixes of the requested specs, e.g. ["mise", "apt"]. */
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
  /** System packages (`mise bootstrap packages`). */
  mise: MiseBootstrap
  /** mise tools (`mise use -g`). */
  tools: MiseTools
  detectManager: () => Promise<SystemManager>
  isTTY: boolean
  /** True when privileged commands can run without a password prompt. */
  sudoReady: () => Promise<boolean>
  /** Plain names installed with apt/dnf even when the mise registry has them. */
  systemPreferred: ReadonlySet<string>
}

type Installed = Map<PackageSpec, {installed: boolean; version?: string}>
type PackageResult = InstallResult['packages'][number]

const PRIVILEGED_MANAGERS = new Set(['apt', 'dnf'])

export async function installPackages(options: InstallOptions, deps: InstallDeps): Promise<InstallResult> {
  if (options.packages.length === 0) throw new OpsError('INVALID_PACKAGE_NAME', 'No tools given')

  const specs = await resolveSpecs(options.packages, {
    detectManager: deps.detectManager,
    inRegistry: (name) => deps.tools.inRegistry(name),
    systemPreferred: deps.systemPreferred,
  })
  const tools = specs.filter(isToolSpec)
  const system = specs.filter((spec) => !isToolSpec(spec))
  const managers = [...new Set(specs.map(managerOf))]
  const base = {action: 'install' as const, dryRun: options.dryRun, managers}

  if (options.dryRun) {
    const commands = [
      ...(tools.length > 0 ? await deps.tools.dryRun(tools.map(toolName)) : []),
      ...(system.length > 0 ? await deps.mise.dryRun(system) : []),
    ]
    const state = new Map([
      ...(tools.length > 0 ? await toolState(deps, tools) : []),
      ...(system.length > 0 ? systemState(await deps.mise.status()) : []),
    ])
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

  // Only `mise bootstrap packages apply` prompts; `mise use` does not.
  const autoYes = options.yes || options.nonInteractive
  if (system.length > 0 && !autoYes && (options.json || !deps.isTTY)) {
    throw new OpsError('CONFIRMATION_REQUIRED', 'Confirmation required: re-run with --yes (or --non-interactive)')
  }

  const results = new Map<PackageSpec, PackageResult>()
  if (tools.length > 0) for (const r of await installTools(tools, options, deps)) results.set(r.spec, r)
  if (system.length > 0) for (const r of await installSystem(system, options, deps)) results.set(r.spec, r)

  const packages = specs.map((spec) => results.get(spec)!)
  return {...base, packages, success: packages.every((p) => p.status !== 'failed')}
}

async function installTools(specs: PackageSpec[], options: InstallOptions, deps: InstallDeps): Promise<PackageResult[]> {
  const before = await toolState(deps, specs)
  const missing = specs.filter((spec) => !before.get(spec)?.installed)

  let after = before
  if (missing.length > 0) {
    await deps.tools.install(missing.map(toolName), {capture: options.json, nonInteractive: options.nonInteractive})
    after = await toolState(deps, specs)
  }

  return outcomes(specs, before, after)
}

async function installSystem(specs: PackageSpec[], options: InstallOptions, deps: InstallDeps): Promise<PackageResult[]> {
  await deps.mise.declare(specs)
  const before = systemState(await deps.mise.status())
  const missing = specs.filter((spec) => !before.get(spec)?.installed)

  let after = before
  if (missing.length > 0) {
    const needsRoot = missing.some((spec) => PRIVILEGED_MANAGERS.has(managerOf(spec)))
    if (options.nonInteractive && needsRoot && !(await deps.sudoReady())) {
      throw new OpsError('SUDO_PASSWORD_REQUIRED', 'sudo needs a password; run without --non-interactive or configure passwordless sudo')
    }

    const yes = options.yes || options.nonInteractive
    await deps.mise.apply(missing, {capture: options.json, nonInteractive: options.nonInteractive, yes})
    after = systemState(await deps.mise.status())
  }

  return outcomes(specs, before, after)
}

function outcomes(specs: PackageSpec[], before: Installed, after: Installed): PackageResult[] {
  return specs.map((spec) => {
    if (before.get(spec)?.installed) return {spec, status: 'already-installed', version: before.get(spec)?.version}
    if (after.get(spec)?.installed) return {spec, status: 'installed', version: after.get(spec)?.version}
    return {spec, status: 'failed'}
  })
}

function systemState(states: PackageState[]): Installed {
  return new Map(states.map((s) => [s.spec, s]))
}

async function toolState(deps: InstallDeps, specs: PackageSpec[]): Promise<Installed> {
  const byName = new Map((await deps.tools.status()).map((t) => [t.name, t]))
  return new Map(specs.map((spec) => [spec, byName.get(toolKey(spec)) ?? {installed: false}]))
}
