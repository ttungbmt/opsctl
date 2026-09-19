import {OpsError} from '../errors.js'

export type PackageSpec = `${string}:${string}`

// A part must be non-empty, contain no whitespace, and not start with "-"
// (so it can never be read as an option by mise or the package manager).
const PART = /^[^\s-]\S*$/

export function toPackageSpec(input: string, manager?: string): PackageSpec {
  const colon = input.indexOf(':')
  const [mgr, name] = colon === -1 ? [manager, input] : [input.slice(0, colon), input.slice(colon + 1)]

  if (mgr === undefined) {
    throw new OpsError('INVALID_PACKAGE_NAME', `No package manager for "${input}"; use manager:package`)
  }

  if (!PART.test(mgr) || !PART.test(name)) {
    throw new OpsError('INVALID_PACKAGE_NAME', `Invalid package name: "${input}"`)
  }

  return `${mgr}:${name}`
}

export function managerOf(spec: PackageSpec): string {
  return spec.slice(0, spec.indexOf(':'))
}

/** Manager prefix for mise tools (`mise use -g`); every other prefix is a `mise bootstrap packages` manager. */
export const TOOL_MANAGER = 'mise'

export function isToolSpec(spec: PackageSpec): boolean {
  return managerOf(spec) === TOOL_MANAGER
}

/** "mise:fastfetch" → "fastfetch"; "mise:aqua:owner/repo" → "aqua:owner/repo". */
export function toolName(spec: PackageSpec): string {
  return spec.slice(spec.indexOf(':') + 1)
}

/** The key mise uses for the tool in [tools] and `mise ls`: the name without an "@version" suffix. */
export function toolKey(spec: PackageSpec): string {
  const name = toolName(spec)
  const at = name.indexOf('@', 1)
  return at === -1 ? name : name.slice(0, at)
}
