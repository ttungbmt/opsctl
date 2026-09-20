import {SECTION_ORDER, type SectionName} from '#core/config.js'
import {OpsError} from '#core/errors.js'
import type {PreflightResult} from '#core/preflight.js'
import {type ProfileIndex, type ResolvedProfile, declaresSection} from '#core/profile/resolve.js'
import {
  type BootstrapOptions,
  type Change,
  type ChangeStatus,
  type Section,
  type SectionContext,
  type SectionPlan,
  type SectionRegistry,
  type SectionReport,
  pendingIn,
} from './section.js'

export type {BootstrapOptions} from './section.js'

export interface BootstrapDeps {
  profiles: ProfileIndex
  /** The sections this build can run. The engine never constructs one. */
  sections: SectionRegistry
  /** True when a human can read the plan. */
  isTTY: boolean
  /** Called once with every section's plan before the first apply; never under --dry-run. */
  onPlan: (plans: SectionPlan[]) => void
  /** Called as each section begins applying, so the command layer can print a heading. */
  onSection?: (section: SectionName) => void
}

export interface BootstrapResult {
  success: boolean
  action: 'bootstrap'
  profile: string
  /** Every profile in the extends chain, base first, the requested one last. */
  lineage: string[]
  dryRun: boolean
  /** Only the sections that actually ran, in SECTION_ORDER. */
  sections: SectionReport[]
  /** Dry run only: every command the run would execute, in section order. */
  commands?: string[]
  counts: Record<ChangeStatus, number>
  /**
   * What the mise preflight did. Attached by the command layer, never by the engine: a
   * preflight is not a section, so its change never enters `counts`.
   */
  preflight?: PreflightResult
}

/**
 * The result of a run that stopped in preflight: no section plans to report, because
 * computing one needs the tool the preflight was about to install.
 */
export function haltedBeforePlan(
  profile: ResolvedProfile,
  options: BootstrapOptions,
  preflight: PreflightResult,
): BootstrapResult {
  return {
    action: 'bootstrap',
    commands: preflight.commands ?? [],
    counts: {changed: 0, failed: 0, satisfied: 0, skipped: 0, 'would-change': 0},
    dryRun: options.dryRun,
    lineage: profile.lineage,
    preflight,
    profile: profile.name,
    sections: [],
    success: false,
  }
}

function tally(reports: {changes: Change[]}[]): Record<ChangeStatus, number> {
  const counts: Record<ChangeStatus, number> = {changed: 0, failed: 0, satisfied: 0, skipped: 0, 'would-change': 0}
  for (const report of reports) for (const change of report.changes) counts[change.status] += 1
  return counts
}

/**
 * Converges the machine to a profile: plan every declared section, take consent once,
 * then apply in a fixed order. A failed section stops the run -- the sections after it
 * are reported skipped rather than left unexplained.
 */
export async function bootstrapProfile(options: BootstrapOptions, deps: BootstrapDeps): Promise<BootstrapResult> {
  const profile = deps.profiles.resolve(options.profile)
  const only = new Set(options.only)
  const skip = new Set(options.skip)

  // SECTION_ORDER drives the run, not the registry: the order is a property of
  // bootstrapping a machine, not of whichever key happened to be inserted first.
  const wanted = SECTION_ORDER.filter(
    (name) => declaresSection(profile, name) && (only.size === 0 || only.has(name)) && !skip.has(name),
  )

  const active: Section[] = []
  for (const name of wanted) {
    const section = deps.sections[name]
    if (!section) {
      throw new OpsError(
        'PROFILE_SECTION_UNSUPPORTED',
        `Profile "${profile.name}" declares a "${name}" section, which this version of ops cannot run; upgrade ops or re-run with --skip ${name}`,
      )
    }

    active.push(section)
  }

  const ctx: SectionContext = {options, profile}
  const base = {action: 'bootstrap' as const, dryRun: options.dryRun, lineage: profile.lineage, profile: profile.name}

  // Plan the whole run before anything writes: that is what makes one confirmation
  // possible. A throw here costs nothing, because nothing has changed yet.
  const plans: SectionPlan[] = []
  for (const section of active) plans.push(await section.plan(ctx))

  if (options.dryRun) {
    // A dry run does not fail on drift -- that is what `would-change` is for. It does
    // fail when a plan could not be computed: printing "1 failed" beside exit 0 lies.
    const sections: SectionReport[] = plans.map((plan) => ({
      changes: plan.changes,
      commands: plan.commands,
      section: plan.section,
      status: plan.changes.some((change) => change.status === 'failed') ? 'failed' : 'ok',
    }))
    return {
      ...base,
      commands: plans.flatMap((plan) => plan.commands),
      counts: tally(sections),
      sections,
      success: sections.every((section) => section.status !== 'failed'),
    }
  }

  const pending = plans.reduce((total, plan) => total + pendingIn(plan), 0)
  if (pending > 0 && !(options.yes || options.nonInteractive) && (options.json || !deps.isTTY)) {
    throw new OpsError(
      'CONFIRMATION_REQUIRED',
      `Confirmation required: ${pending} change${pending === 1 ? '' : 's'} across ${plans.length} section${plans.length === 1 ? '' : 's'}; re-run with --yes (or --non-interactive)`,
    )
  }

  if (pending > 0) deps.onPlan(plans)

  const reports: SectionReport[] = []
  let stopped = false
  for (const [at, section] of active.entries()) {
    if (stopped) {
      reports.push({changes: [], section: section.name, status: 'skipped'})
      continue
    }

    deps.onSection?.(section.name)
    const report = await section.apply(ctx, plans[at])
    reports.push(report)
    if (report.status === 'failed') stopped = true
  }

  return {...base, counts: tally(reports), sections: reports, success: reports.every((r) => r.status !== 'failed')}
}
