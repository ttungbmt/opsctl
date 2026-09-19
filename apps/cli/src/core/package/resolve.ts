import type {SystemManager} from '../../providers/os.js'
import {type PackageSpec, TOOL_MANAGER, toPackageSpec} from './spec.js'

/**
 * Plain names that go to the OS package manager even when the mise registry has them:
 * shells and base system packages that other software expects at system paths.
 */
export const SYSTEM_PREFERRED: ReadonlySet<string> = new Set([
  'bash',
  'build-essential',
  'ca-certificates',
  'curl',
  'fish',
  'git',
  'openssh-client',
  'tmux',
  'unzip',
  'wget',
  'zsh',
])

export interface ResolveDeps {
  detectManager: () => Promise<SystemManager>
  inRegistry: (name: string) => Promise<boolean>
}

/**
 * Turns user input into specs. `manager:package` is kept as is; a plain name becomes
 * `apt:`/`dnf:` if system-preferred, else `mise:` if the mise registry knows it, else `apt:`/`dnf:`.
 */
export async function resolveSpecs(inputs: string[], deps: ResolveDeps): Promise<PackageSpec[]> {
  let manager: Promise<SystemManager> | undefined
  const system = (name: string) => {
    manager ??= deps.detectManager()
    return manager.then((m) => toPackageSpec(name, m))
  }

  const specs: PackageSpec[] = []
  for (const input of inputs) {
    if (input.includes(':')) specs.push(toPackageSpec(input))
    else if (SYSTEM_PREFERRED.has(input)) specs.push(await system(input))
    else {
      // Validate before handing the name to `mise registry`.
      toPackageSpec(input, TOOL_MANAGER)
      specs.push(await deps.inRegistry(input) ? `${TOOL_MANAGER}:${input}` : await system(input))
    }
  }

  return [...new Set(specs)]
}
