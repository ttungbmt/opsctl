import {access, readFile, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import {afterEach, describe, expect, it} from 'vitest'
import {OpsError} from '../../src/core/errors.js'
import {createDebInstaller, fetchDownload} from '../../src/providers/deb.js'
import {FakeRunner} from '../helpers/fake-runner.js'

const URL = 'https://example.test/chrome.deb'

/** Records where the .deb was written and creates the file, like a real download. */
function fakeDownload() {
  const paths: string[] = []
  return {
    download: async (_url: string, dest: string) => {
      paths.push(dest)
      await writeFile(dest, 'deb')
    },
    paths,
  }
}

async function exists(path: string) {
  return access(path).then(() => true, () => false)
}

async function codeOf(promise: Promise<unknown>) {
  const error = await promise.then(() => undefined, (e: unknown) => e)
  expect(error).toBeInstanceOf(OpsError)
  return (error as OpsError).code
}

describe('createDebInstaller', () => {
  it('downloads to a temp file and installs it with apt', async () => {
    const runner = new FakeRunner().on('sudo apt-get install')
    const {download, paths} = fakeDownload()
    await createDebInstaller(runner, download).installFromUrl(URL, {capture: false, nonInteractive: false})

    expect(paths).toHaveLength(1)
    expect(paths[0]).toMatch(/ops-[0-9a-f]{16}\.deb$/)
    expect(runner.calls).toEqual([
      {args: ['apt-get', 'install', '-y', paths[0]], cmd: 'sudo', opts: {stdin: 'inherit', stdout: 'inherit'}},
    ])
  })

  it('removes the temp file afterwards, including when apt fails', async () => {
    const ok = fakeDownload()
    await createDebInstaller(new FakeRunner().on('sudo apt-get install'), ok.download).installFromUrl(URL, {
      capture: false,
      nonInteractive: false,
    })
    expect(await exists(ok.paths[0])).toBe(false)

    const bad = fakeDownload()
    const installer = createDebInstaller(new FakeRunner().on('sudo apt-get install', {exitCode: 100}), bad.download)
    expect(await codeOf(installer.installFromUrl(URL, {capture: false, nonInteractive: false}))).toBe('DEB_INSTALL_FAILED')
    expect(await exists(bad.paths[0])).toBe(false)
  })

  it('announces each stage in order', async () => {
    const runner = new FakeRunner().on('sudo apt-get install')
    const {download} = fakeDownload()
    const stages: string[] = []
    await createDebInstaller(runner, download).installFromUrl(URL, {
      capture: false,
      nonInteractive: false,
      onStage: (stage) => stages.push(stage),
    })
    expect(stages).toEqual(['downloading', 'installing'])
  })

  it('puts the captured apt output into the failure, since nobody saw it', async () => {
    const runner = new FakeRunner().on('sudo apt-get install', {exitCode: 100, stderr: 'E: Unmet dependencies'})
    const {download} = fakeDownload()
    const installer = createDebInstaller(runner, download)
    const error = await installer
      .installFromUrl(URL, {capture: true, nonInteractive: false})
      .then(() => undefined, (e: unknown) => e as OpsError)
    expect(error?.code).toBe('DEB_INSTALL_FAILED')
    expect(error?.message).toContain('E: Unmet dependencies')
  })

  it('captures apt output and ignores stdin when asked', async () => {
    const runner = new FakeRunner().on('sudo apt-get install')
    const {download} = fakeDownload()
    await createDebInstaller(runner, download).installFromUrl(URL, {capture: true, nonInteractive: true})
    expect(runner.calls[0].opts).toEqual({stdin: 'ignore', stdout: 'capture'})
  })

  it('rejects a non-https URL before downloading anything', async () => {
    const runner = new FakeRunner()
    const {download, paths} = fakeDownload()
    const installer = createDebInstaller(runner, download)

    for (const url of ['http://example.test/x.deb', 'file:///tmp/x.deb', 'ftp://example.test/x.deb']) {
      expect(await codeOf(installer.installFromUrl(url, {capture: false, nonInteractive: false}))).toBe('INVALID_PACKAGE_NAME')
    }

    expect(await codeOf(installer.installFromUrl('not a url', {capture: false, nonInteractive: false}))).toBe('INVALID_PACKAGE_NAME')
    expect(paths).toEqual([])
    expect(runner.calls).toEqual([])
  })

  it('describes the steps for a dry run without touching anything', async () => {
    const runner = new FakeRunner()
    const {download, paths} = fakeDownload()
    expect(createDebInstaller(runner, download).describe(URL)).toEqual([
      `download ${URL}`,
      'sudo apt-get install -y <downloaded .deb>',
    ])
    expect(paths).toEqual([])
    expect(runner.calls).toEqual([])
  })

  it('rejects a non-https URL in describe too', () => {
    const installer = createDebInstaller(new FakeRunner(), fakeDownload().download)
    expect(() => installer.describe('http://example.test/x.deb')).toThrow(OpsError)
  })
})

describe('fetchDownload', () => {
  const realFetch = globalThis.fetch
  const dest = join(tmpdir(), `ops-download-test-${process.pid}.deb`)

  afterEach(async () => {
    globalThis.fetch = realFetch
    await rm(dest, {force: true})
  })

  /** A Response whose body arrives in chunks, like a real download. */
  function serve(chunks: Uint8Array[], headers: Record<string, string> = {}) {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk)
        controller.close()
      },
    })
    globalThis.fetch = (async () => new Response(body, {headers})) as typeof fetch
  }

  it('streams the body to disk byte for byte', async () => {
    serve([new Uint8Array([1, 2, 3]), new Uint8Array([4, 5])], {'content-length': '5'})
    await fetchDownload('https://example.test/x.deb', dest)
    expect([...(await readFile(dest))]).toEqual([1, 2, 3, 4, 5])
  })

  it('reports progress that rises to the total', async () => {
    serve([new Uint8Array(10), new Uint8Array(30), new Uint8Array(60)], {'content-length': '100'})
    const seen: [number, number | undefined][] = []
    await fetchDownload('https://example.test/x.deb', dest, (done, total) => seen.push([done, total]))
    expect(seen).toEqual([
      [10, 100],
      [40, 100],
      [100, 100],
    ])
  })

  it('leaves total undefined when there is no content-length', async () => {
    serve([new Uint8Array(7)])
    const seen: (number | undefined)[] = []
    await fetchDownload('https://example.test/x.deb', dest, (_done, total) => seen.push(total))
    expect(seen).toEqual([undefined])
  })

  it('reports a failed response instead of writing a file', async () => {
    globalThis.fetch = (async () => new Response('nope', {status: 404, statusText: 'Not Found'})) as typeof fetch
    expect(await codeOf(fetchDownload('https://example.test/x.deb', dest))).toBe('DOWNLOAD_FAILED')
    expect(await exists(dest)).toBe(false)
  })
})
