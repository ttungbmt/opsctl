import type {MiseDeclarations} from '#providers/mise-config.js'
import type {MiseTools} from '#providers/mise-tools.js'
import type {SystemManager} from '#providers/os.js'
import type {PathRemover} from '#providers/paths.js'
import type {SystemPackages} from '#providers/system.js'
import {OpsError} from '#core/errors.js'
import type {RecipeIndex} from '#core/tool/recipe.js'
import {resolveSpecs} from './resolve.js'
import {MISE} from '#core/preflight.js'
import {type PackageSpec, isToolSpec, managerOf, packageName, toolKey, toolName} from './spec.js'

export type UninstallStatus = 'already-absent' | 'uninstalled' | 'would-uninstall' | 'skipped' | 'failed'
export type PurgeStatus = 'already-absent' | 'removed' | 'would-remove' | 'skipped' | 'failed'

export interface PackageRemoval {
  spec: PackageSpec
  status: UninstallStatus
  /** The version that was there before removal, when there was one. */
  version?: string
  /** True when a [bootstrap.packages] or [tools] entry was deleted. */
  undeclared?: boolean
  error?: string
}

export interface PathRemoval {
  tool: string
  path: string
  status: PurgeStatus
  privileged: boolean
  error?: string
}

export interface UninstallResult {
  success: boolean
  action: 'uninstall'
  dryRun: boolean
  purge: boolean
  /** Distinct manager prefixes of the requested specs, e.g. ["mise", "apt"]. */
  managers: string[]
  /** Dry run only: every command that would run, in order. */
  commands?: string[]
  packages: PackageRemoval[]
  /** Present only with --purge. */
  paths?: PathRemoval[]
}

export interface UninstallOptions {
  packages: string[]
  /** Remove even what ops depends on. */
  force: boolean
  purge: boolean
  yes: boolean
  nonInteractive: boolean
  dryRun: boolean
  json: boolean
}

export interface UninstallPlan {
  packages: PackageRemoval[]
  paths: PathRemoval[]
}

export interface UninstallDeps {
  /** apt/dnf, probed through dpkg/rpm. */
  system: SystemPackages
  /** mise tools (`mise unuse -g`). */
  tools: MiseTools
  /** The [bootstrap.packages] / [tools] entries ops wrote at install time. */
  declarations: MiseDeclarations
  paths: PathRemover
  detectManager: () => Promise<SystemManager>
  isTTY: boolean
  sudoReady: () => Promise<boolean>
  systemPreferred: ReadonlySet<string>
  recipes: RecipeIndex
  /** Called with the plan before the first removal; never under --dry-run. */
  onPlan: (plan: UninstallPlan) => void
}

/** The only managers ops removes itself. Anything else is the user's own tool. */
const REMOVABLE = new Set(['apt', 'dnf'])
const PRIVILEGED_MANAGERS = new Set(['apt', 'dnf'])

type State = {installed: boolean; version?: string; declared: boolean; configFiles?: boolean}

export async function uninstallPackages(options: UninstallOptions, deps: UninstallDeps): Promise<UninstallResult> {
  if (options.packages.length === 0) throw new OpsError('INVALID_PACKAGE_NAME', 'No tools given')

  const specs = await resolveSpecs(options.packages, {
    detectManager: deps.detectManager,
    inRegistry: (name) => deps.tools.inRegistry(name),
    recipe: deps.recipes.byName,
    systemPreferred: deps.systemPreferred,
  })

  // Refuse before any I/O: half-removing a brew package is worse than saying no.
  for (const spec of specs) {
    const manager = managerOf(spec)
    // Whichever manager owns it, mise is what ops drives; without it ops cannot install,
    // uninstall or bootstrap anything again.
    if (!options.force && packageName(spec) === MISE) {
      throw new OpsError(
        'UNINSTALL_WOULD_BREAK_OPS',
        `"${spec}" is what ops runs on; removing it would leave ops unable to run. Re-run with --force if you mean it.`,
      )
    }

    if (!isToolSpec(spec) && !REMOVABLE.has(manager)) {
      throw new OpsError(
        'UNINSTALL_UNAVAILABLE',
        `ops cannot remove ${manager} packages; remove "${toolName(spec)}" with ${manager} directly`,
      )
    }
  }

  const tools = specs.filter(isToolSpec)
  const system = specs.filter((spec) => !isToolSpec(spec))
  const managers = [...new Set(specs.map(managerOf))]

  // Inspect everything before changing anything, so the plan is known up front.
  const state = new Map<PackageSpec, State>()
  for (const spec of tools) {
    const installed = (await deps.tools.status()).find((t) => t.name === toolKey(spec))
    state.set(spec, {
      declared: await deps.declarations.isDeclared('tools', toolKey(spec)),
      installed: installed?.installed ?? false,
      ...(installed?.version ? {version: installed.version} : {}),
    })
  }

  if (system.length > 0) {
    for (const s of await deps.system.status(system)) {
      state.set(s.spec, {
        declared: await deps.declarations.isDeclared('bootstrap.packages', s.spec),
        installed: s.installed,
        ...(s.configFiles ? {configFiles: true} : {}),
        ...(s.version ? {version: s.version} : {}),
      })
    }
  }

  const purgePaths = options.purge ? await plannedPaths(options.packages, deps) : []
  const packages = specs.map((spec) => planned(spec, state.get(spec)!, options))
  const pendingPackages = specs.filter((spec) => needsWork(state.get(spec)!, options))
  const pendingPaths = purgePaths.filter((p) => p.status === 'would-remove')

  const base = {
    action: 'uninstall' as const,
    dryRun: options.dryRun,
    managers,
    purge: options.purge,
    ...(options.purge ? {paths: purgePaths} : {}),
  }

  if (options.dryRun) {
    return {...base, commands: describe(tools, system, specs, state, purgePaths, options, deps), packages, success: true}
  }

  const autoYes = options.yes || options.nonInteractive
  const pending = pendingPackages.length + pendingPaths.length
  if (pending > 0 && !autoYes && (options.json || !deps.isTTY)) {
    throw new OpsError('CONFIRMATION_REQUIRED', 'Confirmation required: re-run with --yes (or --non-interactive)')
  }

  // --purge deletes files no package manager owns, so it asks a second time even
  // on a terminal. There is no prompt primitive in the CLI yet; --yes is the consent.
  if (options.purge && pending > 0 && !autoYes) {
    throw new OpsError(
      'CONFIRMATION_REQUIRED',
      '--purge deletes files outside the package manager; re-run with --yes (or --non-interactive)',
    )
  }

  if (pending > 0) deps.onPlan({packages: packages.filter((p) => p.status === 'would-uninstall'), paths: pendingPaths})

  const results = new Map<PackageSpec, PackageRemoval>()
  for (const r of await removeTools(tools, state, options, deps)) results.set(r.spec, r)
  for (const r of await removeSystem(system, state, options, deps)) results.set(r.spec, r)

  const paths = options.purge ? await purge(purgePaths, options, deps) : undefined
  const done = specs.map((spec) => results.get(spec)!)

  return {
    ...base,
    packages: done,
    ...(paths ? {paths} : {}),
    success: done.every((p) => p.status !== 'failed') && (paths ?? []).every((p) => p.status !== 'failed'),
  }
}

/** Installed, declared, or still holding conffiles that --purge would clear. */
function needsWork(state: State, options: UninstallOptions): boolean {
  return state.installed || state.declared || (options.purge && state.configFiles === true)
}

/**
 * Whether the package manager itself has work: installed, or removed but still
 * holding its conffiles, which only `apt-get purge` clears. Shared so the dry-run
 * plan and the real run can never disagree about what apt will be asked to do.
 */
function needsPackageRemoval(state: State): boolean {
  return state.installed || state.configFiles === true
}

function planned(spec: PackageSpec, state: State, options: UninstallOptions): PackageRemoval {
  if (!needsWork(state, options)) return {spec, status: 'already-absent'}
  return {spec, status: 'would-uninstall', ...(state.version ? {version: state.version} : {})}
}

async function plannedPaths(names: string[], deps: UninstallDeps): Promise<PathRemoval[]> {
  const out: PathRemoval[] = []
  for (const tool of [...new Set(names)]) {
    for (const path of deps.recipes.purgeFor(tool) ?? []) {
      const state = await deps.paths.stat(path)
      out.push({
        path,
        privileged: state.privileged,
        status: state.exists ? 'would-remove' : 'already-absent',
        tool,
      })
    }
  }

  return out
}

function describe(
  tools: PackageSpec[],
  system: PackageSpec[],
  specs: PackageSpec[],
  state: Map<PackageSpec, State>,
  paths: PathRemoval[],
  options: UninstallOptions,
  deps: UninstallDeps,
): string[] {
  const live = (list: PackageSpec[]) => list.filter((spec) => needsWork(state.get(spec)!, options))
  const liveTools = live(tools)
  const toRemove = live(system).filter((spec) => needsPackageRemoval(state.get(spec)!))
  return [
    ...(liveTools.length > 0 ? deps.tools.describeRemove(liveTools.map(toolKey)) : []),
    ...(toRemove.length > 0 ? deps.system.describe(toRemove, {purge: options.purge}) : []),
    ...specs
      .filter((spec) => state.get(spec)!.declared)
      .map((spec) => deps.declarations.describe(isToolSpec(spec) ? 'tools' : 'bootstrap.packages', isToolSpec(spec) ? toolKey(spec) : spec)),
    ...paths.filter((p) => p.status === 'would-remove').map((p) => deps.paths.describe(p.path, p.privileged)),
  ]
}

async function removeTools(
  specs: PackageSpec[],
  state: Map<PackageSpec, State>,
  options: UninstallOptions,
  deps: UninstallDeps,
): Promise<PackageRemoval[]> {
  const pending = specs.filter((spec) => needsWork(state.get(spec)!, options))
  if (pending.length > 0) {
    await deps.tools.remove(pending.map(toolKey), {capture: options.json, nonInteractive: options.nonInteractive})
  }

  const after = new Map((await statusOrEmpty(pending, deps)).map((t) => [t.name, t]))
  const out: PackageRemoval[] = []
  for (const spec of specs) {
    const before = state.get(spec)!
    if (!needsWork(before, options)) {
      out.push({spec, status: 'already-absent'})
      continue
    }

    if (after.get(toolKey(spec))?.installed) {
      out.push({spec, status: 'failed', error: `"${toolKey(spec)}" is still installed after mise unuse`})
      continue
    }

    // mise unuse edits [tools] itself; only clean up if it somehow did not.
    const undeclared = await deps.declarations.undeclare('tools', toolKey(spec))
    out.push({spec, status: 'uninstalled', ...(before.version ? {version: before.version} : {}), ...(undeclared ? {undeclared} : {})})
  }

  return out
}

async function statusOrEmpty(pending: PackageSpec[], deps: UninstallDeps) {
  return pending.length > 0 ? deps.tools.status() : []
}

async function removeSystem(
  specs: PackageSpec[],
  state: Map<PackageSpec, State>,
  options: UninstallOptions,
  deps: UninstallDeps,
): Promise<PackageRemoval[]> {
  const pending = specs.filter((spec) => needsWork(state.get(spec)!, options))
  const toRemove = pending.filter((spec) => needsPackageRemoval(state.get(spec)!))

  if (toRemove.length > 0) {
    const needsRoot = toRemove.some((spec) => PRIVILEGED_MANAGERS.has(managerOf(spec)))
    if (options.nonInteractive && needsRoot && !(await deps.sudoReady())) {
      throw new OpsError('SUDO_PASSWORD_REQUIRED', 'sudo needs a password; run without --non-interactive or configure passwordless sudo')
    }

    // apt does not refuse to take dependents with it -- it just reports them.
    const requested = new Set(toRemove.map((spec) => toolName(spec)))
    const {removes} = await deps.system.simulate(toRemove, {purge: options.purge})
    const extra = removes.filter((name) => !requested.has(name))
    if (extra.length > 0) {
      throw new OpsError(
        'UNINSTALL_WOULD_REMOVE_DEPENDENTS',
        `Removing ${[...requested].join(', ')} would also remove ${extra.join(', ')}; nothing was removed`,
      )
    }

    await deps.system.remove(toRemove, {capture: options.json, nonInteractive: options.nonInteractive, purge: options.purge})
  }

  const after = new Map((toRemove.length > 0 ? await deps.system.status(toRemove) : []).map((s) => [s.spec, s]))
  const out: PackageRemoval[] = []
  for (const spec of specs) {
    const before = state.get(spec)!
    if (!needsWork(before, options)) {
      out.push({spec, status: 'already-absent'})
      continue
    }

    if (after.get(spec)?.installed) {
      out.push({spec, status: 'failed', error: `"${toolName(spec)}" is still installed after removal`})
      continue
    }

    // Last: a failed removal must leave the declaration intact, so a later
    // `ops bootstrap` restores a working state instead of a half-removed one.
    const undeclared = await deps.declarations.undeclare('bootstrap.packages', spec)
    out.push({spec, status: 'uninstalled', ...(before.version ? {version: before.version} : {}), ...(undeclared ? {undeclared} : {})})
  }

  return out
}

async function purge(planned: PathRemoval[], options: UninstallOptions, deps: UninstallDeps): Promise<PathRemoval[]> {
  const out: PathRemoval[] = []
  for (const entry of planned) {
    if (entry.status !== 'would-remove') {
      out.push({...entry, status: 'already-absent'})
      continue
    }

    try {
      await deps.paths.remove(entry.path, {nonInteractive: options.nonInteractive, privileged: entry.privileged})
    } catch (error) {
      out.push({...entry, error: (error as Error).message, status: 'failed'})
      continue
    }

    // Verify: the path the plan named must actually be gone.
    const after = await deps.paths.stat(entry.path)
    out.push(after.exists ? {...entry, error: `${entry.path} still exists`, status: 'failed'} : {...entry, status: 'removed'})
  }

  return out
}
