import {execa} from 'execa'

import {CommandNotFoundError} from '#core/errors.js'

export interface RunOptions {
  /** capture (default): collect output; inherit: stream stdout/stderr to the terminal. */
  stdout?: 'capture' | 'inherit'
  stdin?: 'inherit' | 'ignore'
  /** Milliseconds before the command is killed; the result then carries a non-zero exit. */
  timeout?: number
  /** Added to the ambient environment, not replacing it. For output a parser must read, e.g. LC_ALL=C. */
  env?: Record<string, string>
}

export interface RunResult {
  stdout: string
  stderr: string
  exitCode: number
}

export interface Runner {
  /** Never throws on a non-zero exit; throws CommandNotFoundError if the binary does not exist. */
  run(cmd: string, args: string[], opts?: RunOptions): Promise<RunResult>
}

export const execaRunner: Runner = {
  async run(cmd, args, opts = {}) {
    const output = opts.stdout === 'inherit' ? 'inherit' : 'pipe'
    const result = await execa(cmd, args, {
      reject: false,
      stderr: output,
      stdin: opts.stdin ?? 'inherit',
      stdout: output,
      ...(opts.timeout === undefined ? {} : {timeout: opts.timeout}),
      ...(opts.env === undefined ? {} : {env: opts.env}),
    })

    if ((result as {code?: string}).code === 'ENOENT') throw new CommandNotFoundError(cmd)

    return {
      exitCode: result.exitCode ?? 1,
      stderr: typeof result.stderr === 'string' ? result.stderr : '',
      stdout: typeof result.stdout === 'string' ? result.stdout : '',
    }
  },
}

/** True when privileged commands can run without a password prompt. */
export async function sudoReady(runner: Runner, uid: number | undefined = process.getuid?.()): Promise<boolean> {
  if (uid === 0) return true
  try {
    const result = await runner.run('sudo', ['-n', 'true'], {stdin: 'ignore'})
    return result.exitCode === 0
  } catch {
    return false
  }
}
