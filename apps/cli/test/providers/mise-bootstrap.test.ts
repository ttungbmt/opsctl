import {describe, expect, it} from 'vitest'
import {OpsError} from '../../src/core/errors.js'
import {CommandNotFoundError} from '../../src/core/errors.js'
import {createMiseBootstrap} from '../../src/providers/mise-bootstrap.js'
import {FakeRunner} from '../helpers/fake-runner.js'

// Shape observed from `mise bootstrap packages status --json` on mise 2026.9.11.
const STATUS = JSON.stringify({
  apt: {
    available: true,
    packages: [
      {desired_state: 'present', installed_version: '5.9-6ubuntu2', package: 'zsh', requested_version: 'latest', state: 'installed'},
      {desired_state: 'present', installed_version: null, package: 'sl', requested_version: 'latest', state: 'missing'},
    ],
  },
  brew: {available: false, packages: []},
})

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  const error = await promise.then(() => undefined, (e: unknown) => e)
  expect(error).toBeInstanceOf(OpsError)
  return (error as OpsError).code
}

describe('createMiseBootstrap', () => {
  it('declare runs use -g --no-install', async () => {
    const runner = new FakeRunner().on('mise')
    await createMiseBootstrap(runner).declare(['apt:zsh', 'apt:sl'])
    expect(runner.calls[0]).toMatchObject({cmd: 'mise', args: ['bootstrap', 'packages', 'use', '-g', '--no-install', 'apt:zsh', 'apt:sl']})
  })

  it('status parses JSON into package states', async () => {
    const runner = new FakeRunner().on('mise bootstrap packages status --json', {stdout: STATUS})
    expect(await createMiseBootstrap(runner).status()).toEqual([
      {installed: true, spec: 'apt:zsh', version: '5.9-6ubuntu2'},
      {installed: false, spec: 'apt:sl', version: undefined},
    ])
  })

  it('status rejects unexpected JSON with MISE_BOOTSTRAP_UNAVAILABLE', async () => {
    const runner = new FakeRunner().on('mise', {stdout: '{"apt": {"packages": "nope"}}'})
    expect(await codeOf(createMiseBootstrap(runner).status())).toBe('MISE_BOOTSTRAP_UNAVAILABLE')
    const garbage = new FakeRunner().on('mise', {stdout: 'not json'})
    expect(await codeOf(createMiseBootstrap(garbage).status())).toBe('MISE_BOOTSTRAP_UNAVAILABLE')
  })

  it('apply passes --yes and streams output unless capturing', async () => {
    const runner = new FakeRunner().on('mise', {exitCode: 0})
    const mise = createMiseBootstrap(runner)
    await mise.apply(['apt:sl'], {capture: false, nonInteractive: false, yes: true})
    await mise.apply(['apt:sl'], {capture: true, nonInteractive: true, yes: false})
    expect(runner.calls[0]).toMatchObject({args: ['bootstrap', 'packages', 'apply', '--yes', 'apt:sl'], opts: {stdin: 'inherit', stdout: 'inherit'}})
    expect(runner.calls[1]).toMatchObject({args: ['bootstrap', 'packages', 'apply', 'apt:sl'], opts: {stdin: 'ignore', stdout: 'capture'}})
  })

  it('apply returns a non-zero exit code instead of throwing', async () => {
    const runner = new FakeRunner().on('mise', {exitCode: 100})
    expect(await createMiseBootstrap(runner).apply(['apt:sl'], {capture: true, nonInteractive: true, yes: true})).toEqual({exitCode: 100})
  })

  it('dryRun returns the planned lines from stdout', async () => {
    const stdout = '~/.config/mise/config.toml: "apt:sl" = "latest"\nsudo env DEBIAN_FRONTEND=noninteractive apt-get install -y -- sl\n'
    const runner = new FakeRunner().on('mise', {stdout})
    expect(await createMiseBootstrap(runner).dryRun(['apt:sl'])).toEqual([
      '~/.config/mise/config.toml: "apt:sl" = "latest"',
      'sudo env DEBIAN_FRONTEND=noninteractive apt-get install -y -- sl',
    ])
    expect(runner.calls[0].args).toEqual(['bootstrap', 'packages', 'use', '-g', '--dry-run', 'apt:sl'])
  })

  it('maps a missing mise binary to MISE_BOOTSTRAP_UNAVAILABLE', async () => {
    const runner = new FakeRunner()
    runner.run = async () => {
      throw new CommandNotFoundError('mise')
    }
    expect(await codeOf(createMiseBootstrap(runner).declare(['apt:zsh']))).toBe('MISE_BOOTSTRAP_UNAVAILABLE')
  })

  it('maps an old mise without bootstrap to MISE_BOOTSTRAP_UNAVAILABLE', async () => {
    const runner = new FakeRunner().on('mise', {exitCode: 2, stderr: "error: unrecognized subcommand 'bootstrap'"})
    expect(await codeOf(createMiseBootstrap(runner).status())).toBe('MISE_BOOTSTRAP_UNAVAILABLE')
  })

  it('maps other mise failures to MISE_COMMAND_FAILED with stderr', async () => {
    const runner = new FakeRunner().on('mise', {exitCode: 1, stderr: "unknown bootstrap package manager 'yum'"})
    const error = await createMiseBootstrap(runner).declare(['yum:zsh']).catch((e: unknown) => e)
    expect((error as OpsError).code).toBe('MISE_COMMAND_FAILED')
    expect((error as OpsError).message).toContain("unknown bootstrap package manager 'yum'")
  })
})
