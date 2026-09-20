import {Args, Command, Flags} from '@oclif/core'

import {loadConfig} from '../../core/config.js'
import {OpsError} from '../../core/errors.js'
import {renderSetupPlan, renderSetupResult} from '../../core/output.js'
import {recipeIndex} from '../../core/tool/recipe.js'
import {type SetupResult, setupTools} from '../../core/tool/setup.js'
import {execaRunner} from '../../executor/exec.js'

export default class ToolSetup extends Command {
  static override summary = 'Configure an installed tool'
  static override description =
    'Installing a tool makes it exist; setting it up makes it behave. Each tool named in the config as `tool.<name>.setup` carries an ordered list of steps, and every step has a `check` (exit 0 means it is already done) and a `run` that makes the check pass. ops runs the checks first, shows what is missing, applies only those steps, then re-runs each check to verify it. Steps come from `config/defaults.yaml` and can be replaced or added in ~/.config/ops/config.yaml (or $OPS_CONFIG).'
  static override examples = [
    '<%= config.bin %> tool setup agent-browser',
    '<%= config.bin %> tool setup agent-browser --dry-run',
    '<%= config.bin %> tool setup agent-browser --json --yes',
  ]
  static override enableJsonFlag = true
  // Variadic tool names; anything that looks like an unknown flag is rejected by setupTools.
  static override strict = false
  // Shown in usage/help; the full list is read from argv (strict = false).
  static override args = {
    tools: Args.string({description: 'Tool names to configure (e.g. agent-browser)'}),
  }
  static override flags = {
    'dry-run': Flags.boolean({default: false, summary: 'Run the checks and show what would be configured, without changing anything'}),
    'non-interactive': Flags.boolean({default: false, summary: 'Never prompt (implies --yes); a step that needs input fails instead of waiting'}),
    yes: Flags.boolean({char: 'y', default: false, summary: 'Skip the confirmation prompt'}),
  }

  async run(): Promise<SetupResult> {
    const {argv, flags} = await this.parse(ToolSetup)
    const config = await loadConfig()
    const result = await setupTools(
      {
        dryRun: flags['dry-run'],
        json: this.jsonEnabled(),
        nonInteractive: flags['non-interactive'],
        tools: argv as string[],
        yes: flags.yes,
      },
      {
        // stdout, not stdin: the question is whether a human can read the plan.
        isTTY: Boolean(process.stdout.isTTY),
        onPlan: (pending) => {
          if (!this.jsonEnabled()) for (const line of renderSetupPlan(pending)) this.log(line)
        },
        recipes: recipeIndex(config.tool, {repos: config.repo}),
        runner: execaRunner,
      },
    )

    if (!this.jsonEnabled()) for (const line of renderSetupResult(result)) this.log(line)
    if (!result.success) process.exitCode = 1
    return result
  }

  protected override async catch(error: Error & {exitCode?: number}): Promise<unknown> {
    if (!(error instanceof OpsError)) return super.catch(error)
    if (this.jsonEnabled()) {
      process.exitCode = 1
      this.logJson({error: {code: error.code, message: error.message}, success: false})
      return
    }

    this.error(error.message, {code: error.code, exit: 1})
  }
}
