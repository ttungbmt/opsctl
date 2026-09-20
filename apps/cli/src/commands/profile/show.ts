import {Args, Command, Flags} from '@oclif/core'

import {type Profile, loadConfig} from '#core/config.js'
import {OpsError} from '#core/errors.js'
import {renderProfileShow} from '#core/output.js'
import {type ResolvedProfile, profileIndex} from '#core/profile/resolve.js'
import {styleFor} from '#core/style.js'
import {recipeIndex} from '#core/tool/recipe.js'

export default class ProfileShow extends Command {
  static override summary = 'Show a profile, composed through its extends chain'
  static override description =
    'By default this prints what `ops bootstrap <name>` would actually work from: every section after `extends` composition, with the profiles that contributed. `--raw` prints the literal profile.<name> entry instead, which is what you edit.'
  static override examples = [
    '<%= config.bin %> profile show dev',
    '<%= config.bin %> profile show dev --raw',
    '<%= config.bin %> profile show dev --json',
  ]
  static override enableJsonFlag = true
  static override strict = true
  static override args = {
    name: Args.string({description: 'Profile name', required: true}),
  }
  static override flags = {
    raw: Flags.boolean({default: false, summary: 'Print the literal config entry, before extends composition'}),
  }

  async run(): Promise<Profile | ResolvedProfile> {
    const {args, flags} = await this.parse(ProfileShow)
    const config = await loadConfig()
    const profiles = profileIndex(config.profile, {recipes: recipeIndex(config.tool, {repos: config.repo})})

    if (flags.raw) {
      const raw = profiles.raw(args.name)
      if (!raw) {
        throw new OpsError(
          'PROFILE_NOT_FOUND',
          `No profile "${args.name}"; available: ${profiles.names().join(', ') || '(none)'}`,
        )
      }

      if (!this.jsonEnabled()) this.log(JSON.stringify(raw, undefined, 2))
      return raw
    }

    const profile = profiles.resolve(args.name)
    if (!this.jsonEnabled()) for (const line of renderProfileShow(profile, styleFor(false))) this.log(line)
    return profile
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
