import {describe, expect, it} from 'vitest'
import {buildSections} from '#core/bootstrap/registry.js'
import {recipeIndex} from '#core/tool/recipe.js'
import {FakeDeb, FakeMise, FakeRepos, FakeTools} from '#test/helpers/fake-packages.js'
import {FakeRunner} from '#test/helpers/fake-runner.js'

const sections = () =>
  buildSections({
    install: {
      deb: new FakeDeb(),
      detectManager: async () => 'apt',
      isTTY: true,
      mise: new FakeMise(),
      recipes: recipeIndex(),
      repos: new FakeRepos(),
      sudoReady: async () => true,
      systemPreferred: new Set(),
      tools: new FakeTools(),
    },
    setup: {isTTY: true, recipes: recipeIndex(), runner: new FakeRunner()},
  })

describe('buildSections', () => {
  it('registers exactly the sections this phase implements', () => {
    // This guard goes red the moment a phase-2 section lands without its own tests.
    expect(Object.keys(sections()).sort()).toEqual(['packages', 'setup', 'tools'])
  })

  it('names each section after its key', () => {
    for (const [key, section] of Object.entries(sections())) expect(section?.name).toBe(key)
  })
})
