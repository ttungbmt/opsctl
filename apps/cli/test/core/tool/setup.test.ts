import {describe, expect, it} from 'vitest'
import {CommandNotFoundError, OpsError} from '../../../src/core/errors.js'
import {type Recipe, recipeIndex} from '../../../src/core/tool/recipe.js'
import {type SetupDeps, type SetupOptions, type SetupStepResult, setupTools} from '../../../src/core/tool/setup.js'
import {FakeRunner} from '../../helpers/fake-runner.js'

const BROWSERS = {name: 'browsers', check: ['ab', 'doctor'], run: ['ab', 'install']}
const DEPS = {name: 'deps', check: ['ab', 'deps'], run: ['ab', 'install-deps']}

const RECIPES: Record<string, Recipe> = {
  ab: {package: 'mise:ab', setup: [BROWSERS]},
  'google-chrome': {package: 'apt:google-chrome-stable'},
}

function fixture(recipes: Record<string, Recipe> = RECIPES, overrides: Partial<SetupDeps> = {}) {
  const runner = new FakeRunner()
  const plans: SetupStepResult[][] = []
  const deps: SetupDeps = {isTTY: true, onPlan: (p) => plans.push(p), recipes: recipeIndex(recipes), runner, ...overrides}
  return {deps, plans, runner}
}

const opts = (o: Partial<SetupOptions>): SetupOptions => ({dryRun: false, json: false, nonInteractive: false, tools: [], yes: false, ...o})

/** The command lines the runner saw, in order. */
const lines = (runner: FakeRunner) => runner.calls.map((c) => [c.cmd, ...c.args].join(' '))

async function codeOf(promise: Promise<unknown>) {
  const error = await promise.then(() => undefined, (e: unknown) => e)
  expect(error).toBeInstanceOf(OpsError)
  return (error as OpsError).code
}

describe('setupTools', () => {
  it('reports a satisfied step without running it', async () => {
    const {deps, plans, runner} = fixture()
    runner.on('ab doctor', {exitCode: 0})
    const result = await setupTools(opts({tools: ['ab']}), deps)

    expect(result).toEqual({
      action: 'setup',
      dryRun: false,
      steps: [{tool: 'ab', step: 'browsers', status: 'already-configured'}],
      success: true,
      tools: ['ab'],
    })
    expect(lines(runner)).toEqual(['ab doctor'])
    expect(plans).toEqual([])
  })

  it('runs a pending step and verifies it with the same check', async () => {
    const {deps, plans, runner} = fixture()
    runner.on('ab doctor', {exitCode: 1}, {exitCode: 0}).on('ab install', {exitCode: 0})
    const result = await setupTools(opts({tools: ['ab']}), deps)

    expect(result.steps).toEqual([{tool: 'ab', step: 'browsers', status: 'configured'}])
    expect(result.success).toBe(true)
    expect(lines(runner)).toEqual(['ab doctor', 'ab install', 'ab doctor'])
  })

  it('announces the plan before running anything', async () => {
    const {deps, plans, runner} = fixture()
    runner.on('ab doctor', {exitCode: 1}, {exitCode: 0}).on('ab install', {exitCode: 0})
    await setupTools(opts({tools: ['ab']}), deps)

    expect(plans).toEqual([[{tool: 'ab', step: 'browsers', status: 'would-configure', command: 'ab install'}]])
  })

  it('fails a step whose check still fails after it ran', async () => {
    const {deps, runner} = fixture()
    runner.on('ab doctor', {exitCode: 1}).on('ab install', {exitCode: 0})
    const result = await setupTools(opts({tools: ['ab']}), deps)

    expect(result.steps[0]).toMatchObject({status: 'failed'})
    expect(result.steps[0].error).toContain('still fails')
    expect(result.success).toBe(false)
  })

  it('fails a step whose command exits non-zero, keeping its stderr', async () => {
    const {deps, runner} = fixture()
    runner.on('ab doctor', {exitCode: 1}).on('ab install', {exitCode: 2, stderr: 'no disk space\n'})
    const result = await setupTools(opts({tools: ['ab']}), deps)

    expect(result.steps[0]).toEqual({tool: 'ab', step: 'browsers', status: 'failed', error: 'no disk space'})
  })

  it('skips the rest of a tool after a step fails, and still sets up the next tool', async () => {
    const recipes: Record<string, Recipe> = {ab: {package: 'mise:ab', setup: [BROWSERS, DEPS]}, cd: {package: 'mise:cd', setup: [{name: 'ok', check: ['cd', 'check'], run: ['cd', 'go']}]}}
    const {deps, runner} = fixture(recipes)
    runner.on('ab doctor', {exitCode: 1}).on('ab deps', {exitCode: 1}).on('ab install', {exitCode: 1}).on('cd check', {exitCode: 0})
    const result = await setupTools(opts({tools: ['ab', 'cd']}), deps)

    expect(result.steps).toEqual([
      {tool: 'ab', step: 'browsers', status: 'failed', error: '`ab install` exited with 1'},
      {tool: 'ab', step: 'deps', status: 'skipped'},
      {tool: 'cd', step: 'ok', status: 'already-configured'},
    ])
    expect(lines(runner)).not.toContain('ab install-deps')
    expect(result.success).toBe(false)
  })

  it('points at tool install when the check binary is missing', async () => {
    const {deps, runner} = fixture()
    runner.run = async (cmd: string) => {
      throw new CommandNotFoundError(cmd)
    }
    const result = await setupTools(opts({tools: ['ab']}), deps)

    expect(result.steps[0]).toMatchObject({status: 'failed'})
    expect(result.steps[0].error).toContain('ops tool install ab')
  })

  it('runs checks but never commands under --dry-run', async () => {
    const {deps, plans, runner} = fixture()
    runner.on('ab doctor', {exitCode: 1})
    const result = await setupTools(opts({dryRun: true, tools: ['ab']}), deps)

    expect(result).toEqual({
      action: 'setup',
      dryRun: true,
      steps: [{tool: 'ab', step: 'browsers', status: 'would-configure', command: 'ab install'}],
      success: true,
      tools: ['ab'],
    })
    expect(lines(runner)).toEqual(['ab doctor'])
    expect(plans).toEqual([])
  })

  it('reports a satisfied step as already configured under --dry-run', async () => {
    const {deps, runner} = fixture()
    runner.on('ab doctor', {exitCode: 0})
    const result = await setupTools(opts({dryRun: true, tools: ['ab']}), deps)
    expect(result.steps).toEqual([{tool: 'ab', step: 'browsers', status: 'already-configured'}])
  })

  it('always captures the check and ignores its stdin; streams the command unless --json', async () => {
    const {deps, runner} = fixture()
    runner.on('ab doctor', {exitCode: 1}, {exitCode: 0}).on('ab install', {exitCode: 0})
    await setupTools(opts({tools: ['ab'], yes: true}), deps)

    expect(runner.calls[0].opts).toMatchObject({stdout: 'capture', stdin: 'ignore'})
    expect(runner.calls[0].opts?.timeout).toBeGreaterThan(0)
    expect(runner.calls[1].opts).toMatchObject({stdout: 'inherit', stdin: 'inherit'})
  })

  it('captures the command under --json and ignores its stdin under --non-interactive', async () => {
    const {deps, runner} = fixture()
    runner.on('ab doctor', {exitCode: 1}, {exitCode: 0}).on('ab install', {exitCode: 0})
    await setupTools(opts({json: true, nonInteractive: true, tools: ['ab'], yes: true}), deps)

    expect(runner.calls[1].opts).toMatchObject({stdout: 'capture', stdin: 'ignore'})
  })

  it('refuses a tool with no recipe, and one whose recipe has no setup steps', async () => {
    const {deps, runner} = fixture()
    const unknown = await setupTools(opts({tools: ['nope']}), deps).then(() => undefined, (e: unknown) => e as OpsError)
    expect(unknown?.code).toBe('SETUP_UNAVAILABLE')
    expect(unknown?.message).toContain('No recipe for tool "nope"')

    const bare = await setupTools(opts({tools: ['google-chrome']}), deps).then(() => undefined, (e: unknown) => e as OpsError)
    expect(bare?.code).toBe('SETUP_UNAVAILABLE')
    expect(bare?.message).toContain('has no setup steps')
    expect(runner.calls).toEqual([])
  })

  it('validates every name before running anything', async () => {
    const {deps, runner} = fixture()
    runner.on('ab doctor', {exitCode: 0})
    expect(await codeOf(setupTools(opts({tools: []}), deps))).toBe('INVALID_PACKAGE_NAME')
    expect(await codeOf(setupTools(opts({tools: ['ab', 'apt:ab']}), deps))).toBe('INVALID_PACKAGE_NAME')
    expect(await codeOf(setupTools(opts({tools: ['--force']}), deps))).toBe('INVALID_PACKAGE_NAME')
    expect(runner.calls).toEqual([])
  })

  it('deduplicates names, keeping the order given', async () => {
    const {deps, runner} = fixture()
    runner.on('ab doctor', {exitCode: 0})
    const result = await setupTools(opts({tools: ['ab', 'ab']}), deps)
    expect(result.tools).toEqual(['ab'])
    expect(lines(runner)).toEqual(['ab doctor'])
  })

  it('requires --yes when pending steps cannot be shown to a human', async () => {
    const {deps, runner} = fixture(RECIPES, {isTTY: false})
    runner.on('ab doctor', {exitCode: 1})
    expect(await codeOf(setupTools(opts({tools: ['ab']}), deps))).toBe('CONFIRMATION_REQUIRED')
    expect(lines(runner)).toEqual(['ab doctor'])

    const json = fixture()
    json.runner.on('ab doctor', {exitCode: 1})
    expect(await codeOf(setupTools(opts({json: true, tools: ['ab']}), json.deps))).toBe('CONFIRMATION_REQUIRED')
  })

  it('needs no confirmation when every step is already satisfied', async () => {
    const {deps, runner} = fixture(RECIPES, {isTTY: false})
    runner.on('ab doctor', {exitCode: 0})
    const result = await setupTools(opts({json: true, tools: ['ab']}), deps)
    expect(result.success).toBe(true)
    expect(result.steps).toEqual([{tool: 'ab', step: 'browsers', status: 'already-configured'}])
  })
})

describe('assumeInstalled', () => {
  /** A runner for which the tool's binary does not exist yet. */
  const absent = {
    async run(cmd: string) {
      throw new CommandNotFoundError(cmd)
    },
  }

  it('treats a missing binary as pending when the run is about to install it', async () => {
    // On a fresh machine `ops bootstrap` plans setup before packages has installed
    // anything, so this must be pending rather than an error that aborts the run.
    const {deps} = fixture(RECIPES, {assumeInstalled: new Set(['ab']), runner: absent})
    const result = await setupTools(opts({dryRun: true, tools: ['ab']}), deps)
    expect(result.steps[0].status).toBe('would-configure')
    expect(result.steps[0].error).toBeUndefined()
  })

  it('still reports a missing binary as failed when nothing will install it', async () => {
    const {deps} = fixture(RECIPES, {runner: absent})
    const result = await setupTools(opts({dryRun: true, tools: ['ab']}), deps)
    expect(result.steps[0].status).toBe('failed')
    expect(result.steps[0].error).toContain('ops tool install ab')
  })

  it('does not assume a tool that is not in the set', async () => {
    const {deps} = fixture(RECIPES, {assumeInstalled: new Set(['other']), runner: absent})
    const result = await setupTools(opts({dryRun: true, tools: ['ab']}), deps)
    expect(result.steps[0].status).toBe('failed')
  })
})
