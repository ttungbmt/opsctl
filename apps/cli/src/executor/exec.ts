import {execa} from 'execa'

export interface RunOptions {
  /** capture (default): collect output; inherit: stream stdout/stderr to the terminal. */
  stdout?: 'capture' | 'inherit'
  stdin?: 'inherit' | 'ignore'
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

export class CommandNotFoundError extends Error {
  readonly command: string

  constructor(command: string) {
    super(`Command not found: ${command}`)
    this.name = 'CommandNotFoundError'
    this.command = command
  }
}

export const execaRunner: Runner = {
  async run(cmd, args, opts = {}) {
    const output = opts.stdout === 'inherit' ? 'inherit' : 'pipe'
    const result = await execa(cmd, args, {
      reject: false,
      stderr: output,
      stdin: opts.stdin ?? 'inherit',
      stdout: output,
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
