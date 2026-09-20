/**
 * The five outcomes every convergeable area collapses into. Deliberately the union of what
 * PackageStatus and SetupStatus already say, so a new area's own vocabulary (already-enabled
 * / enabled / would-enable) maps in without widening this type -- which is what lets one
 * renderer and one --json shape cover all of them.
 */
export type ChangeStatus = 'satisfied' | 'changed' | 'would-change' | 'skipped' | 'failed'

export interface Change {
  /** Stable within its area and across runs: "apt:git", "git/user.email", "mise". */
  id: string
  status: ChangeStatus
  /** One line of human detail: a version, a target, a reason. */
  detail?: string
  /** argv joined; set on `would-change`, collected into the run's "Would run:" block. */
  command?: string
  error?: string
}
