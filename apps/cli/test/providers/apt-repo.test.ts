import {access, readFile, writeFile} from 'node:fs/promises'

import {describe, expect, it} from 'vitest'
import {OpsError} from '../../src/core/errors.js'
import type {AptRepo} from '../../src/core/repo.js'
import type {RunOptions, RunResult} from '../../src/executor/exec.js'
import {
  createAptRepoProvider,
  keyringPath,
  parsePolicy,
  pinPath,
  pinStanza,
  servedBy,
  sourcesPath,
  sourcesStanza,
} from '../../src/providers/apt-repo.js'
import {FakeRunner} from '../helpers/fake-runner.js'

async function exists(path: string) {
  return access(path).then(() => true, () => false)
}

async function errorOf(promise: Promise<unknown>) {
  const error = await promise.then(() => undefined, (e: unknown) => e)
  expect(error).toBeInstanceOf(OpsError)
  return error as OpsError
}

const MOZILLA: AptRepo = {
  name: 'mozilla',
  uri: 'https://packages.mozilla.org/apt',
  suite: 'mozilla',
  components: ['main'],
  keyring: 'https://packages.mozilla.org/apt/repo-signing-key.gpg',
  pin: {origin: 'packages.mozilla.org', priority: 1000},
}

/** Real `LC_ALL=C apt-cache policy firefox` on Ubuntu 24.04: the snap transitional package. */
const SHIM = `firefox:
  Installed: (none)
  Candidate: 1:1snap1-0ubuntu5
  Version table:
     1:1snap1-0ubuntu5 500
        500 http://archive.ubuntu.com/ubuntu noble/main amd64 Packages
`

/** Real `LC_ALL=C apt-cache policy gh`: exercises the ` *** ` installed line and dpkg/status. */
const INSTALLED = `gh:
  Installed: 2.97.0
  Candidate: 2.101.0
  Version table:
     2.101.0 500
        500 https://cli.github.com/packages stable/main amd64 Packages
 *** 2.97.0 100
        100 /var/lib/dpkg/status
     2.45.0-1ubuntu0.3 500
        500 http://archive.ubuntu.com/ubuntu noble-updates/universe amd64 Packages
        500 http://security.ubuntu.com/ubuntu noble-security/universe amd64 Packages
`

/** What Mozilla's repo looks like once configured and pinned above the archive. */
const MOZILLA_WINS = `firefox:
  Installed: (none)
  Candidate: 143.0
  Version table:
     143.0 1000
        1000 https://packages.mozilla.org/apt mozilla/main amd64 Packages
     1:1snap1-0ubuntu5 500
        500 http://archive.ubuntu.com/ubuntu noble/main amd64 Packages
`

describe('sourcesStanza', () => {
  it('renders a deb822 stanza pointing at the keyring ops installs', () => {
    expect(sourcesStanza(MOZILLA)).toBe(
      `# Managed by ops (repo.mozilla). Edits are overwritten.
Types: deb
URIs: https://packages.mozilla.org/apt
Suites: mozilla
Components: main
Signed-By: /etc/apt/keyrings/ops-mozilla.asc
`,
    )
  })

  it('joins several components with a space', () => {
    expect(sourcesStanza({...MOZILLA, components: ['main', 'contrib']})).toContain('Components: main contrib\n')
  })
})

describe('pinStanza', () => {
  // `Pin: origin <host>` matches the site hostname. This repo's Release Origin is an
  // internal path, so `release o=` would not work -- see the design spec.
  it('pins by site hostname, above the distro archive', () => {
    expect(pinStanza(MOZILLA)).toBe(
      `# Managed by ops (repo.mozilla). Edits are overwritten.
Package: *
Pin: origin packages.mozilla.org
Pin-Priority: 1000
`,
    )
  })

  it('is absent when the repo needs no pin', () => {
    expect(pinStanza({...MOZILLA, pin: undefined})).toBeUndefined()
  })
})

describe('parsePolicy', () => {
  it('reads the candidate and the sources that serve each version', () => {
    expect(parsePolicy(SHIM)).toEqual({
      candidate: '1:1snap1-0ubuntu5',
      versions: [
        {
          version: '1:1snap1-0ubuntu5',
          priority: 500,
          sources: ['http://archive.ubuntu.com/ubuntu noble/main amd64 Packages'],
        },
      ],
    })
  })

  it('reads the installed version, which apt marks with *** and serves from dpkg', () => {
    const policy = parsePolicy(INSTALLED)
    expect(policy.candidate).toBe('2.101.0')
    expect(policy.versions.map((v) => v.version)).toEqual(['2.101.0', '2.97.0', '2.45.0-1ubuntu0.3'])
    expect(policy.versions[1]).toEqual({version: '2.97.0', priority: 100, sources: ['/var/lib/dpkg/status']})
    expect(policy.versions[2].sources).toHaveLength(2)
  })

  it('has no candidate when apt knows the package but has no version for it', () => {
    expect(parsePolicy('zsh:\n  Installed: (none)\n  Candidate: (none)\n  Version table:\n').candidate).toBeUndefined()
  })

  it('is empty for a package apt has never heard of, which prints nothing at all', () => {
    expect(parsePolicy('')).toEqual({versions: []})
  })
})

describe('servedBy', () => {
  it('is true when the candidate comes from the pinned host', () => {
    expect(servedBy(parsePolicy(MOZILLA_WINS), 'packages.mozilla.org')).toBe(true)
  })

  it('is false when the candidate is the distro package', () => {
    expect(servedBy(parsePolicy(SHIM), 'packages.mozilla.org')).toBe(false)
  })

  // A locally installed version is served by /var/lib/dpkg/status, which is not a URL.
  it('does not treat the dpkg status file as a host', () => {
    expect(servedBy(parsePolicy(INSTALLED), 'cli.github.com')).toBe(true)
    expect(servedBy({candidate: '2.97.0', versions: parsePolicy(INSTALLED).versions}, 'cli.github.com')).toBe(false)
  })

  it('is false when there is no candidate at all', () => {
    expect(servedBy(parsePolicy(''), 'packages.mozilla.org')).toBe(false)
  })
})

/** Records the bytes handed to `sudo install`, before the temp file is removed. */
class CapturingRunner extends FakeRunner {
  placed: {dest: string; text: string}[] = []
  temps: string[] = []

  override async run(cmd: string, args: string[], opts?: RunOptions): Promise<RunResult> {
    if (cmd === 'sudo' && args[0] === 'install') {
      const [src, dest] = args.slice(-2) as [string, string]
      this.temps.push(src)
      this.placed.push({dest, text: await readFile(src, 'utf8')})
    }

    return super.run(cmd, args, opts)
  }
}

const KEY = '-----BEGIN PGP PUBLIC KEY BLOCK-----\n'

/** Writes the keyring like a real download, and records every URL fetched. */
function fakeDownload() {
  const urls: string[] = []
  return {
    download: async (url: string, dest: string) => {
      urls.push(url)
      await writeFile(dest, KEY)
    },
    urls,
  }
}

/** Serves only the paths given; anything else looks absent, like ENOENT. */
function fakeFiles(files: Record<string, string> = {}) {
  return async (path: string) => {
    const text = files[path]
    if (text === undefined) throw Object.assign(new Error('missing'), {code: 'ENOENT'})
    return text
  }
}

const CONFIGURED = {
  [keyringPath('mozilla')]: KEY,
  [sourcesPath('mozilla')]: sourcesStanza(MOZILLA),
  [pinPath('mozilla')]: pinStanza(MOZILLA)!,
}

const OPTS = {capture: false, nonInteractive: false}
const ready = () => new CapturingRunner().on('sudo install').on('sudo rm').on('sudo apt-get update').on('apt-cache policy firefox', {stdout: MOZILLA_WINS})

describe('createAptRepoProvider.describe', () => {
  it('lists every command, ending with the check that the pin took effect', () => {
    const runner = new CapturingRunner()
    const {download, urls} = fakeDownload()
    expect(createAptRepoProvider(runner, download, fakeFiles()).describe(MOZILLA, 'firefox')).toEqual([
      'download https://packages.mozilla.org/apt/repo-signing-key.gpg',
      'sudo install -D -m 0644 -o root -g root <key> /etc/apt/keyrings/ops-mozilla.asc',
      'sudo install -D -m 0644 -o root -g root <stanza> /etc/apt/sources.list.d/ops-mozilla.sources',
      'sudo install -D -m 0644 -o root -g root <stanza> /etc/apt/preferences.d/ops-mozilla.pref',
      'sudo apt-get update',
      'apt-cache policy firefox  # candidate must come from packages.mozilla.org',
    ])
    expect(runner.calls).toEqual([])
    expect(urls).toEqual([])
  })

  it('omits the pin file when the repo has no pin', () => {
    const lines = createAptRepoProvider(new FakeRunner(), fakeDownload().download, fakeFiles()).describe({...MOZILLA, pin: undefined}, 'firefox')
    expect(lines.some((line) => line.includes('preferences.d'))).toBe(false)
  })

  it('rejects a non-https uri or keyring before doing anything', async () => {
    const provider = createAptRepoProvider(new FakeRunner(), fakeDownload().download, fakeFiles())
    expect(() => provider.describe({...MOZILLA, uri: 'http://packages.mozilla.org/apt'}, 'firefox')).toThrow(OpsError)
    expect(() => provider.describe({...MOZILLA, keyring: 'ftp://x.test/k.gpg'}, 'firefox')).toThrow(OpsError)
  })
})

describe('createAptRepoProvider.ensure', () => {
  it('installs the keyring, sources and pin, updates apt, then verifies the candidate', async () => {
    const runner = ready()
    const {download, urls} = fakeDownload()
    const result = await createAptRepoProvider(runner, download, fakeFiles()).ensure(MOZILLA, 'firefox', OPTS)

    expect(urls).toEqual(['https://packages.mozilla.org/apt/repo-signing-key.gpg'])
    expect(result).toEqual({
      written: [keyringPath('mozilla'), sourcesPath('mozilla'), pinPath('mozilla')],
      updated: true,
      candidate: '143.0',
    })
    expect(runner.placed.map((p) => p.dest)).toEqual([keyringPath('mozilla'), sourcesPath('mozilla'), pinPath('mozilla')])
    expect(runner.placed[1].text).toBe(sourcesStanza(MOZILLA))
    expect(runner.placed[2].text).toBe(pinStanza(MOZILLA))
    expect(runner.calls.map((c) => [c.cmd, ...c.args].join(' ')).at(-2)).toBe('sudo apt-get update')
    expect(runner.calls.at(-1)).toEqual({
      cmd: 'apt-cache',
      args: ['policy', 'firefox'],
      opts: {env: {LC_ALL: 'C'}, stdin: 'ignore', stdout: 'capture'},
    })
  })

  it('places every file as root, mode 0644, creating parent directories', async () => {
    const runner = ready()
    await createAptRepoProvider(runner, fakeDownload().download, fakeFiles()).ensure(MOZILLA, 'firefox', OPTS)
    for (const call of runner.calls.filter((c) => c.args[0] === 'install')) {
      expect(call.args.slice(0, -2)).toEqual(['install', '-D', '-m', '0644', '-o', 'root', '-g', 'root'])
    }
  })

  it('removes its temp files', async () => {
    const runner = ready()
    await createAptRepoProvider(runner, fakeDownload().download, fakeFiles()).ensure(MOZILLA, 'firefox', OPTS)
    expect(runner.temps).toHaveLength(3)
    for (const temp of runner.temps) expect(await exists(temp)).toBe(false)
  })

  it('writes nothing and skips apt-get update when already configured', async () => {
    const runner = ready()
    const {download, urls} = fakeDownload()
    const result = await createAptRepoProvider(runner, download, fakeFiles(CONFIGURED)).ensure(MOZILLA, 'firefox', OPTS)

    expect(result).toEqual({written: [], updated: false, candidate: '143.0'})
    expect(urls).toEqual([])
    expect(runner.calls).toEqual([
      {cmd: 'apt-cache', args: ['policy', 'firefox'], opts: {env: {LC_ALL: 'C'}, stdin: 'ignore', stdout: 'capture'}},
    ])
  })

  it('rewrites only the stanza that drifted, and never re-downloads a keyring it has', async () => {
    const runner = ready()
    const {download, urls} = fakeDownload()
    const stale = {...CONFIGURED, [sourcesPath('mozilla')]: '# hand-edited\n'}
    const result = await createAptRepoProvider(runner, download, fakeFiles(stale)).ensure(MOZILLA, 'firefox', OPTS)

    expect(result.written).toEqual([sourcesPath('mozilla')])
    expect(urls).toEqual([])
  })

  // Configured but the lists were never fetched, or someone ran `apt-get clean`.
  it('updates apt once and re-checks when the pin is configured but not in effect', async () => {
    const runner = new CapturingRunner()
      .on('sudo apt-get update')
      .on('apt-cache policy firefox', {stdout: SHIM}, {stdout: MOZILLA_WINS})
    const result = await createAptRepoProvider(runner, fakeDownload().download, fakeFiles(CONFIGURED)).ensure(MOZILLA, 'firefox', OPTS)

    expect(result).toEqual({written: [], updated: true, candidate: '143.0'})
    expect(runner.calls.filter((c) => c.args[0] === 'apt-get')).toHaveLength(1)
  })

  it('fails without installing anything when the candidate still is not from the repo', async () => {
    const runner = new CapturingRunner().on('sudo install').on('sudo apt-get update').on('apt-cache policy firefox', {stdout: SHIM})
    const provider = createAptRepoProvider(runner, fakeDownload().download, fakeFiles())
    const error = await errorOf(provider.ensure(MOZILLA, 'firefox', OPTS))

    expect(error.code).toBe('REPO_PIN_UNSATISFIED')
    expect(error.message).toContain('packages.mozilla.org')
    expect(error.message).toContain('1:1snap1-0ubuntu5')
    expect(runner.calls.filter((c) => c.args[0] === 'apt-get')).toHaveLength(1)
  })

  it('removes a pin file the config no longer asks for', async () => {
    const runner = ready()
    const result = await createAptRepoProvider(runner, fakeDownload().download, fakeFiles(CONFIGURED)).ensure(
      {...MOZILLA, pin: undefined},
      'firefox',
      OPTS,
    )

    expect(runner.calls.some((c) => [c.cmd, ...c.args].join(' ') === `sudo rm -f ${pinPath('mozilla')}`)).toBe(true)
    expect(result.updated).toBe(true)
  })

  it.each([
    ['sudo install', 'sudo install'],
    ['apt-get update', 'sudo apt-get update'],
  ])('reports REPO_SETUP_FAILED when %s fails, and cleans up', async (_label, prefix) => {
    const runner = ready().on(prefix, {exitCode: 100, stderr: 'boom'})
    const provider = createAptRepoProvider(runner, fakeDownload().download, fakeFiles())
    expect(await errorOf(provider.ensure(MOZILLA, 'firefox', OPTS))).toMatchObject({code: 'REPO_SETUP_FAILED'})
    for (const temp of runner.temps) expect(await exists(temp)).toBe(false)
  })

  it('rejects a non-https keyring before any I/O', async () => {
    const runner = ready()
    const {download, urls} = fakeDownload()
    const provider = createAptRepoProvider(runner, download, fakeFiles())
    expect(await errorOf(provider.ensure({...MOZILLA, keyring: 'http://x.test/k.gpg'}, 'firefox', OPTS))).toMatchObject({
      code: 'CONFIG_INVALID',
    })
    expect(runner.calls).toEqual([])
    expect(urls).toEqual([])
  })

  it('silences and captures subprocess output when asked', async () => {
    const runner = ready()
    await createAptRepoProvider(runner, fakeDownload().download, fakeFiles()).ensure(MOZILLA, 'firefox', {capture: true, nonInteractive: true})
    for (const call of runner.calls.filter((c) => c.cmd === 'sudo')) {
      expect(call.opts).toEqual({stdin: 'ignore', stdout: 'capture'})
    }
  })
})

describe('createAptRepoProvider.verify', () => {
  it('reads apt-cache policy under LC_ALL=C so the field names are parseable', async () => {
    const runner = new FakeRunner().on('apt-cache policy firefox', {stdout: SHIM})
    const result = await createAptRepoProvider(runner, fakeDownload().download, fakeFiles()).verify(MOZILLA, 'firefox')

    expect(result).toEqual({ok: false, candidate: '1:1snap1-0ubuntu5'})
    expect(runner.calls[0]!.opts).toEqual({env: {LC_ALL: 'C'}, stdin: 'ignore', stdout: 'capture'})
  })

  it('is ok when the repo serves the candidate, and writes nothing either way', async () => {
    const runner = new FakeRunner().on('apt-cache policy firefox', {stdout: MOZILLA_WINS})
    const result = await createAptRepoProvider(runner, fakeDownload().download, fakeFiles()).verify(MOZILLA, 'firefox')

    expect(result).toEqual({ok: true, candidate: '143.0'})
    expect(runner.calls.every((c) => c.cmd === 'apt-cache')).toBe(true)
  })

  it('reports no candidate for a package apt has never heard of', async () => {
    const runner = new FakeRunner().on('apt-cache policy firefox', {stdout: ''})
    expect(await createAptRepoProvider(runner, fakeDownload().download, fakeFiles()).verify(MOZILLA, 'firefox')).toEqual({ok: false})
  })
})
