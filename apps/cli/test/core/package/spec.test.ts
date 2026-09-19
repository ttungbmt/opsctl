import {describe, expect, it} from 'vitest'
import {OpsError} from '../../../src/core/errors.js'
import {managerOf, toPackageSpec} from '../../../src/core/package/spec.js'

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
