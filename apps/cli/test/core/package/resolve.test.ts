import {describe, expect, it} from 'vitest'
import {OpsError} from '../../../src/core/errors.js'
import {resolveSpecs} from '../../../src/core/package/resolve.js'

function deps(registry: string[] = []) {
  const lookups: string[] = []
  let detections = 0
  return {
    deps: {
      detectManager: async () => {
        detections++
        return 'apt' as const
      },
      inRegistry: async (name: string) => {
        lookups.push(name)
        return registry.includes(name)
      },
    },
    detections: () => detections,
    lookups,
  }
}

describe('resolveSpecs', () => {
  it('uses a mise tool for names in the registry', async () => {
    const d = deps(['fastfetch'])
    expect(await resolveSpecs(['fastfetch'], d.deps)).toEqual(['mise:fastfetch'])
    expect(d.detections()).toBe(0)
  })

  it('sends system-preferred names to the OS manager without a registry lookup', async () => {
    const d = deps(['tmux'])
    expect(await resolveSpecs(['zsh', 'tmux'], d.deps)).toEqual(['apt:zsh', 'apt:tmux'])
    expect(d.lookups).toEqual([])
  })

  it('falls back to the OS manager for names missing from the registry', async () => {
    const d = deps()
    expect(await resolveSpecs(['sl', 'cowsay'], d.deps)).toEqual(['apt:sl', 'apt:cowsay'])
    expect(d.detections()).toBe(1)
  })

  it('keeps explicit manager prefixes unchanged', async () => {
    const d = deps(['fastfetch'])
    expect(await resolveSpecs(['apt:fastfetch', 'mise:aqua:a/b', 'brew:jq'], d.deps)).toEqual(['apt:fastfetch', 'mise:aqua:a/b', 'brew:jq'])
    expect(d.lookups).toEqual([])
    expect(d.detections()).toBe(0)
  })

  it('deduplicates and rejects option-like names before any lookup', async () => {
    const d = deps(['jq'])
    expect(await resolveSpecs(['jq', 'mise:jq'], d.deps)).toEqual(['mise:jq'])
    const error = await resolveSpecs(['--force'], d.deps).catch((e: unknown) => e)
    expect((error as OpsError).code).toBe('INVALID_PACKAGE_NAME')
    expect(d.lookups).toEqual(['jq'])
  })
})
