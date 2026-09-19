import {Args, Command, Flags} from '@oclif/core'

import {OpsError} from '../../core/errors.js'
import {renderInstallResult} from '../../core/output.js'
import {type InstallResult, installPackages} from '../../core/package/install.js'
import {execaRunner, sudoReady} from '../../executor/exec.js'
import {createMiseBootstrap} from '../../providers/mise-bootstrap.js'
import {createMiseTools} from '../../providers/mise-tools.js'
import {detectSystemManager} from '../../providers/os.js'

export default class PackageInstall extends Command {
  static override summary = 'Install packages'
  static override description =
    'A plain name is installed as a mise tool (`mise use -g`, recorded in [tools]) when the mise registry has it. Shells and base system packages (zsh, git, curl, …) and names missing from the registry go to the OS package manager (apt or dnf) via `mise bootstrap packages`, recorded in [bootstrap.packages]. Use manager:package to pick one (e.g. apt:fastfetch, brew:jq, mise:aqua:owner/repo).'
  static override examples = [
    '<%= config.bin %> package install fastfetch',
    '<%= config.bin %> package install zsh git --yes',
    '<%= config.bin %> package install jq sl --dry-run',
    '<%= config.bin %> package install apt:fastfetch mise:aqua:BurntSushi/ripgrep',
    '<%= config.bin %> package install brew:jq --json --non-interactive',
  ]
  static override enableJsonFlag = true
  // Variadic package names; anything that looks like an unknown flag is rejected by toPackageSpec.
  static override strict = false
  // Shown in usage/help; the full list is read from argv (strict = false).
  static override args = {
    packages: Args.string({description: 'Package names (mise tool if in the registry, else apt/dnf) or manager:package (e.g. apt:zsh, mise:jq)'}),
  }
  static override flags = {
    'dry-run': Flags.boolean({default: false, summary: 'Show what would be installed without writing config or installing'}),
    'non-interactive': Flags.boolean({default: false, summary: 'Never prompt (implies --yes); fail if sudo needs a password'}),
    yes: Flags.boolean({char: 'y', default: false, summary: 'Skip the confirmation prompt'}),
  }

  async run(): Promise<InstallResult> {
    const {argv, flags} = await this.parse(PackageInstall)
    const result = await installPackages(
      {
        dryRun: flags['dry-run'],
        json: this.jsonEnabled(),
        nonInteractive: flags['non-interactive'],
        packages: argv as string[],
        yes: flags.yes,
      },
      {
        detectManager: () => detectSystemManager(),
        isTTY: Boolean(process.stdin.isTTY),
        mise: createMiseBootstrap(execaRunner),
        sudoReady: () => sudoReady(execaRunner),
        tools: createMiseTools(execaRunner),
      },
    )

    if (!this.jsonEnabled()) for (const line of renderInstallResult(result)) this.log(line)
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
