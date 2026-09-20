import {CommandNotFoundError, OpsError} from '../errors.js'
import type {RecipeIndex, SetupStep} from './recipe.js'
import type {RunOptions, Runner} from '../../executor/exec.js'

export type SetupStatus = 'already-configured' | 'configured' | 'would-configure' | 'skipped' | 'failed'

export interface SetupStepResult {
  tool: string
  /** SetupStep.name. */
  step: string
  status: SetupStatus
  /** The command that would run, joined for display; set while a step is still pending. */
  command?: string
  error?: string
}

export interface SetupResult {
  success: boolean
  action: 'setup'
  dryRun: boolean
  /** The requested tool names, deduplicated, in the order given. */
  tools: string[]
  steps: SetupStepResult[]
}

export interface SetupOptions {
  tools: string[]
  yes: boolean
  nonInteractive: boolean
  dryRun: boolean
  json: boolean
}

export interface SetupDeps {
  /** Named recipes (`tool.<name>` in the config). */
  recipes: RecipeIndex
  runner: Runner
  /** True when a human can read the plan. */
  isTTY: boolean
  /** Called with the pending steps before the first one runs; never under --dry-run. */
  onPlan: (pending: SetupStepResult[]) => void
  /**
   * Tools something else in this run is about to install. A binary missing at probe time
   * is then pending, not an error: `ops bootstrap` plans the setup section before the
   * packages section has installed anything, and on a fresh machine nothing exists yet.
   */
  assumeInstalled?: ReadonlySet<string>
}

// A tool name must be non-empty, contain no whitespace, and not start with "-";
// unlike a package, it can never carry a manager prefix — setup is per tool.
const NAME = /^[^\s:-][^\s:]*$/
/** A check is a probe, not a download: it should never hold the command open. */
const CHECK_TIMEOUT_MS = 120_000
/** Enough stderr to diagnose a failure, bounded so --json stays readable. */
const ERROR_LIMIT = 4000

type Planned = {tool: string; step: SetupStep}

export async function setupTools(options: SetupOptions, deps: SetupDeps): Promise<SetupResult> {
  const tools = plan(options.tools, deps)
  const steps = tools.flatMap((tool) => deps.recipes.setupFor(tool)!.map((step) => ({tool, step})))

  // Inspect every step before changing anything, so the plan is known up front.
  const state = new Map<SetupStep, {satisfied: boolean; error?: string}>()
  for (const {tool, step} of steps) state.set(step, await probe(tool, step, deps))

  const pending = steps.filter(({step}) => !state.get(step)!.satisfied && state.get(step)!.error === undefined)
  const base = {action: 'setup' as const, dryRun: options.dryRun, tools}

  if (options.dryRun) {
    return {...base, steps: steps.map((s) => resolved(s, state)), success: true}
  }

  if (pending.length > 0 && !(options.yes || options.nonInteractive) && (options.json || !deps.isTTY)) {
    throw new OpsError('CONFIRMATION_REQUIRED', 'Confirmation required: re-run with --yes (or --non-interactive)')
  }

  if (pending.length > 0) deps.onPlan(pending.map((s) => resolved(s, state)))

  const results: SetupStepResult[] = []
  const stopped = new Set<string>()
  for (const {tool, step} of steps) {
    if (stopped.has(tool)) {
      results.push({tool, step: step.name, status: 'skipped'})
      continue
    }

    const result = state.get(step)!.satisfied
      ? {tool, step: step.name, status: 'already-configured' as const}
      : await apply(tool, step, state.get(step)!.error, options, deps)

    results.push(result)
    if (result.status === 'failed') stopped.add(tool)
  }

  return {...base, steps: results, success: results.every((r) => r.status !== 'failed')}
}

/** Validates the names and proves every one of them has something to run. */
function plan(names: string[], deps: SetupDeps): string[] {
  if (names.length === 0) throw new OpsError('INVALID_PACKAGE_NAME', 'No tools given')

  const tools = [...new Set(names)]
  for (const name of tools) {
    if (!NAME.test(name)) throw new OpsError('INVALID_PACKAGE_NAME', `Invalid tool name: "${name}"`)

    if (deps.recipes.setupFor(name)) continue
    throw new OpsError(
      'SETUP_UNAVAILABLE',
      deps.recipes.byName(name)
        ? `Tool "${name}" has no setup steps`
        : `No recipe for tool "${name}"; add tool.${name}.setup to ~/.config/ops/config.yaml`,
    )
  }

  return tools
}

/** Runs a check. A missing binary is the tool itself being absent, not a failed check. */
async function probe(tool: string, step: SetupStep, deps: SetupDeps): Promise<{satisfied: boolean; error?: string}> {
  const [cmd, ...args] = step.check
  try {
    const result = await deps.runner.run(cmd, args, {stdin: 'ignore', stdout: 'capture', timeout: CHECK_TIMEOUT_MS})
    return {satisfied: result.exitCode === 0}
  } catch (error) {
    if (error instanceof CommandNotFoundError) {
      if (deps.assumeInstalled?.has(tool)) return {satisfied: false}
      return {satisfied: false, error: `${error.command} not found on PATH; run \`ops tool install ${tool}\` first`}
    }

    throw error
  }
}

async function apply(tool: string, step: SetupStep, probeError: string | undefined, options: SetupOptions, deps: SetupDeps): Promise<SetupStepResult> {
  if (probeError !== undefined) return {tool, step: step.name, status: 'failed', error: probeError}

  const [cmd, ...args] = step.run
  const opts: RunOptions = {
    stdin: options.nonInteractive ? 'ignore' : 'inherit',
    stdout: options.json ? 'capture' : 'inherit',
  }

  let ran
  try {
    ran = await deps.runner.run(cmd, args, opts)
  } catch (error) {
    if (!(error instanceof CommandNotFoundError)) throw error
    return {tool, step: step.name, status: 'failed', error: `${error.command} not found on PATH`}
  }

  if (ran.exitCode !== 0) {
    const stderr = ran.stderr.trim().slice(-ERROR_LIMIT)
    return {tool, step: step.name, status: 'failed', error: stderr || `\`${step.run.join(' ')}\` exited with ${ran.exitCode}`}
  }

  // Verify: the check that declared the step pending must now pass.
  const after = await probe(tool, step, deps)
  return after.satisfied
    ? {tool, step: step.name, status: 'configured'}
    : {tool, step: step.name, status: 'failed', error: after.error ?? `\`${step.run.join(' ')}\` ran but the check still fails`}
}

function resolved({tool, step}: Planned, state: Map<SetupStep, {satisfied: boolean; error?: string}>): SetupStepResult {
  const {satisfied, error} = state.get(step)!
  if (satisfied) return {tool, step: step.name, status: 'already-configured'}
  if (error !== undefined) return {tool, step: step.name, status: 'failed', error}
  return {tool, step: step.name, status: 'would-configure', command: step.run.join(' ')}
}
