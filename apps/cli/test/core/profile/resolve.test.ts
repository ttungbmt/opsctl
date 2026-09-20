import {describe, expect, it} from 'vitest'
import type {Profile} from '#core/config.js'
import {OpsError} from '#core/errors.js'
import {declaresSection, profileIndex} from '#core/profile/resolve.js'
import {recipeIndex} from '#core/tool/recipe.js'

const index = (profiles: Record<string, Profile>, recipes = recipeIndex()) => profileIndex(profiles, {recipes})

const svc = (name: string, state: 'started' | 'stopped' = 'started') =>
  ({name, state, scope: 'system' as const, enabled: true})

describe('profileIndex.resolve', () => {
  it('returns every list present and empty when nothing is declared', () => {
    expect(index({a: {}}).resolve('a')).toEqual({name: 'a', lineage: ['a'], packages: [], tools: [], setup: [], services: []})
  })

  it('concatenates lists base first', () => {
    const p = index({base: {packages: ['git']}, a: {extends: 'base', packages: ['zsh']}}).resolve('a')
    expect(p.packages).toEqual(['git', 'zsh'])
    expect(p.lineage).toEqual(['base', 'a'])
  })

  it('deduplicates keeping the first occurrence position', () => {
    const p = index({base: {packages: ['git', 'curl']}, a: {extends: 'base', packages: ['git', 'zsh']}}).resolve('a')
    expect(p.packages).toEqual(['git', 'curl', 'zsh'])
  })

  it('contributes a shared base once through a diamond', () => {
    const p = index({
      base: {packages: ['git']},
      l: {extends: 'base', packages: ['a']},
      r: {extends: 'base', packages: ['b']},
      c: {extends: ['l', 'r']},
    }).resolve('c')
    expect(p.packages).toEqual(['git', 'a', 'b'])
    expect(p.lineage).toEqual(['base', 'l', 'r', 'c'])
  })

  it('resolves multiple parents left to right', () => {
    const p = index({a: {packages: ['a']}, b: {packages: ['b']}, c: {extends: ['a', 'b'], packages: ['c']}}).resolve('c')
    expect(p.packages).toEqual(['a', 'b', 'c'])
  })

  it('removes an inherited entry and appends the additions', () => {
    const p = index({base: {packages: ['git', 'zsh']}, a: {extends: 'base', packages: {remove: ['zsh'], add: ['fish']}}}).resolve('a')
    expect(p.packages).toEqual(['git', 'fish'])
  })

  it('merges shell key by key with the child winning', () => {
    const p = index({
      base: {shell: {name: 'bash', user: 'ops'}},
      a: {extends: 'base', shell: {name: 'zsh', user: 'current'}},
    }).resolve('a')
    expect(p.shell).toEqual({name: 'zsh', user: 'current'})
  })

  it('inherits shell when the child declares none', () => {
    expect(index({base: {shell: {name: 'bash', user: 'ops'}}, a: {extends: 'base'}}).resolve('a').shell).toEqual({name: 'bash', user: 'ops'})
  })

  it('replaces a service by name in the parent position', () => {
    const p = index({
      base: {services: [svc('docker'), svc('nginx')]},
      a: {extends: 'base', services: [svc('docker', 'stopped')]},
    }).resolve('a')
    expect(p.services.map((s) => s.name)).toEqual(['docker', 'nginx'])
    expect(p.services[0].state).toBe('stopped')
  })

  it('does not inherit summary', () => {
    expect(index({base: {summary: 'base box'}, a: {extends: 'base'}}).resolve('a').summary).toBeUndefined()
  })

  it('throws PROFILE_NOT_FOUND naming what is available', () => {
    try {
      index({a: {}, b: {}}).resolve('nope')
      throw new Error('expected a throw')
    } catch (error) {
      expect(error).toBeInstanceOf(OpsError)
      expect((error as OpsError).code).toBe('PROFILE_NOT_FOUND')
      expect((error as OpsError).message).toContain('a, b')
    }
  })
})

describe('profileIndex validation', () => {
  it('rejects a dangling extends at construction', () => {
    expect(() => index({a: {extends: 'nope'}})).toThrow(/unknown profile "nope"/)
  })

  it('rejects a cycle and names the chain', () => {
    try {
      index({a: {extends: 'b'}, b: {extends: 'a'}})
      throw new Error('expected a throw')
    } catch (error) {
      expect((error as OpsError).code).toBe('CONFIG_INVALID')
      expect((error as OpsError).message).toContain('profile.a')
      expect((error as OpsError).message).toContain('profile.b')
    }
  })

  it('rejects a self-referencing profile', () => {
    expect(() => index({a: {extends: 'a'}})).toThrow(/circular/)
  })

  it('rejects a setup entry naming a tool with no setup steps', () => {
    expect(() => index({a: {setup: ['git']}}, recipeIndex({git: {package: 'apt:git'}}))).toThrow(/tool\.git\.setup/)
  })

  it('accepts a setup entry whose tool has steps', () => {
    const recipes = recipeIndex({ab: {package: 'mise:ab', setup: [{name: 's', check: ['ab', 'ok'], run: ['ab', 'go']}]}})
    expect(index({a: {setup: ['ab']}}, recipes).resolve('a').setup).toEqual(['ab'])
  })

  it('does not validate package or tool names', () => {
    // They resolve at run time through resolveSpecs, and the mise registry is a network call.
    expect(() => index({a: {packages: ['no-such-thing'], tools: ['nor-this']}})).not.toThrow()
  })
})

describe('profileIndex.list, names and raw', () => {
  it('lists names sorted with summary, parents and declared sections', () => {
    expect(index({b: {summary: 'B', extends: 'a', tools: ['node']}, a: {packages: ['git']}}).list()).toEqual([
      {name: 'a', summary: undefined, extends: [], sections: ['packages']},
      {name: 'b', summary: 'B', extends: ['a'], sections: ['packages', 'tools']},
    ])
  })

  it('names returns the sorted keys', () => {
    expect(index({b: {}, a: {}}).names()).toEqual(['a', 'b'])
  })

  it('raw returns the literal entry, before composition', () => {
    expect(index({base: {packages: ['git']}, a: {extends: 'base'}}).raw('a')).toEqual({extends: 'base'})
  })
})

describe('declaresSection', () => {
  const p = index({a: {packages: ['git'], shell: {name: 'zsh', user: 'current'}}}).resolve('a')

  it('is true for a non-empty list and a present object', () => {
    expect(declaresSection(p, 'packages')).toBe(true)
    expect(declaresSection(p, 'shell')).toBe(true)
  })

  it('is false for an empty list and an absent object', () => {
    expect(declaresSection(p, 'tools')).toBe(false)
    expect(declaresSection(p, 'setup')).toBe(false)
    expect(declaresSection(p, 'services')).toBe(false)
    expect(declaresSection(p, 'dotfiles')).toBe(false)
  })
})
