import {ux} from '@oclif/core'
import {afterEach, describe, expect, it} from 'vitest'
import {OpsError} from '../../../src/core/errors.js'
import ToolInstall, {stageReporter} from '../../../src/commands/tool/install.js'

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

describe('stageReporter', () => {
  /** Records writes and spinner starts in order. */
  function recorder(showsProgress: boolean, withSpinner = true) {
    const events: string[] = []
    const report = stageReporter(
      (text) => events.push(text === '\n' ? 'newline' : `write:${text.replace(/\n$/, '')}`),
      showsProgress,
      withSpinner ? (label) => events.push(`start:${label}`) : undefined,
      withSpinner ? () => events.push('stop') : undefined,
    )
    return {events, report}
  }

  it('names the download, then closes the line before the spinner takes the row', () => {
    const r = recorder(true)
    r.report('downloading', 'apt:google-chrome-stable')
    r.report('installing', 'apt:google-chrome-stable')
    expect(r.events).toEqual([
      'write:downloading apt:google-chrome-stable',
      'newline',
      'start:installing apt:google-chrome-stable',
    ])
  })

  // Repo work has no \r progress line to close, so it must not steal a newline -- but it
  // must still name what it is doing, because apt's own output is captured while spinning.
  it('spins for repo stages without touching the progress line', () => {
    const r = recorder(true)
    r.report('repo-key', 'repo.mozilla')
    r.report('repo-files', 'repo.mozilla')
    r.report('repo-update', 'repo.mozilla')
    r.report('repo-check', 'repo.mozilla')
    expect(r.events).toEqual([
      'start:fetching signing key for repo.mozilla',
      'start:configuring repo.mozilla',
      'start:updating package lists for repo.mozilla',
      'start:checking repo.mozilla',
    ])
  })

  // A spinner may only run while every subprocess is captured. apt streams its own
  // download, so the spinner has to let go of the row before that starts.
  it('releases the row when a subprocess takes the terminal', () => {
    const r = recorder(false)
    r.report('repo-update', 'repo.mozilla')
    r.report('streaming', 'apt:firefox')
    expect(r.events).toEqual(['start:updating package lists for repo.mozilla', 'stop'])
  })

  it('has nothing to release when no spinner is running', () => {
    const r = recorder(true, false)
    r.report('streaming', 'apt:firefox')
    expect(r.events).toEqual([])
  })

  it('writes nothing of its own when no progress is being shown', () => {
    const r = recorder(false)
    r.report('downloading', 'apt:zsh')
    r.report('installing', 'apt:zsh')
    expect(r.events).toEqual(['start:installing apt:zsh'])
  })

  it('still closes the progress line when there is no spinner', () => {
    const r = recorder(true, false)
    r.report('downloading', 'apt:zsh')
    r.report('installing', 'apt:zsh')
    expect(r.events).toEqual(['write:downloading apt:zsh', 'newline'])
  })
})
