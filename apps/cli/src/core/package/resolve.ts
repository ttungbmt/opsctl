import type {SystemManager} from '../../providers/os.js'
import type {Recipe} from '../tool/recipe.js'
import {type PackageSpec, TOOL_MANAGER, toPackageSpec} from './spec.js'

export interface ResolveDeps {
  /** Plain names sent to apt/dnf even when the registry has them (`package.system` in the config). */
  systemPreferred: ReadonlySet<string>
  detectManager: () => Promise<SystemManager>
  inRegistry: (name: string) => Promise<boolean>
  /** Named recipes (`tool.<name>` in the config); they know the real package name. */
  recipe?: (name: string) => Recipe | undefined
}

/**
 * Turns user input into specs. `manager:package` is kept as is; a plain name becomes the
 * package of its recipe, else `apt:`/`dnf:` if system-preferred, else `mise:` if the mise
 * registry knows it, else `apt:`/`dnf:`.
 */
export async function resolveSpecs(inputs: string[], deps: ResolveDeps): Promise<PackageSpec[]> {
  let manager: Promise<SystemManager> | undefined
  const system = (name: string) => {
    manager ??= deps.detectManager()
    return manager.then((m) => toPackageSpec(name, m))
  }

  const specs: PackageSpec[] = []
  for (const input of inputs) {
    // An explicit manager prefix always wins; a recipe beats every heuristic below it.
    const explicit = input.includes(':')
    const recipe = explicit ? undefined : deps.recipe?.(input)

    if (explicit) specs.push(toPackageSpec(input))
    else if (recipe) specs.push(toPackageSpec(recipe.package))
    else if (deps.systemPreferred.has(input)) specs.push(await system(input))
    else {
      // Validate before handing the name to `mise registry`.
      toPackageSpec(input, TOOL_MANAGER)
      specs.push(await deps.inRegistry(input) ? `${TOOL_MANAGER}:${input}` : await system(input))
    }
  }

  return [...new Set(specs)]
}
