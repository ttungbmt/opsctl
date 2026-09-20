import {describe, expect, it} from 'vitest'
import {OpsError} from '#core/errors.js'
import {CommandNotFoundError} from '#core/errors.js'
import {createMiseTools} from '#providers/mise-tools.js'
import {FakeRunner} from '#test/helpers/fake-runner.js'

// Shape observed from `mise ls -g --json` on mise 2026.9.11 (extra fields trimmed).
const LS = JSON.stringify({
  bat: [{active: true, installed: true, requested_version: 'latest', version: '0.26.1'}],
  'github:ouch-org/ouch': [{installed: true, version: '0.6.1'}],
  jq: [{installed: false, requested_version: 'latest', version: '1.8.1'}],
})

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  const error = await promise.then(() => undefined, (e: unknown) => e)
  expect(error).toBeInstanceOf(OpsError)
  return (error as OpsError).code
}

describe('createMiseTools', () => {
  it('inRegistry follows the exit code of mise registry', async () => {
    const runner = new FakeRunner().on('mise -C / registry fastfetch', {exitCode: 0}).on('mise -C / registry zsh', {exitCode: 1})
    const tools = createMiseTools(runner)
    expect(await tools.inRegistry('fastfetch')).toBe(true)
    expect(await tools.inRegistry('zsh')).toBe(false)
    expect(runner.calls[0].args).toEqual(['-C', '/', 'registry', 'fastfetch'])
  })

  it('runs every command from a neutral directory', async () => {
    // `mise ls -g` omits a tool that a mise.toml in the cwd overrides, so ops reported a
    // globally installed tool as missing whenever you stood in a project that pins it.
    // ops manages the global toolchain; where the user happens to stand must not change
    // what it sees or does. "/" is root-owned, so no planted mise.toml can be read there.
    const runner = new FakeRunner().on('mise', {exitCode: 0, stdout: '{}'})
    const tools = createMiseTools(runner)
    await tools.inRegistry('jq')
    await tools.status()
    await tools.install(['jq'], {capture: false, nonInteractive: false})
    await tools.dryRun(['jq'])
    await tools.remove(['jq'], {capture: false, nonInteractive: false})

    expect(runner.calls).toHaveLength(5)
    for (const call of runner.calls) expect(call.args.slice(0, 2)).toEqual(['-C', '/'])
  })

  it('status parses mise ls -g --json', async () => {
    const runner = new FakeRunner().on('mise -C / ls -g --json', {stdout: LS})
    expect(await createMiseTools(runner).status()).toEqual([
      {installed: true, name: 'bat', version: '0.26.1'},
      {installed: true, name: 'github:ouch-org/ouch', version: '0.6.1'},
      {installed: false, name: 'jq', version: undefined},
    ])
  })

  it('status rejects unexpected JSON with MISE_BOOTSTRAP_UNAVAILABLE', async () => {
    const runner = new FakeRunner().on('mise', {stdout: '{"bat": "nope"}'})
    expect(await codeOf(createMiseTools(runner).status())).toBe('MISE_BOOTSTRAP_UNAVAILABLE')
    const garbage = new FakeRunner().on('mise', {stdout: 'not json'})
    expect(await codeOf(createMiseTools(garbage).status())).toBe('MISE_BOOTSTRAP_UNAVAILABLE')
  })

  it('install runs use -g, recording latest unless a version is given', async () => {
    const runner = new FakeRunner().on('mise', {exitCode: 0})
    const tools = createMiseTools(runner)
    await tools.install(['fastfetch', 'node@22', 'aqua:a/b'], {capture: false, nonInteractive: false})
    await tools.install(['jq'], {capture: true, nonInteractive: true})
    expect(runner.calls[0]).toMatchObject({args: ['-C', '/', 'use', '-g', 'fastfetch@latest', 'node@22', 'aqua:a/b@latest'], opts: {stdin: 'inherit', stdout: 'inherit'}})
    expect(runner.calls[1]).toMatchObject({args: ['-C', '/', 'use', '-g', 'jq@latest'], opts: {stdin: 'ignore', stdout: 'capture'}})
  })

  it('install returns a non-zero exit code instead of throwing', async () => {
    const runner = new FakeRunner().on('mise', {exitCode: 1})
    expect(await createMiseTools(runner).install(['nope'], {capture: true, nonInteractive: true})).toEqual({exitCode: 1})
  })

  it('dryRun returns the planned lines from stderr and stdout', async () => {
    const runner = new FakeRunner().on('mise', {
      stderr: 'mise fastfetch@2.68.1          ⇢ would install\n',
      stdout: 'mise would update ~/.config/mise/config.toml (add: fastfetch@2.68.1)\n',
    })
    expect(await createMiseTools(runner).dryRun(['fastfetch'])).toEqual([
      'mise fastfetch@2.68.1          ⇢ would install',
      'mise would update ~/.config/mise/config.toml (add: fastfetch@2.68.1)',
    ])
    expect(runner.calls[0].args).toEqual(['-C', '/', 'use', '-g', '--dry-run', 'fastfetch@latest'])
  })

  it('maps failures to OpsErrors', async () => {
    const missing = new FakeRunner()
    missing.run = async () => {
      throw new CommandNotFoundError('mise')
    }
    expect(await codeOf(createMiseTools(missing).inRegistry('jq'))).toBe('MISE_BOOTSTRAP_UNAVAILABLE')
    const failing = new FakeRunner().on('mise', {exitCode: 1, stderr: 'boom'})
    expect(await codeOf(createMiseTools(failing).dryRun(['nope']))).toBe('MISE_COMMAND_FAILED')
  })

  it('remove runs unuse -g with bare names, never pinning @latest', async () => {
    const runner = new FakeRunner().on('mise', {exitCode: 0})
    const tools = createMiseTools(runner)
    await tools.remove(['fastfetch', 'node', 'aqua:a/b'], {capture: false, nonInteractive: false})
    expect(runner.calls[0]).toMatchObject({
      args: ['-C', '/', 'unuse', '-g', 'fastfetch', 'node', 'aqua:a/b'],
      opts: {stdin: 'inherit', stdout: 'inherit'},
    })
  })

  it('remove ignores stdin and captures output when asked', async () => {
    const runner = new FakeRunner().on('mise', {exitCode: 0})
    await createMiseTools(runner).remove(['fastfetch'], {capture: true, nonInteractive: true})
    expect(runner.calls[0].opts).toMatchObject({stdin: 'ignore', stdout: 'capture'})
  })

  it('describes removal locally, since mise unuse has no dry run', () => {
    expect(createMiseTools(new FakeRunner()).describeRemove(['fastfetch', 'node'])).toEqual([
      'mise unuse -g fastfetch',
      'mise unuse -g node',
    ])
  })
})
