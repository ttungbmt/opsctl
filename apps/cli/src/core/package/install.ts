import type {AptRepoProvider} from '../../providers/apt-repo.js'
import type {DebInstaller, OnProgress} from '../../providers/deb.js'
import type {MiseBootstrap, PackageState} from '../../providers/mise-bootstrap.js'
import type {MiseTools} from '../../providers/mise-tools.js'
import type {SystemManager} from '../../providers/os.js'
import {OpsError} from '../errors.js'
import type {AptRepo} from '../repo.js'
import type {Stage} from '../stage.js'
import type {PrepareStep, RecipeIndex} from '../tool/recipe.js'
import {resolveSpecs} from './resolve.js'
import {type PackageSpec, isToolSpec, managerOf, packageName, toolKey, toolName} from './spec.js'

export type PackageStatus = 'already-installed' | 'installed' | 'would-install' | 'failed'

export interface InstallResult {
  success: boolean
  action: 'install'
  /** Distinct manager prefixes of the requested specs, e.g. ["mise", "apt"]. */
  managers: string[]
  dryRun: boolean
  /** Dry run only: what mise would do. */
  commands?: string[]
  packages: {spec: PackageSpec; status: PackageStatus; version?: string; error?: string}[]
}

export interface InstallOptions {
  packages: string[]
  yes: boolean
  /** Reinstall through a recipe's repo even when a build from somewhere else is installed. */
  force: boolean
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
  /** Named recipes (`tool.<name>` in the config). */
  recipes: RecipeIndex
  /** Installs a .deb from a URL, for specs whose recipe has a prepare step. */
  deb: DebInstaller
  /** Configures a third-party apt repo, for specs whose recipe names one. */
  repos: AptRepoProvider
  /** Shown while a .deb downloads; omitted when nobody is watching (--json, no TTY). */
  onProgress?: OnProgress
  /** Called as each .deb stage begins; deb.ts knows the stage, this layer adds the spec. */
  onStage?: (stage: Stage, subject: string) => void
  /** Capture subprocess output instead of streaming it, when a spinner owns the terminal. */
  captureOutput?: boolean
}

type Installed = Map<PackageSpec, {installed: boolean; version?: string}>
type PackageResult = InstallResult['packages'][number]

const PRIVILEGED_MANAGERS = new Set(['apt', 'dnf'])

export async function installPackages(options: InstallOptions, deps: InstallDeps): Promise<InstallResult> {
  if (options.packages.length === 0) throw new OpsError('INVALID_PACKAGE_NAME', 'No tools given')

  const specs = await resolveSpecs(options.packages, {
    detectManager: deps.detectManager,
    inRegistry: (name) => deps.tools.inRegistry(name),
    recipe: deps.recipes.byName,
    systemPreferred: deps.systemPreferred,
  })
  const tools = specs.filter(isToolSpec)
  const system = specs.filter((spec) => !isToolSpec(spec))
  const managers = [...new Set(specs.map(managerOf))]
  const base = {action: 'install' as const, dryRun: options.dryRun, managers}

  if (options.dryRun) {
    // A prepared spec never reaches mise.apply, so asking mise to describe it would
    // print an apt command that will not run. Describe each path separately.
    const prepared: {spec: PackageSpec; step: PrepareStep}[] = []
    const viaRepo: {spec: PackageSpec; repo: AptRepo}[] = []
    const plain: PackageSpec[] = []
    for (const spec of system) {
      const step = deps.recipes.prepareFor(spec)
      if (step) {
        prepared.push({spec, step})
        continue
      }

      // A repo only makes the package reachable; mise still installs it, so it stays in `plain`.
      const repo = deps.recipes.repoFor(spec)
      if (repo) viaRepo.push({repo, spec})
      plain.push(spec)
    }

    const commands = [
      ...(tools.length > 0 ? await deps.tools.dryRun(tools.map(toolName)) : []),
      ...prepared.flatMap(({spec, step}) => [...deps.deb.describe(step.deb), `declare "${spec}" in [bootstrap.packages]`]),
      ...viaRepo.flatMap(({repo, spec}) => deps.repos.describe(repo, packageName(spec))),
      ...(plain.length > 0 ? await deps.mise.dryRun(plain) : []),
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
    // `mise use` writes straight to the terminal, so any spinner has to stand down first.
    deps.onStage?.('streaming', missing.join(' '))
    await deps.tools.install(missing.map(toolName), {capture: options.json, nonInteractive: options.nonInteractive})
    after = await toolState(deps, specs)
  }

  return outcomes(specs, before, after)
}

async function installSystem(specs: PackageSpec[], options: InstallOptions, deps: InstallDeps): Promise<PackageResult[]> {
  await deps.mise.declare(specs)
  const before = systemState(await deps.mise.status())

  // A repo-backed spec cannot be judged by "is it installed": the distro may ship a package
  // of the same name that installs something else entirely. Ask apt where it would come from.
  const mismatched = new Map<PackageSpec, string>()
  const reinstall: PackageSpec[] = []
  for (const spec of specs) {
    const repo = deps.recipes.repoFor(spec)
    if (!repo) continue
    // A repo is deb822 files under /etc/apt; there is no dnf equivalent yet.
    if (managerOf(spec) !== 'apt') {
      throw new OpsError(
        'UNSUPPORTED_PLATFORM',
        `repo.${repo.name} can only configure apt, but "${spec}" is a ${managerOf(spec)} package`,
      )
    }

    if (!before.get(spec)?.installed) continue

    const check = await deps.repos.verify(repo, packageName(spec))
    if (check.ok) continue
    if (options.force) reinstall.push(spec)
    else {
      mismatched.set(
        spec,
        `installed ${before.get(spec)?.version ?? 'version'} is not from ${repo.pin?.origin ?? repo.name}; re-run with --force to switch`,
      )
    }
  }

  const missing = [...specs.filter((spec) => !before.get(spec)?.installed), ...reinstall]

  let after = before
  if (missing.length > 0) {
    const needsRoot = missing.some((spec) => PRIVILEGED_MANAGERS.has(managerOf(spec)))
    if (options.nonInteractive && needsRoot && !(await deps.sudoReady())) {
      throw new OpsError('SUDO_PASSWORD_REQUIRED', 'sudo needs a password; run without --non-interactive or configure passwordless sudo')
    }

    // A prepared package is not in any configured repo yet, so apt cannot install it;
    // its .deb carries the repo. Only what is left goes through mise.
    const rest: PackageSpec[] = []
    for (const spec of missing) {
      const step = deps.recipes.prepareFor(spec)
      if (step) {
        await deps.deb.installFromUrl(step.deb, {
          capture: options.json || deps.captureOutput === true,
          nonInteractive: options.nonInteractive,
          onProgress: deps.onProgress,
          onStage: (stage) => deps.onStage?.(stage, spec),
        })
      } else {
        // A repo is the other way round from prepare: ops configures it and apt installs,
        // so the spec continues to mise.
        const repo = deps.recipes.repoFor(spec)
        if (repo) {
          await deps.repos.ensure(repo, packageName(spec), {
            capture: options.json || deps.captureOutput === true,
            nonInteractive: options.nonInteractive,
            onStage: (stage) => deps.onStage?.(stage, `repo.${repo.name}`),
          })
        }

        rest.push(spec)
      }
    }

    if (rest.length > 0) {
      const yes = options.yes || options.nonInteractive
      // apt streams its own progress through mise; the spinner must release the row first.
      deps.onStage?.('streaming', rest.join(' '))
      await deps.mise.apply(rest, {capture: options.json, nonInteractive: options.nonInteractive, yes})
    }

    after = systemState(await deps.mise.status())
  }

  return outcomes(specs, before, after, mismatched)
}

function outcomes(
  specs: PackageSpec[],
  before: Installed,
  after: Installed,
  mismatched: Map<PackageSpec, string> = new Map(),
): PackageResult[] {
  return specs.map((spec) => {
    const error = mismatched.get(spec)
    if (error !== undefined) return {error, spec, status: 'failed', version: before.get(spec)?.version}
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
