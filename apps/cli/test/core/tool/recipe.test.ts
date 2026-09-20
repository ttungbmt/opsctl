import {describe, expect, it} from 'vitest'
import {OpsError} from '../../../src/core/errors.js'
import {recipeIndex} from '../../../src/core/tool/recipe.js'

const CHROME = {package: 'apt:google-chrome-stable', prepare: {deb: 'https://example.test/chrome.deb'}}
const STEP = {name: 'browser binaries', check: ['ab', 'doctor'], run: ['ab', 'install']}
const AB = {package: 'mise:ab', setup: [STEP]}
const HOME = '/home/t'

const MOZILLA = {
  uri: 'https://packages.mozilla.org/apt',
  suite: 'mozilla',
  components: ['main'],
  keyring: 'https://packages.mozilla.org/apt/repo-signing-key.gpg',
  pin: {origin: 'packages.mozilla.org', priority: 1000},
}
const FIREFOX = {package: 'apt:firefox', repo: 'mozilla'}

/** recipeIndex checks repo cross-references eagerly, so a bad one throws from the constructor. */
function ctxError(recipes: Parameters<typeof recipeIndex>[0], ctx: Parameters<typeof recipeIndex>[1]) {
  const error = (() => {
    try {
      recipeIndex(recipes, ctx)
    } catch (e: unknown) {
      return e
    }
  })()
  expect(error).toBeInstanceOf(OpsError)
  return error as OpsError
}

/** recipeIndex validates purge paths eagerly, so a bad one throws from the constructor. */
function indexError(recipes: Parameters<typeof recipeIndex>[0]) {
  const error = (() => {
    try {
      recipeIndex(recipes, {home: HOME})
    } catch (e: unknown) {
      return e
    }
  })()
  expect(error).toBeInstanceOf(OpsError)
  return error as OpsError
}

const withPaths = (...paths: string[]) => ({ab: {package: 'apt:ab', uninstall: {purge: {paths}}}})

describe('recipeIndex', () => {
  it('looks recipes up by tool name', () => {
    const index = recipeIndex({'google-chrome': CHROME})
    expect(index.byName('google-chrome')).toEqual(CHROME)
    expect(index.byName('node')).toBeUndefined()
  })

  it('looks prepare steps up by resolved spec', () => {
    const index = recipeIndex({'google-chrome': CHROME})
    expect(index.prepareFor('apt:google-chrome-stable')).toEqual({deb: 'https://example.test/chrome.deb'})
    expect(index.prepareFor('apt:zsh')).toBeUndefined()
  })

  it('indexes no prepare step for a recipe that has none', () => {
    const index = recipeIndex({code: {package: 'apt:code'}})
    expect(index.byName('code')).toEqual({package: 'apt:code'})
    expect(index.prepareFor('apt:code')).toBeUndefined()
  })

  it('is empty when no recipes are configured', () => {
    expect(recipeIndex().byName('google-chrome')).toBeUndefined()
    expect(recipeIndex({}).prepareFor('apt:zsh')).toBeUndefined()
  })

  it('looks setup steps up by tool name', () => {
    const index = recipeIndex({ab: AB, 'google-chrome': CHROME})
    expect(index.setupFor('ab')).toEqual([STEP])
  })

  // "no recipe" and "a recipe with nothing to configure" both mean: nothing to run.
  it('has no setup steps for a recipe without them, or for an unknown name', () => {
    const index = recipeIndex({'google-chrome': CHROME})
    expect(index.setupFor('google-chrome')).toBeUndefined()
    expect(index.setupFor('node')).toBeUndefined()
  })

  it('rejects a package without a manager prefix', () => {
    const error = (() => {
      try {
        recipeIndex({'google-chrome': {package: 'google-chrome-stable'}})
      } catch (e: unknown) {
        return e
      }
    })()
    expect(error).toBeInstanceOf(OpsError)
    expect((error as OpsError).code).toBe('CONFIG_INVALID')
    expect((error as OpsError).message).toContain('tool.google-chrome')
  })

  it('expands ~ in purge paths against the given home', () => {
    const index = recipeIndex(withPaths('/etc/ab.conf', '~/.config/ab', '~/.cache/ab/'), {home: HOME})
    expect(index.purgeFor('ab')).toEqual(['/etc/ab.conf', '/home/t/.config/ab', '/home/t/.cache/ab'])
  })

  it('has no purge paths for a recipe without them, or for an unknown name', () => {
    const index = recipeIndex({'google-chrome': CHROME}, {home: HOME})
    expect(index.purgeFor('google-chrome')).toBeUndefined()
    expect(index.purgeFor('node')).toBeUndefined()
  })

  // Every one of these reaches `rm -rf`, sometimes under sudo. They must die at config load.
  it.each([
    ['a relative path', 'etc/ab.conf'],
    ['another user home', '~other/x'],
    ['an escape via ..', '~/../../etc/passwd'],
    ['a .. segment', '/etc/../etc'],
    ['the root directory', '/'],
    ['a single top-level directory', '/etc'],
    ['a bare home', '~'],
    ['the home directory itself', '/home/t'],
    ['a shared config root', '~/.config'],
    ['a shared cache root', '~/.cache'],
    ['a shared data root', '~/.local/share'],
    ['a glob, which rm would not expand', '/etc/apt/sources.list.d/*.list'],
    ['a newline', '/etc/ab\nrm -rf /'],
  ])('rejects %s', (_label, path) => {
    const error = indexError(withPaths(path))
    expect(error.code).toBe('CONFIG_INVALID')
    expect(error.message).toContain('tool.ab')
  })

  it('accepts a path two segments deep under a shared root', () => {
    expect(recipeIndex(withPaths('~/.config/ab', '/etc/apt/sources.list.d/ab.list'), {home: HOME}).purgeFor('ab')).toEqual([
      '/home/t/.config/ab',
      '/etc/apt/sources.list.d/ab.list',
    ])
  })
})

describe('recipeIndex repos', () => {
  it('looks a repo up by resolved spec, with the config key injected as its name', () => {
    const index = recipeIndex({firefox: FIREFOX}, {repos: {mozilla: MOZILLA}})
    expect(index.repoFor('apt:firefox')).toEqual({...MOZILLA, name: 'mozilla'})
  })

  it('has no repo for a recipe without one, or for an unknown spec', () => {
    const index = recipeIndex({'google-chrome': CHROME, firefox: FIREFOX}, {repos: {mozilla: MOZILLA}})
    expect(index.repoFor('apt:google-chrome-stable')).toBeUndefined()
    expect(index.repoFor('apt:zsh')).toBeUndefined()
  })

  // A loose RecipeSchema keeps `repoo:`, and an unconfigured repo means nothing is verified.
  it('rejects a recipe naming a repo that is not defined', () => {
    const error = ctxError({firefox: FIREFOX}, {repos: {}})
    expect(error.code).toBe('CONFIG_INVALID')
    expect(error.message).toContain('tool.firefox')
    expect(error.message).toContain('mozilla')
  })

  // This is what catches a misspelled `repo:` key: the repo it meant becomes unreferenced.
  it('rejects a repo that no recipe references', () => {
    const error = ctxError({firefox: {...FIREFOX, repoo: 'mozilla', repo: undefined}}, {repos: {mozilla: MOZILLA}})
    expect(error.code).toBe('CONFIG_INVALID')
    expect(error.message).toContain('repo.mozilla')
  })

  it('rejects a recipe carrying both prepare and repo', () => {
    const error = ctxError({firefox: {...FIREFOX, prepare: {deb: 'https://example.test/f.deb'}}}, {repos: {mozilla: MOZILLA}})
    expect(error.code).toBe('CONFIG_INVALID')
    expect(error.message).toContain('tool.firefox')
  })

  it('rejects two recipes claiming the same spec, naming both', () => {
    const error = ctxError(
      {firefox: FIREFOX, 'firefox-alias': {package: 'apt:firefox', prepare: {deb: 'https://example.test/f.deb'}}},
      {repos: {mozilla: MOZILLA}},
    )
    expect(error.code).toBe('CONFIG_INVALID')
    expect(error.message).toContain('firefox')
    expect(error.message).toContain('firefox-alias')
  })
})
