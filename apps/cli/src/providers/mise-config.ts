import {randomBytes} from 'node:crypto'
import {open, rename, rm, stat, readFile as fsReadFile} from 'node:fs/promises'
import {homedir} from 'node:os'
import {basename, dirname, join} from 'node:path'

import {CommandNotFoundError, OpsError} from '../core/errors.js'
import type {Runner} from '../executor/exec.js'

/** The tables ops declares into, and so the only ones it will edit. */
export type MiseTable = 'bootstrap.packages' | 'tools'

export interface MiseDeclarations {
  /** True when `<table>.<key>` is present in the global config. */
  isDeclared(table: MiseTable, key: string): Promise<boolean>
  /** Deletes `<table>.<key>`. A missing table, key or file is a no-op returning false. */
  undeclare(table: MiseTable, key: string): Promise<boolean>
  describe(table: MiseTable, key: string): string
  path(): string
}

/** Injected so tests never touch a real config file. */
export interface ConfigFile {
  /** undefined when the file does not exist. */
  read(path: string): Promise<string | undefined>
  writeAtomic(path: string, text: string): Promise<void>
}

/** mise's own precedence: MISE_GLOBAL_CONFIG_FILE, MISE_CONFIG_DIR, XDG_CONFIG_HOME, ~/.config. */
export function miseGlobalConfigPath(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  if (env.MISE_GLOBAL_CONFIG_FILE) return env.MISE_GLOBAL_CONFIG_FILE
  if (env.MISE_CONFIG_DIR) return join(env.MISE_CONFIG_DIR, 'config.toml')
  return join(env.XDG_CONFIG_HOME || join(home, '.config'), 'mise', 'config.toml')
}

const HEADER = /^\s*\[([^[\]]+)]\s*(?:#.*)?$/
const ARRAY_HEADER = /^\s*\[\[/
const KEY = /^\s*(?:"((?:[^"\\]|\\.)*)"|'([^']*)'|([A-Za-z0-9_-]+))\s*=\s*(.*)$/

/** "bootstrap.\"packages\"" and "bootstrap.packages" name the same table. */
function normalizeHeader(header: string): string {
  const parts: string[] = []
  let current = ''
  let quote: string | undefined
  for (const ch of header.trim()) {
    if (quote) {
      if (ch === quote) quote = undefined
      else current += ch
    } else if (ch === '"' || ch === "'") quote = ch
    else if (ch === '.') {
      parts.push(current.trim())
      current = ''
    } else current += ch
  }

  parts.push(current.trim())
  return parts.join('.')
}

/** True when the value text ends on this line, so deleting the line deletes the whole entry. */
function selfContained(value: string): boolean {
  const text = value.replace(/\s+#.*$/, '').trim()
  if (text === '') return false

  let quote: string | undefined
  let depth = 0
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (quote) {
      if (ch === '\\') i += 1
      else if (ch === quote) quote = undefined
    } else if (ch === '"' || ch === "'") quote = ch
    else if (ch === '[' || ch === '{') depth += 1
    else if (ch === ']' || ch === '}') depth -= 1
  }

  return quote === undefined && depth === 0
}

/**
 * The text with `<table>.<key>` deleted, or undefined when there is nothing to
 * delete or the entry is not one line we fully understand.
 *
 * Deliberately line-oriented: every TOML library in reach round-trips through a
 * plain object and drops the comments a user wrote. Deleting one line keeps the
 * rest of the file byte-identical, and mise verifies the result afterwards.
 */
export function removeTableKey(text: string, table: MiseTable, key: string): string | undefined {
  const lines = text.split('\n')
  let current: string | undefined

  for (const [i, line] of lines.entries()) {
    if (ARRAY_HEADER.test(line)) {
      current = undefined
      continue
    }

    const header = HEADER.exec(line)
    if (header) {
      current = normalizeHeader(header[1])
      continue
    }

    if (current !== table) continue
    const match = KEY.exec(line)
    if (!match) continue

    const name = match[1] === undefined ? (match[2] ?? match[3]) : match[1].replaceAll(/\\(.)/g, '$1')
    if (name !== key) continue
    if (!selfContained(match[4])) return undefined

    // Leave any comment above it: orphaning a comment beats deleting one we did not write.
    return [...lines.slice(0, i), ...lines.slice(i + 1)].join('\n')
  }

  return undefined
}

export const nodeConfigFile: ConfigFile = {
  async read(path) {
    try {
      return await fsReadFile(path, 'utf8')
    } catch (error) {
      if ((error as {code?: string}).code === 'ENOENT') return undefined
      throw error
    }
  },

  /** Same directory so rename is atomic; the original is never truncated. */
  async writeAtomic(path, text) {
    const tmp = join(dirname(path), `.${basename(path)}.ops-${randomBytes(6).toString('hex')}`)
    const {mode} = await stat(path)
    try {
      const handle = await open(tmp, 'wx', mode)
      try {
        await handle.writeFile(text, 'utf8')
        await handle.sync()
      } finally {
        await handle.close()
      }

      await rename(tmp, path)
    } finally {
      await rm(tmp, {force: true})
    }
  },
}

export function createMiseDeclarations(
  runner: Runner,
  file: ConfigFile = nodeConfigFile,
  path: string = miseGlobalConfigPath(),
): MiseDeclarations {
  /** mise is the oracle: it answers from the same file it would later read. */
  async function isDeclared(table: MiseTable, key: string): Promise<boolean> {
    try {
      const result = await runner.run('mise', ['config', 'get', '-g', `${table}.${key}`], {stdin: 'ignore'})
      return result.exitCode === 0
    } catch (error) {
      if (error instanceof CommandNotFoundError) {
        throw new OpsError('MISE_BOOTSTRAP_UNAVAILABLE', 'mise not found on PATH; run `ops bootstrap` to install it, or install it from https://mise.jdx.dev')
      }

      throw error
    }
  }

  return {
    describe: (table, key) => `undeclare "${key}" from [${table}]`,
    isDeclared,
    path: () => path,

    async undeclare(table, key) {
      if (!(await isDeclared(table, key))) return false

      const text = await file.read(path)
      if (text === undefined) return false

      const next = removeTableKey(text, table, key)
      if (next === undefined) {
        throw new OpsError(
          'MISE_CONFIG_EDIT_FAILED',
          `mise declares "${key}" in [${table}] but ops cannot find that line in ${path}; remove it by hand`,
        )
      }

      await file.writeAtomic(path, next)

      // Verify against mise, not against our own edit: this catches a wrong path
      // guess, the wrong table and a parser bug in one assertion.
      if (await isDeclared(table, key)) {
        throw new OpsError('MISE_CONFIG_EDIT_FAILED', `"${key}" is still declared in [${table}] after editing ${path}`)
      }

      return true
    },
  }
}
