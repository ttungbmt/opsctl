import {access, readFile, writeFile} from 'node:fs/promises'

import {describe, expect, it} from 'vitest'
import {OpsError} from '../../src/core/errors.js'
import type {AptRepo} from '../../src/core/repo.js'
import type {Stage} from '../../src/core/stage.js'
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

/**
 * Real `LC_ALL=C apt-cache policy firefox` once the repo is configured and pinned.
 * Captured verbatim -- do not retype it. The 1000 rows are indented SEVEN spaces while
 * the 500 row gets eight: apt right-aligns the priority in an 11-wide column, so the
 * indent shrinks as the number grows. An earlier hand-written version of this fixture
 * used eight spaces throughout and hid a parser bug that broke every pinned repo.
 */
const MOZILLA_WINS = `firefox:
  Installed: (none)
  Candidate: 156.0~build1
  Version table:
     1:1snap1-0ubuntu5 500
        500 http://archive.ubuntu.com/ubuntu noble/main amd64 Packages
     156.0~build1 1000
       1000 https://packages.mozilla.org/apt mozilla/main amd64 Packages
     155.0.1~build1 1000
       1000 https://packages.mozilla.org/apt mozilla/main amd64 Packages
     155.0~build1 1000
       1000 https://packages.mozilla.org/apt mozilla/main amd64 Packages
`

/**
 * Real `apt-cache policy bash`: installed from the distro archive. apt lists BOTH the repo
 * that still offers the version and /var/lib/dpkg/status. This is the shape a machine
 * holding Ubuntu's firefox shim would have.
 */
const FROM_ARCHIVE = `bash:
  Installed: 5.2.21-2ubuntu4
  Candidate: 5.2.21-2ubuntu4
  Version table:
 *** 5.2.21-2ubuntu4 500
        500 http://archive.ubuntu.com/ubuntu noble/main amd64 Packages
        100 /var/lib/dpkg/status
`

/** Real `apt-cache policy tailscale`: installed from a third-party repo that still offers it. */
const FROM_REPO = `tailscale:
  Installed: 1.102.3
  Candidate: 1.102.4
  Version table:
     1.102.4 500
        500 https://pkgs.tailscale.com/stable/ubuntu noble/main amd64 Packages
 *** 1.102.3 500
        500 https://pkgs.tailscale.com/stable/ubuntu noble/main amd64 Packages
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

  // apt right-aligns the priority in an 11-wide column: 500 gets eight spaces, 1000 gets
  // seven. Hard-coding eight silently dropped every source line of a pinned repo.
  it('attaches source lines whose priority is four digits, which any real pin produces', () => {
    const mozilla = parsePolicy(MOZILLA_WINS).versions.find((v) => v.version === '156.0~build1')
    expect(mozilla).toEqual({
      version: '156.0~build1',
      priority: 1000,
      sources: ['https://packages.mozilla.org/apt mozilla/main amd64 Packages'],
    })
  })

  it('reads the installed version, and treats (none) as nothing installed', () => {
    expect(parsePolicy(FROM_ARCHIVE).installed).toBe('5.2.21-2ubuntu4')
    expect(parsePolicy(SHIM).installed).toBeUndefined()
  })

  it('lists every source for a version that is both installed and still offered', () => {
    expect(parsePolicy(FROM_ARCHIVE).versions[0]!.sources).toEqual([
      'http://archive.ubuntu.com/ubuntu noble/main amd64 Packages',
      '/var/lib/dpkg/status',
    ])
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
      candidate: '156.0~build1',
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

    expect(result).toEqual({written: [], updated: false, candidate: '156.0~build1'})
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

    expect(result).toEqual({written: [], updated: true, candidate: '156.0~build1'})
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

  // The counterpart to verify's "judges what is installed": ensure runs just before apt
  // installs, so it must judge the candidate. On this very output verify says not-ok and
  // ensure says fine -- which is what makes `--force` able to replace a wrong-origin build.
  it('accepts a candidate from the repo even when the installed version is not', async () => {
    const runner = new CapturingRunner().on('sudo install').on('sudo apt-get update').on('apt-cache policy gh', {stdout: INSTALLED})
    const repo = {...MOZILLA, name: 'github', pin: {origin: 'cli.github.com', priority: 1000}}
    const provider = createAptRepoProvider(runner, fakeDownload().download, fakeFiles())

    await expect(provider.ensure(repo, 'gh', OPTS)).resolves.toMatchObject({candidate: '2.101.0'})
    expect((await provider.verify(repo, 'gh')).ok).toBe(false)
  })

  // apt-get update is the slow step and its output is captured when a spinner is running,
  // so without these the command sits silent for seconds with no sign it is alive.
  it('announces each stage so the caller can show what is happening', async () => {
    const runner = ready()
    const stages: Stage[] = []
    await createAptRepoProvider(runner, fakeDownload().download, fakeFiles()).ensure(MOZILLA, 'firefox', {
      ...OPTS,
      onStage: (stage) => stages.push(stage),
    })
    expect(stages).toEqual(['repo-key', 'repo-files', 'repo-update', 'repo-check'])
  })

  it('announces only the check when the repo is already configured', async () => {
    const runner = ready()
    const stages: Stage[] = []
    await createAptRepoProvider(runner, fakeDownload().download, fakeFiles(CONFIGURED)).ensure(MOZILLA, 'firefox', {
      ...OPTS,
      onStage: (stage) => stages.push(stage),
    })
    expect(stages).toEqual(['repo-check'])
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

    expect(result).toEqual({ok: true, candidate: '156.0~build1'})
    expect(runner.calls.every((c) => c.cmd === 'apt-cache')).toBe(true)
  })

  // The whole point of this provider: "installed" cannot be trusted on its own, and neither
  // can the candidate. gh is installed at 2.97.0, which the repo no longer offers, while the
  // candidate 2.101.0 does come from the repo -- judging the candidate would say all is well.
  it('judges what is installed, not what apt would install next', async () => {
    const runner = new FakeRunner().on('apt-cache policy gh', {stdout: INSTALLED})
    const repo = {...MOZILLA, name: 'github', pin: {origin: 'cli.github.com', priority: 1000}}
    const result = await createAptRepoProvider(runner, fakeDownload().download, fakeFiles()).verify(repo, 'gh')

    expect(result).toEqual({ok: false, candidate: '2.101.0', installed: '2.97.0'})
  })

  it('is ok when the installed version is one the repo serves', async () => {
    const runner = new FakeRunner().on('apt-cache policy tailscale', {stdout: FROM_REPO})
    const repo = {...MOZILLA, name: 'tailscale', pin: {origin: 'pkgs.tailscale.com', priority: 1000}}
    const result = await createAptRepoProvider(runner, fakeDownload().download, fakeFiles()).verify(repo, 'tailscale')

    expect(result).toEqual({ok: true, candidate: '1.102.4', installed: '1.102.3'})
  })

  // A machine holding Ubuntu's firefox shim: installed from the archive, not from Mozilla.
  it('is not ok when the installed version comes from the distro archive', async () => {
    const runner = new FakeRunner().on('apt-cache policy firefox', {stdout: FROM_ARCHIVE})
    const result = await createAptRepoProvider(runner, fakeDownload().download, fakeFiles()).verify(MOZILLA, 'firefox')
    expect(result.ok).toBe(false)
  })

  it('reports no candidate for a package apt has never heard of', async () => {
    const runner = new FakeRunner().on('apt-cache policy firefox', {stdout: ''})
    expect(await createAptRepoProvider(runner, fakeDownload().download, fakeFiles()).verify(MOZILLA, 'firefox')).toEqual({ok: false})
  })
})
