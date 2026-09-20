import {Args, Command, Flags, ux} from '@oclif/core'

import {buildSections} from '../core/bootstrap/registry.js'
import {type BootstrapOptions, type BootstrapResult, bootstrapProfile, haltedBeforePlan} from '../core/bootstrap/run.js'
import {SECTION_ORDER, type SectionName, loadConfig} from '../core/config.js'
import {OpsError} from '../core/errors.js'
import {
  downloadProgress,
  renderBootstrapPlan,
  renderBootstrapResult,
  renderPreflight,
  renderPreflightPlan,
  stageReporter,
} from '../core/output.js'
import {type PreflightResult, ensureMise} from '../core/preflight.js'
import {profileIndex} from '../core/profile/resolve.js'
import {styleFor} from '../core/style.js'
import {recipeIndex} from '../core/tool/recipe.js'
import {execaRunner, sudoReady} from '../executor/exec.js'
import {createAptRepoProvider} from '../providers/apt-repo.js'
import {createDebInstaller} from '../providers/deb.js'
import {createMiseBootstrap} from '../providers/mise-bootstrap.js'
import {createMiseInstaller} from '../providers/mise-install.js'
import {probeMise} from '../providers/mise-presence.js'
import {createMiseTools} from '../providers/mise-tools.js'
import {detectSystemManager} from '../providers/os.js'

/**
 * What `ops bootstrap` runs with no argument. A constant rather than config data because
 * it is fixed by design: a user who wants a different set redefines profile.minimal,
 * which merges by name like every other built-in.
 */
const DEFAULT_PROFILE = 'minimal'

export default class Bootstrap extends Command {
  static override summary = 'Converge this machine to a profile'
  static override description =
    'A profile names what a machine should have: system packages, mise tools, and tool setup steps. ops inspects every section first, shows one plan for the whole run, then applies only what is missing and verifies it -- so running it twice reports that everything is already satisfied. A failed section stops the run and the sections after it are reported skipped. Profiles are `profile.<name>` in config/defaults.yaml, extended or replaced in ~/.config/ops/config.yaml (or $OPS_CONFIG); `extends` composes them and `ops profile show` prints the result. With no name it runs "minimal". Note that the plan is advisory for system packages: one installed but never declared to ops shows as pending and comes back already satisfied once the run declares it.'
  static override examples = [
    '<%= config.bin %> bootstrap',
    '<%= config.bin %> bootstrap dev --dry-run',
    '<%= config.bin %> bootstrap dev --yes',
    '<%= config.bin %> bootstrap dev --only tools --yes',
    '<%= config.bin %> bootstrap dev --json --non-interactive',
  ]
  static override enableJsonFlag = true
  // One optional positional; unlike `tool install` there is nothing variadic to accept.
  static override strict = true
  static override args = {
    profile: Args.string({description: 'Profile name (see `ops profile list`)', required: false}),
  }
  static override flags = {
    'dry-run': Flags.boolean({default: false, summary: 'Inspect every section and show the plan, without changing anything'}),
    force: Flags.boolean({default: false, summary: "Reinstall through a recipe's repo even when a build from elsewhere is installed"}),
    'non-interactive': Flags.boolean({default: false, summary: 'Never prompt (implies --yes)'}),
    preflight: Flags.boolean({
      allowNo: true,
      default: true,
      summary: 'Install mise first when it is missing (--no-preflight to skip)',
    }),
    only: Flags.string({
      default: [],
      exclusive: ['skip'],
      multiple: true,
      options: [...SECTION_ORDER],
      summary: 'Run only these sections',
    }),
    skip: Flags.string({default: [], multiple: true, options: [...SECTION_ORDER], summary: 'Skip these sections'}),
    yes: Flags.boolean({char: 'y', default: false, summary: 'Skip the confirmation prompt'}),
  }

  async run(): Promise<BootstrapResult> {
    const {args, flags} = await this.parse(Bootstrap)
    const config = await loadConfig()
    const recipes = recipeIndex(config.tool, {repos: config.repo})

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
    // once sudo is known not to ask.
    const mayInstall = !flags['dry-run'] && !this.jsonEnabled() && process.stderr.isTTY
    const spin = mayInstall && (await sudoReady(execaRunner))
    const stopSpinner = () => {
      if (ux.action.running) ux.action.stop()
    }

    const options: BootstrapOptions = {
      dryRun: flags['dry-run'],
      force: flags.force,
      json: this.jsonEnabled(),
      nonInteractive: flags['non-interactive'],
      only: flags.only as SectionName[],
      profile: args.profile ?? DEFAULT_PROFILE,
      skip: flags.skip as SectionName[],
      yes: flags.yes,
    }

    // Named, because the preflight drives the same spinner the sections do.
    const onStage =
      spin || onProgress
        ? stageReporter(
            (text) => process.stderr.write(text),
            Boolean(onProgress),
            spin ? (label) => ux.action.start(label) : undefined,
            spin ? stopSpinner : undefined,
          )
        : undefined

    const profiles = profileIndex(config.profile, {recipes})
    // Resolved before the preflight: a mistyped profile name is more useful to hear about
    // than a prerequisite install, and resolving needs no mise.
    const profile = profiles.resolve(options.profile)

    let preflight: PreflightResult | undefined
    if (flags.preflight) {
      preflight = await ensureMise(options, {
        captureOutput: spin,
        installer: config.mise && createMiseInstaller(execaRunner, config.mise),
        isTTY: Boolean(process.stdout.isTTY),
        onPlan: (changes) => {
          if (!this.jsonEnabled()) for (const line of renderPreflightPlan(changes, styleFor(false))) this.log(line)
        },
        onProgress,
        onStage,
        probe: () => probeMise(execaRunner),
        sudoReady: () => sudoReady(execaRunner),
      })

      stopSpinner()
      if (!this.jsonEnabled()) for (const line of renderPreflight(preflight, styleFor(false))) this.log(line)

      // Without mise no section can even be inspected, so there is no plan to show. Exit 1:
      // printing a partial picture beside exit 0 would tell a script it saw everything.
      if (!preflight.satisfied) {
        process.exitCode = 1
        return haltedBeforePlan(profile, options, preflight)
      }
    }

    const result = await bootstrapProfile(options, {
      isTTY: Boolean(process.stdout.isTTY),
      onPlan: (plans) => {
        if (!this.jsonEnabled()) for (const line of renderBootstrapPlan(plans, styleFor(false))) this.log(line)
      },
      // A section is about to run its own subprocesses; the spinner must let go of the row.
      onSection: stopSpinner,
      profiles,
      sections: buildSections({
        install: {
          captureOutput: spin,
          deb: createDebInstaller(execaRunner),
          detectManager: () => detectSystemManager(),
          isTTY: Boolean(process.stdin.isTTY),
          mise: createMiseBootstrap(execaRunner),
          onProgress,
          onStage,
          recipes,
          repos: createAptRepoProvider(execaRunner),
          sudoReady: () => sudoReady(execaRunner),
          systemPreferred: new Set(config.package.system),
          tools: createMiseTools(execaRunner),
        },
        setup: {isTTY: Boolean(process.stdout.isTTY), recipes, runner: execaRunner},
      }),
    })

    stopSpinner()
    if (preflight) result.preflight = preflight
    if (!this.jsonEnabled()) for (const line of renderBootstrapResult(result, styleFor(this.jsonEnabled()))) this.log(line)
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
