import {Args, Command, Flags} from '@oclif/core'

import {loadConfig} from '../../core/config.js'
import {OpsError} from '../../core/errors.js'
import {renderUninstallPlan, renderUninstallResult} from '../../core/output.js'
import {type UninstallResult, uninstallPackages} from '../../core/package/uninstall.js'
import {styleFor} from '../../core/style.js'
import {recipeIndex} from '../../core/tool/recipe.js'
import {execaRunner, sudoReady} from '../../executor/exec.js'
import {createMiseDeclarations} from '../../providers/mise-config.js'
import {createMiseTools} from '../../providers/mise-tools.js'
import {detectSystemManager} from '../../providers/os.js'
import {createPathRemover} from '../../providers/paths.js'
import {createSystemPackages} from '../../providers/system.js'

export default class ToolUninstall extends Command {
  static override summary = 'Remove an installed tool'
  static override description =
    'Removes a tool and the declaration ops wrote when it installed it, so a later `ops bootstrap` does not bring it back. A mise tool goes through `mise unuse -g`; a system package through apt/dnf, after a simulation that refuses the removal if it would take other packages with it. `--purge` additionally deletes what the package manager does not own -- the apt source and keyring a vendor .deb wrote, and the tool\'s own config and cache -- from `tool.<name>.uninstall.purge.paths` in the config. Because those files are outside any package manager, --purge always requires --yes. Nothing is removed until the plan has been printed.'
  static override examples = [
    '<%= config.bin %> tool uninstall google-chrome',
    '<%= config.bin %> tool uninstall google-chrome --purge --yes',
    '<%= config.bin %> tool uninstall fastfetch --dry-run',
    '<%= config.bin %> tool uninstall zsh --json --non-interactive',
  ]
  static override enableJsonFlag = true
  // Variadic tool names; anything that looks like an unknown flag is rejected by toPackageSpec.
  static override strict = false
  // Shown in usage/help; the full list is read from argv (strict = false).
  static override args = {
    tools: Args.string({description: 'Tool names, or manager:name to force a provider (e.g. apt:zsh, mise:jq)'}),
  }
  static override flags = {
    'dry-run': Flags.boolean({default: false, summary: 'Show what would be removed without changing anything'}),
    'non-interactive': Flags.boolean({default: false, summary: 'Never prompt (implies --yes); fail if sudo needs a password'}),
    purge: Flags.boolean({default: false, summary: "Also delete the tool's config, cache and install traces (requires --yes)"}),
    yes: Flags.boolean({char: 'y', default: false, summary: 'Skip the confirmation prompt'}),
  }

  async run(): Promise<UninstallResult> {
    const {argv, flags} = await this.parse(ToolUninstall)
    const config = await loadConfig()
    const style = styleFor(this.jsonEnabled())

    const result = await uninstallPackages(
      {
        dryRun: flags['dry-run'],
        json: this.jsonEnabled(),
        nonInteractive: flags['non-interactive'],
        packages: argv as string[],
        purge: flags.purge,
        yes: flags.yes,
      },
      {
        declarations: createMiseDeclarations(execaRunner),
        detectManager: () => detectSystemManager(),
        // stdout, not stdin: the question is whether a human can read the plan.
        isTTY: Boolean(process.stdout.isTTY),
        onPlan: (plan) => {
          if (!this.jsonEnabled()) for (const line of renderUninstallPlan(plan, style)) this.log(line)
        },
        paths: createPathRemover(execaRunner),
        recipes: recipeIndex(config.tool, {repos: config.repo}),
        sudoReady: () => sudoReady(execaRunner),
        system: createSystemPackages(execaRunner, await detectSystemManager()),
        systemPreferred: new Set(config.package.system),
        tools: createMiseTools(execaRunner),
      },
    )

    if (!this.jsonEnabled()) for (const line of renderUninstallResult(result, style)) this.log(line)
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
