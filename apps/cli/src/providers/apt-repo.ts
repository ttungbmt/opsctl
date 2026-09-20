import {randomBytes} from 'node:crypto'
import {readFile as fsReadFile, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import {OpsError} from '#core/errors.js'
import type {AptRepo} from '#core/repo.js'
import type {Stage} from '#core/stage.js'
import type {RunOptions, Runner} from '#executor/exec.js'
import {type Download, fetchDownload} from './deb.js'

/** Where ops keeps the files it owns for a repo. The `ops-` stem marks them as managed. */
export const keyringPath = (name: string): string => `/etc/apt/keyrings/ops-${name}.asc`
export const sourcesPath = (name: string): string => `/etc/apt/sources.list.d/ops-${name}.sources`
export const pinPath = (name: string): string => `/etc/apt/preferences.d/ops-${name}.pref`

const managedBy = (name: string) => `# Managed by ops (repo.${name}). Edits are overwritten.\n`

/** One version apt knows about, and the sources that can serve it. */
export interface PolicyEntry {
  version: string
  priority: number
  /** Verbatim source lines with the leading priority stripped; not always URLs. */
  sources: string[]
}

/** What `apt-cache policy <pkg>` reports. Absent candidate means apt has no version to install. */
export interface Policy {
  /** What apt would install. Absent when apt has no version for the package. */
  candidate?: string
  /** What is on the machine right now. Absent when the package is not installed. */
  installed?: string
  versions: PolicyEntry[]
}

/** "  Candidate: 1:1snap1-0ubuntu5"; "(none)" means there is nothing to install. */
const CANDIDATE = /^ {2}Candidate: (.+)$/m
/** "  Installed: 5.2.21-2ubuntu4"; "(none)" means the package is not installed. */
const INSTALLED = /^ {2}Installed: (.+)$/m
/** "     143.0 1000", or " *** 2.97.0 100" for the version currently installed. */
const ENTRY = /^(?: {5}| \*\*\* )(\S+) (\d+)$/
/**
 * "        500 http://archive.ubuntu.com/ubuntu noble/main amd64 Packages", or a local path.
 * The indent is NOT fixed: apt right-aligns the priority in an 11-wide column, so 500 gets
 * eight spaces and 1000 gets seven. Hard-coding eight broke every pinned repo, since a pin
 * that beats the distro archive's 500 is four digits.
 */
const SOURCE = /^ {2,}(\d+) (.+)$/

/** deb822, so multi-value fields stay readable and `Signed-By` takes an explicit path. */
export function sourcesStanza(repo: AptRepo): string {
  return (
    managedBy(repo.name) +
    [
      'Types: deb',
      `URIs: ${repo.uri}`,
      `Suites: ${repo.suite}`,
      `Components: ${repo.components.join(' ')}`,
      `Signed-By: ${keyringPath(repo.name)}`,
    ].join('\n') +
    '\n'
  )
}

/**
 * An apt preferences stanza, or undefined when the repo needs no pin. `Pin: origin <host>`
 * matches the site hostname rather than the Release file's `Origin:` field, which some
 * repositories publish as an internal path.
 */
export function pinStanza(repo: AptRepo): string | undefined {
  if (!repo.pin) return undefined
  return managedBy(repo.name) + ['Package: *', `Pin: origin ${repo.pin.origin}`, `Pin-Priority: ${repo.pin.priority}`].join('\n') + '\n'
}

/**
 * Parses `apt-cache policy` output. Run the command under LC_ALL=C: these field names are
 * localised. A package apt has never heard of prints nothing and still exits 0.
 */
export function parsePolicy(stdout: string): Policy {
  const version = (match: RegExpExecArray | null) => (match?.[1] === undefined || match[1] === '(none)' ? undefined : match[1])
  const candidate = version(CANDIDATE.exec(stdout))
  const installed = version(INSTALLED.exec(stdout))
  const versions: PolicyEntry[] = []

  for (const line of stdout.split('\n')) {
    const entry = ENTRY.exec(line)
    if (entry) {
      versions.push({priority: Number(entry[2]), sources: [], version: entry[1]})
      continue
    }

    const source = SOURCE.exec(line)
    if (source && versions.length > 0) versions.at(-1)!.sources.push(source[2])
  }

  return {
    ...(candidate === undefined ? {} : {candidate}),
    ...(installed === undefined ? {} : {installed}),
    versions,
  }
}

/** A source line's hostname, or undefined when it is not a URL (e.g. /var/lib/dpkg/status). */
function hostOf(source: string): string | undefined {
  try {
    return new URL(source.split(' ')[0]!).hostname
  } catch {
    return undefined
  }
}

/**
 * Whether the version apt would install is actually served by `host`. This is the guard
 * that stops ops reporting success for a package that came from somewhere else -- on
 * Ubuntu, `apt:firefox` resolves to a transitional package that installs the snap, and
 * `mise bootstrap packages status` reports it as installed just like a real build.
 */
export function servedBy(policy: Policy, host: string, version = policy.candidate): boolean {
  if (version === undefined) return false
  const entry = policy.versions.find((v) => v.version === version)
  return entry?.sources.some((source) => hostOf(source) === host) ?? false
}

/** Reads a managed file; injected so tests never touch /etc. */
export type ReadFile = (path: string) => Promise<string>

export interface EnsureRepoOptions {
  nonInteractive: boolean
  /** Capture apt's output instead of streaming it (used with --json). */
  capture: boolean
  /** Called as each stage begins, so a caller can drive a spinner. */
  onStage?: (stage: Stage) => void
}

export interface EnsureRepoResult {
  /** Files written this run, in write order; empty when the repo was already configured. */
  written: string[]
  /** Whether `apt-get update` ran. */
  updated: boolean
  /** apt's candidate version for the verified package, once the repo serves it. */
  candidate: string
}

/** Whether the repo really serves the version that is on the machine (or would be). */
export interface VerifyResult {
  ok: boolean
  candidate?: string
  installed?: string
}

export interface AptRepoProvider {
  /**
   * Configures the repo if needed, then proves apt's candidate for `pkg` comes from it.
   * `pkg` is the bare package name ("firefox"), not a spec.
   */
  ensure(repo: AptRepo, pkg: string, opts: EnsureRepoOptions): Promise<EnsureRepoResult>
  /**
   * Read-only: does apt resolve `pkg` through this repo? Answered here rather than by
   * exposing the parser, so the core layer never has to know what apt's output looks like.
   */
  verify(repo: AptRepo, pkg: string): Promise<VerifyResult>
  /** What ensure would do, for --dry-run. No I/O. */
  describe(repo: AptRepo, pkg: string): string[]
}

/** The host `Pin: origin` matches; without a pin, the repo's own host is what must serve it. */
const originOf = (repo: AptRepo): string => repo.pin?.origin ?? new URL(repo.uri).hostname

/**
 * Rejects anything but https before any I/O. Repos can come from the user's config, and
 * configuring one writes to /etc/apt as root and trusts a signing key for every future
 * package from that origin.
 */
function checkRepo(repo: AptRepo): void {
  for (const [field, value] of [
    ['uri', repo.uri],
    ['keyring', repo.keyring],
  ] as const) {
    let parsed: URL
    try {
      parsed = new URL(value)
    } catch {
      throw new OpsError('CONFIG_INVALID', `repo.${repo.name}.${field}: not a URL: "${value}"`)
    }

    if (parsed.protocol !== 'https:') {
      throw new OpsError('CONFIG_INVALID', `repo.${repo.name}.${field}: must use https, got "${parsed.protocol}//" in "${value}"`)
    }
  }
}

const tempPath = () => join(tmpdir(), `ops-${randomBytes(8).toString('hex')}`)

export function createAptRepoProvider(
  runner: Runner,
  download: Download = fetchDownload,
  readFile: ReadFile = (path) => fsReadFile(path, 'utf8'),
): AptRepoProvider {
  /** A managed file's contents, or undefined when it is not there yet. */
  const current = (path: string) => readFile(path).then((text) => text, () => undefined)

  const policy = async (pkg: string): Promise<Policy> => {
    // LC_ALL=C: apt localises "Candidate:", and the parser reads those field names.
    const result = await runner.run('apt-cache', ['policy', pkg], {env: {LC_ALL: 'C'}, stdin: 'ignore', stdout: 'capture'})
    return parsePolicy(result.stdout)
  }

  return {
    describe(repo, pkg) {
      checkRepo(repo)
      const place = (what: string, dest: string) => `sudo install -D -m 0644 -o root -g root ${what} ${dest}`
      return [
        `download ${repo.keyring}`,
        place('<key>', keyringPath(repo.name)),
        place('<stanza>', sourcesPath(repo.name)),
        ...(repo.pin ? [place('<stanza>', pinPath(repo.name))] : []),
        'sudo apt-get update',
        `apt-cache policy ${pkg}  # candidate must come from ${originOf(repo)}`,
      ]
    },

    async verify(repo, pkg) {
      checkRepo(repo)
      const result = await policy(pkg)
      // Judge what is on the machine, falling back to what apt would install when nothing is.
      // `ensure` deliberately asks the other question -- see its call to servedBy.
      return {
        ...(result.candidate === undefined ? {} : {candidate: result.candidate}),
        ...(result.installed === undefined ? {} : {installed: result.installed}),
        ok: servedBy(result, originOf(repo), result.installed ?? result.candidate),
      }
    },

    async ensure(repo, pkg, opts) {
      checkRepo(repo)
      const host = originOf(repo)
      const runOpts: RunOptions = {
        stdin: opts.nonInteractive ? 'ignore' : 'inherit',
        stdout: opts.capture ? 'capture' : 'inherit',
      }

      const sudo = async (args: string[], what: string) => {
        const result = await runner.run('sudo', args, runOpts)
        if (result.exitCode !== 0) {
          // With capture on, apt's own output never reached the terminal; say why it failed.
          const reason = result.stderr.trim() || result.stdout.trim()
          throw new OpsError('REPO_SETUP_FAILED', `${what} failed (exit ${result.exitCode})${reason ? `: ${reason}` : ''}`)
        }
      }

      /** Renders to an unprivileged temp file, then places it as root: the executor takes
       * argv arrays, so there is no `… | sudo tee`. */
      const place = async (write: (temp: string) => Promise<void>, dest: string) => {
        const temp = tempPath()
        try {
          await write(temp)
          await sudo(['install', '-D', '-m', '0644', '-o', 'root', '-g', 'root', temp, dest], `install ${dest}`)
        } finally {
          await rm(temp, {force: true})
        }
      }

      // Inspect: byte-identical stanzas mean configured; the keyring counts by presence only,
      // so the idempotent path needs no network and a re-serialised key cannot churn it.
      const [key, sources, pin] = await Promise.all([
        current(keyringPath(repo.name)),
        current(sourcesPath(repo.name)),
        current(pinPath(repo.name)),
      ])
      const wantSources = sourcesStanza(repo)
      const wantPin = pinStanza(repo)

      const written: string[] = []
      if (key === undefined) {
        opts.onStage?.('repo-key')
        await place((temp) => download(repo.keyring, temp), keyringPath(repo.name))
        written.push(keyringPath(repo.name))
      }

      if (sources !== wantSources || pin !== wantPin) opts.onStage?.('repo-files')
      if (sources !== wantSources) {
        await place((temp) => writeFile(temp, wantSources, {mode: 0o600}), sourcesPath(repo.name))
        written.push(sourcesPath(repo.name))
      }

      let removedPin = false
      if (wantPin === undefined) {
        if (pin !== undefined) {
          await sudo(['rm', '-f', pinPath(repo.name)], `remove ${pinPath(repo.name)}`)
          removedPin = true
        }
      } else if (pin !== wantPin) {
        await place((temp) => writeFile(temp, wantPin, {mode: 0o600}), pinPath(repo.name))
        written.push(pinPath(repo.name))
      }

      const update = () => {
        opts.onStage?.('repo-update')
        return sudo(['apt-get', 'update'], 'apt-get update')
      }
      let updated = written.length > 0 || removedPin
      if (updated) await update()

      // Verify the CANDIDATE, not the installed version: this runs just before apt installs,
      // including a --force reinstall over a build from somewhere else, which an
      // installed-first check would reject before it could replace anything. `verify` asks
      // the other question, for a package that is already there.
      opts.onStage?.('repo-check')
      let result = await policy(pkg)
      if (!servedBy(result, host)) {
        if (!updated) {
          await update()
          updated = true
          result = await policy(pkg)
        }

        if (!servedBy(result, host)) {
          const found = result.candidate ?? 'no candidate'
          throw new OpsError(
            'REPO_PIN_UNSATISFIED',
            `apt's candidate for ${pkg} is ${found}, not from ${host}; check repo.${repo.name} (uri, suite, components) and its pin`,
          )
        }
      }

      return {candidate: result.candidate!, updated, written}
    },
  }
}
