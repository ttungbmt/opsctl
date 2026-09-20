import {describe, expect, it} from 'vitest'
import type {BootstrapOptions, SectionContext} from '#core/bootstrap/section.js'
import {createInstallSection} from '#core/bootstrap/sections/install.js'
import type {InstallDeps} from '#core/package/install.js'
import {profileIndex} from '#core/profile/resolve.js'
import {recipeIndex} from '#core/tool/recipe.js'
import {FakeDeb, FakeMise, FakeRepos, FakeTools} from '#test/helpers/fake-packages.js'

function setup() {
  const mise = new FakeMise()
  const tools = new FakeTools()
  tools.registry.add('jq')
  tools.registry.add('node')
  const deps: InstallDeps = {
    deb: new FakeDeb(),
    detectManager: async () => 'apt',
    isTTY: true,
    mise,
    recipes: recipeIndex(),
    repos: new FakeRepos(),
    sudoReady: async () => true,
    // `jq` is system-preferred, so `packages: [jq]` must go to apt even though mise has it.
    systemPreferred: new Set(['jq']),
    tools,
  }
  return {deps, mise, tools}
}

const ctx = (profile: {packages?: string[]; tools?: string[]}, over: Partial<BootstrapOptions> = {}): SectionContext => ({
  options: {dryRun: false, force: false, json: false, nonInteractive: false, only: [], profile: 'p', skip: [], yes: false, ...over},
  profile: profileIndex({p: profile}).resolve('p'),
})

const emptyPlan = (section: 'packages' | 'tools') => ({section, changes: [], commands: []})

describe('packages section', () => {
  it('resolves through the system-preferred list', async () => {
    const {deps, mise} = setup()
    await createInstallSection('packages', deps).apply(ctx({packages: ['jq']}), emptyPlan('packages'))
    expect([...mise.declared]).toEqual(['apt:jq'])
  })

  it('plan writes nothing', async () => {
    const {deps, mise} = setup()
    const plan = await createInstallSection('packages', deps).plan(ctx({packages: ['jq']}))
    expect(mise.calls).not.toContain('declare')
    expect(mise.calls).not.toContain('apply')
    expect(plan.section).toBe('packages')
    expect(plan.changes).toEqual([{id: 'apt:jq', status: 'would-change'}])
    expect(plan.commands).toEqual(['would install apt:jq'])
  })

  it('maps package statuses onto change statuses', async () => {
    const {deps, mise} = setup()
    mise.declared.add('apt:jq')
    mise.installed.set('apt:jq', '1.7')
    const report = await createInstallSection('packages', deps).apply(ctx({packages: ['jq']}), emptyPlan('packages'))
    expect(report.status).toBe('ok')
    expect(report.changes).toEqual([{id: 'apt:jq', status: 'satisfied', detail: '1.7'}])
    expect(report.detail?.action).toBe('install')
  })

  it('reports a failed install as a failed section', async () => {
    const {deps, mise} = setup()
    mise.installOnApply = false
    const report = await createInstallSection('packages', deps).apply(ctx({packages: ['jq']}), emptyPlan('packages'))
    expect(report.status).toBe('failed')
    expect(report.changes[0].status).toBe('failed')
  })

  it('applies with yes: true even when the run did not pass --yes', async () => {
    // The engine already took consent for the whole run; a section must not gate again.
    const {deps, mise} = setup()
    await createInstallSection('packages', deps).apply(ctx({packages: ['jq']}, {json: true, yes: false}), emptyPlan('packages'))
    expect(mise.applied[0].specs).toEqual(['apt:jq'])
  })
})

describe('tools section', () => {
  it('ignores the system-preferred list so a bare name prefers the mise registry', async () => {
    const {deps, tools} = setup()
    await createInstallSection('tools', deps).apply(ctx({tools: ['jq']}), emptyPlan('tools'))
    expect(tools.installs[0].names).toEqual(['jq'])
  })

  it('reads the profile tools list, not packages', async () => {
    const {deps, tools} = setup()
    const plan = await createInstallSection('tools', deps).plan(ctx({packages: ['jq'], tools: ['node']}))
    expect(plan.changes.map((c) => c.id)).toEqual(['mise:node'])
    expect(tools.calls).not.toContain('install')
  })
})
