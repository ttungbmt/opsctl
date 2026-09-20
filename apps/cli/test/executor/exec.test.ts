import {describe, expect, it} from 'vitest'
import {CommandNotFoundError} from '#core/errors.js'
import {execaRunner, sudoReady} from '#executor/exec.js'
import {FakeRunner} from '#test/helpers/fake-runner.js'

describe('execaRunner', () => {
  it('captures stdout, stderr and a non-zero exit code without throwing', async () => {
    const result = await execaRunner.run('node', ['-e', 'process.stdout.write("out");process.stderr.write("err");process.exit(3)'])
    expect(result).toEqual({stdout: 'out', stderr: 'err', exitCode: 3})
  })

  it('passes arguments verbatim (no shell)', async () => {
    const result = await execaRunner.run('node', ['-e', 'process.stdout.write(process.argv[1])', '$HOME; echo hi'])
    expect(result.stdout).toBe('$HOME; echo hi')
  })

  it('kills a command that outlives its timeout and reports a non-zero exit', async () => {
    const result = await execaRunner.run('node', ['-e', 'setTimeout(() => {}, 5000)'], {timeout: 100})
    expect(result.exitCode).not.toBe(0)
  })

  it('passes env to the child on top of the ambient environment', async () => {
    const result = await execaRunner.run(
      'node',
      ['-e', 'process.stdout.write(`${process.env.LC_ALL}|${Boolean(process.env.PATH)}`)'],
      {env: {LC_ALL: 'C'}},
    )
    expect(result.stdout).toBe('C|true')
  })

  it('throws CommandNotFoundError for a missing binary', async () => {
    await expect(execaRunner.run('definitely-not-a-command-xyz', [])).rejects.toBeInstanceOf(CommandNotFoundError)
  })
})

describe('sudoReady', () => {
  it('is true for root without running sudo', async () => {
    const runner = new FakeRunner()
    expect(await sudoReady(runner, 0)).toBe(true)
    expect(runner.calls).toEqual([])
  })

  it('runs sudo -n true for a normal user', async () => {
    const runner = new FakeRunner().on('sudo -n true', {exitCode: 1})
    expect(await sudoReady(runner, 1000)).toBe(false)
    expect(runner.calls[0]).toMatchObject({cmd: 'sudo', args: ['-n', 'true']})
  })

  it('is false when sudo is not installed', async () => {
    const runner: FakeRunner = new FakeRunner()
    runner.run = async () => {
      throw new CommandNotFoundError('sudo')
    }
    expect(await sudoReady(runner, 1000)).toBe(false)
  })
})
