import {constants} from 'node:fs'
import {access, lstat, rm} from 'node:fs/promises'
import {dirname} from 'node:path'

import {OpsError} from '#core/errors.js'
import type {Runner} from '#executor/exec.js'

export interface PathState {
  path: string
  exists: boolean
  /** True when deleting it needs root, i.e. the parent directory is not writable. */
  privileged: boolean
}

/** Injected so tests never touch the real filesystem. */
export interface PathFs {
  /** lstat, not stat: a leftover may be a symlink, and the link is what we delete. */
  exists(path: string): Promise<boolean>
  canWriteParent(path: string): Promise<boolean>
  remove(path: string): Promise<void>
}

export interface PathRemover {
  stat(path: string): Promise<PathState>
  remove(path: string, opts: {privileged: boolean; nonInteractive: boolean}): Promise<void>
  describe(path: string, privileged: boolean): string
}

export const nodePathFs: PathFs = {
  async canWriteParent(path) {
    try {
      await access(dirname(path), constants.W_OK)
      return true
    } catch {
      return false
    }
  },

  async exists(path) {
    try {
      // lstat: a symlink into a package directory must be unlinked, not followed.
      await lstat(path)
      return true
    } catch {
      return false
    }
  },

  async remove(path) {
    await rm(path, {force: true, recursive: true})
  },
}

export function createPathRemover(runner: Runner, fs: PathFs = nodePathFs): PathRemover {
  return {
    describe: (path, privileged) => `${privileged ? 'sudo ' : ''}rm -rf -- ${path}`,

    async remove(path, opts) {
      if (!opts.privileged) {
        await fs.remove(path)
        return
      }

      // The only privileged deletion ops performs, and only ever on a path that
      // recipeIndex validated at config load.
      const result = await runner.run('sudo', ['rm', '-rf', '--', path], {
        stdin: opts.nonInteractive ? 'ignore' : 'inherit',
      })
      if (result.exitCode !== 0) {
        throw new OpsError('UNINSTALL_UNAVAILABLE', `Could not remove ${path}: ${result.stderr.trim() || `rm exited with ${result.exitCode}`}`)
      }
    },

    async stat(path) {
      const exists = await fs.exists(path)
      return {exists, path, privileged: exists && !(await fs.canWriteParent(path))}
    },
  }
}
