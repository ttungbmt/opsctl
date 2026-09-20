import {describe, expect, it} from 'vitest'
import {OpsError} from '../../../src/core/errors.js'
import {managerOf, toPackageSpec, toolKey, withoutVersion} from '../../../src/core/package/spec.js'

describe('toPackageSpec', () => {
  it('prefixes a plain name with the given manager', () => {
    expect(toPackageSpec('zsh', 'apt')).toBe('apt:zsh')
  })

  it('keeps an explicit manager', () => {
    expect(toPackageSpec('brew:jq', 'apt')).toBe('brew:jq')
    expect(toPackageSpec('brew:postgresql@17')).toBe('brew:postgresql@17')
  })

  it.each(['-y', 'apt:-y', '', 'apt:', ':zsh', 'has space'])('rejects %j', (input) => {
    expect(() => toPackageSpec(input, 'apt')).toThrow(OpsError)
    try {
      toPackageSpec(input, 'apt')
    } catch (error) {
      expect((error as OpsError).code).toBe('INVALID_PACKAGE_NAME')
    }
  })

  it('rejects a plain name when no manager is known', () => {
    expect(() => toPackageSpec('zsh')).toThrow(OpsError)
  })
})

describe('managerOf', () => {
  it('returns the prefix', () => {
    expect(managerOf('apt:zsh')).toBe('apt')
  })
})

describe('withoutVersion', () => {
  it('leaves a bare name alone', () => {
    expect(withoutVersion('node')).toBe('node')
    expect(withoutVersion('aqua:owner/repo')).toBe('aqua:owner/repo')
  })

  it('drops an @version request', () => {
    expect(withoutVersion('node@lts')).toBe('node')
    expect(withoutVersion('node@24.21.0')).toBe('node')
    expect(withoutVersion('aqua:owner/repo@1.2')).toBe('aqua:owner/repo')
  })

  it('keeps a leading @, so an npm scope survives', () => {
    // This is why the search starts at index 1 rather than 0.
    expect(withoutVersion('@scope/pkg')).toBe('@scope/pkg')
    expect(withoutVersion('@scope/pkg@1.2')).toBe('@scope/pkg')
  })
})

describe('toolKey', () => {
  it('is the name mise writes in [tools] and reports in `mise ls`', () => {
    expect(toolKey('mise:node@lts')).toBe('node')
    expect(toolKey('mise:aqua:owner/repo@1.2')).toBe('aqua:owner/repo')
  })
})
