import type {Change} from '../change.js'
import type {SectionName} from '../config.js'
import type {ResolvedProfile} from '../profile/resolve.js'

// A change is not a bootstrap concept -- the mise preflight reports them too, and
// `ops tool install` must not import from core/bootstrap/.
export type {Change, ChangeStatus} from '../change.js'

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
