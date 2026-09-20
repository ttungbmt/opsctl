import {describe, expect, it} from 'vitest'
import {PROBE_TIMEOUT_MS, probeMise, probeMiseReach} from '#providers/mise-presence.js'
import {FakeRunner} from '#test/helpers/fake-runner.js'

describe('probeMise', () => {
  it('is absent only when the binary is not on PATH', async () => {
    expect(await probeMise(new FakeRunner().missing('mise'))).toEqual({state: 'absent'})
  })

  it('reports the version from the first token of the output', async () => {
    const runner = new FakeRunner().on('mise --version', {stdout: '2026.9.11 linux-x64 (abc 2026-09-11)\n'})
    expect(await probeMise(runner)).toEqual({state: 'present', version: '2026.9.11'})
  })

  it('treats a non-zero exit as unhealthy, never as absent', async () => {
    // mise exists and is broken. Installing over it would be the wrong repair.
    const runner = new FakeRunner().on('mise --version', {exitCode: 1, stderr: 'config error\n'})
    expect(await probeMise(runner)).toEqual({state: 'unhealthy', exitCode: 1, detail: 'config error'})
  })

  it('synthesises a detail when a failing mise says nothing', async () => {
    const runner = new FakeRunner().on('mise --version', {exitCode: 2})
    expect(await probeMise(runner)).toEqual({state: 'unhealthy', exitCode: 2, detail: 'mise --version exited 2'})
  })

  it('probes without prompting, printing or hanging', async () => {
    const runner = new FakeRunner().on('mise --version', {stdout: '2026.9.11\n'})
    await probeMise(runner)
    expect(runner.calls[0]).toEqual({
      cmd: 'mise',
      args: ['--version'],
      opts: {stdin: 'ignore', stdout: 'capture', timeout: PROBE_TIMEOUT_MS},
    })
  })

  it('lets an unrelated error through', async () => {
    const boom = new Error('boom')
    const runner = {
      async run() {
        throw boom
      },
    }
    await expect(probeMise(runner)).rejects.toThrow(boom)
  })
})

const DOCTOR = JSON.stringify({activated: true, shims_on_path: true, other: 'ignored'})

describe('probeMiseReach', () => {
  it('reports both axes from mise doctor', async () => {
    const runner = new FakeRunner().on('mise doctor --json', {stdout: DOCTOR})
    expect(await probeMiseReach(runner)).toEqual({activated: true, shimsOnPath: true})
  })

  it('reads shims and activation independently', async () => {
    // A machine with shims on PATH but no shell hook works fine; so does the reverse.
    const runner = new FakeRunner().on('mise doctor --json', {
      stdout: JSON.stringify({activated: false, shims_on_path: true}),
    })
    expect(await probeMiseReach(runner)).toEqual({activated: false, shimsOnPath: true})
  })

  it('says nothing it cannot prove', async () => {
    // An older mise has no --json. Nagging on a failed probe is worse than silence.
    expect(await probeMiseReach(new FakeRunner().on('mise doctor --json', {exitCode: 1}))).toBeUndefined()
    expect(await probeMiseReach(new FakeRunner().on('mise doctor --json', {stdout: 'not json'}))).toBeUndefined()
    expect(await probeMiseReach(new FakeRunner().on('mise doctor --json', {stdout: '{"activated": 1}'}))).toBeUndefined()
    expect(await probeMiseReach(new FakeRunner().missing('mise'))).toBeUndefined()
  })

  it('probes without prompting or printing', async () => {
    const runner = new FakeRunner().on('mise doctor --json', {stdout: DOCTOR})
    await probeMiseReach(runner)
    expect(runner.calls[0]).toEqual({
      cmd: 'mise',
      args: ['doctor', '--json'],
      opts: {stdin: 'ignore', stdout: 'capture', timeout: PROBE_TIMEOUT_MS},
    })
  })
})
