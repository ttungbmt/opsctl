import {ux} from '@oclif/core'
import {afterEach, describe, expect, it} from 'vitest'
import Bootstrap from '../../src/commands/bootstrap.js'
import {SECTION_ORDER} from '../../src/core/config.js'
import {OpsError} from '../../src/core/errors.js'

/** The command with just enough oclif around it to call catch() directly. */
function command(json = false): Bootstrap {
  const cmd = new Bootstrap([], {runHook: async () => ({successes: [], failures: []})} as never)
  Object.defineProperty(cmd, 'jsonEnabled', {value: () => json})
  // this.error() would exit the process; swallow it so the assertion can run.
  Object.defineProperty(cmd, 'error', {value: () => undefined})
  return cmd
}

/** catch() is protected; the test drives it the way oclif does. */
const runCatch = (cmd: Bootstrap, error: Error) =>
  (cmd as unknown as {catch(e: Error): Promise<unknown>}).catch(error).catch(() => undefined)

afterEach(() => {
  if (ux.action.running) ux.action.stop()
})

describe('Bootstrap flags', () => {
  it('restricts --only and --skip to real section names', () => {
    // oclif then rejects a misspelled section at parse time, so core validates nothing.
    expect(Bootstrap.flags.only.options).toEqual([...SECTION_ORDER])
    expect(Bootstrap.flags.skip.options).toEqual([...SECTION_ORDER])
    // Letting both through would make their intersection meaningless.
    expect(Bootstrap.flags.only.exclusive).toEqual(['skip'])
  })

  it('takes one optional positional profile', () => {
    expect(Bootstrap.strict).toBe(true)
    expect(Bootstrap.args.profile.required).toBeFalsy()
  })
})

describe('Bootstrap.catch', () => {
  it('stops a running spinner before reporting an OpsError', async () => {
    ux.action.start('installing apt:git')
    await runCatch(command(), new OpsError('PROFILE_NOT_FOUND', 'No profile "nope"'))
    expect(ux.action.running).toBe(false)
  })

  it('stops the spinner on the --json path as well', async () => {
    ux.action.start('installing apt:git')
    await runCatch(command(true), new OpsError('PROFILE_SECTION_UNSUPPORTED', 'no services yet'))
    expect(ux.action.running).toBe(false)
  })

  it('stops the spinner for ordinary errors too', async () => {
    ux.action.start('installing apt:git')
    await runCatch(command(), new Error('boom'))
    expect(ux.action.running).toBe(false)
  })
})
