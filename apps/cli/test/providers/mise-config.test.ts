import {describe, expect, it} from 'vitest'
import {OpsError} from '#core/errors.js'
import {type ConfigFile, createMiseDeclarations, miseGlobalConfigPath, removeTableKey} from '#providers/mise-config.js'
import {FakeRunner} from '#test/helpers/fake-runner.js'

/** Reproduces the shape of a real ~/.config/mise/config.toml, comments and all. */
const CONFIG = `[tools]
bat = "latest"
# Python CLIs. mise's pipx: backend is a thin wrapper that shells out to
# \`uv tool install\`, and the venv lands on uv-managed python.
"pipx:yt-dlp" = "latest"
node = "lts"

[bootstrap.packages]
"apt:curl" = "latest"
"apt:google-chrome-stable" = "latest"
"brew:antidote" = "latest"
`

/** An in-memory ConfigFile that records every write. */
function fakeFile(initial?: string) {
  const state = {text: initial, writes: [] as string[], reads: 0}
  const file: ConfigFile = {
    async read() {
      state.reads += 1
      return state.text
    },
    async writeAtomic(_path, text) {
      state.text = text
      state.writes.push(text)
    },
  }
  return {file, state}
}

const PATH = '/home/t/.config/mise/config.toml'
const CHROME = 'apt:google-chrome-stable'

describe('miseGlobalConfigPath', () => {
  it('prefers MISE_GLOBAL_CONFIG_FILE, then MISE_CONFIG_DIR, then XDG, then ~/.config', () => {
    expect(miseGlobalConfigPath({MISE_GLOBAL_CONFIG_FILE: '/x/c.toml', MISE_CONFIG_DIR: '/d'}, '/home/t')).toBe('/x/c.toml')
    expect(miseGlobalConfigPath({MISE_CONFIG_DIR: '/d'}, '/home/t')).toBe('/d/config.toml')
    expect(miseGlobalConfigPath({XDG_CONFIG_HOME: '/xdg'}, '/home/t')).toBe('/xdg/mise/config.toml')
    expect(miseGlobalConfigPath({}, '/home/t')).toBe('/home/t/.config/mise/config.toml')
  })
})

describe('removeTableKey', () => {
  it('removes exactly one line and leaves every other byte alone', () => {
    const next = removeTableKey(CONFIG, 'bootstrap.packages', CHROME)
    expect(next).toBe(CONFIG.replace('"apt:google-chrome-stable" = "latest"\n', ''))
  })

  it('keeps comments that sit above an unrelated key', () => {
    const next = removeTableKey(CONFIG, 'tools', 'node')!
    expect(next).toContain("# Python CLIs. mise's pipx: backend is a thin wrapper")
    expect(next).toContain('"pipx:yt-dlp" = "latest"')
    expect(next).not.toContain('node = "lts"')
  })

  it('is undefined when the key, the table or the file has nothing to remove', () => {
    expect(removeTableKey(CONFIG, 'bootstrap.packages', 'apt:absent')).toBeUndefined()
    expect(removeTableKey('[tools]\nbat = "latest"\n', 'bootstrap.packages', CHROME)).toBeUndefined()
    expect(removeTableKey('', 'bootstrap.packages', CHROME)).toBeUndefined()
  })

  // "node" lives in [tools]; asking for it in [bootstrap.packages] must not match it.
  it('does not match a same-named key in a different table', () => {
    expect(removeTableKey(CONFIG, 'bootstrap.packages', 'node')).toBeUndefined()
    expect(removeTableKey(CONFIG, 'tools', 'apt:curl')).toBeUndefined()
  })

  it('reads a quoted table header as the same table', () => {
    const quoted = '[bootstrap."packages"]\n"apt:curl" = "latest"\n'
    expect(removeTableKey(quoted, 'bootstrap.packages', 'apt:curl')).toBe('[bootstrap."packages"]\n')
  })

  it('is not confused by an array-of-tables header', () => {
    const arrays = '[[bootstrap.packages]]\n"apt:curl" = "latest"\n\n[bootstrap.packages]\n"apt:curl" = "1"\n'
    expect(removeTableKey(arrays, 'bootstrap.packages', 'apt:curl')).toBe('[[bootstrap.packages]]\n"apt:curl" = "latest"\n\n[bootstrap.packages]\n')
  })

  // Values mise writes are one quoted string. Anything else, we do not understand.
  it('refuses to guess at a value that does not end on its line', () => {
    expect(removeTableKey('[bootstrap.packages]\n"apt:curl" = [\n  "a",\n]\n', 'bootstrap.packages', 'apt:curl')).toBeUndefined()
    expect(removeTableKey('[bootstrap.packages]\n"apt:curl" = "unterminated\n', 'bootstrap.packages', 'apt:curl')).toBeUndefined()
  })

  it('removes an inline-table value that does end on its line', () => {
    const inline = '[bootstrap.packages]\n"apt:curl" = {version = "1"}\n"apt:git" = "latest"\n'
    expect(removeTableKey(inline, 'bootstrap.packages', 'apt:curl')).toBe('[bootstrap.packages]\n"apt:git" = "latest"\n')
  })
})

describe('createMiseDeclarations', () => {
  const declared = () => new FakeRunner().on('mise config get', {exitCode: 0, stdout: '"latest"'})
  const absent = () => new FakeRunner().on('mise config get', {exitCode: 1, stderr: 'Key not found'})

  it('asks mise whether a key is declared', async () => {
    const runner = declared()
    const {file} = fakeFile(CONFIG)
    expect(await createMiseDeclarations(runner, file, PATH).isDeclared('bootstrap.packages', CHROME)).toBe(true)
    expect(runner.calls[0]).toMatchObject({cmd: 'mise', args: ['config', 'get', '-g', `bootstrap.packages.${CHROME}`]})
  })

  it('treats a non-zero exit as "not declared" rather than a failure', async () => {
    const {file} = fakeFile(CONFIG)
    expect(await createMiseDeclarations(absent(), file, PATH).isDeclared('bootstrap.packages', CHROME)).toBe(false)
  })

  it('undeclares by removing the line, then proves it is gone', async () => {
    const runner = new FakeRunner()
      .on('mise config get', {exitCode: 0}, {exitCode: 1})
    const {file, state} = fakeFile(CONFIG)
    expect(await createMiseDeclarations(runner, file, PATH).undeclare('bootstrap.packages', CHROME)).toBe(true)
    expect(state.text).toBe(CONFIG.replace('"apt:google-chrome-stable" = "latest"\n', ''))
    expect(state.writes).toHaveLength(1)
  })

  // The no-op that keeps uninstall idempotent: never open the file we have no reason to touch.
  it('is a no-op that reads nothing when the key was never declared', async () => {
    const {file, state} = fakeFile(CONFIG)
    expect(await createMiseDeclarations(absent(), file, PATH).undeclare('bootstrap.packages', CHROME)).toBe(false)
    expect(state.reads).toBe(0)
    expect(state.writes).toEqual([])
  })

  it('is a no-op when the config file does not exist', async () => {
    const {file, state} = fakeFile(undefined)
    expect(await createMiseDeclarations(declared(), file, PATH).undeclare('bootstrap.packages', CHROME)).toBe(false)
    expect(state.writes).toEqual([])
  })

  it('fails loudly when mise still sees the key after the edit', async () => {
    const runner = new FakeRunner().on('mise config get', {exitCode: 0})
    const {file} = fakeFile(CONFIG)
    const error = await createMiseDeclarations(runner, file, PATH)
      .undeclare('bootstrap.packages', CHROME)
      .then(() => undefined, (e: unknown) => e)
    expect(error).toBeInstanceOf(OpsError)
    expect((error as OpsError).code).toBe('MISE_CONFIG_EDIT_FAILED')
  })

  it('fails loudly when mise says the key is there but the editor cannot find it', async () => {
    const {file} = fakeFile('[tools]\nbat = "latest"\n')
    const error = await createMiseDeclarations(declared(), file, PATH)
      .undeclare('bootstrap.packages', CHROME)
      .then(() => undefined, (e: unknown) => e)
    expect((error as OpsError).code).toBe('MISE_CONFIG_EDIT_FAILED')
    expect((error as OpsError).message).toContain(PATH)
  })

  it('describes what it would do', () => {
    const {file} = fakeFile(CONFIG)
    expect(createMiseDeclarations(declared(), file, PATH).describe('bootstrap.packages', CHROME)).toBe(
      `undeclare "${CHROME}" from [bootstrap.packages]`,
    )
  })
})
