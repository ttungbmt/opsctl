import {describe, expect, it} from 'vitest'
import {OpsError} from '../../../src/core/errors.js'
import {type InstallDeps, type InstallOptions, installPackages} from '../../../src/core/package/install.js'
import type {PackageSpec} from '../../../src/core/package/spec.js'
import {recipeIndex} from '../../../src/core/tool/recipe.js'
import {FakeDeb, FakeMise, FakeRepos, FakeTools} from '../../helpers/fake-packages.js'

function setup(overrides: Partial<InstallDeps> = {}) {
  const mise = new FakeMise()
  const tools = new FakeTools()
  const deb = new FakeDeb()
  const repos = new FakeRepos()
  const deps: InstallDeps = {
    deb,
    repos,
    detectManager: async () => 'apt',
    isTTY: true,
    mise,
    recipes: recipeIndex(),
    sudoReady: async () => true,
    systemPreferred: new Set(['zsh']),
    tools,
    ...overrides,
  }
  return {deb, deps, mise, repos, tools}
}

const CHROME = {'google-chrome': {package: 'apt:google-chrome-stable', prepare: {deb: 'https://example.test/chrome.deb'}}}

const opts = (o: Partial<InstallOptions>): InstallOptions => ({
  dryRun: false,
  force: false,
  json: false,
  nonInteractive: false,
  packages: [],
  yes: false,
  ...o,
})

const MOZILLA = {
  mozilla: {
    uri: 'https://packages.mozilla.org/apt',
    suite: 'mozilla',
    components: ['main'],
    keyring: 'https://packages.mozilla.org/apt/repo-signing-key.gpg',
    pin: {origin: 'packages.mozilla.org', priority: 1000},
  },
}
const FIREFOX = {firefox: {package: 'apt:firefox', repo: 'mozilla'}}
const firefoxRecipes = () => recipeIndex(FIREFOX, {repos: MOZILLA})

async function codeOf(promise: Promise<unknown>) {
  const error = await promise.then(() => undefined, (e: unknown) => e)
  expect(error).toBeInstanceOf(OpsError)
  return (error as OpsError).code
}

describe('installPackages', () => {
  it('reports already-installed packages without calling apply', async () => {
    const {deps, mise} = setup()
    mise.installed.set('apt:zsh', '5.9')
    const result = await installPackages(opts({packages: ['zsh'], yes: true}), deps)
    expect(result).toEqual({
      action: 'install',
      dryRun: false,
      managers: ['apt'],
      packages: [{spec: 'apt:zsh', status: 'already-installed', version: '5.9'}],
      success: true,
    })
    expect(mise.calls).toEqual(['declare', 'status'])
  })

  it('declares everything but applies only missing packages', async () => {
    const {deps, mise} = setup()
    mise.installed.set('apt:zsh', '5.9')
    const result = await installPackages(opts({packages: ['zsh', 'sl', 'zsh'], yes: true}), deps)
    expect([...mise.declared]).toEqual(['apt:zsh', 'apt:sl'])
    expect(mise.applied).toEqual([{opts: {capture: false, nonInteractive: false, yes: true}, specs: ['apt:sl']}])
    expect(result.packages).toEqual([
      {spec: 'apt:zsh', status: 'already-installed', version: '5.9'},
      {spec: 'apt:sl', status: 'installed', version: '1.0'},
    ])
    expect(result.success).toBe(true)
  })

  it('installs a prepared package from its .deb instead of through apt', async () => {
    const {deps, deb, mise} = setup({recipes: recipeIndex(CHROME)})
    mise.installOnApply = false // nothing reaches mise.apply, so this must not matter
    const result = await installPackages(opts({packages: ['google-chrome'], yes: true}), deps)

    expect(deb.installs).toHaveLength(1)
    expect(deb.installs[0].url).toBe('https://example.test/chrome.deb')
    expect(deb.installs[0].opts).toMatchObject({capture: false, nonInteractive: false})
    expect(mise.applied).toEqual([])
    // Declared anyway, so the desired state is recorded and later updates go through apt.
    expect([...mise.declared]).toEqual(['apt:google-chrome-stable'])
    expect(result.packages).toEqual([{spec: 'apt:google-chrome-stable', status: 'failed'}])
  })

  it('reports a prepared package as installed once apt sees it', async () => {
    const {deps, deb, mise} = setup({recipes: recipeIndex(CHROME)})
    // The .deb install is what makes it appear, so mirror that in the fake.
    deb.installFromUrl = async (url, o) => {
      deb.installs.push({opts: o, url})
      mise.installed.set('apt:google-chrome-stable', '152.0')
    }
    const result = await installPackages(opts({packages: ['google-chrome'], yes: true}), deps)
    expect(result.packages).toEqual([{spec: 'apt:google-chrome-stable', status: 'installed', version: '152.0'}])
    expect(result.success).toBe(true)
  })

  it('passes the progress reporter down to the .deb installer', async () => {
    const onProgress = () => {}
    const {deps, deb} = setup({onProgress, recipes: recipeIndex(CHROME)})
    await installPackages(opts({packages: ['google-chrome'], yes: true}), deps)
    expect(deb.installs[0].opts.onProgress).toBe(onProgress)
  })

  it('labels each stage with the spec deb.ts cannot know', async () => {
    const seen: [string, string][] = []
    const {deps, deb} = setup({onStage: (stage, spec) => seen.push([stage, spec]), recipes: recipeIndex(CHROME)})
    deb.installFromUrl = async (url, o) => {
      deb.installs.push({opts: o, url})
      o.onStage?.('downloading')
      o.onStage?.('installing')
    }
    await installPackages(opts({packages: ['google-chrome'], yes: true}), deps)
    expect(seen).toEqual([
      ['downloading', 'apt:google-chrome-stable'],
      ['installing', 'apt:google-chrome-stable'],
    ])
  })

  it('captures subprocess output when a spinner owns the terminal', async () => {
    const {deps, deb} = setup({captureOutput: true, recipes: recipeIndex(CHROME)})
    await installPackages(opts({packages: ['google-chrome'], yes: true}), deps)
    expect(deb.installs[0].opts.capture).toBe(true) // even though --json is off
  })

  it('skips the .deb download when the tool is already installed', async () => {
    const {deps, deb, mise} = setup({recipes: recipeIndex(CHROME)})
    mise.installed.set('apt:google-chrome-stable', '152.0')
    const result = await installPackages(opts({packages: ['google-chrome'], yes: true}), deps)

    expect(deb.installs).toEqual([])
    expect(mise.applied).toEqual([])
    expect(result.packages).toEqual([{spec: 'apt:google-chrome-stable', status: 'already-installed', version: '152.0'}])
  })

  it('sends prepared and ordinary packages down their own paths', async () => {
    const {deps, deb, mise} = setup({recipes: recipeIndex(CHROME)})
    await installPackages(opts({packages: ['google-chrome', 'sl'], yes: true}), deps)

    expect(deb.installs.map((i) => i.url)).toEqual(['https://example.test/chrome.deb'])
    expect(mise.applied).toEqual([{opts: {capture: false, nonInteractive: false, yes: true}, specs: ['apt:sl']}])
  })

  it('dry-run shows the download without installing anything', async () => {
    const {deps, deb, mise} = setup({recipes: recipeIndex(CHROME)})
    const result = await installPackages(opts({dryRun: true, packages: ['google-chrome']}), deps)

    expect(result.commands).toContain('download https://example.test/chrome.deb')
    expect(deb.installs).toEqual([])
    expect(mise.applied).toEqual([])
    expect(result.packages).toEqual([{spec: 'apt:google-chrome-stable', status: 'would-install'}])
  })

  it('dry-run never asks mise to describe a prepared package', async () => {
    const {deps, mise} = setup({recipes: recipeIndex(CHROME)})
    const result = await installPackages(opts({dryRun: true, packages: ['google-chrome', 'sl']}), deps)

    // mise would print an apt command for a spec that never reaches mise.apply.
    expect(result.commands).toEqual([
      'download https://example.test/chrome.deb',
      'declare "apt:google-chrome-stable" in [bootstrap.packages]',
      'would install apt:sl',
    ])
    expect(mise.calls).not.toContain('apply')
  })

  it('marks packages still missing after apply as failed', async () => {
    const {deps, mise} = setup()
    mise.installOnApply = false
    const result = await installPackages(opts({packages: ['nope'], yes: true}), deps)
    expect(result.packages).toEqual([{spec: 'apt:nope', status: 'failed'}])
    expect(result.success).toBe(false)
  })

  it('dry-run writes nothing and reports would-install', async () => {
    const {deps, mise} = setup()
    const result = await installPackages(opts({dryRun: true, packages: ['sl']}), deps)
    expect(mise.calls).toEqual(['dryRun', 'status'])
    expect(result).toMatchObject({commands: ['would install apt:sl'], dryRun: true, success: true})
    expect(result.packages).toEqual([{spec: 'apt:sl', status: 'would-install'}])
  })

  it('requires confirmation flags without a TTY or with --json', async () => {
    const noTty = setup({isTTY: false})
    expect(await codeOf(installPackages(opts({packages: ['sl']}), noTty.deps))).toBe('CONFIRMATION_REQUIRED')
    expect(noTty.mise.calls).toEqual([])

    const json = setup()
    expect(await codeOf(installPackages(opts({json: true, packages: ['sl']}), json.deps))).toBe('CONFIRMATION_REQUIRED')
  })

  it('lets mise prompt on a TTY without --yes', async () => {
    const {deps, mise} = setup()
    await installPackages(opts({packages: ['sl']}), deps)
    expect(mise.applied[0].opts).toEqual({capture: false, nonInteractive: false, yes: false})
  })

  it('non-interactive implies yes and checks sudo first', async () => {
    const {deps, mise} = setup({sudoReady: async () => false})
    expect(await codeOf(installPackages(opts({nonInteractive: true, packages: ['sl']}), deps))).toBe('SUDO_PASSWORD_REQUIRED')
    expect(mise.calls).not.toContain('apply')

    const ok = setup()
    await installPackages(opts({json: true, nonInteractive: true, packages: ['sl']}), ok.deps)
    expect(ok.mise.applied[0].opts).toEqual({capture: true, nonInteractive: true, yes: true})
  })

  it('skips the sudo check for managers that do not need root', async () => {
    let checked = false
    const {deps} = setup({sudoReady: async () => (checked = true)})
    await installPackages(opts({nonInteractive: true, packages: ['brew:jq']}), deps)
    expect(checked).toBe(false)
  })

  it('does not detect the OS when every package names its manager', async () => {
    const {deps} = setup({
      detectManager: async () => {
        throw new OpsError('UNSUPPORTED_PLATFORM', 'nope')
      },
    })
    const result = await installPackages(opts({packages: ['brew:jq'], yes: true}), deps)
    expect(result.managers).toEqual(['brew'])
  })

  it('rejects an empty package list and invalid names', async () => {
    const {deps} = setup()
    expect(await codeOf(installPackages(opts({packages: [], yes: true}), deps))).toBe('INVALID_PACKAGE_NAME')
    expect(await codeOf(installPackages(opts({packages: ['--force'], yes: true}), deps))).toBe('INVALID_PACKAGE_NAME')
  })

  it('installs registry tools with mise use and system-preferred names with the OS manager', async () => {
    const {deps, mise, tools} = setup()
    tools.registry.add('fastfetch').add('zsh')
    const result = await installPackages(opts({packages: ['fastfetch', 'zsh'], yes: true}), deps)
    expect(tools.installs).toEqual([{names: ['fastfetch'], opts: {capture: false, nonInteractive: false}}])
    expect(mise.applied.map((a) => a.specs)).toEqual([['apt:zsh']])
    expect(result).toMatchObject({managers: ['mise', 'apt'], success: true})
    expect(result.packages).toEqual([
      {spec: 'mise:fastfetch', status: 'installed', version: '2.0'},
      {spec: 'apt:zsh', status: 'installed', version: '1.0'},
    ])
  })

  it('skips mise use for installed tools and keeps the version suffix out of the lookup', async () => {
    const {deps, mise, tools} = setup()
    tools.installed.set('jq', '1.8')
    const result = await installPackages(opts({packages: ['mise:jq@1'], yes: true}), deps)
    expect(tools.calls).toEqual(['status'])
    expect(mise.calls).toEqual([])
    expect(result.packages).toEqual([{spec: 'mise:jq@1', status: 'already-installed', version: '1.8'}])
  })

  it('marks tools still missing after mise use as failed', async () => {
    const {deps, tools} = setup()
    tools.registry.add('fastfetch')
    tools.installOnUse = false
    const result = await installPackages(opts({packages: ['fastfetch'], yes: true}), deps)
    expect(result.packages).toEqual([{spec: 'mise:fastfetch', status: 'failed'}])
    expect(result.success).toBe(false)
  })

  it('needs no confirmation or OS detection for tools only', async () => {
    const {deps, tools} = setup({
      detectManager: async () => {
        throw new OpsError('UNSUPPORTED_PLATFORM', 'nope')
      },
      isTTY: false,
    })
    tools.registry.add('fastfetch')
    const result = await installPackages(opts({json: true, packages: ['fastfetch']}), deps)
    expect(result.success).toBe(true)
    expect(tools.installs[0].opts).toEqual({capture: true, nonInteractive: false})
  })

  it('dry-run plans tools and system packages without writing', async () => {
    const {deps, mise, tools} = setup()
    tools.registry.add('fastfetch')
    const result = await installPackages(opts({dryRun: true, packages: ['fastfetch', 'sl']}), deps)
    expect(tools.calls).toEqual(['dryRun', 'status'])
    expect(mise.calls).toEqual(['dryRun', 'status'])
    expect(result.commands).toEqual(['would use fastfetch', 'would install apt:sl'])
    expect(result.packages.map((p) => p.status)).toEqual(['would-install', 'would-install'])
  })
})

describe('installPackages with a repo-backed recipe', () => {
  it('configures the repo, then lets the package manager install the package', async () => {
    const {deps, deb, mise, repos} = setup({recipes: firefoxRecipes()})
    const result = await installPackages(opts({packages: ['firefox'], yes: true}), deps)

    expect(repos.ensured).toHaveLength(1)
    expect(repos.ensured[0]).toMatchObject({opts: {capture: false, nonInteractive: false}, pkg: 'firefox', repo: {...MOZILLA.mozilla, name: 'mozilla'}})
    // Unlike a prepare step, a repo does not install anything itself.
    expect(deb.installs).toEqual([])
    expect(mise.applied).toEqual([{opts: {capture: false, nonInteractive: false, yes: true}, specs: ['apt:firefox']}])
    expect(result.packages).toEqual([{spec: 'apt:firefox', status: 'installed', version: '1.0'}])
  })

  it('leaves a package already installed from the repo alone', async () => {
    const {deps, mise, repos} = setup({recipes: firefoxRecipes()})
    mise.installed.set('apt:firefox', '143.0')
    const result = await installPackages(opts({packages: ['firefox'], yes: true}), deps)

    // Verified, not assumed: "installed" alone cannot tell the repo build from the shim.
    expect(repos.verified).toEqual([{pkg: 'firefox', repo: {...MOZILLA.mozilla, name: 'mozilla'}}])
    expect(repos.ensured).toEqual([])
    expect(mise.applied).toEqual([])
    expect(result.packages).toEqual([{spec: 'apt:firefox', status: 'already-installed', version: '143.0'}])
  })

  // The Ubuntu `firefox` package is a 121 KB shim that installs the snap, and mise reports
  // it as installed. Saying "already installed" here would be a lie.
  it('fails instead of claiming success when the installed package came from elsewhere', async () => {
    const {deps, mise, repos} = setup({recipes: firefoxRecipes()})
    mise.installed.set('apt:firefox', '1:1snap1-0ubuntu5')
    repos.serves = false
    repos.candidate = '1:1snap1-0ubuntu5'
    const result = await installPackages(opts({packages: ['firefox'], yes: true}), deps)

    expect(result.success).toBe(false)
    expect(result.packages[0]).toMatchObject({spec: 'apt:firefox', status: 'failed'})
    expect(result.packages[0]!.error).toContain('packages.mozilla.org')
    expect(result.packages[0]!.error).toContain('--force')
    expect(repos.ensured).toEqual([])
    expect(mise.applied).toEqual([])
  })

  it('switches a wrong-origin package to the repo build with --force', async () => {
    const {deps, mise, repos} = setup({recipes: firefoxRecipes()})
    mise.installed.set('apt:firefox', '1:1snap1-0ubuntu5')
    repos.serves = false
    const result = await installPackages(opts({force: true, packages: ['firefox'], yes: true}), deps)

    expect(repos.ensured).toHaveLength(1)
    expect(mise.applied).toEqual([{opts: {capture: false, nonInteractive: false, yes: true}, specs: ['apt:firefox']}])
    expect(result.success).toBe(true)
  })

  it('forwards repo stages naming the repo, not the package spec', async () => {
    const seen: [string, string][] = []
    const {deps} = setup({onStage: (stage, subject) => seen.push([stage, subject]), recipes: firefoxRecipes()})
    await installPackages(opts({packages: ['firefox'], yes: true}), deps)
    // Repo work is named after the repo, not the spec, then the terminal goes to apt.
    expect(seen).toEqual([
      ['repo-update', 'repo.mozilla'],
      ['streaming', 'apt:firefox'],
    ])
  })

  it('releases the terminal before the package manager streams its own output', async () => {
    const seen: string[] = []
    const {deps, mise} = setup({onStage: (stage) => seen.push(stage), recipes: firefoxRecipes()})
    const apply = mise.apply.bind(mise)
    mise.apply = async (specs, o) => {
      seen.push('apply')
      return apply(specs, o)
    }

    await installPackages(opts({packages: ['firefox'], yes: true}), deps)
    expect(seen).toEqual(['repo-update', 'streaming', 'apply'])
  })

  it('installs nothing when configuring the repo fails', async () => {
    const {deps, mise, repos} = setup({recipes: firefoxRecipes()})
    repos.failWith = new OpsError('REPO_PIN_UNSATISFIED', 'candidate is not from packages.mozilla.org')
    expect(await codeOf(installPackages(opts({packages: ['firefox'], yes: true}), deps))).toBe('REPO_PIN_UNSATISFIED')
    expect(mise.calls).not.toContain('apply')
  })

  it('configures the repo once and applies every system package together', async () => {
    const {deps, mise, repos} = setup({recipes: firefoxRecipes()})
    await installPackages(opts({packages: ['firefox', 'sl'], yes: true}), deps)

    expect(repos.ensured).toHaveLength(1)
    expect(mise.applied).toEqual([{opts: {capture: false, nonInteractive: false, yes: true}, specs: ['apt:firefox', 'apt:sl']}])
  })

  it('forwards capture and non-interactive to the repo provider', async () => {
    const {deps, repos} = setup({recipes: firefoxRecipes()})
    await installPackages(opts({json: true, nonInteractive: true, packages: ['firefox'], yes: true}), deps)
    expect(repos.ensured[0]!.opts).toMatchObject({capture: true, nonInteractive: true})
  })

  // A repo writes deb822 files under /etc/apt; there is no dnf equivalent yet. Fail loudly
  // rather than configure nothing and let the install fail somewhere confusing.
  it('refuses a repo-backed recipe whose package is not an apt package', async () => {
    const {deps, repos} = setup({
      recipes: recipeIndex({firefox: {package: 'dnf:firefox', repo: 'mozilla'}}, {repos: MOZILLA}),
    })
    expect(await codeOf(installPackages(opts({packages: ['firefox'], yes: true}), deps))).toBe('UNSUPPORTED_PLATFORM')
    expect(repos.ensured).toEqual([])
  })

  it('describes the repo before the install, and still lets mise describe the package', async () => {
    const {deps, repos} = setup({recipes: firefoxRecipes()})
    const result = await installPackages(opts({dryRun: true, packages: ['firefox', 'sl']}), deps)

    expect(result.commands).toEqual(['configure repo mozilla', 'apt-cache policy firefox', 'would install apt:firefox', 'would install apt:sl'])
    expect(repos.ensured).toEqual([])
    expect(repos.verified).toEqual([])
  })
})

describe('installPackages terminal handover for mise tools', () => {
  it('releases the terminal before `mise use` streams its own output', async () => {
    const seen: string[] = []
    const {deps, tools} = setup({onStage: (stage) => seen.push(stage)})
    tools.registry.add('fastfetch')
    const install = tools.install.bind(tools)
    tools.install = async (names, o) => {
      seen.push('install')
      return install(names, o)
    }

    await installPackages(opts({packages: ['fastfetch'], yes: true}), deps)
    expect(seen).toEqual(['streaming', 'install'])
  })
})
