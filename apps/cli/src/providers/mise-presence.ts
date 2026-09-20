import {z} from 'zod'

import {CommandNotFoundError} from '#core/errors.js'
import type {Runner} from '#executor/exec.js'

/**
 * Whether the `mise` binary is where a subprocess would find it. Three states rather than a
 * boolean: "missing" and "there but not answering" call for opposite responses, and the
 * preflight installs only for the first.
 */
export type MiseState =
  | {state: 'present'; version: string}
  | {state: 'unhealthy'; exitCode: number; detail: string}
  | {state: 'absent'}

/** A wedged mise must not hold the CLI open; a healthy one answers in milliseconds. */
export const PROBE_TIMEOUT_MS = 10_000

/**
 * Asks exactly the question execa will ask later: is there a `mise` on PATH, and does it run?
 * Spawning is the only faithful probe -- walking PATH in core answers a different question,
 * since it cannot see the exec bit, a dangling shim, or an unreadable interpreter.
 *
 * CommandNotFoundError is the ONLY signal for "absent". A non-zero exit means mise exists and
 * is broken, which is a different repair: installing over it would be the wrong one, and the
 * provider that needs it fails in its own, more specific words.
 */
export async function probeMise(runner: Runner, timeout: number = PROBE_TIMEOUT_MS): Promise<MiseState> {
  let result
  try {
    result = await runner.run('mise', ['--version'], {stdin: 'ignore', stdout: 'capture', timeout})
  } catch (error) {
    if (error instanceof CommandNotFoundError) return {state: 'absent'}
    throw error
  }

  if (result.exitCode !== 0) {
    return {
      detail: result.stderr.trim() || result.stdout.trim() || `mise --version exited ${result.exitCode}`,
      exitCode: result.exitCode,
      state: 'unhealthy',
    }
  }

  // "2026.9.11 linux-x64 (a1b2c3d 2026-09-11)" -- the first token is the version.
  return {state: 'present', version: result.stdout.trim().split(/\s+/)[0] ?? ''}
}

/** Whether a tool mise installed can actually be called from a shell. */
export interface MiseReach {
  /** mise's shell hook is installed, so it rewrites PATH per directory. */
  activated: boolean
  /** The shims directory is on PATH, which makes tools callable without the hook. */
  shimsOnPath: boolean
}

// Only the two fields that decide reachability; mise reports dozens more.
const DoctorSchema = z.looseObject({activated: z.boolean(), shims_on_path: z.boolean()})

/**
 * Asks mise whether its tools are reachable. Both axes, because either one alone is enough:
 * a machine with the shims directory on PATH works without the shell hook, and vice versa.
 *
 * Returns undefined whenever mise cannot answer -- an older mise has no `doctor --json`, and
 * a probe that failed is not evidence of a problem. ops must not nag on a guess.
 */
export async function probeMiseReach(runner: Runner, timeout: number = PROBE_TIMEOUT_MS): Promise<MiseReach | undefined> {
  let stdout: string
  try {
    const result = await runner.run('mise', ['doctor', '--json'], {stdin: 'ignore', stdout: 'capture', timeout})
    if (result.exitCode !== 0) return undefined
    stdout = result.stdout
  } catch (error) {
    if (error instanceof CommandNotFoundError) return undefined
    throw error
  }

  try {
    const parsed = DoctorSchema.parse(JSON.parse(stdout))
    return {activated: parsed.activated, shimsOnPath: parsed.shims_on_path}
  } catch {
    return undefined
  }
}
