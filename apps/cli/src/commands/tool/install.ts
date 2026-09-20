import {Args, Command, Flags, ux} from '@oclif/core'

import {loadConfig} from '../../core/config.js'
import {OpsError} from '../../core/errors.js'
import {downloadProgress, renderInstallResult} from '../../core/output.js'
import {styleFor} from '../../core/style.js'
import {type InstallResult, installPackages} from '../../core/package/install.js'
import {recipeIndex} from '../../core/tool/recipe.js'
import {execaRunner, sudoReady} from '../../executor/exec.js'
import {createAptRepoProvider} from '../../providers/apt-repo.js'
import {createDebInstaller} from '../../providers/deb.js'
import {createMiseBootstrap} from '../../providers/mise-bootstrap.js'
import {createMiseTools} from '../../providers/mise-tools.js'
import {detectSystemManager} from '../../providers/os.js'
import {type Stage, stageLabel} from '../../core/stage.js'

/**
 * Drives the terminal around the .deb work: names the file before the progress line
 * starts, then closes that line off so the spinner does not overwrite it. The progress
 * line is written with \r and never newline-terminated, hence the handover.
 */
export function stageReporter(
  write: (s: string) => void,
  showsProgress: boolean,
  start?: (label: string) => void,
  stop?: () => void,
): (stage: Stage, subject: string) => void {
  return (stage, subject) => {
    // apt prints its own download and install; a spinner repainting over it shreds both.
    if (stage === 'streaming') {
      stop?.()
      return
    }

    if (stage === 'downloading') {
      if (showsProgress) write(`downloading ${subject}\n`)
      return
    }

    // Only the .deb download leaves an unterminated \r line, so only its successor
    // has a row to hand over; repo stages must not steal a newline they never needed.
    if (stage === 'installing' && showsProgress) write('\n')
    start?.(stageLabel(stage, subject))
  }
}

export default class ToolInstall extends Command {
  static override summary = 'Install a tool'
  static override description =
    'Makes sure each tool exists on this machine; ops picks how to install it. A plain name becomes a mise tool (`mise use -g`, recorded in [tools]) when the mise registry has it. Shells and base system packages (zsh, git, curl, …) and names missing from the registry go to the OS package manager (apt or dnf) via `mise bootstrap packages`, recorded in [bootstrap.packages]. Use manager:name to pick one yourself (e.g. apt:fastfetch, brew:jq, mise:aqua:owner/repo). The system list is package.system in config/defaults.yaml; replace it (a list) or adjust it (add/remove) in ~/.config/ops/config.yaml (or $OPS_CONFIG).'
  static override examples = [
    '<%= config.bin %> tool install fastfetch',
    '<%= config.bin %> tool install zsh git --yes',
    '<%= config.bin %> tool install jq sl --dry-run',
    '<%= config.bin %> tool install apt:fastfetch mise:aqua:BurntSushi/ripgrep',
    '<%= config.bin %> tool install brew:jq --json --non-interactive',
  ]
  static override enableJsonFlag = true
  // Variadic tool names; anything that looks like an unknown flag is rejected by toPackageSpec.
  static override strict = false
  // Shown in usage/help; the full list is read from argv (strict = false).
  static override args = {
    tools: Args.string({description: 'Tool names, or manager:name to force a provider (e.g. apt:zsh, mise:jq)'}),
  }
  static override flags = {
    'dry-run': Flags.boolean({default: false, summary: 'Show what would be installed without writing config or installing'}),
    force: Flags.boolean({
      default: false,
      summary: "Reinstall through a recipe's repo when a build from somewhere else is installed",
    }),
    'non-interactive': Flags.boolean({default: false, summary: 'Never prompt (implies --yes); fail if sudo needs a password'}),
    yes: Flags.boolean({char: 'y', default: false, summary: 'Skip the confirmation prompt'}),
  }

  async run(): Promise<InstallResult> {
    const {argv, flags} = await this.parse(ToolInstall)
    const config = await loadConfig()
    // Progress goes to stderr so --json stdout stays clean, and only when someone is watching.
    const onProgress =
      this.jsonEnabled() || !process.stderr.isTTY
        ? undefined
        : downloadProgress(
            // \x1b[K erases to end of line: the bar's width varies, so padding cannot clear it.
            (line) => process.stderr.write(`\r\u001B[K${line}`),
            Date.now,
            () => process.stderr.columns || 80,
          )

    // A spinner and sudo's password prompt would fight over the terminal, so spin only
    // once sudo is known not to ask. Otherwise apt keeps streaming, as it does today.
    const mayInstall = !flags['dry-run'] && !this.jsonEnabled() && process.stderr.isTTY
    const spin = mayInstall && (await sudoReady(execaRunner))

    const result = await installPackages(
      {
        dryRun: flags['dry-run'],
        force: flags.force,
        json: this.jsonEnabled(),
        nonInteractive: flags['non-interactive'],
        packages: argv as string[],
        yes: flags.yes,
      },
      {
        deb: createDebInstaller(execaRunner),
        detectManager: () => detectSystemManager(),
        repos: createAptRepoProvider(execaRunner),
        isTTY: Boolean(process.stdin.isTTY),
        captureOutput: spin,
        mise: createMiseBootstrap(execaRunner),
        onProgress,
        onStage:
          spin || onProgress
            ? stageReporter(
                (text) => process.stderr.write(text),
                Boolean(onProgress),
                spin ? (label) => ux.action.start(label) : undefined,
                spin
                  ? () => {
                      if (ux.action.running) ux.action.stop()
                    }
                  : undefined,
              )
            : undefined,
        recipes: recipeIndex(config.tool, {repos: config.repo}),
        sudoReady: () => sudoReady(execaRunner),
        systemPreferred: new Set(config.package.system),
        tools: createMiseTools(execaRunner),
      },
    )

    if (ux.action.running) ux.action.stop()
    if (!this.jsonEnabled()) for (const line of renderInstallResult(result, styleFor(this.jsonEnabled()))) this.log(line)
    if (!result.success) process.exitCode = 1
    return result
  }

  protected override async catch(error: Error & {exitCode?: number}): Promise<unknown> {
    // oclif only stops the spinner inside super.catch(), which the OpsError branch skips;
    // a spinner left running scribbles over the very message the user needs to read.
    if (ux.action.running) ux.action.stop('failed')
    if (!(error instanceof OpsError)) return super.catch(error)
    if (this.jsonEnabled()) {
      process.exitCode = 1
      this.logJson({error: {code: error.code, message: error.message}, success: false})
      return
    }

    this.error(error.message, {code: error.code, exit: 1})
  }
}
