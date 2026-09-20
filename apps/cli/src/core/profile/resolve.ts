import {SECTION_ORDER, type DotfilesSpec, type Profile, type SectionName, type ServiceSpec, type ShellSpec} from '#core/config.js'
import {OpsError} from '#core/errors.js'
import type {RecipeIndex} from '#core/tool/recipe.js'

/** A profile after `extends` composition: every list present, no add/remove left. */
export interface ResolvedProfile {
  name: string
  summary?: string
  /** Every profile visited, base first, `name` last. */
  lineage: string[]
  packages: string[]
  tools: string[]
  setup: string[]
  services: ServiceSpec[]
  shell?: ShellSpec
  dotfiles?: DotfilesSpec
}

export interface ProfileSummary {
  name: string
  summary?: string
  /** Direct parents, in declaration order. */
  extends: string[]
  /** Sections this profile declares once composed. */
  sections: SectionName[]
}

export interface ProfileIndex {
  names(): string[]
  list(): ProfileSummary[]
  /** The literal config entry, before composition. */
  raw(name: string): Profile | undefined
  /** Fully composed. Throws PROFILE_NOT_FOUND for an unknown name. */
  resolve(name: string): ResolvedProfile
}

export interface ProfileContext {
  /** Recipes, so a `setup:` entry naming a tool with no steps fails at load. */
  recipes?: RecipeIndex
}

type ListSection = Profile['packages']
type ServiceSection = Profile['services']

const parentsOf = (profile: Profile): string[] =>
  profile.extends === undefined ? [] : Array.isArray(profile.extends) ? profile.extends : [profile.extends]

/** First occurrence wins its position, so a plan stays diffable between runs. */
const dedupe = (names: string[]): string[] => [...new Set(names)]

/** A bare list adds to what `extends` brought in; `remove` applies to the inherited names. */
function mergeList(base: string[], section: ListSection): string[] {
  if (section === undefined) return base
  if (Array.isArray(section)) return dedupe([...base, ...section])
  const removed = new Set(section.remove ?? [])
  return dedupe([...base.filter((name) => !removed.has(name)), ...(section.add ?? [])])
}

/**
 * Services are keyed by unit name. A child entry replaces the parent's wholesale, in the
 * parent's position -- not key by key, because Zod applies the scope/enabled/state defaults
 * at parse time, so afterwards there is no way to tell what the child actually wrote.
 */
function mergeServices(base: ServiceSpec[], section: ServiceSection): ServiceSpec[] {
  if (section === undefined) return base
  const additions = Array.isArray(section) ? section : (section.add ?? [])
  const removed = new Set(Array.isArray(section) ? [] : (section.remove ?? []))
  const merged = base.filter((service) => !removed.has(service.name))
  for (const service of additions) {
    const at = merged.findIndex((existing) => existing.name === service.name)
    if (at === -1) merged.push(service)
    else merged[at] = service
  }

  return merged
}

/**
 * Indexes profiles and checks every cross-reference eagerly -- dangling `extends`, cycles,
 * and a `setup:` entry naming a tool with no steps -- so a bad config fails at load rather
 * than halfway through a privileged bootstrap. The same contract as recipeIndex.
 */
export function profileIndex(profiles: Record<string, Profile> = {}, ctx: ProfileContext = {}): ProfileIndex {
  const composed = new Map<string, ResolvedProfile>()

  const compose = (name: string, path: string[]): ResolvedProfile => {
    const cached = composed.get(name)
    if (cached) return cached

    const at = path.indexOf(name)
    if (at !== -1) {
      const chain = [...path.slice(at), name].map((n) => `profile.${n}`).join(' -> ')
      throw new OpsError('CONFIG_INVALID', `Profile chain ${chain} is circular`)
    }

    const profile = profiles[name]
    if (!profile) {
      const from = path.at(-1)
      // At the top of the chain this is the user mistyping a name; deeper it is a
      // dangling reference in the config itself, which is a different fix.
      throw from === undefined
        ? new OpsError(
            'PROFILE_NOT_FOUND',
            `No profile "${name}"; available: ${Object.keys(profiles).sort().join(', ') || '(none)'}`,
          )
        : new OpsError('CONFIG_INVALID', `Profile profile.${from}: unknown profile "${name}"; define profile.${name}`)
    }

    let lineage: string[] = []
    let packages: string[] = []
    let tools: string[] = []
    let setup: string[] = []
    let services: ServiceSpec[] = []
    let shell: ShellSpec | undefined
    let dotfiles: DotfilesSpec | undefined

    for (const parent of parentsOf(profile)) {
      const base = compose(parent, [...path, name])
      lineage = dedupe([...lineage, ...base.lineage])
      packages = dedupe([...packages, ...base.packages])
      tools = dedupe([...tools, ...base.tools])
      setup = dedupe([...setup, ...base.setup])
      services = mergeServices(services, base.services)
      if (base.shell) shell = {...shell, ...base.shell}
      if (base.dotfiles) dotfiles = {...dotfiles, ...base.dotfiles}
    }

    const result: ResolvedProfile = {
      name,
      // Deliberately not inherited: a summary describes this profile, not its base.
      summary: profile.summary,
      lineage: [...lineage, name],
      packages: mergeList(packages, profile.packages),
      tools: mergeList(tools, profile.tools),
      setup: mergeList(setup, profile.setup),
      services: mergeServices(services, profile.services),
      ...(profile.shell || shell ? {shell: {...shell, ...profile.shell} as ShellSpec} : {}),
      ...(profile.dotfiles || dotfiles ? {dotfiles: {...dotfiles, ...profile.dotfiles} as DotfilesSpec} : {}),
    }

    composed.set(name, result)
    return result
  }

  // Eagerly: every profile composes, so a cycle or a dangling parent fails at load.
  for (const name of Object.keys(profiles)) {
    for (const tool of compose(name, []).setup) {
      if (ctx.recipes?.setupFor(tool)) continue
      throw new OpsError(
        'CONFIG_INVALID',
        `Profile profile.${name}: setup names "${tool}", which has no setup steps; add tool.${tool}.setup`,
      )
    }
  }

  return {
    names: () => Object.keys(profiles).sort(),
    list: () =>
      Object.keys(profiles)
        .sort()
        .map((name) => ({
          name,
          summary: profiles[name].summary,
          extends: parentsOf(profiles[name]),
          sections: SECTION_ORDER.filter((section) => declaresSection(compose(name, []), section)),
        })),
    raw: (name) => profiles[name],
    resolve: (name) => compose(name, []),
  }
}

/** True when the profile declares anything for this section. The only place that knows. */
export function declaresSection(profile: ResolvedProfile, section: SectionName): boolean {
  switch (section) {
    case 'packages':
    case 'tools':
    case 'setup': {
      return profile[section].length > 0
    }

    case 'services': {
      return profile.services.length > 0
    }

    case 'shell': {
      return profile.shell !== undefined
    }

    case 'dotfiles': {
      return profile.dotfiles !== undefined
    }
  }
}
