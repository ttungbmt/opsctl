import type {Runner} from '../../../executor/exec.js'
import {withoutVersion} from '../../package/spec.js'
import type {RecipeIndex} from '../../tool/recipe.js'
import {type SetupOptions, type SetupResult, type SetupStatus, setupTools} from '../../tool/setup.js'
import type {Change, ChangeStatus, Section, SectionContext} from '../section.js'

export interface SetupSectionDeps {
  recipes: RecipeIndex
  runner: Runner
  isTTY: boolean
}

const STATUS: Record<SetupStatus, ChangeStatus> = {
  'already-configured': 'satisfied',
  configured: 'changed',
  failed: 'failed',
  skipped: 'skipped',
  'would-configure': 'would-change',
}

const toChange = (s: SetupResult['steps'][number]): Change => ({
  id: `${s.tool}/${s.step}`,
  status: STATUS[s.status],
  ...(s.command === undefined ? {} : {command: s.command}),
  ...(s.error === undefined ? {} : {error: s.error}),
})

/** "mise:node@22" and "node@22" both name the tool "node". */
const bareName = (entry: string): string => withoutVersion(entry.replace(/^[^:]+:/, ''))

function optionsFor(ctx: SectionContext, dryRun: boolean): SetupOptions {
  return {
    dryRun,
    json: ctx.options.json,
    nonInteractive: ctx.options.nonInteractive,
    tools: ctx.profile.setup,
    // The engine already gated for the whole run.
    yes: true,
  }
}

/**
 * The `setup` section. `assumeInstalled` is what makes a bare machine work: at plan time
 * the tools this profile installs do not exist yet, and a probe that cannot find one must
 * report its step pending rather than failing the whole run before anything is installed.
 */
export function createSetupSection(deps: SetupSectionDeps): Section<SetupResult> {
  const run = async (ctx: SectionContext, dryRun: boolean): Promise<SetupResult> =>
    setupTools(optionsFor(ctx, dryRun), {
      assumeInstalled: new Set([...ctx.profile.packages, ...ctx.profile.tools].map(bareName)),
      isTTY: deps.isTTY,
      // The engine prints one plan for the whole run; a second one here would repeat it.
      onPlan: () => {},
      recipes: deps.recipes,
      runner: deps.runner,
    })

  return {
    name: 'setup',
    async plan(ctx) {
      const changes = (await run(ctx, true)).steps.map(toChange)
      return {changes, commands: changes.map((c) => c.command).filter((c) => c !== undefined), section: 'setup'}
    },
    async apply(ctx) {
      const result = await run(ctx, false)
      return {
        changes: result.steps.map(toChange),
        detail: result,
        section: 'setup',
        status: result.success ? 'ok' : 'failed',
      }
    },
  }
}
