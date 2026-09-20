import {CommandNotFoundError} from '#core/errors.js'
import type {RunOptions, RunResult, Runner} from '#executor/exec.js'

interface Response {
  prefix: string
  results: Partial<RunResult>[]
}

/**
 * Records calls and answers by command-line prefix ("cmd arg1 arg2 ...").
 * Results for one prefix are consumed in order; the last one repeats.
 * Later `on()` calls take precedence over earlier ones for overlapping prefixes.
 */
export class FakeRunner implements Runner {
  calls: {cmd: string; args: string[]; opts?: RunOptions}[] = []
  private responses: Response[] = []
  private absent = new Set<string>()

  /** Makes `cmd` behave as if it is not on PATH, the way execa reports ENOENT. */
  missing(cmd: string): this {
    this.absent.add(cmd)
    return this
  }

  on(prefix: string, ...results: Partial<RunResult>[]): this {
    this.responses.push({prefix, results: results.length > 0 ? results : [{}]})
    return this
  }

  async run(cmd: string, args: string[], opts?: RunOptions): Promise<RunResult> {
    if (this.absent.has(cmd)) throw new CommandNotFoundError(cmd)
    this.calls.push({cmd, args, opts})
    const line = [cmd, ...args].join(' ')
    const response = [...this.responses].reverse().find((r) => line.startsWith(r.prefix))
    if (!response) throw new Error(`FakeRunner: no response for "${line}"`)
    const result = response.results.length > 1 ? response.results.shift()! : response.results[0]
    return {stdout: '', stderr: '', exitCode: 0, ...result}
  }
}
