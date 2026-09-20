import {readFile} from 'node:fs/promises'

import {describe, expect, it} from 'vitest'
import {configPath, defaultsPath, loadConfig} from '../../src/core/config.js'
import {OpsError} from '../../src/core/errors.js'
import {recipeIndex} from '../../src/core/tool/recipe.js'

const DEFAULTS = 'package:\n  system: [zsh, tmux]\n'

/** Serves the defaults at /defaults.yaml and the user config (if any) at /user.yaml. */
function files(user?: string, defaults = DEFAULTS) {
  return async (path: string) => {
    if (path === '/defaults.yaml') return defaults
    if (path === '/user.yaml' && user !== undefined) return user
    throw Object.assign(new Error('missing'), {code: 'ENOENT'})
  }
}

const load = (user?: string, defaults?: string) => loadConfig(files(user, defaults), '/user.yaml', '/defaults.yaml')

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
    expect(await load()).toEqual({package: {system: ['zsh', 'tmux']}, repo: {}, tool: {}})
    expect(await load('')).toEqual({package: {system: ['zsh', 'tmux']}, repo: {}, tool: {}})
  })

  it('adjusts the default list with add/remove', async () => {
    const config = await load('package:\n  system:\n    add: [htop, zsh]\n    remove: [tmux]\n')
    expect(config.package.system).toEqual(['zsh', 'htop'])
  })

  it('replaces the default list with a user list', async () => {
    expect((await load('package:\n  system: [git]\n')).package.system).toEqual(['git'])
  })

  it('keeps unknown keys', async () => {
    expect(await load('youtube:\n  quality: 1080p\n')).toEqual({package: {system: ['zsh', 'tmux']}, repo: {}, tool: {}, youtube: {quality: '1080p'}})
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
    const defaults = 'package:\n  system: [zsh]\ntool:\n  chrome:\n    package: apt:google-chrome-stable\n'
    const config = await load('tool:\n  chrome:\n    package: apt:chromium\n  code:\n    package: apt:code\n', defaults)
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
    const defaults = 'package:\n  system: [zsh]\ntool:\n  ab:\n    package: mise:ab\n    setup:\n      - name: built-in\n        check: [ab, doctor]\n        run: [ab, install]\n'
    const config = await load('tool:\n  ab:\n    package: mise:ab\n    setup:\n      - name: mine\n        check: [ab, ok]\n        run: [ab, go]\n', defaults)
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
    'repo:',
    '  mozilla:',
    '    uri: https://packages.mozilla.org/apt',
    '    suite: mozilla',
    '    components: [main]',
    '    keyring: https://packages.mozilla.org/apt/repo-signing-key.gpg',
    '    pin:',
    '      origin: packages.mozilla.org',
    '      priority: 1000',
    '',
  ].join('\n')

  it('defaults to no repos', async () => {
    expect((await load()).repo).toEqual({})
  })

  it('parses a repo with a pin', async () => {
    const config = await load(undefined, DEFAULTS + MOZILLA)
    expect(config.repo.mozilla).toEqual({
      uri: 'https://packages.mozilla.org/apt',
      suite: 'mozilla',
      components: ['main'],
      keyring: 'https://packages.mozilla.org/apt/repo-signing-key.gpg',
      pin: {origin: 'packages.mozilla.org', priority: 1000},
    })
  })

  it('rejects a misspelled key inside a repo, naming it', async () => {
    const error = await errorOf(load(undefined, DEFAULTS + MOZILLA.replace('    suite:', '    suit:')))
    expect(error.code).toBe('CONFIG_INVALID')
    expect(error.message).toContain('suit')
  })

  it('rejects a repo name that would not be a usable filename', async () => {
    const error = await errorOf(load(undefined, DEFAULTS + MOZILLA.replace('  mozilla:', '  Mozilla/1:')))
    expect(error.code).toBe('CONFIG_INVALID')
    expect(error.message).toContain('Mozilla/1')
  })

  it('rejects a non-https uri and keyring, naming the field', async () => {
    const uri = await errorOf(load(undefined, DEFAULTS + MOZILLA.replace('uri: https://', 'uri: http://')))
    expect(uri.message).toContain('uri')

    const keyring = await errorOf(load(undefined, DEFAULTS + MOZILLA.replace('keyring: https://', 'keyring: http://')))
    expect(keyring.message).toContain('keyring')
  })

  it('merges repos by name, with the user winning and other repos kept', async () => {
    const other = '  other:\n    uri: https://other.test/apt\n    suite: o\n    components: [main]\n    keyring: https://other.test/k.gpg\n'
    const user = 'repo:\n  mozilla:\n    uri: https://mirror.test/apt\n    suite: m\n    components: [main]\n    keyring: https://mirror.test/k.gpg\n'
    const config = await load(user, DEFAULTS + MOZILLA + other)
    expect(config.repo.mozilla.uri).toBe('https://mirror.test/apt')
    expect(config.repo.mozilla.pin).toBeUndefined()
    // A user `repo` section must not drop the built-in repos it does not mention.
    expect(config.repo.other.uri).toBe('https://other.test/apt')
  })

  it('rejects a pin priority that is not a positive integer', async () => {
    const zero = await errorOf(load(undefined, DEFAULTS + MOZILLA.replace('priority: 1000', 'priority: 0')))
    expect(zero.code).toBe('CONFIG_INVALID')

    const text = await errorOf(load(undefined, DEFAULTS + MOZILLA.replace('priority: 1000', 'priority: high')))
    expect(text.code).toBe('CONFIG_INVALID')
  })
})
