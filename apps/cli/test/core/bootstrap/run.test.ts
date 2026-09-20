import {describe, expect, it, vi} from 'vitest'
import {bootstrapProfile, haltedBeforePlan, type BootstrapDeps} from '../../../src/core/bootstrap/run.js'
import type {BootstrapOptions, Change, Section, SectionPlan, SectionRegistry} from '../../../src/core/bootstrap/section.js'
import type {SectionName} from '../../../src/core/config.js'
import {OpsError} from '../../../src/core/errors.js'
import type {PreflightResult} from '../../../src/core/preflight.js'
import {profileIndex} from '../../../src/core/profile/resolve.js'

/** Records plan/apply order across every section in one shared log. */
function stub(
  name: SectionName,
  log: string[],
  over: {changes?: Change[]; commands?: string[]; fails?: boolean; planThrows?: Error} = {},
): Section {
  const changes = over.changes ?? [{id: `${name}-1`, status: 'would-change' as const, command: `do ${name}`}]
  return {
    name,
    async plan() {
      log.push(`plan:${name}`)
      if (over.planThrows) throw over.planThrows
      return {section: name, changes, commands: over.commands ?? [`do ${name}`]}
    },
    async apply() {
      log.push(`apply:${name}`)
      return {
        section: name,
        status: over.fails ? ('failed' as const) : ('ok' as const),
        changes: changes.map((c) => ({...c, status: over.fails ? ('failed' as const) : ('changed' as const)})),
      }
    },
  }
}

const opts = (o: Partial<BootstrapOptions> = {}): BootstrapOptions => ({
  dryRun: false,
  force: false,
  json: false,
  nonInteractive: false,
  only: [],
  profile: 'p',
  skip: [],
  yes: true,
  ...o,
})

function deps(sections: SectionRegistry, over: Partial<BootstrapDeps> = {}): BootstrapDeps {
  return {
    isTTY: true,
    onPlan: () => {},
    profiles: profileIndex({
      p: {packages: ['git'], tools: ['node'], services: [{name: 'docker', scope: 'system', enabled: true, state: 'started'}]},
    }),
    sections,
    ...over,
  }
}

describe('bootstrapProfile choreography', () => {
  it('plans every section before applying any', async () => {
    const log: string[] = []
    await bootstrapProfile(opts(), deps({packages: stub('packages', log), tools: stub('tools', log), services: stub('services', log)}))
    expect(log).toEqual(['plan:packages', 'plan:tools', 'plan:services', 'apply:packages', 'apply:tools', 'apply:services'])
  })

  it('runs sections in SECTION_ORDER regardless of registry insertion order', async () => {
    const log: string[] = []
    const registry: SectionRegistry = {}
    registry.services = stub('services', log)
    registry.packages = stub('packages', log)
    registry.tools = stub('tools', log)
    const result = await bootstrapProfile(opts(), deps(registry))
    expect(result.sections.map((s) => s.section)).toEqual(['packages', 'tools', 'services'])
  })

  it('never touches a section the profile does not declare', async () => {
    const log: string[] = []
    // `setup` is absent from the profile, so it must not run even though the registry has it.
    const profiles = profileIndex({p: {packages: ['git']}})
    await bootstrapProfile(opts(), deps({packages: stub('packages', log), setup: stub('setup', log)}, {profiles}))
    expect(log).toEqual(['plan:packages', 'apply:packages'])
  })

  it('throws PROFILE_SECTION_UNSUPPORTED when a declared section has no handler', async () => {
    // Silently skipping would leave the machine unconverged while reporting success.
    const log: string[] = []
    const run = () => bootstrapProfile(opts(), deps({packages: stub('packages', log), tools: stub('tools', log)}))
    await expect(run()).rejects.toThrow(OpsError)
    await expect(run()).rejects.toThrow(/--skip services/)
    expect(log).toEqual([])
  })

  it('--skip suppresses an unsupported section', async () => {
    const log: string[] = []
    const result = await bootstrapProfile(opts({skip: ['services']}), deps({packages: stub('packages', log), tools: stub('tools', log)}))
    expect(result.sections.map((s) => s.section)).toEqual(['packages', 'tools'])
  })

  it('--only narrows to the named sections', async () => {
    const log: string[] = []
    const result = await bootstrapProfile(
      opts({only: ['tools']}),
      deps({packages: stub('packages', log), tools: stub('tools', log), services: stub('services', log)}),
    )
    expect(result.sections.map((s) => s.section)).toEqual(['tools'])
    expect(log).toEqual(['plan:tools', 'apply:tools'])
  })

  it('aborts before any apply when a plan throws', async () => {
    const log: string[] = []
    const boom = new OpsError('MISE_COMMAND_FAILED', 'mise exploded')
    const run = bootstrapProfile(
      opts({skip: ['services']}),
      deps({packages: stub('packages', log), tools: stub('tools', log, {planThrows: boom})}),
    )
    await expect(run).rejects.toThrow('mise exploded')
    expect(log).toEqual(['plan:packages', 'plan:tools'])
  })
})

describe('bootstrapProfile dry run', () => {
  it('plans every section and applies none', async () => {
    const log: string[] = []
    const result = await bootstrapProfile(
      opts({dryRun: true, skip: ['services']}),
      deps({packages: stub('packages', log), tools: stub('tools', log)}),
    )
    expect(log).toEqual(['plan:packages', 'plan:tools'])
    expect(result.dryRun).toBe(true)
    expect(result.success).toBe(true)
  })

  it('concatenates commands in section order', async () => {
    const log: string[] = []
    const result = await bootstrapProfile(
      opts({dryRun: true, skip: ['services']}),
      deps({packages: stub('packages', log, {commands: ['apt install git']}), tools: stub('tools', log, {commands: ['mise use node']})}),
    )
    expect(result.commands).toEqual(['apt install git', 'mise use node'])
  })

  it('reports failure when a plan could not be computed for a change', async () => {
    // "1 failed" printed next to exit 0 would be a lie. Drift is `would-change`;
    // `failed` means the probe itself could not answer, which is an error either way.
    const log: string[] = []
    const failed: Change[] = [{id: 'x', status: 'failed', error: 'nope'}]
    const result = await bootstrapProfile(
      opts({dryRun: true, skip: ['services']}),
      deps({packages: stub('packages', log, {changes: failed}), tools: stub('tools', log)}),
    )
    expect(result.success).toBe(false)
    expect(result.sections.map((s) => [s.section, s.status])).toEqual([
      ['packages', 'failed'],
      ['tools', 'ok'],
    ])
  })

  it('does not fail fast: a failing section still lets the rest plan', async () => {
    const log: string[] = []
    const failed: Change[] = [{id: 'x', status: 'failed', error: 'nope'}]
    await bootstrapProfile(
      opts({dryRun: true, skip: ['services']}),
      deps({packages: stub('packages', log, {changes: failed}), tools: stub('tools', log)}),
    )
    expect(log).toEqual(['plan:packages', 'plan:tools'])
  })
})

describe('bootstrapProfile confirmation gate', () => {
  const twoSections = (log: string[]) => ({packages: stub('packages', log), tools: stub('tools', log)})

  it('throws once for the whole run under --json with pending changes', async () => {
    const log: string[] = []
    const run = bootstrapProfile(opts({json: true, skip: ['services'], yes: false}), deps(twoSections(log)))
    await expect(run).rejects.toThrow(/2 changes across 2 sections/)
    expect(log).toEqual(['plan:packages', 'plan:tools'])
  })

  it('throws when stdout is not a TTY', async () => {
    const log: string[] = []
    await expect(bootstrapProfile(opts({skip: ['services'], yes: false}), deps(twoSections(log), {isTTY: false}))).rejects.toThrow(OpsError)
  })

  it('does not throw with --yes', async () => {
    const log: string[] = []
    await expect(bootstrapProfile(opts({json: true, skip: ['services']}), deps(twoSections(log)))).resolves.toBeTruthy()
  })

  it('does not throw with --non-interactive', async () => {
    const log: string[] = []
    await expect(
      bootstrapProfile(opts({json: true, nonInteractive: true, skip: ['services'], yes: false}), deps(twoSections(log))),
    ).resolves.toBeTruthy()
  })

  it('does not throw when nothing is pending', async () => {
    const log: string[] = []
    const satisfied: Change[] = [{id: 'x', status: 'satisfied'}]
    const sections = {packages: stub('packages', log, {changes: satisfied}), tools: stub('tools', log, {changes: satisfied})}
    await expect(bootstrapProfile(opts({json: true, skip: ['services'], yes: false}), deps(sections))).resolves.toBeTruthy()
  })

  it('calls onPlan exactly once with every plan', async () => {
    const log: string[] = []
    const onPlan = vi.fn<(plans: SectionPlan[]) => void>()
    await bootstrapProfile(opts({skip: ['services']}), deps(twoSections(log), {onPlan}))
    expect(onPlan).toHaveBeenCalledTimes(1)
    expect(onPlan.mock.calls[0][0].map((p) => p.section)).toEqual(['packages', 'tools'])
  })

  it('does not call onPlan when nothing is pending', async () => {
    const log: string[] = []
    const onPlan = vi.fn()
    const satisfied: Change[] = [{id: 'x', status: 'satisfied'}]
    const profiles = profileIndex({p: {packages: ['git']}})
    await bootstrapProfile(opts(), deps({packages: stub('packages', log, {changes: satisfied})}, {onPlan, profiles}))
    expect(onPlan).not.toHaveBeenCalled()
  })
})

describe('bootstrapProfile failure handling', () => {
  it('fails fast: a failed section skips every later one', async () => {
    const log: string[] = []
    const result = await bootstrapProfile(
      opts(),
      deps({packages: stub('packages', log, {fails: true}), tools: stub('tools', log), services: stub('services', log)}),
    )
    expect(log).toEqual(['plan:packages', 'plan:tools', 'plan:services', 'apply:packages'])
    expect(result.sections.map((s) => [s.section, s.status])).toEqual([
      ['packages', 'failed'],
      ['tools', 'skipped'],
      ['services', 'skipped'],
    ])
    expect(result.success).toBe(false)
  })

  it('reports lineage, counts and the action', async () => {
    const log: string[] = []
    const profiles = profileIndex({base: {packages: ['git']}, p: {extends: 'base', tools: ['node']}})
    const result = await bootstrapProfile(opts(), deps({packages: stub('packages', log), tools: stub('tools', log)}, {profiles}))
    expect(result.lineage).toEqual(['base', 'p'])
    expect(result.counts).toEqual({satisfied: 0, changed: 2, 'would-change': 0, skipped: 0, failed: 0})
    expect(result.action).toBe('bootstrap')
    expect(result.profile).toBe('p')
  })

  it('announces each section as it begins applying', async () => {
    const log: string[] = []
    const onSection = vi.fn()
    await bootstrapProfile(opts({skip: ['services']}), deps({packages: stub('packages', log), tools: stub('tools', log)}, {onSection}))
    expect(onSection.mock.calls.map((c) => c[0])).toEqual(['packages', 'tools'])
  })

  it('surfaces PROFILE_NOT_FOUND for an unknown profile', async () => {
    const log: string[] = []
    await expect(bootstrapProfile(opts({profile: 'nope'}), deps({packages: stub('packages', log)}))).rejects.toThrow(/No profile "nope"/)
  })
})

describe('haltedBeforePlan', () => {
  it('reports a run that never got to plan anything', () => {
    const stopped: PreflightResult = {
      action: 'preflight',
      changes: [{id: 'mise', status: 'would-change', command: 'sudo env ... sh <installer>'}],
      commands: ['download https://mise.run'],
      dryRun: true,
      satisfied: false,
    }
    const profile = profileIndex({base: {packages: ['git']}, p: {extends: 'base'}}).resolve('p')
    expect(haltedBeforePlan(profile, opts({dryRun: true}), stopped)).toEqual({
      action: 'bootstrap',
      commands: ['download https://mise.run'],
      counts: {changed: 0, failed: 0, satisfied: 0, skipped: 0, 'would-change': 0},
      dryRun: true,
      lineage: ['base', 'p'],
      preflight: stopped,
      profile: 'p',
      sections: [],
      success: false,
    })
  })
})
