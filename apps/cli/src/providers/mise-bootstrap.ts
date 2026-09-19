import {z} from 'zod'

import {OpsError} from '../core/errors.js'
import type {PackageSpec} from '../core/package/spec.js'
import {CommandNotFoundError, type RunOptions, type RunResult, type Runner} from '../executor/exec.js'

export interface PackageState {
  spec: PackageSpec
  installed: boolean
  version?: string
}

export interface ApplyOptions {
  yes: boolean
  nonInteractive: boolean
  /** Capture mise's output instead of streaming it (used with --json). */
  capture: boolean
}

export interface MiseBootstrap {
  declare(specs: PackageSpec[]): Promise<void>
  status(): Promise<PackageState[]>
  apply(specs: PackageSpec[], opts: ApplyOptions): Promise<{exitCode: number}>
  dryRun(specs: PackageSpec[]): Promise<string[]>
}

// Only the fields ops relies on; unknown fields are ignored.
const StatusSchema = z.record(
  z.string(),
  z.object({
    packages: z
      .array(
        z.object({
          installed_version: z.string().nullish(),
          package: z.string(),
          state: z.string(),
        }),
      )
      .default([]),
  }),
)

const BASE = ['bootstrap', 'packages']

export function createMiseBootstrap(runner: Runner): MiseBootstrap {
  async function mise(args: string[], opts?: RunOptions): Promise<RunResult> {
    try {
      return await runner.run('mise', [...BASE, ...args], opts)
    } catch (error) {
      if (error instanceof CommandNotFoundError) {
        throw new OpsError('MISE_BOOTSTRAP_UNAVAILABLE', 'mise not found on PATH; install it from https://mise.jdx.dev')
      }

      throw error
    }
  }

  async function checked(args: string[]): Promise<RunResult> {
    const result = await mise(args)
    if (result.exitCode === 0) return result
    if (/unrecognized subcommand/.test(result.stderr)) {
      throw new OpsError('MISE_BOOTSTRAP_UNAVAILABLE', 'This mise version has no `mise bootstrap packages`; upgrade mise (mise self-update)')
    }

    throw new OpsError('MISE_COMMAND_FAILED', `mise ${[...BASE, ...args].join(' ')} failed: ${result.stderr.trim()}`)
  }

  return {
    async apply(specs, opts) {
      const result = await mise(['apply', ...(opts.yes ? ['--yes'] : []), ...specs], {
        stdin: opts.nonInteractive ? 'ignore' : 'inherit',
        stdout: opts.capture ? 'capture' : 'inherit',
      })
      return {exitCode: result.exitCode}
    },

    async declare(specs) {
      await checked(['use', '-g', '--no-install', ...specs])
    },

    async dryRun(specs) {
      const {stdout} = await checked(['use', '-g', '--dry-run', ...specs])
      return stdout.split('\n').map((line) => line.trim()).filter(Boolean)
    },

    async status() {
      const {stdout} = await checked(['status', '--json'])
      let parsed: z.infer<typeof StatusSchema>
      try {
        parsed = StatusSchema.parse(JSON.parse(stdout))
      } catch (error) {
        throw new OpsError('MISE_BOOTSTRAP_UNAVAILABLE', `Unexpected output from mise bootstrap packages status --json: ${(error as Error).message}`)
      }

      return Object.entries(parsed).flatMap(([manager, {packages}]) =>
        packages.map((p) => ({
          installed: p.state === 'installed',
          spec: `${manager}:${p.package}` as PackageSpec,
          version: p.installed_version ?? undefined,
        })),
      )
    },
  }
}
