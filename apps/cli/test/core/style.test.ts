import ansis from 'ansis'
import {describe, expect, it} from 'vitest'
import {ansiStyle, plainStyle, styleFor} from '#core/style.js'

const KEYS = ['ok', 'add', 'warn', 'fail', 'muted', 'heading'] as const

describe('plainStyle', () => {
  it('returns every string untouched', () => {
    for (const key of KEYS) expect(plainStyle[key]('text')).toBe('text')
  })
})

describe('ansiStyle', () => {
  it('wraps text in escape codes that strip back to the original', () => {
    for (const key of KEYS) {
      const painted = ansiStyle[key]('text')
      expect(painted).not.toBe('text')
      expect(ansis.strip(painted)).toBe('text')
    }
  })

  it('distinguishes success, warning and failure', () => {
    const [ok, warn, fail] = [ansiStyle.ok('x'), ansiStyle.warn('x'), ansiStyle.fail('x')]
    expect(new Set([ok, warn, fail]).size).toBe(3)
  })
})

describe('styleFor', () => {
  it('never colours machine-readable output', () => {
    expect(styleFor(true)).toBe(plainStyle)
  })

  it('follows ansis colour detection otherwise', () => {
    expect(styleFor(false)).toBe(ansis.isSupported() ? ansiStyle : plainStyle)
  })
})
