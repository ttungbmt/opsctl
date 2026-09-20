import {describe, expect, it} from 'vitest'
import {type PathFs, createPathRemover} from '../../src/providers/paths.js'
import {FakeRunner} from '../helpers/fake-runner.js'

/** Entries are [path, {missing?, symlink?, writableParent?}]. */
function fakeFs(entries: Record<string, {missing?: boolean; writableParent?: boolean}>) {
  const removed: string[] = []
  const fs: PathFs = {
    async canWriteParent(path) {
      return entries[path]?.writableParent ?? true
    },
    async exists(path) {
      return !(entries[path]?.missing ?? false)
    },
    async remove(path) {
      removed.push(path)
    },
  }
  return {fs, removed}
}

describe('createPathRemover', () => {
  it('reports an existing path the user can delete themselves', async () => {
    const {fs} = fakeFs({'/home/t/.config/ab': {}})
    expect(await createPathRemover(new FakeRunner(), fs).stat('/home/t/.config/ab')).toEqual({
      path: '/home/t/.config/ab',
      exists: true,
      privileged: false,
    })
  })

  // Unlinking needs write on the parent directory, not on the file itself.
  it('marks a path privileged when its parent is not writable', async () => {
    const {fs} = fakeFs({'/etc/apt/sources.list.d/ab.list': {writableParent: false}})
    expect(await createPathRemover(new FakeRunner(), fs).stat('/etc/apt/sources.list.d/ab.list')).toMatchObject({
      exists: true,
      privileged: true,
    })
  })

  it('reports a missing path as absent', async () => {
    const {fs} = fakeFs({'/etc/gone': {missing: true}})
    expect(await createPathRemover(new FakeRunner(), fs).stat('/etc/gone')).toMatchObject({exists: false})
  })

  it('deletes an unprivileged path through the filesystem, not a subprocess', async () => {
    const runner = new FakeRunner()
    const {fs, removed} = fakeFs({'/home/t/.config/ab': {}})
    await createPathRemover(runner, fs).remove('/home/t/.config/ab', {nonInteractive: false, privileged: false})
    expect(removed).toEqual(['/home/t/.config/ab'])
    expect(runner.calls).toEqual([])
  })

  it('deletes a privileged path with sudo rm -rf and a -- guard', async () => {
    const runner = new FakeRunner().on('sudo rm', {exitCode: 0})
    const {fs, removed} = fakeFs({'/etc/apt/sources.list.d/ab.list': {writableParent: false}})
    await createPathRemover(runner, fs).remove('/etc/apt/sources.list.d/ab.list', {nonInteractive: true, privileged: true})
    expect(runner.calls[0]).toMatchObject({
      cmd: 'sudo',
      args: ['rm', '-rf', '--', '/etc/apt/sources.list.d/ab.list'],
      opts: {stdin: 'ignore'},
    })
    expect(removed).toEqual([])
  })

  it('fails when sudo rm exits non-zero', async () => {
    const runner = new FakeRunner().on('sudo rm', {exitCode: 1, stderr: 'rm: cannot remove'})
    const {fs} = fakeFs({'/etc/ab': {writableParent: false}})
    await expect(
      createPathRemover(runner, fs).remove('/etc/ab', {nonInteractive: true, privileged: true}),
    ).rejects.toThrow(/cannot remove/)
  })

  it('describes both forms', () => {
    const remover = createPathRemover(new FakeRunner(), fakeFs({}).fs)
    expect(remover.describe('/etc/ab.list', true)).toBe('sudo rm -rf -- /etc/ab.list')
    expect(remover.describe('/home/t/.config/ab', false)).toBe('rm -rf -- /home/t/.config/ab')
  })
})
