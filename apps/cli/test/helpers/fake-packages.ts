/**
 * Fake package providers, shared by the install tests and the bootstrap section tests.
 * They record what was asked of them so a test can assert on the calls, not just the result.
 */
import type {PackageSpec} from '#core/package/spec.js'
import type {AptRepo} from '#core/repo.js'
import type {AptRepoProvider, EnsureRepoOptions, VerifyResult} from '#providers/apt-repo.js'
import type {DebInstaller, InstallDebOptions} from '#providers/deb.js'
import type {ApplyOptions, MiseBootstrap, PackageState} from '#providers/mise-bootstrap.js'
import type {InstallToolOptions, MiseTools, ToolState} from '#providers/mise-tools.js'

export class FakeRepos implements AptRepoProvider {
  ensured: {repo: AptRepo; pkg: string; opts: EnsureRepoOptions}[] = []
  verified: {repo: AptRepo; pkg: string}[] = []
  /** What `verify` answers: apt resolves the package through the repo unless told otherwise. */
  serves = true
  candidate = '143.0'
  failWith: Error | undefined

  describe(repo: AptRepo, pkg: string) {
    return [`configure repo ${repo.name}`, `apt-cache policy ${pkg}`]
  }

  async verify(repo: AptRepo, pkg: string): Promise<VerifyResult> {
    this.verified.push({pkg, repo})
    return {candidate: this.candidate, ok: this.serves}
  }

  async ensure(repo: AptRepo, pkg: string, opts: EnsureRepoOptions) {
    this.ensured.push({opts, pkg, repo})
    if (this.failWith) throw this.failWith
    opts.onStage?.('repo-update')
    return {candidate: this.candidate, updated: true, written: []}
  }
}

export class FakeDeb implements DebInstaller {
  installs: {url: string; opts: InstallDebOptions}[] = []

  describe(url: string) {
    return [`download ${url}`]
  }

  async installFromUrl(url: string, opts: InstallDebOptions) {
    this.installs.push({opts, url})
  }
}

export class FakeMise implements MiseBootstrap {
  calls: string[] = []
  applied: {specs: PackageSpec[]; opts: ApplyOptions}[] = []
  declared = new Set<string>()
  installed = new Map<string, string>() // spec -> version
  installOnApply = true

  async declare(specs: PackageSpec[]) {
    this.calls.push('declare')
    for (const s of specs) this.declared.add(s)
  }

  async status(): Promise<PackageState[]> {
    this.calls.push('status')
    return [...this.declared].map((s) => ({
      installed: this.installed.has(s),
      spec: s as PackageSpec,
      version: this.installed.get(s),
    }))
  }

  async apply(specs: PackageSpec[], opts: ApplyOptions) {
    this.calls.push('apply')
    this.applied.push({opts, specs})
    if (this.installOnApply) for (const s of specs) this.installed.set(s, '1.0')
    return {exitCode: this.installOnApply ? 0 : 100}
  }

  async dryRun(specs: PackageSpec[]) {
    this.calls.push('dryRun')
    return specs.map((s) => `would install ${s}`)
  }
}

export class FakeTools implements MiseTools {
  calls: string[] = []
  installs: {names: string[]; opts: InstallToolOptions}[] = []
  registry = new Set<string>()
  installed = new Map<string, string>() // tool name -> version
  installOnUse = true

  async inRegistry(name: string) {
    return this.registry.has(name)
  }

  async status(): Promise<ToolState[]> {
    this.calls.push('status')
    return [...this.installed].map(([name, version]) => ({installed: true, name, version}))
  }

  async install(names: string[], opts: InstallToolOptions) {
    this.calls.push('install')
    this.installs.push({names, opts})
    if (this.installOnUse) for (const n of names) this.installed.set(n.replace(/@.*/, ''), '2.0')
    return {exitCode: this.installOnUse ? 0 : 1}
  }

  // install never removes; present so the fake satisfies MiseTools.
  async remove(names: string[], opts: InstallToolOptions) {
    this.calls.push('remove')
    for (const n of names) this.installed.delete(n)
    return {exitCode: 0}
  }

  describeRemove(names: string[]) {
    return names.map((n) => `mise unuse -g ${n}`)
  }

  async dryRun(names: string[]) {
    this.calls.push('dryRun')
    return names.map((n) => `would use ${n}`)
  }
}
