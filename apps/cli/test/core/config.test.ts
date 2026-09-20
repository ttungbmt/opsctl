import {readFile} from 'node:fs/promises'

import {describe, expect, it} from 'vitest'
import {configPath, defaultsPath, loadConfig} from '../../src/core/config.js'
import {OpsError} from '../../src/core/errors.js'

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
    expect(await load()).toEqual({package: {system: ['zsh', 'tmux']}})
    expect(await load('')).toEqual({package: {system: ['zsh', 'tmux']}})
  })

  it('adjusts the default list with add/remove', async () => {
    const config = await load('package:\n  system:\n    add: [htop, zsh]\n    remove: [tmux]\n')
    expect(config.package.system).toEqual(['zsh', 'htop'])
  })

  it('replaces the default list with a user list', async () => {
    expect((await load('package:\n  system: [git]\n')).package.system).toEqual(['git'])
  })

  it('keeps unknown keys', async () => {
    expect(await load('youtube:\n  quality: 1080p\n')).toEqual({package: {system: ['zsh', 'tmux']}, youtube: {quality: '1080p'}})
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

  it('ships config/defaults.yaml with the system list', async () => {
    const config = await loadConfig((path) => readFile(path, 'utf8'), '/nonexistent/ops.yaml', defaultsPath())
    expect(config.package.system).toContain('zsh')
    expect(config.package.system).toContain('git')
  })
})
