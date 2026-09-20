import {Command} from '@oclif/core'

import {loadConfig} from '#core/config.js'
import {OpsError} from '#core/errors.js'
import {renderProfileList} from '#core/output.js'
import {type ProfileSummary, profileIndex} from '#core/profile/resolve.js'
import {styleFor} from '#core/style.js'
import {recipeIndex} from '#core/tool/recipe.js'

export default class ProfileList extends Command {
  static override summary = 'List the machine profiles this config defines'
  static override description =
    'Profiles are `profile.<name>` in config/defaults.yaml, extended or replaced in ~/.config/ops/config.yaml (or $OPS_CONFIG). `ops bootstrap <name>` converges the machine to one; `ops profile show <name>` prints what it resolves to.'
  static override examples = ['<%= config.bin %> profile list', '<%= config.bin %> profile list --json']
  static override enableJsonFlag = true

  async run(): Promise<ProfileSummary[]> {
    const config = await loadConfig()
    const profiles = profileIndex(config.profile, {recipes: recipeIndex(config.tool, {repos: config.repo})}).list()
    if (!this.jsonEnabled()) for (const line of renderProfileList(profiles, styleFor(false))) this.log(line)
    return profiles
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
