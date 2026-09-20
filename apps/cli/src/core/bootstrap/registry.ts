import type {InstallDeps} from '#core/package/install.js'
import type {SectionRegistry} from './section.js'
import {createInstallSection} from './sections/install.js'
import {type SetupSectionDeps, createSetupSection} from './sections/setup.js'

export interface RegistryDeps {
  install: InstallDeps
  setup: SetupSectionDeps
}

/**
 * The sections this build can run. Providers arrive as arguments rather than being
 * reached for, so this stays in core and a test can assert the list without loading
 * oclif. A later phase adds one entry here and touches nothing in run.ts.
 */
export function buildSections(deps: RegistryDeps): SectionRegistry {
  return {
    packages: createInstallSection('packages', deps.install),
    setup: createSetupSection(deps.setup),
    tools: createInstallSection('tools', deps.install),
  }
}
