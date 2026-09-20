import {describe, expect, it, vi} from 'vitest'
import {OpsError} from '#core/errors.js'
import {type PreflightDeps, type PreflightOptions, ensureMise} from '#core/preflight.js'
import type {Stage} from '#core/stage.js'
import type {MiseInstaller} from '#providers/mise-install.js'
import type {MiseState} from '#providers/mise-presence.js'

/** Answers each probe from a queue; the last answer repeats. */
function stubProbe(...answers: MiseState[]) {
  const calls: number[] = []
  return {
    calls,
    probe: async () => {
      calls.push(calls.length)
      return answers[Math.min(calls.length - 1, answers.length - 1)]
    },
  }
}

function fakeInstaller(exitCode = 0) {
  const installs: {capture: boolean; nonInteractive: boolean}[] = []
  const installer: MiseInstaller = {
    describe: () => [
      'download https://mise.run',
      'sudo env MISE_INSTALL_PATH=/usr/local/bin/mise sh <downloaded installer>',
    ],
    async install(opts) {
      installs.push({capture: opts.capture, nonInteractive: opts.nonInteractive})
      opts.onStage?.('downloading')
      opts.onStage?.('installing')
      return {exitCode}
    },
  }
  return {installer, installs}
}

const opts = (o: Partial<PreflightOptions> = {}): PreflightOptions => ({
  dryRun: false,
  json: false,
  nonInteractive: false,
  yes: true,
  ...o,
})

function deps(over: Partial<PreflightDeps> = {}): PreflightDeps {
  return {
    installer: fakeInstaller().installer,
    isTTY: true,
    onPlan: () => {},
    probe: async () => ({state: 'absent'}),
    sudoReady: async () => true,
    ...over,
  }
}

describe('ensureMise when mise is there', () => {
  it('is satisfied, and touches nothing else', async () => {
    const p = stubProbe({state: 'present', version: '2026.9.11'})
    const f = fakeInstaller()
    const result = await ensureMise(opts(), deps({installer: f.installer, probe: p.probe}))
    expect(result).toEqual({
      action: 'preflight',
      dryRun: false,
      satisfied: true,
      changes: [{id: 'mise', status: 'satisfied', detail: '2026.9.11'}],
    })
    // The common path must cost nothing: one probe, no install.
    expect(p.calls).toHaveLength(1)
    expect(f.installs).toEqual([])
  })

  it('leaves a broken mise alone rather than installing over it', async () => {
    const f = fakeInstaller()
    const p = stubProbe({state: 'unhealthy', exitCode: 1, detail: 'config error'})
    const result = await ensureMise(opts(), deps({installer: f.installer, probe: p.probe}))
    expect(result.satisfied).toBe(true)
    expect(result.changes[0].status).toBe('skipped')
    expect(result.changes[0].detail).toContain('config error')
    expect(f.installs).toEqual([])
  })
})

describe('ensureMise dry run', () => {
  it('reports what it would do and installs nothing', async () => {
    const f = fakeInstaller()
    const result = await ensureMise(opts({dryRun: true}), deps({installer: f.installer}))
    expect(result.satisfied).toBe(false)
    expect(result.dryRun).toBe(true)
    expect(result.changes).toEqual([
      {
        id: 'mise',
        status: 'would-change',
        detail: 'not installed',
        command: 'sudo env MISE_INSTALL_PATH=/usr/local/bin/mise sh <downloaded installer>',
      },
    ])
    expect(result.commands).toEqual([
      'download https://mise.run',
      'sudo env MISE_INSTALL_PATH=/usr/local/bin/mise sh <downloaded installer>',
    ])
    expect(f.installs).toEqual([])
  })

  it('never gates, because nothing is applied', async () => {
    await expect(ensureMise(opts({dryRun: true, json: true, yes: false}), deps())).resolves.toBeTruthy()
  })
})

describe('ensureMise gate', () => {
  it('throws under --json without --yes, before installing anything', async () => {
    const f = fakeInstaller()
    const run = () => ensureMise(opts({json: true, yes: false}), deps({installer: f.installer}))
    await expect(run()).rejects.toThrow(OpsError)
    await expect(run()).rejects.toThrow(/--yes/)
    expect(f.installs).toEqual([])
  })

  it('throws when stdout is not a TTY', async () => {
    await expect(ensureMise(opts({yes: false}), deps({isTTY: false}))).rejects.toThrow(OpsError)
  })

  it('does not throw with --non-interactive', async () => {
    const p = stubProbe({state: 'absent'}, {state: 'present', version: '1.0'})
    await expect(
      ensureMise(opts({json: true, nonInteractive: true, yes: false}), deps({probe: p.probe})),
    ).resolves.toBeTruthy()
  })

  it('demands passwordless sudo under --non-interactive, before installing', async () => {
    const f = fakeInstaller()
    const run = ensureMise(opts({nonInteractive: true}), deps({installer: f.installer, sudoReady: async () => false}))
    await expect(run).rejects.toThrow(/sudo/)
    expect(f.installs).toEqual([])
  })

  it('prints the plan exactly once before installing', async () => {
    const onPlan = vi.fn()
    const p = stubProbe({state: 'absent'}, {state: 'present', version: '1.0'})
    await ensureMise(opts(), deps({onPlan, probe: p.probe}))
    expect(onPlan).toHaveBeenCalledTimes(1)
    expect(onPlan.mock.calls[0][0][0]).toMatchObject({id: 'mise', status: 'would-change'})
  })
})

describe('ensureMise install', () => {
  it('installs, then verifies by probing again', async () => {
    const f = fakeInstaller()
    const p = stubProbe({state: 'absent'}, {state: 'present', version: '2026.9.11'})
    const result = await ensureMise(opts(), deps({installer: f.installer, probe: p.probe}))
    expect(p.calls).toHaveLength(2)
    expect(f.installs).toEqual([{capture: false, nonInteractive: false}])
    expect(result).toMatchObject({satisfied: true, changes: [{id: 'mise', status: 'changed', detail: '2026.9.11'}]})
  })

  it('captures output under --json', async () => {
    const f = fakeInstaller()
    const p = stubProbe({state: 'absent'}, {state: 'present', version: '1.0'})
    await ensureMise(opts({json: true}), deps({installer: f.installer, probe: p.probe}))
    expect(f.installs[0].capture).toBe(true)
  })

  it('captures output when a spinner owns the terminal', async () => {
    const f = fakeInstaller()
    const p = stubProbe({state: 'absent'}, {state: 'present', version: '1.0'})
    await ensureMise(opts(), deps({captureOutput: true, installer: f.installer, probe: p.probe}))
    expect(f.installs[0].capture).toBe(true)
  })

  it('forwards stages with mise as the subject', async () => {
    const seen: [Stage, string][] = []
    const p = stubProbe({state: 'absent'}, {state: 'present', version: '1.0'})
    await ensureMise(opts(), deps({onStage: (stage, subject) => seen.push([stage, subject]), probe: p.probe}))
    expect(seen).toEqual([
      ['downloading', 'mise'],
      ['installing', 'mise'],
    ])
  })

  it('fails when mise is still absent after the installer ran', async () => {
    // A status is a claim; the probe is the evidence.
    const f = fakeInstaller(3)
    const p = stubProbe({state: 'absent'})
    const run = () => ensureMise(opts(), deps({installer: f.installer, probe: p.probe}))
    await expect(run()).rejects.toThrow(/still not on PATH/)
    await expect(run()).rejects.toThrow(/exit 3/)
  })

  it('fails clearly when the config says nothing about mise', async () => {
    await expect(ensureMise(opts(), deps({installer: undefined}))).rejects.toThrow(/"mise:"/)
  })
})
