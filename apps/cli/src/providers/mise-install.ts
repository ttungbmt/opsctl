import {randomBytes} from 'node:crypto'
import {rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import type {MiseConfig} from '../core/config.js'
import type {Stage} from '../core/stage.js'
import type {RunOptions, Runner} from '../executor/exec.js'
import {type Download, type OnProgress, fetchDownload} from './deb.js'

export interface MiseInstallOptions {
  nonInteractive: boolean
  /** Capture the installer's output instead of streaming it (used with --json). */
  capture: boolean
  /** Called while the script downloads; the caller decides whether to show anything. */
  onProgress?: OnProgress
  /** Called as each stage begins, so a caller can drive a spinner. */
  onStage?: (stage: Stage) => void
}

export interface MiseInstaller {
  /** What install would do, for --dry-run. No I/O. */
  describe(): string[]
  /**
   * Downloads mise's official installer and runs it. The exit code is returned rather than
   * thrown on: the caller verifies by probing for mise afterwards, because a status is a
   * claim and the probe is the evidence.
   */
  install(opts: MiseInstallOptions): Promise<{exitCode: number}>
}

/**
 * Installs mise the way its vendor does -- the script detects OS, architecture and libc and
 * verifies sha256 checksums, none of which ops should reimplement.
 *
 * The script is downloaded first and then run as argv. Piping it (`curl | sh`) would be a
 * shell string, which this project forbids, and it feeds a shell bytes as they arrive: a
 * connection that drops mid-transfer executes half a script. A file that failed to download
 * completely simply does not run. `env` sits inside the argv because sudo resets the
 * environment. The https check lives in the config schema, before any of this is reached.
 */
export function createMiseInstaller(
  runner: Runner,
  source: MiseConfig,
  download: Download = fetchDownload,
): MiseInstaller {
  const argv = (file: string) => ['env', `MISE_INSTALL_PATH=${source.path}`, 'sh', file]

  return {
    describe: () => [`download ${source.installer}`, `sudo ${argv('<downloaded installer>').join(' ')}`],

    async install(opts) {
      const file = join(tmpdir(), `ops-mise-${randomBytes(8).toString('hex')}.sh`)

      try {
        opts.onStage?.('downloading')
        await download(source.installer, file, opts.onProgress)

        const runOpts: RunOptions = {
          stdin: opts.nonInteractive ? 'ignore' : 'inherit',
          stdout: opts.capture ? 'capture' : 'inherit',
        }

        opts.onStage?.('installing')
        const result = await runner.run('sudo', argv(file), runOpts)
        return {exitCode: result.exitCode}
      } finally {
        await rm(file, {force: true})
      }
    },
  }
}
