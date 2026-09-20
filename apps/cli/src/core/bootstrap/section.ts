import type {SectionName} from '../config.js'
import type {ResolvedProfile} from '../profile/resolve.js'

/**
 * The five outcomes every section collapses into. Deliberately the union of what
 * PackageStatus and SetupStatus already say, so a later section's own vocabulary
 * (already-enabled / enabled / would-enable) maps in without widening this type --
 * which is what lets one renderer and one --json shape cover every section.
 */
export type ChangeStatus = 'satisfied' | 'changed' | 'would-change' | 'skipped' | 'failed'

export interface Change {
  /** Stable within the section and across runs: "apt:git", "git/user.email", "docker.service". */
  id: string
  status: ChangeStatus
  /** One line of human detail: a version, a target, a reason. */
  detail?: string
  /** argv joined; set on `would-change`, collected into the run's "Would run:" block. */
  command?: string
  error?: string
}

export interface SectionPlan {
  section: SectionName
  changes: Change[]
  /** Everything this section would run, in order, for --dry-run output. */
  commands: string[]
  /** Carried from plan() to apply() untouched by the engine: the section's own notes. */
  state?: unknown
}

export interface SectionReport<D = unknown> {
  section: SectionName
  status: 'ok' | 'failed' | 'skipped'
  changes: Change[]
  /** Dry run only. */
  commands?: string[]
  /** The section's native result (InstallResult, SetupResult, ...); --json only. */
  detail?: D
}

export interface BootstrapOptions {
  /** Profile name; the command resolves the fallback before calling. */
  profile: string
  /** Run only these sections; empty means all of them. Exclusive with `skip`. */
  only: SectionName[]
  skip: SectionName[]
  yes: boolean
  force: boolean
  nonInteractive: boolean
  dryRun: boolean
  json: boolean
}

export interface SectionContext {
  profile: ResolvedProfile
  /** The run's flags. A section never re-reads process, env or config. */
  options: BootstrapOptions
}

/**
 * One convergeable area of a machine. Inspect -> compare -> plan, then apply -> verify,
 * split across two calls so the engine can plan the WHOLE run before it changes anything
 * and ask for consent once.
 */
export interface Section<D = unknown> {
  readonly name: SectionName
  /** Inspect and compare only. Must not change the machine; read-only subprocesses are fine. */
  plan(ctx: SectionContext): Promise<SectionPlan>
  /**
   * Apply what `plan` found pending, then verify. Consent is already collected:
   * a section must never gate again.
   */
  apply(ctx: SectionContext, plan: SectionPlan): Promise<SectionReport<D>>
}

/** The sections a build can run. A later phase adds an entry; the engine is untouched. */
export type SectionRegistry = Partial<Record<SectionName, Section>>

/** How many changes a plan would actually make. */
export const pendingIn = (plan: SectionPlan): number => plan.changes.filter((c) => c.status === 'would-change').length
