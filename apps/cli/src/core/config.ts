import {readFile as fsReadFile} from 'node:fs/promises'
import {homedir} from 'node:os'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'

import {parse} from 'yaml'
import {z} from 'zod'

import {OpsError} from './errors.js'

type ReadFile = (path: string) => Promise<string>

const NameList = z.array(z.string())

/** A command line as argv, never a shell string. */
const Argv = z
  .array(z.string().min(1))
  .min(1)
  .refine((argv) => !argv[0]?.startsWith('-'), {message: 'the command must not start with "-"'})

/**
 * One setup step. Strict, unlike the recipe around it: a step runs an arbitrary
 * command, so a misspelled key must fail loudly instead of being kept.
 */
const SetupStepSchema = z.strictObject({
  /** Shown in output; unique within a tool. */
  name: z.string().min(1),
  /** Exit 0 means the step is already satisfied. It must not change anything. */
  check: Argv,
  /** Makes `check` pass. */
  run: Argv,
})

/**
 * A path `--purge` deletes. Only the shape is checked here; the checks that need
 * $HOME -- expansion, the deny-set, escapes -- live in recipeIndex.
 */
const PurgePath = z
  .string()
  .min(1)
  .refine((path) => path.startsWith('/') || path === '~' || path.startsWith('~/'), {
    message: 'a purge path must be absolute or start with "~/"',
  })

/**
 * tool.<name>.uninstall. Strict for the same reason a setup step is: this block
 * names files that get deleted, so a misspelled key must fail loudly.
 */
const UninstallSchema = z.strictObject({
  purge: z.strictObject({paths: z.array(PurgePath).min(1)}),
})

/** A repo name becomes a filename under /etc/apt, so restrict it to what apt will read. */
const RepoName = z.string().regex(/^[a-z0-9][a-z0-9._-]*$/, 'must match [a-z0-9][a-z0-9._-]*')

const HttpsUrl = z.url({protocol: /^https$/})

/**
 * repo.<name>: a third-party apt repository a recipe can reference. Strict, unlike the
 * recipe that references it: these fields drive privileged writes under /etc/apt, so a
 * misspelled key must fail loudly instead of being kept.
 */
const RepoSchema = z.strictObject({
  /** Base URL, e.g. https://packages.mozilla.org/apt (deb822 URIs). */
  uri: HttpsUrl,
  /** deb822 Suites, e.g. "mozilla". */
  suite: z.string().min(1),
  /** deb822 Components, e.g. [main]. */
  components: z.array(z.string().min(1)).min(1),
  /** URL of the repository's OpenPGP signing key, armored or binary. */
  keyring: HttpsUrl,
  /**
   * apt pin, so this repo beats the distro's own package of the same name. `origin` is
   * the site hostname (apt's `Pin: origin <host>`), NOT the Release file's Origin field.
   * A priority above 500 beats the distro archive.
   */
  pin: z.strictObject({origin: z.string().min(1), priority: z.number().int().positive()}).optional(),
})

/** tool.<name>: the package that provides a tool, how to make it installable, how to configure it. */
const RecipeSchema = z.looseObject({
  summary: z.string().optional(),
  package: z.string(),
  prepare: z.looseObject({deb: z.string()}).optional(),
  /** Name of a repo.<name> entry to configure before the package manager installs `package`. */
  repo: z.string().min(1).optional(),
  setup: z.array(SetupStepSchema).min(1).optional(),
  uninstall: UninstallSchema.optional(),
})

/** Every section a profile may declare, in the order `ops bootstrap` runs them. */
export const SECTION_ORDER = ['packages', 'tools', 'setup', 'services', 'shell', 'dotfiles'] as const
export type SectionName = (typeof SECTION_ORDER)[number]

/** A profile name is a config key and appears in output; same shape as a repo name. */
const ProfileName = z.string().regex(/^[a-z0-9][a-z0-9._-]*$/, 'must match [a-z0-9][a-z0-9._-]*')

/** A list section. A bare list ADDS to what `extends` brought in; add/remove adjusts it. */
const NameSection = z.union([NameList, z.strictObject({add: NameList.optional(), remove: NameList.optional()})])

/**
 * profile.<name>.services[]. Phase 2 implements it; the shape is fixed now so nobody's
 * profile needs rewriting when it lands.
 */
const ServiceSchema = z.strictObject({
  /** systemd unit name; ".service" is implied when absent. */
  name: z.string().regex(/^[A-Za-z0-9@._-]+$/, 'must be a systemd unit name'),
  scope: z.enum(['system', 'user']).default('system'),
  enabled: z.boolean().default(true),
  state: z.enum(['started', 'stopped', 'ignore']).default('started'),
})

const ServiceSection = z.union([
  z.array(ServiceSchema),
  z.strictObject({add: z.array(ServiceSchema).optional(), remove: NameList.optional()}),
])

/** profile.<name>.shell. Phase 2. */
const ShellSchema = z.strictObject({
  /** A tool or package name ops can resolve to a shell binary, or an absolute path. */
  name: z.string().min(1),
  /** "current" means whoever runs ops; anything else is a login name. */
  user: z.string().min(1).default('current'),
})

/** profile.<name>.dotfiles. Phase 3. */
const DotfilesSchema = z.strictObject({
  repo: z.string().min(1),
  branch: z.string().min(1).optional(),
  apply: z.boolean().default(true),
  sourceDir: z.string().min(1).optional(),
})

/**
 * profile.<name>: a machine `ops bootstrap` converges to. Strict, unlike a recipe: a
 * misspelled `serivces:` would be kept, silently converge the wrong machine, and still
 * report success -- the same reason SetupStepSchema and RepoSchema are strict.
 */
const ProfileSchema = z.strictObject({
  summary: z.string().optional(),
  /** Profiles this one composes over, left to right; this profile always wins last. */
  extends: z.union([ProfileName, z.array(ProfileName)]).optional(),
  packages: NameSection.optional(),
  tools: NameSection.optional(),
  setup: NameSection.optional(),
  services: ServiceSection.optional(),
  shell: ShellSchema.optional(),
  dotfiles: DotfilesSchema.optional(),
})

export type Profile = z.infer<typeof ProfileSchema>
export type ServiceSpec = z.infer<typeof ServiceSchema>
export type ShellSpec = z.infer<typeof ShellSchema>
export type DotfilesSpec = z.infer<typeof DotfilesSchema>

/**
 * Where ops gets mise on a machine that has none. Strict, and https-only: the script is
 * downloaded and run as root, so the protocol check belongs at the config boundary rather
 * than in the provider that runs it.
 */
const MiseSchema = z.strictObject({
  installer: HttpsUrl,
  path: z.string().min(1).refine((value) => value.startsWith('/'), {message: 'must be an absolute path'}),
})

export type MiseConfig = z.infer<typeof MiseSchema>

// Unknown keys are kept so other areas can add their own sections.
const DefaultsSchema = z.looseObject({
  package: z.looseObject({
    /** Plain names installed with apt/dnf instead of a mise tool. */
    system: NameList,
  }),
  /** Third-party apt repositories, referenced by name from a recipe's `repo`. */
  repo: z.record(RepoName, RepoSchema).default({}),
  /** Named recipes: a plain name resolves to recipe.package before any heuristic. */
  tool: z.record(z.string(), RecipeSchema).default({}),
  /** Named machine profiles; `ops bootstrap <name>` converges the machine to one. */
  profile: z.record(ProfileName, ProfileSchema).default({}),
  /** Where ops gets mise when a machine has none; the preflight reads it. */
  mise: MiseSchema.optional(),
})

const UserSchema = z.looseObject({
  package: z
    .looseObject({
      /** A list replaces the defaults; add/remove adjusts them. */
      system: z.union([NameList, z.object({add: NameList.optional(), remove: NameList.optional()})]).optional(),
    })
    .optional(),
  /** Repos are merged by name; a user repo replaces the built-in of the same name. */
  repo: z.record(RepoName, RepoSchema).optional(),
  /** Recipes are merged by name; a user recipe replaces the built-in of the same name. */
  tool: z.record(z.string(), RecipeSchema).optional(),
  /** Profiles are merged by name; a user profile replaces the built-in of the same name. */
  profile: z.record(ProfileName, ProfileSchema).optional(),
  /**
   * Replaced wholesale, unlike repo/tool/profile: both fields belong together, so the plain
   * `{...defaults, ...user}` spread in mergeConfig is already the right behaviour.
   */
  mise: MiseSchema.optional(),
})

export type Config = z.infer<typeof DefaultsSchema>
export type UserConfig = z.infer<typeof UserSchema>

/** config/defaults.yaml shipped with the CLI; the same relative path from src/core and dist/core. */
export const defaultsPath = (): string => fileURLToPath(new URL('../../config/defaults.yaml', import.meta.url))

/** $OPS_CONFIG, else $XDG_CONFIG_HOME/ops/config.yaml, else ~/.config/ops/config.yaml. */
export function configPath(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  if (env.OPS_CONFIG) return env.OPS_CONFIG
  return join(env.XDG_CONFIG_HOME || join(home, '.config'), 'ops', 'config.yaml')
}

export function mergeConfig(defaults: Config, user: UserConfig): Config {
  const system = user.package?.system
  const names = Array.isArray(system)
    ? system
    : [...defaults.package.system, ...(system?.add ?? [])].filter((name) => !system?.remove?.includes(name))

  return {
    ...defaults,
    ...user,
    package: {...defaults.package, ...user.package, system: [...new Set(names)]},
    profile: {...defaults.profile, ...user.profile},
    repo: {...defaults.repo, ...user.repo},
    tool: {...defaults.tool, ...user.tool},
  }
}

/** Built-in defaults overlaid with the user config; a missing user file means defaults only. */
export async function loadConfig(
  readFile: ReadFile = (path) => fsReadFile(path, 'utf8'),
  path: string = configPath(),
  defaults: string = defaultsPath(),
): Promise<Config> {
  const base = await readYaml(readFile, defaults, DefaultsSchema)
  let user: UserConfig
  try {
    user = await readYaml(readFile, path, UserSchema)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return base
    throw error
  }

  return mergeConfig(base, user)
}

async function readYaml<T>(readFile: ReadFile, path: string, schema: z.ZodType<T>): Promise<T> {
  const text = await readFile(path)
  try {
    return schema.parse(parse(text) ?? {})
  } catch (error) {
    const detail = error instanceof z.ZodError ? z.prettifyError(error) : (error as Error).message
    throw new OpsError('CONFIG_INVALID', `Invalid config ${path}: ${detail}`)
  }
}
