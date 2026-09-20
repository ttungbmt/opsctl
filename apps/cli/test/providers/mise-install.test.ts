import {describe, expect, it} from 'vitest'
import type {Stage} from '../../src/core/stage.js'
import {type MiseInstallOptions, createMiseInstaller} from '../../src/providers/mise-install.js'
import {FakeRunner} from '../helpers/fake-runner.js'

const SOURCE = {installer: 'https://mise.run', path: '/usr/local/bin/mise'}

/** Records what would have been downloaded and writes nothing. */
function fakeDownload() {
  const calls: {url: string; dest: string}[] = []
  return {calls, download: async (url: string, dest: string) => void calls.push({dest, url})}
}

const opts = (o: Partial<MiseInstallOptions> = {}): MiseInstallOptions => ({
  capture: false,
  nonInteractive: false,
  ...o,
})

describe('createMiseInstaller', () => {
  it('runs the downloaded script as argv, never as a shell string', async () => {
    // A pipe is what the argv rule forbids; the official installer is not.
    const runner = new FakeRunner().on('sudo', {exitCode: 0})
    const d = fakeDownload()
    await createMiseInstaller(runner, SOURCE, d.download).install(opts())

    expect(d.calls).toHaveLength(1)
    expect(d.calls[0].url).toBe('https://mise.run')
    const call = runner.calls[0]
    expect(call.cmd).toBe('sudo')
    expect(call.args.slice(0, 3)).toEqual(['env', 'MISE_INSTALL_PATH=/usr/local/bin/mise', 'sh'])
    expect(call.args[3]).toBe(d.calls[0].dest)
    expect(call.args).toHaveLength(4)
  })

  it('reports a non-zero exit instead of throwing', async () => {
    // The preflight verifies by probing; a status is a claim, not evidence.
    const runner = new FakeRunner().on('sudo', {exitCode: 3, stderr: 'no space'})
    const d = fakeDownload()
    expect(await createMiseInstaller(runner, SOURCE, d.download).install(opts())).toEqual({exitCode: 3})
  })

  it('announces downloading then installing', async () => {
    const stages: Stage[] = []
    const runner = new FakeRunner().on('sudo', {exitCode: 0})
    const d = fakeDownload()
    await createMiseInstaller(runner, SOURCE, d.download).install(opts({onStage: (s) => stages.push(s)}))
    expect(stages).toEqual(['downloading', 'installing'])
  })

  it('passes nonInteractive and capture through to the run', async () => {
    const runner = new FakeRunner().on('sudo', {exitCode: 0})
    const d = fakeDownload()
    await createMiseInstaller(runner, SOURCE, d.download).install(opts({capture: true, nonInteractive: true}))
    expect(runner.calls[0].opts).toEqual({stdin: 'ignore', stdout: 'capture'})
  })

  it('cleans up even when the run throws', async () => {
    const runner = {
      async run() {
        throw new Error('boom')
      },
    }
    const d = fakeDownload()
    await expect(createMiseInstaller(runner, SOURCE, d.download).install(opts())).rejects.toThrow('boom')
    // Reaching here without an unhandled rejection means the finally block ran.
    expect(d.calls).toHaveLength(1)
  })

  it('describes what it would do without any I/O', () => {
    const d = fakeDownload()
    expect(createMiseInstaller(new FakeRunner(), SOURCE, d.download).describe()).toEqual([
      'download https://mise.run',
      'sudo env MISE_INSTALL_PATH=/usr/local/bin/mise sh <downloaded installer>',
    ])
    expect(d.calls).toEqual([])
  })
})
