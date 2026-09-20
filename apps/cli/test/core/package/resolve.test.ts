import {describe, expect, it} from 'vitest'
import {OpsError} from '#core/errors.js'
import {resolveSpecs} from '#core/package/resolve.js'

const CHROME = {package: 'apt:google-chrome-stable', prepare: {deb: 'https://example.test/chrome.deb'}}

function deps(registry: string[] = [], preferred: ReadonlySet<string> = new Set(['zsh', 'tmux']), recipes: Record<string, {package: string}> = {}) {
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
      recipe: (name: string) => recipes[name],
      systemPreferred: preferred,
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

  it('resolves a recipe name to its package without any lookup', async () => {
    const d = deps(['google-chrome'], new Set(['zsh']), {'google-chrome': CHROME})
    expect(await resolveSpecs(['google-chrome'], d.deps)).toEqual(['apt:google-chrome-stable'])
    expect(d.lookups).toEqual([])
    expect(d.detections()).toBe(0)
  })

  it('lets a recipe beat the system list and the registry', async () => {
    const d = deps(['google-chrome'], new Set(['google-chrome']), {'google-chrome': CHROME})
    expect(await resolveSpecs(['google-chrome'], d.deps)).toEqual(['apt:google-chrome-stable'])
    expect(d.lookups).toEqual([])
  })

  // agent-browser is in the mise registry; its recipe exists only to carry setup
  // steps, so resolution must land on exactly what the registry lookup produced.
  it('keeps a mise-tool recipe resolving to the same spec, minus the lookup', async () => {
    const d = deps(['agent-browser'], new Set(), {'agent-browser': {package: 'mise:agent-browser'}})
    expect(await resolveSpecs(['agent-browser'], d.deps)).toEqual(['mise:agent-browser'])
    expect(d.lookups).toEqual([])
    expect(d.detections()).toBe(0)
  })

  it('lets an explicit prefix beat a recipe', async () => {
    const d = deps([], new Set(), {'google-chrome': CHROME})
    expect(await resolveSpecs(['apt:chromium'], d.deps)).toEqual(['apt:chromium'])
  })

  // "node@lts" is a version request, not a tool id: `mise registry node@lts` exits 1,
  // so asking with the raw input silently routed the tool to apt.
  it('asks the registry for the name, not the version request', async () => {
    const d = deps(['node'])
    expect(await resolveSpecs(['node@lts'], d.deps)).toEqual(['mise:node@lts'])
    expect(d.lookups).toEqual(['node'])
    expect(d.detections()).toBe(0)
  })

  it('still falls back to the OS manager when the versioned name is not a tool', async () => {
    const d = deps([])
    expect(await resolveSpecs(['sl@1.2'], d.deps)).toEqual(['apt:sl@1.2'])
    expect(d.lookups).toEqual(['sl'])
  })

  it('follows the given system list', async () => {
    const d = deps(['tmux', 'htop'], new Set(['htop']))
    expect(await resolveSpecs(['tmux', 'htop'], d.deps)).toEqual(['mise:tmux', 'apt:htop'])
    expect(d.lookups).toEqual(['tmux'])
  })
})
