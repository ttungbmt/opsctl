import {randomBytes} from 'node:crypto'
import {createWriteStream} from 'node:fs'
import {rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {Readable, Transform} from 'node:stream'
import {pipeline} from 'node:stream/promises'
import type {ReadableStream as NodeReadableStream} from 'node:stream/web'

import {OpsError} from '../core/errors.js'
import type {RunOptions, Runner} from '../executor/exec.js'

/** Which half of the work is running; the caller decides whether to show anything. */
export type Stage = 'downloading' | 'installing'

/** Reports bytes written so far; `total` is absent when the server sends no content-length. */
export type OnProgress = (done: number, total?: number) => void

/** Fetches `url` and writes it to `dest`; injected so tests never touch the network. */
export type Download = (url: string, dest: string, onProgress?: OnProgress) => Promise<void>

export interface InstallDebOptions {
  nonInteractive: boolean
  /** Capture apt's output instead of streaming it (used with --json). */
  capture: boolean
  /** Called while the .deb downloads; the caller decides whether to show anything. */
  onProgress?: OnProgress
  /** Called as each stage begins, so a caller can drive a spinner. */
  onStage?: (stage: Stage) => void
}

export interface DebInstaller {
  /** Downloads a .deb over https and installs it with apt. */
  installFromUrl(url: string, opts: InstallDebOptions): Promise<void>
  /** What installFromUrl would do, for --dry-run. */
  describe(url: string): string[]
}

/**
 * Rejects anything but https before any I/O: recipes can come from the user's config,
 * and the .deb is installed with sudo.
 */
function checkUrl(url: string): URL {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new OpsError('INVALID_PACKAGE_NAME', `Invalid prepare URL: "${url}"`)
  }

  if (parsed.protocol !== 'https:') {
    throw new OpsError('INVALID_PACKAGE_NAME', `Prepare URL must use https, got "${parsed.protocol}//" in "${url}"`)
  }

  return parsed
}

export const fetchDownload: Download = async (url, dest, onProgress) => {
  const response = await fetch(url, {redirect: 'follow'})
  if (!response.ok) throw new OpsError('DOWNLOAD_FAILED', `Download failed (${response.status} ${response.statusText}): ${url}`)
  if (!response.body) throw new OpsError('DOWNLOAD_FAILED', `Download returned no body: ${url}`)

  const length = Number(response.headers.get('content-length'))
  const total = Number.isFinite(length) && length > 0 ? length : undefined

  // Streamed rather than buffered: the artifact can be hundreds of megabytes.
  let done = 0
  const counter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      done += chunk.length
      onProgress?.(done, total)
      callback(null, chunk)
    },
  })

  // fetch's body is typed with the DOM ReadableStream; Readable.fromWeb wants Node's.
  const body = Readable.fromWeb(response.body as NodeReadableStream<Uint8Array>)
  await pipeline(body, counter, createWriteStream(dest))
}

export function createDebInstaller(runner: Runner, download: Download = fetchDownload): DebInstaller {
  return {
    describe(url) {
      checkUrl(url)
      return [`download ${url}`, 'sudo apt-get install -y <downloaded .deb>']
    },

    async installFromUrl(url, opts) {
      checkUrl(url)
      const file = join(tmpdir(), `ops-${randomBytes(8).toString('hex')}.deb`)

      try {
        opts.onStage?.('downloading')
        await download(url, file, opts.onProgress)

        const runOpts: RunOptions = {
          stdin: opts.nonInteractive ? 'ignore' : 'inherit',
          stdout: opts.capture ? 'capture' : 'inherit',
        }

        opts.onStage?.('installing')
        const result = await runner.run('sudo', ['apt-get', 'install', '-y', file], runOpts)
        if (result.exitCode !== 0) {
          // With capture on, apt's own output never reached the terminal; say why it failed.
          const reason = result.stderr.trim() || result.stdout.trim()
          const detail = reason ? `: ${reason}` : ''
          throw new OpsError('DEB_INSTALL_FAILED', `apt-get failed (exit ${result.exitCode}) installing ${url}${detail}`)
        }
      } finally {
        await rm(file, {force: true})
      }
    },
  }
}
