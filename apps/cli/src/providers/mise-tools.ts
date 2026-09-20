import {z} from 'zod'

import {CommandNotFoundError, OpsError} from '../core/errors.js'
import {type RunOptions, type RunResult, type Runner} from '../executor/exec.js'

export interface ToolState {
  /** Tool id as written in [tools], e.g. "fastfetch" or "aqua:owner/repo". */
  name: string
  installed: boolean
  version?: string
}

export interface InstallToolOptions {
  nonInteractive: boolean
  /** Capture mise's output instead of streaming it (used with --json). */
  capture: boolean
}

export interface MiseTools {
  inRegistry(name: string): Promise<boolean>
  status(): Promise<ToolState[]>
  install(names: string[], opts: InstallToolOptions): Promise<{exitCode: number}>
  dryRun(names: string[]): Promise<string[]>
  /** `mise unuse -g`: drops the request from [tools] and prunes the installation. */
  remove(names: string[], opts: InstallToolOptions): Promise<{exitCode: number}>
  /** What remove would do; `mise unuse` has no --dry-run of its own. */
  describeRemove(names: string[]): string[]
}

// Only the fields ops relies on; unknown fields are ignored.
const LsSchema = z.record(
  z.string(),
  z.array(
    z.object({
      installed: z.boolean(),
      version: z.string().nullish(),
    }),
  ),
)

/** Without an explicit version, record "latest" (like [bootstrap.packages]) instead of pinning. */
function withVersion(name: string): string {
  return /@/.test(name.slice(1)) ? name : `${name}@latest`
}

export function createMiseTools(runner: Runner): MiseTools {
  async function mise(args: string[], opts?: RunOptions): Promise<RunResult> {
    try {
      return await runner.run('mise', args, opts)
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
    throw new OpsError('MISE_COMMAND_FAILED', `mise ${args.join(' ')} failed: ${result.stderr.trim()}`)
  }

  return {
    describeRemove: (names) => names.map((name) => `mise unuse -g ${name}`),

    async dryRun(names) {
      // mise prints the plan on both streams: installs on stderr, config changes on stdout.
      const {stderr, stdout} = await checked(['use', '-g', '--dry-run', ...names.map(withVersion)])
      return `${stderr}\n${stdout}`.split('\n').map((line) => line.trim()).filter(Boolean)
    },

    async inRegistry(name) {
      const {exitCode} = await mise(['registry', name])
      return exitCode === 0
    },

    async install(names, opts) {
      const result = await mise(['use', '-g', ...names.map(withVersion)], {
        stdin: opts.nonInteractive ? 'ignore' : 'inherit',
        stdout: opts.capture ? 'capture' : 'inherit',
      })
      return {exitCode: result.exitCode}
    },

    /**
     * Bare names, never withVersion(): `mise unuse` matches the configured request
     * literally, so "node@latest" would miss a config that says node = "lts".
     */
    async remove(names, opts) {
      const result = await mise(['unuse', '-g', ...names], {
        stdin: opts.nonInteractive ? 'ignore' : 'inherit',
        stdout: opts.capture ? 'capture' : 'inherit',
      })
      return {exitCode: result.exitCode}
    },

    async status() {
      const {stdout} = await checked(['ls', '-g', '--json'])
      let parsed: z.infer<typeof LsSchema>
      try {
        parsed = LsSchema.parse(JSON.parse(stdout))
      } catch (error) {
        throw new OpsError('MISE_BOOTSTRAP_UNAVAILABLE', `Unexpected output from mise ls -g --json: ${(error as Error).message}`)
      }

      return Object.entries(parsed).map(([name, versions]) => {
        const installed = versions.find((v) => v.installed)
        return {installed: Boolean(installed), name, version: installed?.version ?? undefined}
      })
    },
  }
}
