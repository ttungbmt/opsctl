import {ux} from '@oclif/core'
import {afterEach, describe, expect, it} from 'vitest'
import {OpsError} from '../../../src/core/errors.js'
import ToolInstall, {spinnerHandover} from '../../../src/commands/tool/install.js'

/** The command with just enough oclif around it to call catch() directly. */
function command(json = false): ToolInstall {
  const cmd = new ToolInstall([], {runHook: async () => ({successes: [], failures: []})} as never)
  Object.defineProperty(cmd, 'jsonEnabled', {value: () => json})
  // this.error() would exit the process; swallow it so the assertion can run.
  Object.defineProperty(cmd, 'error', {value: () => undefined})
  return cmd
}

/** catch() is protected; the test drives it the way oclif does. */
const runCatch = (cmd: ToolInstall, error: Error) =>
  (cmd as unknown as {catch(e: Error): Promise<unknown>}).catch(error).catch(() => undefined)

afterEach(() => {
  if (ux.action.running) ux.action.stop()
})

describe('ToolInstall.catch', () => {
  it('stops a running spinner before reporting an OpsError', async () => {
    ux.action.start('installing apt:google-chrome-stable')
    expect(ux.action.running).toBe(true)

    await runCatch(command(), new OpsError('DEB_INSTALL_FAILED', 'apt-get failed (exit 100)'))

    // Left running, the spinner would scribble over the error message.
    expect(ux.action.running).toBe(false)
  })

  it('stops the spinner for ordinary errors too', async () => {
    ux.action.start('installing apt:zsh')
    await runCatch(command(), new Error('boom'))
    expect(ux.action.running).toBe(false)
  })

  it('stops the spinner on the --json path as well', async () => {
    ux.action.start('installing apt:zsh')
    await runCatch(command(true), new OpsError('MISE_COMMAND_FAILED', 'nope'))
    expect(ux.action.running).toBe(false)
  })

  it('does nothing when no spinner was started', async () => {
    expect(ux.action.running).toBe(false)
    await runCatch(command(), new OpsError('INVALID_PACKAGE_NAME', 'No tools given'))
    expect(ux.action.running).toBe(false)
  })
})

describe('spinnerHandover', () => {
  /** Records the order of newline writes and spinner starts. */
  function recorder(showsProgress: boolean) {
    const events: string[] = []
    const handover = spinnerHandover(
      (label) => events.push(`start:${label}`),
      (text) => events.push(text === '\n' ? 'newline' : `write:${text}`),
      showsProgress,
    )
    return {events, handover}
  }

  it('closes the progress line before the spinner takes the row', () => {
    const r = recorder(true)
    r.handover('installing', 'apt:google-chrome-stable')
    expect(r.events).toEqual(['newline', 'start:installing apt:google-chrome-stable'])
  })

  it('writes no newline when nothing was showing progress', () => {
    const r = recorder(false)
    r.handover('installing', 'apt:zsh')
    expect(r.events).toEqual(['start:installing apt:zsh'])
  })

  it('ignores the downloading stage, which the progress line already covers', () => {
    const r = recorder(true)
    r.handover('downloading', 'apt:zsh')
    expect(r.events).toEqual([])
  })
})
