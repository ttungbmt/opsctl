import {describe, expect, it} from 'vitest'
import type {BootstrapOptions, SectionContext} from '#core/bootstrap/section.js'
import {createSetupSection} from '#core/bootstrap/sections/setup.js'
import {CommandNotFoundError} from '#core/errors.js'
import {profileIndex} from '#core/profile/resolve.js'
import {recipeIndex} from '#core/tool/recipe.js'
import {FakeRunner} from '#test/helpers/fake-runner.js'

const recipes = recipeIndex({
  ab: {package: 'mise:ab', setup: [{name: 'browsers', check: ['ab', 'doctor'], run: ['ab', 'install']}]},
})

const ctx = (over: Partial<BootstrapOptions> = {}): SectionContext => ({
  options: {dryRun: false, force: false, json: false, nonInteractive: false, only: [], profile: 'p', skip: [], yes: false, ...over},
  profile: profileIndex({p: {tools: ['ab@1.2'], setup: ['ab']}}, {recipes}).resolve('p'),
})

const emptyPlan = {section: 'setup' as const, changes: [], commands: []}
const lines = (runner: FakeRunner) => runner.calls.map((c) => [c.cmd, ...c.args].join(' '))

describe('setup section', () => {
  it('plan runs only checks, never a run command', async () => {
    const runner = new FakeRunner().on('ab doctor', {exitCode: 1})
    const plan = await createSetupSection({isTTY: true, recipes, runner}).plan(ctx())
    expect(lines(runner)).toEqual(['ab doctor'])
    expect(plan.changes).toEqual([{id: 'ab/browsers', status: 'would-change', command: 'ab install'}])
    expect(plan.commands).toEqual(['ab install'])
  })

  it('reports a satisfied check as satisfied, with nothing to run', async () => {
    const runner = new FakeRunner().on('ab doctor', {exitCode: 0})
    const plan = await createSetupSection({isTTY: true, recipes, runner}).plan(ctx())
    expect(plan.changes).toEqual([{id: 'ab/browsers', status: 'satisfied'}])
    expect(plan.commands).toEqual([])
  })

  it('apply checks, runs, then re-checks', async () => {
    const runner = new FakeRunner().on('ab doctor', {exitCode: 1}, {exitCode: 0}).on('ab install', {exitCode: 0})
    const report = await createSetupSection({isTTY: true, recipes, runner}).apply(ctx(), emptyPlan)
    expect(lines(runner)).toEqual(['ab doctor', 'ab install', 'ab doctor'])
    expect(report.status).toBe('ok')
    expect(report.changes).toEqual([{id: 'ab/browsers', status: 'changed'}])
    expect(report.detail?.action).toBe('setup')
  })

  it('reports a failed step as a failed section', async () => {
    const runner = new FakeRunner().on('ab doctor', {exitCode: 1}).on('ab install', {exitCode: 3, stderr: 'no disk'})
    const report = await createSetupSection({isTTY: true, recipes, runner}).apply(ctx(), emptyPlan)
    expect(report.status).toBe('failed')
    expect(report.changes[0].error).toContain('no disk')
  })

  it('assumes the profile installs its own tools, stripping version and manager', async () => {
    // `ab` does not exist yet; `tools: [ab@1.2]` earlier in the same run installs it.
    const runner = {
      async run(cmd: string) {
        throw new CommandNotFoundError(cmd)
      },
    }
    const plan = await createSetupSection({isTTY: true, recipes, runner}).plan(ctx())
    expect(plan.changes[0].status).toBe('would-change')
  })
})
