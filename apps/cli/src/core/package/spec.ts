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
