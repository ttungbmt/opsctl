import {homedir} from 'node:os'
import {isAbsolute, join, normalize} from 'node:path'

import {OpsError} from '../errors.js'
import type {AptRepo, RepoConfig} from '../repo.js'
import {type PackageSpec, toPackageSpec} from '../package/spec.js'

/** How to make a package installable before the package manager can see it. */
export interface PrepareStep {
  /** URL of a .deb to download and install; the package's own postinst wires up its apt repo. */
  deb: string
}

/**
 * One idempotent configuration step. `check` decides whether `run` is needed and
 * verifies it afterwards, so a step must only claim what `run` can actually repair.
 */
export interface SetupStep {
  /** Shown in output; unique within a tool. */
  name: string
  /** Exit 0 means the step is already satisfied. It must not change anything. */
  check: string[]
  /** Makes `check` pass. */
  run: string[]
}

/** What `--purge` deletes once the package itself is gone. */
export interface PurgeStep {
  /** Absolute or `~/`-rooted paths the package leaves behind. */
  paths: string[]
}

export interface UninstallStep {
  purge?: PurgeStep
}

/** A named tool and the package that provides it (`tool.<name>` in the config). */
export interface Recipe {
  summary?: string
  /** manager:name, e.g. "apt:google-chrome-stable". */
  package: string
  prepare?: PrepareStep
  /**
   * Name of a `repo.<name>` entry to configure before the package manager installs
   * `package`. Unlike `prepare`, which installs the tool itself, a repo only makes the
   * package reachable -- the spec still goes through the package manager afterwards.
   */
  repo?: string
  setup?: SetupStep[]
  uninstall?: UninstallStep
}

export interface RecipeIndex {
  /** The recipe for a plain name, e.g. "chrome". */
  byName: (name: string) => Recipe | undefined
  /** The prepare step for an already-resolved spec, e.g. "apt:google-chrome-stable". */
  prepareFor: (spec: PackageSpec) => PrepareStep | undefined
  /** The repo an already-resolved spec needs before apt can see it, e.g. "apt:firefox". */
  repoFor: (spec: PackageSpec) => AptRepo | undefined
  /** The setup steps for a tool name; undefined when the recipe has none. */
  setupFor: (name: string) => SetupStep[] | undefined
  /** Purge paths for a tool name, expanded and validated; undefined when the recipe has none. */
  purgeFor: (name: string) => string[] | undefined
}

/** Shared roots that must never be deleted whole, however deep the recipe means to go. */
const sharedRoots = (home: string): Set<string> =>
  new Set([home, ...['.config', '.cache', '.local', '.local/share', '.local/state'].map((dir) => join(home, dir))])

/** `rm` gets argv, never a shell, so a glob would be a silent no-op that looks like success. */
const GLOB = /[*?[\]{}]/

/**
 * Turns one configured purge path into an absolute path that is safe to hand to
 * `rm -rf`, or throws CONFIG_INVALID naming the recipe. Every rule exists because
 * the result is deleted, sometimes as root, from data a user can edit.
 */
export function expandPurgePath(raw: string, home: string, tool: string): string {
  const reject = (why: string): never => {
    throw new OpsError('CONFIG_INVALID', `Recipe tool.${tool}: invalid purge path "${raw}": ${why}`)
  }

  // On the raw segments, before any expansion: join() and normalize() both collapse
  // "..", so checking afterwards would erase the very escape this is meant to catch.
  if (raw.split('/').includes('..')) reject('it must not contain ".."')
  if (GLOB.test(raw)) reject('it looks like a glob, which rm would not expand')
  if ([...raw].some((ch) => ch.codePointAt(0)! < 0x20 || ch.codePointAt(0) === 0x7f)) {
    reject('it contains a control character')
  }

  let path = raw
  if (raw === '~') path = home
  else if (raw.startsWith('~/')) path = join(home, raw.slice(2))
  else if (raw.startsWith('~')) reject("another user's home cannot be resolved")

  if (!isAbsolute(path)) reject('it must be absolute or start with "~/"')

  const full = normalize(path).replace(/\/+$/, '') || '/'
  if (full.split('/').filter(Boolean).length < 2) reject('it is a top-level directory')
  if (sharedRoots(home).has(full)) reject('it is a shared root directory')

  return full
}

/** Context a recipe needs beyond its own entry. An object, so neither field depends on order. */
export interface RecipeContext {
  /** `repo.<name>` entries a recipe's `repo` may reference. */
  repos?: Record<string, RepoConfig>
  /** Where `~` in a purge path points. */
  home?: string
}

/**
 * Indexes recipes twice from one source: by tool name for resolution, and by resolved
 * spec for the prepare and repo lookups during install. Every cross-reference is checked
 * here, eagerly, so a bad config fails at load rather than halfway through a privileged
 * install.
 */
export function recipeIndex(recipes: Record<string, Recipe> = {}, ctx: RecipeContext = {}): RecipeIndex {
  const {repos = {}, home = homedir()} = ctx
  const prepares = new Map<PackageSpec, PrepareStep>()
  const repoOf = new Map<PackageSpec, AptRepo>()
  const purges = new Map<string, string[]>()
  /** Which recipe already claimed a spec, so a silent last-writer-wins becomes an error. */
  const claimed = new Map<PackageSpec, string>()
  const referenced = new Set<string>()

  for (const [name, recipe] of Object.entries(recipes)) {
    if (!recipe.package.includes(':')) {
      throw new OpsError('CONFIG_INVALID', `Recipe tool.${name}: package must be manager:name, got "${recipe.package}"`)
    }

    // They are easy to confuse and have opposite control flow: prepare installs the tool
    // and stops; repo only makes the package reachable and the install continues.
    if (recipe.prepare && recipe.repo) {
      throw new OpsError(
        'CONFIG_INVALID',
        `Recipe tool.${name}: use prepare or repo, not both -- prepare installs outside the package manager, repo makes the package manager able to`,
      )
    }

    const spec = toPackageSpec(recipe.package)
    if (recipe.prepare || recipe.repo) {
      const first = claimed.get(spec)
      if (first !== undefined) {
        throw new OpsError('CONFIG_INVALID', `Recipes tool.${first} and tool.${name} both claim to provide "${spec}"; only one may`)
      }

      claimed.set(spec, name)
    }

    if (recipe.prepare) prepares.set(spec, recipe.prepare)
    if (recipe.repo) {
      const repo = repos[recipe.repo]
      if (!repo) {
        throw new OpsError('CONFIG_INVALID', `Recipe tool.${name}: unknown repo "${recipe.repo}"; define repo.${recipe.repo}`)
      }

      repoOf.set(spec, {...repo, name: recipe.repo})
      referenced.add(recipe.repo)
    }

    // Eagerly, so a bad path fails at config load and never mid-delete.
    const paths = recipe.uninstall?.purge?.paths
    if (paths) purges.set(name, paths.map((path) => expandPurgePath(path, home, name)))
  }

  // A repo nobody references configures nothing, and is how a misspelled `repo:` key
  // surfaces: RecipeSchema keeps unknown keys, so the typo itself is invisible.
  for (const name of Object.keys(repos)) {
    if (!referenced.has(name)) {
      throw new OpsError('CONFIG_INVALID', `repo.${name} is not referenced by any tool recipe; did a recipe's "repo:" get misspelled?`)
    }
  }

  return {
    byName: (name) => recipes[name],
    prepareFor: (spec) => prepares.get(spec),
    purgeFor: (name) => purges.get(name),
    repoFor: (spec) => repoOf.get(spec),
    setupFor: (name) => recipes[name]?.setup,
  }
}
