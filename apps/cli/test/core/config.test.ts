import {readFile} from 'node:fs/promises'

import {z} from 'zod'
import {describe, expect, it} from 'vitest'
import {configPath, defaultsPath, loadConfig, readCatalog} from '#core/config.js'
import {OpsError} from '#core/errors.js'
import {recipeIndex} from '#core/tool/recipe.js'

const DEFAULTS = 'package:\n  system: [zsh, tmux]\n'

type Catalog = Record<string, string>

/**
 * Serves the defaults at /defaults.yaml, the user config (if any) at /user.yaml, and catalog
 * entries at /repo/<name>.yaml and /tool/<name>.yaml -- the layout loadConfig derives from
 * dirname('/defaults.yaml').
 */
function fakes(user: string | undefined, defaults: string, repo: Catalog, tool: Catalog) {
  const entries: Record<string, string> = {'/defaults.yaml': defaults}
  if (user !== undefined) entries['/user.yaml'] = user
  for (const [name, body] of Object.entries(repo)) entries[`/repo/${name}.yaml`] = body
  for (const [name, body] of Object.entries(tool)) entries[`/tool/${name}.yaml`] = body

  const listing: Record<string, string[]> = {
    '/repo': Object.keys(repo).map((name) => `${name}.yaml`),
    '/tool': Object.keys(tool).map((name) => `${name}.yaml`),
  }

  const enoent = () => Object.assign(new Error('missing'), {code: 'ENOENT'})

  return {
    readFile: async (path: string) => {
      if (path in entries) return entries[path]
      throw enoent()
    },
    // An empty catalog is a directory that does not exist: git cannot store an empty one.
    readDir: async (dir: string) => {
      const names = listing[dir]
      if (!names?.length) throw enoent()
      return names
    },
  }
}

const load = (user?: string, defaults = DEFAULTS, catalog: {repo?: Catalog; tool?: Catalog} = {}) => {
  const {readFile, readDir} = fakes(user, defaults, catalog.repo ?? {}, catalog.tool ?? {})
  return loadConfig(readFile, '/user.yaml', '/defaults.yaml', readDir)
}

async function errorOf(promise: Promise<unknown>) {
  const error = await promise.then(() => undefined, (e: unknown) => e)
  expect(error).toBeInstanceOf(OpsError)
  return error as OpsError
}

describe('configPath', () => {
  it('prefers OPS_CONFIG, then XDG_CONFIG_HOME, then ~/.config', () => {
    expect(configPath({OPS_CONFIG: '/x/ops.yaml', XDG_CONFIG_HOME: '/xdg'}, '/home/u')).toBe('/x/ops.yaml')
    expect(configPath({XDG_CONFIG_HOME: '/xdg'}, '/home/u')).toBe('/xdg/ops/config.yaml')
    expect(configPath({}, '/home/u')).toBe('/home/u/.config/ops/config.yaml')
  })
})

describe('loadConfig', () => {
  it('uses the defaults when the user file is missing or empty', async () => {
    expect(await load()).toEqual({package: {system: ['zsh', 'tmux']}, profile: {}, repo: {}, tool: {}})
    expect(await load('')).toEqual({package: {system: ['zsh', 'tmux']}, profile: {}, repo: {}, tool: {}})
  })

  it('adjusts the default list with add/remove', async () => {
    const config = await load('package:\n  system:\n    add: [htop, zsh]\n    remove: [tmux]\n')
    expect(config.package.system).toEqual(['zsh', 'htop'])
  })

  it('replaces the default list with a user list', async () => {
    expect((await load('package:\n  system: [git]\n')).package.system).toEqual(['git'])
  })

  it('keeps unknown keys', async () => {
    expect(await load('youtube:\n  quality: 1080p\n')).toEqual({package: {system: ['zsh', 'tmux']}, profile: {}, repo: {}, tool: {}, youtube: {quality: '1080p'}})
  })

  it('rejects invalid YAML and wrong types with CONFIG_INVALID', async () => {
    const bad = await errorOf(load('package: [unclosed'))
    expect(bad.code).toBe('CONFIG_INVALID')
    expect(bad.message).toContain('/user.yaml')

    const wrong = await errorOf(load('package:\n  system: zsh\n'))
    expect(wrong.code).toBe('CONFIG_INVALID')
    expect(wrong.message).toContain('package.system')
  })

  it('rejects broken defaults with CONFIG_INVALID', async () => {
    const error = await errorOf(load(undefined, 'package: {}\n'))
    expect(error.code).toBe('CONFIG_INVALID')
    expect(error.message).toContain('/defaults.yaml')
  })

  it('refuses a catalog section left behind in defaults.yaml', async () => {
    // looseObject would keep it and nobody would read it: a recipe that silently does nothing.
    const tool = await errorOf(load(undefined, DEFAULTS + 'tool:\n  ab:\n    package: apt:ab\n'))
    expect(tool.code).toBe('CONFIG_INVALID')
    expect(tool.message).toContain('/defaults.yaml')
    expect(tool.message).toContain('config/tool/')

    const repo = await errorOf(load(undefined, DEFAULTS + 'repo:\n  m:\n    uri: https://x.test/apt\n'))
    expect(repo.code).toBe('CONFIG_INVALID')
    expect(repo.message).toContain('config/repo/')
  })

  it('ships config/defaults.yaml with the system list and the google-chrome recipe', async () => {
    const config = await loadConfig((path) => readFile(path, 'utf8'), '/nonexistent/ops.yaml', defaultsPath())
    expect(config.package.system).toContain('zsh')
    expect(config.package.system).toContain('git')
    expect(config.tool['google-chrome'].package).toBe('apt:google-chrome-stable')
    expect(config.tool['google-chrome'].prepare?.deb).toMatch(/^https:\/\/dl\.google\.com\//)
    expect(config.tool['agent-browser'].setup?.map((s) => s.name)).toEqual(['browser binaries'])

    // The shipped purge list must survive the real validation, not just the schema.
    const paths = recipeIndex(config.tool, {home: '/home/t', repos: config.repo}).purgeFor('google-chrome')
    expect(paths).toContain('/etc/apt/sources.list.d/google-chrome.sources')
    expect(paths).toContain('/home/t/.config/google-chrome')
    expect(paths?.every((path) => path.startsWith('/'))).toBe(true)
  })

  it('merges tool recipes by name, letting the user replace one', async () => {
    const config = await load(
      'tool:\n  chrome:\n    package: apt:chromium\n  code:\n    package: apt:code\n',
      DEFAULTS,
      {tool: {chrome: 'package: apt:google-chrome-stable\n'}},
    )
    expect(config.tool.chrome.package).toBe('apt:chromium')
    expect(config.tool.code.package).toBe('apt:code')
  })

  it('rejects a recipe without a package', async () => {
    const error = await errorOf(load('tool:\n  chrome:\n    summary: Google Chrome\n'))
    expect(error.code).toBe('CONFIG_INVALID')
    expect(error.message).toContain('tool.chrome.package')
  })

  it('reads setup steps on a recipe', async () => {
    const config = await load('tool:\n  ab:\n    package: mise:ab\n    setup:\n      - name: binaries\n        check: [ab, doctor]\n        run: [ab, install]\n')
    expect(config.tool.ab.setup).toEqual([{name: 'binaries', check: ['ab', 'doctor'], run: ['ab', 'install']}])
  })

  it('rejects an empty setup list', async () => {
    const error = await errorOf(load('tool:\n  ab:\n    package: mise:ab\n    setup: []\n'))
    expect(error.code).toBe('CONFIG_INVALID')
    expect(error.message).toContain('tool.ab.setup')
  })

  // Steps execute arbitrary commands, so a typo must fail loudly rather than be kept.
  it('rejects an unknown key on a step', async () => {
    const error = await errorOf(load('tool:\n  ab:\n    package: mise:ab\n    setup:\n      - name: x\n        chekc: [ab]\n        check: [ab]\n        run: [ab]\n'))
    expect(error.code).toBe('CONFIG_INVALID')
    expect(error.message).toContain('chekc')
  })

  it('rejects an empty check and an argv starting with a dash', async () => {
    const empty = await errorOf(load('tool:\n  ab:\n    package: mise:ab\n    setup:\n      - name: x\n        check: []\n        run: [ab]\n'))
    expect(empty.message).toContain('tool.ab.setup[0].check')

    const dash = await errorOf(load('tool:\n  ab:\n    package: mise:ab\n    setup:\n      - name: x\n        check: [ab]\n        run: [--force]\n'))
    expect(dash.message).toContain('tool.ab.setup[0].run')
  })

  it('lets a user recipe replace the built-in setup wholesale', async () => {
    const config = await load(
      'tool:\n  ab:\n    package: mise:ab\n    setup:\n      - name: mine\n        check: [ab, ok]\n        run: [ab, go]\n',
      DEFAULTS,
      {tool: {ab: 'package: mise:ab\nsetup:\n  - name: built-in\n    check: [ab, doctor]\n    run: [ab, install]\n'}},
    )
    expect(config.tool.ab.setup?.map((s) => s.name)).toEqual(['mine'])
  })

  it('reads uninstall purge paths on a recipe', async () => {
    const config = await load('tool:\n  ab:\n    package: apt:ab\n    uninstall:\n      purge:\n        paths: [/etc/ab.conf, ~/.config/ab]\n')
    expect(config.tool.ab.uninstall).toEqual({purge: {paths: ['/etc/ab.conf', '~/.config/ab']}})
  })

  it('rejects an empty purge path list', async () => {
    const error = await errorOf(load('tool:\n  ab:\n    package: apt:ab\n    uninstall:\n      purge:\n        paths: []\n'))
    expect(error.code).toBe('CONFIG_INVALID')
    expect(error.message).toContain('tool.ab.uninstall.purge.paths')
  })

  // Strict, unlike `prepare`: this block names files that get deleted.
  it('rejects a misspelled key inside uninstall', async () => {
    const step = await errorOf(load('tool:\n  ab:\n    package: apt:ab\n    uninstall:\n      purge:\n        path: [/etc/ab.conf]\n'))
    expect(step.code).toBe('CONFIG_INVALID')

    const block = await errorOf(load('tool:\n  ab:\n    package: apt:ab\n    uninstall:\n      prune:\n        paths: [/etc/ab.conf]\n'))
    expect(block.code).toBe('CONFIG_INVALID')
  })

  it('rejects a purge path that is neither absolute nor ~-rooted', async () => {
    const error = await errorOf(load('tool:\n  ab:\n    package: apt:ab\n    uninstall:\n      purge:\n        paths: [etc/ab.conf]\n'))
    expect(error.code).toBe('CONFIG_INVALID')
    expect(error.message).toContain('tool.ab.uninstall.purge.paths[0]')
  })

  // prepare stays loose; only the blocks that run or delete are strict.
  it('keeps unknown keys on prepare', async () => {
    const config = await load('tool:\n  ab:\n    package: apt:ab\n    prepare:\n      deb: https://x/a.deb\n      sha256: abc\n')
    expect(config.tool.ab.prepare).toMatchObject({deb: 'https://x/a.deb', sha256: 'abc'})
  })

  it('assembles repo and tool from the catalog directories, not from defaults.yaml', async () => {
    const config = await load(undefined, DEFAULTS, {
      repo: {mozilla: 'uri: https://packages.mozilla.org/apt\nsuite: mozilla\ncomponents: [main]\nkeyring: https://packages.mozilla.org/apt/k.gpg\n'},
      tool: {firefox: 'package: apt:firefox\nrepo: mozilla\n', 'agent-browser': 'package: mise:agent-browser\n'},
    })

    expect(Object.keys(config.tool)).toEqual(['agent-browser', 'firefox'])
    expect(config.tool.firefox.package).toBe('apt:firefox')
    expect(config.repo.mozilla.suite).toBe('mozilla')
  })
})

describe('shipped defaults', () => {
  it('ships the mozilla repo and a firefox recipe that references it', async () => {
    const config = await loadConfig((path) => readFile(path, 'utf8'), '/nonexistent/ops.yaml', defaultsPath())

    expect(config.repo.mozilla.uri).toBe('https://packages.mozilla.org/apt')
    expect(config.repo.mozilla.suite).toBe('mozilla')
    expect(config.repo.mozilla.components).toEqual(['main'])
    expect(config.repo.mozilla.keyring).toMatch(/^https:\/\/packages\.mozilla\.org\//)
    // Above the Ubuntu archive's 500, or apt keeps the transitional package that installs the snap.
    expect(config.repo.mozilla.pin).toEqual({origin: 'packages.mozilla.org', priority: 1000})

    expect(config.tool.firefox.package).toBe('apt:firefox')
    expect(config.tool.firefox.repo).toBe('mozilla')
    expect(config.tool.firefox.prepare).toBeUndefined()

    // The shipped file must satisfy every cross-reference invariant.
    expect(() => recipeIndex(config.tool, {repos: config.repo})).not.toThrow()
  })
})

describe('repo config', () => {
  const MOZILLA = [
    'uri: https://packages.mozilla.org/apt',
    'suite: mozilla',
    'components: [main]',
    'keyring: https://packages.mozilla.org/apt/repo-signing-key.gpg',
    'pin:',
    '  origin: packages.mozilla.org',
    '  priority: 1000',
    '',
  ].join('\n')

  /** The built-in catalog for these tests: one repo, named by its filename. */
  const mozilla = (body = MOZILLA) => ({repo: {mozilla: body}})

  it('defaults to no repos', async () => {
    expect((await load()).repo).toEqual({})
  })

  it('parses a repo with a pin', async () => {
    const config = await load(undefined, DEFAULTS, mozilla())
    expect(config.repo.mozilla).toEqual({
      uri: 'https://packages.mozilla.org/apt',
      suite: 'mozilla',
      components: ['main'],
      keyring: 'https://packages.mozilla.org/apt/repo-signing-key.gpg',
      pin: {origin: 'packages.mozilla.org', priority: 1000},
    })
  })

  it('rejects a misspelled key inside a repo, naming the file and the key', async () => {
    const error = await errorOf(load(undefined, DEFAULTS, mozilla(MOZILLA.replace('suite:', 'suit:'))))
    expect(error.code).toBe('CONFIG_INVALID')
    expect(error.message).toContain('/repo/mozilla.yaml')
    expect(error.message).toContain('suit')
  })

  it('rejects a non-https uri and keyring, naming the field', async () => {
    const uri = await errorOf(load(undefined, DEFAULTS, mozilla(MOZILLA.replace('uri: https://', 'uri: http://'))))
    expect(uri.message).toContain('uri')

    const keyring = await errorOf(load(undefined, DEFAULTS, mozilla(MOZILLA.replace('keyring: https://', 'keyring: http://'))))
    expect(keyring.message).toContain('keyring')
  })

  it('rejects a user repo name that would not be a usable filename', async () => {
    // A built-in repo's name is its filename, guarded by readCatalog; a user's is a map key.
    const user = 'repo:\n  Mozilla/1:\n    uri: https://x.test/apt\n    suite: m\n    components: [main]\n    keyring: https://x.test/k.gpg\n'
    const error = await errorOf(load(user))
    expect(error.code).toBe('CONFIG_INVALID')
    expect(error.message).toContain('Mozilla/1')
  })

  it('merges repos by name, with the user winning and other repos kept', async () => {
    const other = 'uri: https://other.test/apt\nsuite: o\ncomponents: [main]\nkeyring: https://other.test/k.gpg\n'
    const user = 'repo:\n  mozilla:\n    uri: https://mirror.test/apt\n    suite: m\n    components: [main]\n    keyring: https://mirror.test/k.gpg\n'
    const config = await load(user, DEFAULTS, {repo: {mozilla: MOZILLA, other}})

    expect(config.repo.mozilla.uri).toBe('https://mirror.test/apt')
    expect(config.repo.mozilla.pin).toBeUndefined()
    // A user `repo` section must not drop the built-in repos it does not mention.
    expect(config.repo.other.uri).toBe('https://other.test/apt')
  })

  it('rejects a pin priority that is not a positive integer', async () => {
    const zero = await errorOf(load(undefined, DEFAULTS, mozilla(MOZILLA.replace('priority: 1000', 'priority: 0'))))
    expect(zero.code).toBe('CONFIG_INVALID')

    const text = await errorOf(load(undefined, DEFAULTS, mozilla(MOZILLA.replace('priority: 1000', 'priority: high'))))
    expect(text.code).toBe('CONFIG_INVALID')
  })
})

describe('profiles', () => {
  it('merges profiles by name, replacing a built-in wholesale', async () => {
    const defaults = DEFAULTS + 'profile:\n  base:\n    packages: [git]\n  dev:\n    extends: base\n    packages: [zsh]\n'
    const config = await load('profile:\n  dev:\n    packages: [fish]\n', defaults)
    expect(config.profile.base).toEqual({packages: ['git']})
    // The user entry replaced the built-in: `extends` is gone, not merged away.
    expect(config.profile.dev).toEqual({packages: ['fish']})
  })

  it('accepts extends as a string or a list', async () => {
    const config = await load(undefined, DEFAULTS + 'profile:\n  a:\n    extends: base\n  b:\n    extends: [base, a]\n')
    expect(config.profile.a.extends).toBe('base')
    expect(config.profile.b.extends).toEqual(['base', 'a'])
  })

  it('accepts the add/remove form of a list section', async () => {
    const config = await load(undefined, DEFAULTS + 'profile:\n  a:\n    packages: {add: [git], remove: [zsh]}\n')
    expect(config.profile.a.packages).toEqual({add: ['git'], remove: ['zsh']})
  })

  it('applies service defaults', async () => {
    const config = await load(undefined, DEFAULTS + 'profile:\n  a:\n    services: [{name: docker}]\n')
    expect(config.profile.a.services).toEqual([{name: 'docker', scope: 'system', enabled: true, state: 'started'}])
  })

  it('rejects an unknown key in a profile', async () => {
    // Strict, unlike a recipe: a misspelled section would converge the wrong machine
    // and still report success.
    const error = await errorOf(load(undefined, DEFAULTS + 'profile:\n  a:\n    serivces: [docker]\n'))
    expect(error.code).toBe('CONFIG_INVALID')
  })

  it('defaults to an empty map when the file declares no profiles', async () => {
    expect((await load()).profile).toEqual({})
  })

  it('parses the shipped defaults, including the profiles', async () => {
    const config = await loadConfig(async (path) => readFile(path, 'utf8'), '/nonexistent/ops.yaml', defaultsPath())
    expect(Object.keys(config.profile)).toEqual(['base', 'minimal', 'dev'])
    expect(config.profile.dev.extends).toBe('minimal')
    expect(config.profile.dev.tools).toEqual(['node@lts', 'pnpm'])
  })
})

describe('mise', () => {
  it('reads the installer and install path', async () => {
    const config = await load(undefined, DEFAULTS + 'mise:\n  installer: https://mise.run\n  path: /usr/local/bin/mise\n')
    expect(config.mise).toEqual({installer: 'https://mise.run', path: '/usr/local/bin/mise'})
  })

  it('is undefined when the config says nothing', async () => {
    expect((await load()).mise).toBeUndefined()
  })

  it('rejects a non-https installer', async () => {
    // The script is downloaded and run as root; plain http is not negotiable.
    const error = await errorOf(load(undefined, DEFAULTS + 'mise:\n  installer: http://mise.run\n  path: /usr/local/bin/mise\n'))
    expect(error.code).toBe('CONFIG_INVALID')
  })

  it('rejects a relative install path', async () => {
    const error = await errorOf(load(undefined, DEFAULTS + 'mise:\n  installer: https://mise.run\n  path: bin/mise\n'))
    expect(error.code).toBe('CONFIG_INVALID')
  })

  it('lets a user override the installer wholesale', async () => {
    const defaults = DEFAULTS + 'mise:\n  installer: https://mise.run\n  path: /usr/local/bin/mise\n'
    const config = await load('mise:\n  installer: https://mirror.test/mise.sh\n  path: /opt/mise\n', defaults)
    expect(config.mise).toEqual({installer: 'https://mirror.test/mise.sh', path: '/opt/mise'})
  })

  it('ships an installer and a path in the real defaults', async () => {
    const config = await loadConfig(async (path) => readFile(path, 'utf8'), '/nonexistent/ops.yaml', defaultsPath())
    expect(config.mise).toEqual({installer: 'https://mise.run', path: '/usr/local/bin/mise'})
  })
})

describe('readCatalog', () => {
  const Entry = z.strictObject({package: z.string()})

  /** Serves exactly the files given; anything else is ENOENT, like the real fs. */
  const reader = (entries: Record<string, string>) => async (path: string) => {
    if (path in entries) return entries[path]
    throw Object.assign(new Error('missing'), {code: 'ENOENT'})
  }

  const lister = (names: string[]) => async () => names

  it('keys entries by filename and sorts them, whatever order the filesystem returns', async () => {
    const files = {
      '/tool/firefox.yaml': 'package: apt:firefox\n',
      '/tool/agent-browser.yaml': 'package: mise:agent-browser\n',
    }
    // Reverse order in, sorted order out.
    const catalog = await readCatalog(reader(files), lister(['firefox.yaml', 'agent-browser.yaml']), '/tool', Entry)

    expect(Object.keys(catalog)).toEqual(['agent-browser', 'firefox'])
    expect(catalog.firefox).toEqual({package: 'apt:firefox'})
  })

  it('ignores README.md and dotfiles', async () => {
    const files = {'/tool/firefox.yaml': 'package: apt:firefox\n'}
    const names = ['README.md', '.gitkeep', '.firefox.yaml.swp', 'firefox.yaml']
    const catalog = await readCatalog(reader(files), lister(names), '/tool', Entry)

    expect(Object.keys(catalog)).toEqual(['firefox'])
  })

  it('rejects a file that is not .yaml, naming it', async () => {
    // A .yml typo must fail loudly; silently skipping it is the bug this guards.
    const error = await errorOf(readCatalog(reader({}), lister(['firefox.yml']), '/tool', Entry))

    expect(error.code).toBe('CONFIG_INVALID')
    expect(error.message).toContain('/tool/firefox.yml')
  })

  it('rejects a filename that is not a usable entry name', async () => {
    const error = await errorOf(readCatalog(reader({}), lister(['Firefox.yaml']), '/tool', Entry))

    expect(error.code).toBe('CONFIG_INVALID')
    expect(error.message).toContain('/tool/Firefox.yaml')
  })

  it('treats a missing directory as no entries', async () => {
    const missing = async () => {
      throw Object.assign(new Error('missing'), {code: 'ENOENT'})
    }

    expect(await readCatalog(reader({}), missing, '/repo', Entry)).toEqual({})
  })

  it('propagates a directory error that is not ENOENT', async () => {
    const denied = async () => {
      throw Object.assign(new Error('denied'), {code: 'EACCES'})
    }

    await expect(readCatalog(reader({}), denied, '/repo', Entry)).rejects.toThrow('denied')
  })

  it('names the offending file when an entry fails its schema', async () => {
    const files = {'/tool/firefox.yaml': 'packag: apt:firefox\n'}
    const error = await errorOf(readCatalog(reader(files), lister(['firefox.yaml']), '/tool', Entry))

    expect(error.code).toBe('CONFIG_INVALID')
    expect(error.message).toContain('/tool/firefox.yaml')
  })
})
