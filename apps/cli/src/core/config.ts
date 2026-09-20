import {readFile as fsReadFile} from 'node:fs/promises'
import {homedir} from 'node:os'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'

import {parse} from 'yaml'
import {z} from 'zod'

import {OpsError} from './errors.js'

type ReadFile = (path: string) => Promise<string>

const NameList = z.array(z.string())

// Unknown keys are kept so other areas can add their own sections.
const DefaultsSchema = z.looseObject({
  package: z.looseObject({
    /** Plain names installed with apt/dnf instead of a mise tool. */
    system: NameList,
  }),
})

const UserSchema = z.looseObject({
  package: z
    .looseObject({
      /** A list replaces the defaults; add/remove adjusts them. */
      system: z.union([NameList, z.object({add: NameList.optional(), remove: NameList.optional()})]).optional(),
    })
    .optional(),
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

  return {...defaults, ...user, package: {...defaults.package, ...user.package, system: [...new Set(names)]}}
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
