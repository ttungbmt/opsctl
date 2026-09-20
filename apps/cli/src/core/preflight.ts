import type {OnProgress} from '#providers/deb.js'
import type {MiseInstaller} from '#providers/mise-install.js'
import type {MiseState} from '#providers/mise-presence.js'
import type {Change} from './change.js'
import {OpsError} from './errors.js'
import type {Stage} from './stage.js'

/** The one id the preflight reports under. */
export const MISE = 'mise'

/** The four run flags a preflight cares about; a subset of both BootstrapOptions and InstallOptions. */
export interface PreflightOptions {
  dryRun: boolean
  yes: boolean
  nonInteractive: boolean
  json: boolean
}

export interface PreflightResult {
  action: 'preflight'
  dryRun: boolean
  /** True when mise is on PATH now. False only after a dry run that would have installed it. */
  satisfied: boolean
  /** One entry, id "mise", in the same vocabulary a section reports. */
  changes: Change[]
  /** Dry run only: everything the preflight would run, in order. */
  commands?: string[]
}

export interface PreflightDeps {
  probe: () => Promise<MiseState>
  /** undefined when the config carries no `mise:` block saying where to get it. */
  installer: MiseInstaller | undefined
  /** True when a human can read the plan. */
  isTTY: boolean
  /** True when privileged commands can run without a password prompt. */
  sudoReady: () => Promise<boolean>
  /** Called once with the pending change, before anything is written. */
  onPlan: (changes: Change[]) => void
  onStage?: (stage: Stage, subject: string) => void
  onProgress?: OnProgress
  /** Capture the installer's output instead of streaming it, when a spinner owns the terminal. */
  captureOutput?: boolean
}

/**
 * Makes sure mise exists before anything that needs it runs: inspect -> plan -> confirm ->
 * install -> verify, the same five beats as every other privileged area, compressed into one
 * package because there is only ever one thing to do.
 *
 * Lives outside the bootstrap engine on purpose. The engine's invariant is that it plans
 * every section before applying any, and a prerequisite has to be applied before any section
 * can even be inspected -- so it is the caller, which knows it is `ops bootstrap`, that runs
 * this first and owns the extra gate.
 */
export async function ensureMise(options: PreflightOptions, deps: PreflightDeps): Promise<PreflightResult> {
  const base = {action: 'preflight' as const, dryRun: options.dryRun}
  const state = await deps.probe()

  // The overwhelmingly common path: one exec, nothing printed, nothing else touched.
  if (state.state === 'present') {
    return {...base, changes: [{detail: state.version, id: MISE, status: 'satisfied'}], satisfied: true}
  }

  // mise EXISTS and is misbehaving. Installing over it would be the wrong repair, and
  // whichever provider needs it will fail with a message about what it actually ran.
  if (state.state === 'unhealthy') {
    const detail = `on PATH but did not answer --version: ${state.detail}`
    return {...base, changes: [{detail, id: MISE, status: 'skipped'}], satisfied: true}
  }

  if (!deps.installer) {
    throw new OpsError(
      'MISE_BOOTSTRAP_UNAVAILABLE',
      'mise is not installed and this config has no "mise:" block saying where to get it; install it from https://mise.jdx.dev and re-run',
    )
  }

  const commands = deps.installer.describe()
  const command = commands.at(-1)!

  if (options.dryRun) {
    return {
      ...base,
      changes: [{command, detail: 'not installed', id: MISE, status: 'would-change'}],
      commands,
      satisfied: false,
    }
  }

  // The same gate the engine applies to a section plan, on the same terms -- taken here
  // because this install has to happen before any section can be inspected.
  if (!(options.yes || options.nonInteractive) && (options.json || !deps.isTTY)) {
    throw new OpsError(
      'CONFIRMATION_REQUIRED',
      'Confirmation required: mise is not installed and ops must install it before it can continue; re-run with --yes (or --non-interactive)',
    )
  }

  deps.onPlan([{command, id: MISE, status: 'would-change'}])

  if (options.nonInteractive && !(await deps.sudoReady())) {
    throw new OpsError(
      'SUDO_PASSWORD_REQUIRED',
      'sudo needs a password; run without --non-interactive or configure passwordless sudo',
    )
  }

  const {exitCode} = await deps.installer.install({
    capture: options.json || deps.captureOutput === true,
    nonInteractive: options.nonInteractive,
    onProgress: deps.onProgress,
    onStage: (stage) => deps.onStage?.(stage, MISE),
  })

  // Verify by asking the machine again, never by trusting an exit code.
  const after = await deps.probe()
  if (after.state === 'absent') {
    throw new OpsError(
      'MISE_BOOTSTRAP_UNAVAILABLE',
      `Ran the mise installer${exitCode === 0 ? '' : ` (exit ${exitCode})`} but mise is still not on PATH; install it from https://mise.jdx.dev`,
    )
  }

  const detail = after.state === 'present' ? after.version : 'installed'
  return {...base, changes: [{detail, id: MISE, status: 'changed'}], satisfied: true}
}
