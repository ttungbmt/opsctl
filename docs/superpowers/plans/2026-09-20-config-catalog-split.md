# Config Catalog Split Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move `repo` and `tool` entries out of `apps/cli/config/defaults.yaml` into `config/repo/<name>.yaml` and `config/tool/<name>.yaml`, discovered by a sorted directory scan, so adding a tool to ops becomes adding one file.

**Architecture:** One new injected primitive (`ReadDir`) and one new exported helper (`readCatalog`) inside `src/core/config.ts`. `readCatalog` lists a directory, sorts the names, derives each key from the filename, and parses each file with the *existing* per-entry schema. `loadConfig` assembles `defaults.yaml` + the two catalogs into the same `Config` object it returns today, so no consumer changes. `defaults.yaml` is then forbidden from declaring either section, because `z.looseObject` would otherwise keep a leftover block that nobody reads.

**Tech Stack:** TypeScript (NodeNext), Zod 4, `yaml`, Vitest, pnpm workspace.

**Spec:** [`docs/superpowers/specs/2026-09-20-config-catalog-split-design.md`](../specs/2026-09-20-config-catalog-split-design.md)

## Global Constraints

- **The assembled `Config` shape does not change.** `repo` and `tool` remain `Record<string, …>` on it. No file outside `src/core/config.ts` reads config differently; the only other source edits are user-facing help strings (Task 4).
- **Core reaches the filesystem only through injected defaults.** `readFile` and the new `readDir` are parameters with real-`fs` defaults, so tests never touch disk.
- **Core must never import `@oclif/core`.**
- **Every config failure is `OpsError` with code `CONFIG_INVALID`**, and the message names the offending file.
- **Entry name regex:** `^[a-z0-9][a-z0-9._-]*$` — already in `config.ts` as `RepoName`, renamed to `EntryName` in Task 1.
- **Catalog directory contents:** `*.yaml` is an entry; `README.md` is allowed and ignored; a name starting with `.` is ignored; anything else is `CONFIG_INVALID`. Classification is by **name only** — never stat, never `withFileTypes`.
- **A missing catalog directory means no entries** (`ENOENT` → `{}`); any other error propagates.
- **Order is by sorted filename**, so it never depends on what the filesystem returns.
- **`profile` stays in `defaults.yaml`.** Its key order is pinned by an existing test: `Object.keys(config.profile)` must equal `['base', 'minimal', 'dev']`.
- **Default data lives in `config/`, never in TypeScript constants.**
- Relative imports inside `src/` need `.js` extensions (NodeNext). Tests import through subpaths: `#core/config.js`.

---

## File Structure

| File | Responsibility |
|---|---|
| `apps/cli/src/core/config.ts` | **Modify.** `ReadDir` type, `EntryName` rename, `readCatalog`, `DefaultsFileSchema`, `Config` type, `loadConfig` assembly. The whole loader change lives here. |
| `apps/cli/config/defaults.yaml` | **Modify.** Loses `repo:` and `tool:`; header comment updated. |
| `apps/cli/config/repo/mozilla.yaml` | **Create.** The mozilla repo entry body. |
| `apps/cli/config/repo/README.md` | **Create.** What a repo entry is. |
| `apps/cli/config/tool/{agent-browser,firefox,google-chrome}.yaml` | **Create.** One recipe each, comments carried over verbatim. |
| `apps/cli/config/tool/README.md` | **Create.** The shared recipe prose currently above `tool:` in `defaults.yaml`. |
| `apps/cli/test/core/config.test.ts` | **Modify.** `readCatalog` unit tests; `load()` helper gains a catalog argument; the tests that fed `repo:`/`tool:` through *defaults* are rewritten. |
| `apps/cli/src/commands/tool/{install,setup,uninstall}.ts` | **Modify.** `description` strings naming where recipes live. |
| `CLAUDE.md`, `docs/architecture.md`, `docs/commands.md` | **Modify.** Prose naming `config/defaults.yaml` as the home of recipes. |

**Task order rationale:** Task 1 adds the helper without wiring it, so the suite stays green and a reviewer can judge the scan rules alone. Task 2 is the atomic flip — moving the data and wiring the loader cannot be separated without leaving the repo broken between commits. Task 3 adds the strictness that is only meaningful once the data has moved.

---

### Task 1: `readCatalog` — read one catalog directory

**Files:**
- Modify: `apps/cli/src/core/config.ts`
- Test: `apps/cli/test/core/config.test.ts`

**Interfaces:**
- Consumes: the existing private `readYaml(readFile, path, schema)` helper and `OpsError`.
- Produces:
  - `type ReadDir = (dir: string) => Promise<string[]>`
  - `export async function readCatalog<T>(readFile: ReadFile, readDir: ReadDir, dir: string, schema: z.ZodType<T>): Promise<Record<string, T>>`
  - `EntryName` (renamed from `RepoName`, same regex, same behaviour)

`loadConfig` is **not** touched in this task; the suite must stay green.

- [ ] **Step 1: Write the failing tests**

Add `import {z} from 'zod'` to the imports at the top of `apps/cli/test/core/config.test.ts`, add `readCatalog` to the existing `#core/config.js` import, and append this block at the end of the file:

```ts
describe('readCatalog', () => {
  const Entry = z.strictObject({package: z.string()})

  /** Serves exactly the files given; anything else is ENOENT, like the real fs. */
  const reader = (entries: Record<string, string>) => async (path: string) => {
    if (path in entries) return entries[path]
    throw Object.assign(new Error('missing'), {code: 'ENOENT'})
  }

  const lister = (names: string[]) => async () => names

  it('keys entries by filename and sorts them, whatever order the filesystem returns', async () => {
    const files = {
      '/tool/firefox.yaml': 'package: apt:firefox\n',
      '/tool/agent-browser.yaml': 'package: mise:agent-browser\n',
    }
    // Reverse order in, sorted order out.
    const catalog = await readCatalog(reader(files), lister(['firefox.yaml', 'agent-browser.yaml']), '/tool', Entry)

    expect(Object.keys(catalog)).toEqual(['agent-browser', 'firefox'])
    expect(catalog.firefox).toEqual({package: 'apt:firefox'})
  })

  it('ignores README.md and dotfiles', async () => {
    const files = {'/tool/firefox.yaml': 'package: apt:firefox\n'}
    const names = ['README.md', '.gitkeep', '.firefox.yaml.swp', 'firefox.yaml']
    const catalog = await readCatalog(reader(files), lister(names), '/tool', Entry)

    expect(Object.keys(catalog)).toEqual(['firefox'])
  })

  it('rejects a file that is not .yaml, naming it', async () => {
    // A .yml typo must fail loudly; silently skipping it is the bug this guards.
    const error = await errorOf(readCatalog(reader({}), lister(['firefox.yml']), '/tool', Entry))

    expect(error.code).toBe('CONFIG_INVALID')
    expect(error.message).toContain('/tool/firefox.yml')
  })

  it('rejects a filename that is not a usable entry name', async () => {
    const error = await errorOf(readCatalog(reader({}), lister(['Firefox.yaml']), '/tool', Entry))

    expect(error.code).toBe('CONFIG_INVALID')
    expect(error.message).toContain('/tool/Firefox.yaml')
  })

  it('treats a missing directory as no entries', async () => {
    const missing = async () => {
      throw Object.assign(new Error('missing'), {code: 'ENOENT'})
    }

    expect(await readCatalog(reader({}), missing, '/repo', Entry)).toEqual({})
  })

  it('propagates a directory error that is not ENOENT', async () => {
    const denied = async () => {
      throw Object.assign(new Error('denied'), {code: 'EACCES'})
    }

    await expect(readCatalog(reader({}), denied, '/repo', Entry)).rejects.toThrow('denied')
  })

  it('names the offending file when an entry fails its schema', async () => {
    const files = {'/tool/firefox.yaml': 'packag: apt:firefox\n'}
    const error = await errorOf(readCatalog(reader(files), lister(['firefox.yaml']), '/tool', Entry))

    expect(error.code).toBe('CONFIG_INVALID')
    expect(error.message).toContain('/tool/firefox.yaml')
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @ops/cli exec vitest run test/core/config.test.ts`
Expected: FAIL — `readCatalog` is not exported from `#core/config.js`.

- [ ] **Step 3: Rename `RepoName` to `EntryName`**

In `apps/cli/src/core/config.ts`, replace the declaration:

```ts
/** A repo name becomes a filename under /etc/apt, so restrict it to what apt will read. */
const RepoName = z.string().regex(/^[a-z0-9][a-z0-9._-]*$/, 'must match [a-z0-9][a-z0-9._-]*')
```

with:

```ts
/**
 * A catalog entry's name. It is a filename (under config/, and for a repo under /etc/apt
 * too), it is typed on the command line, and it is printed -- so restrict it to what all
 * three accept.
 */
const EntryName = z.string().regex(/^[a-z0-9][a-z0-9._-]*$/, 'must match [a-z0-9][a-z0-9._-]*')
```

Then update its two remaining uses, both `z.record(RepoName, RepoSchema)` — one in `DefaultsSchema`, one in `UserSchema` — to `z.record(EntryName, RepoSchema)`. `ProfileName` is a separate symbol and is **not** touched.

- [ ] **Step 4: Add `ReadDir` and `readCatalog`**

Add the type beside the existing `ReadFile` type near the top of the file:

```ts
type ReadFile = (path: string) => Promise<string>
type ReadDir = (dir: string) => Promise<string[]>
```

Add `join` to the `node:path` import if it is not already there (it is — `configPath` uses it).

Add this function immediately after the private `readYaml` helper at the bottom of the file:

```ts
/**
 * One catalog directory -> one record keyed by filename. Files are sorted so the result
 * never depends on the order the filesystem returns, and each key is validated because it is
 * typed on the command line and printed. Classification is by name alone: nothing is stat'd,
 * so a catalog is flat by construction. A missing directory means no entries -- git cannot
 * store an empty one, so "none configured" presents as "no directory".
 */
export async function readCatalog<T>(
  readFile: ReadFile,
  readDir: ReadDir,
  dir: string,
  schema: z.ZodType<T>,
): Promise<Record<string, T>> {
  let names: string[]
  try {
    names = await readDir(dir)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw error
  }

  const entries: Record<string, T> = {}
  for (const name of [...names].sort()) {
    // Editor swapfiles and .gitkeep are not entries; README.md documents the directory.
    if (name.startsWith('.') || name === 'README.md') continue

    const path = join(dir, name)
    if (!name.endsWith('.yaml')) {
      throw new OpsError('CONFIG_INVALID', `Invalid config ${path}: a catalog entry must be named <name>.yaml`)
    }

    const key = name.slice(0, -'.yaml'.length)
    const named = EntryName.safeParse(key)
    if (!named.success) {
      throw new OpsError('CONFIG_INVALID', `Invalid config ${path}: ${z.prettifyError(named.error)}`)
    }

    entries[key] = await readYaml(readFile, path, schema)
  }

  return entries
}
```

The loop is sequential on purpose: it keeps both the insertion order and the order in which errors surface deterministic.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @ops/cli exec vitest run test/core/config.test.ts`
Expected: PASS, including every pre-existing test — `loadConfig` has not changed yet.

- [ ] **Step 6: Typecheck and run the whole suite**

Run: `pnpm typecheck && pnpm test`
Expected: both clean.

- [ ] **Step 7: Commit**

```bash
git add apps/cli/src/core/config.ts apps/cli/test/core/config.test.ts
git commit -m "$(cat <<'EOF'
feat(config): read a catalog directory into a keyed record

readCatalog lists one directory, sorts the names so the result never depends on
what the filesystem returns, derives each key from the filename, and parses each
file with the caller's schema. Classification is by name alone -- nothing is
stat'd -- so a .yml typo fails loudly instead of being skipped, and a catalog is
flat by construction. Nothing calls it yet.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Move the catalog out of `defaults.yaml` and wire the loader

This task is atomic: moving the data without wiring the loader, or wiring it without moving the data, leaves the repo broken.

**Files:**
- Create: `apps/cli/config/repo/mozilla.yaml`, `apps/cli/config/repo/README.md`
- Create: `apps/cli/config/tool/{agent-browser,firefox,google-chrome}.yaml`, `apps/cli/config/tool/README.md`
- Modify: `apps/cli/config/defaults.yaml`
- Modify: `apps/cli/src/core/config.ts`
- Test: `apps/cli/test/core/config.test.ts`

**Interfaces:**
- Consumes: `readCatalog`, `ReadDir` from Task 1.
- Produces:
  - `loadConfig(readFile?, path?, defaults?, readDir?)` — a fourth optional parameter, defaulting to real `fs.readdir`.
  - `DefaultsFileSchema` — what `defaults.yaml` itself may hold (`mise`, `package`, `profile`).
  - `Config` — unchanged shape, now an intersection type rather than a single `z.infer`.

- [ ] **Step 1: Capture the baseline, before changing anything**

The whole point is that the loaded config does not change. Capture it first.

```bash
mkdir -p /tmp/ops-split && cat > /tmp/ops-split/dump-config.mjs <<'EOF'
// Deep-sorts every object key so the dump is independent of declaration order:
// a diff of two dumps then shows only real data changes, never reordering.
const sortDeep = (value) =>
  Array.isArray(value)
    ? value.map(sortDeep)
    : value && typeof value === 'object'
      ? Object.fromEntries(Object.keys(value).sort().map((k) => [k, sortDeep(value[k])]))
      : value

const {loadConfig} = await import(process.argv[2])
const config = await loadConfig(undefined, '/nonexistent/ops.yaml')
console.log(JSON.stringify(sortDeep(config), null, 2))
EOF
pnpm build
node /tmp/ops-split/dump-config.mjs "$PWD/apps/cli/dist/core/config.js" > /tmp/ops-split/before.json
wc -l /tmp/ops-split/before.json
```

Expected: a non-empty dump (~113 lines).

- [ ] **Step 2: Write the failing test**

Replace the `load` helper and the `files` helper near the top of `apps/cli/test/core/config.test.ts` with a version that also serves catalog directories. The existing two-argument call sites keep working; the third argument is new.

```ts
type Catalog = Record<string, string>

/**
 * Serves the defaults at /defaults.yaml, the user config (if any) at /user.yaml, and catalog
 * entries at /repo/<name>.yaml and /tool/<name>.yaml -- the layout loadConfig derives from
 * dirname('/defaults.yaml').
 */
function fakes(user: string | undefined, defaults: string, repo: Catalog, tool: Catalog) {
  const entries: Record<string, string> = {'/defaults.yaml': defaults}
  if (user !== undefined) entries['/user.yaml'] = user
  for (const [name, body] of Object.entries(repo)) entries[`/repo/${name}.yaml`] = body
  for (const [name, body] of Object.entries(tool)) entries[`/tool/${name}.yaml`] = body

  const listing: Record<string, string[]> = {
    '/repo': Object.keys(repo).map((name) => `${name}.yaml`),
    '/tool': Object.keys(tool).map((name) => `${name}.yaml`),
  }

  const enoent = () => Object.assign(new Error('missing'), {code: 'ENOENT'})

  return {
    readFile: async (path: string) => {
      if (path in entries) return entries[path]
      throw enoent()
    },
    // An empty catalog is a directory that does not exist: git cannot store an empty one.
    readDir: async (dir: string) => {
      const names = listing[dir]
      if (!names?.length) throw enoent()
      return names
    },
  }
}

const load = (user?: string, defaults = DEFAULTS, catalog: {repo?: Catalog; tool?: Catalog} = {}) => {
  const {readFile, readDir} = fakes(user, defaults, catalog.repo ?? {}, catalog.tool ?? {})
  return loadConfig(readFile, '/user.yaml', '/defaults.yaml', readDir)
}
```

Then add this test to the `loadConfig` describe block:

```ts
it('assembles repo and tool from the catalog directories, not from defaults.yaml', async () => {
  const config = await load(undefined, DEFAULTS, {
    repo: {mozilla: 'uri: https://packages.mozilla.org/apt\nsuite: mozilla\ncomponents: [main]\nkeyring: https://packages.mozilla.org/apt/k.gpg\n'},
    tool: {firefox: 'package: apt:firefox\nrepo: mozilla\n', 'agent-browser': 'package: mise:agent-browser\n'},
  })

  expect(Object.keys(config.tool)).toEqual(['agent-browser', 'firefox'])
  expect(config.tool.firefox.package).toBe('apt:firefox')
  expect(config.repo.mozilla.suite).toBe('mozilla')
})
```

- [ ] **Step 3: Run it to verify it fails**

Run: `pnpm --filter @ops/cli exec vitest run test/core/config.test.ts -t 'assembles repo and tool'`
Expected: FAIL — `loadConfig` takes three parameters and reads `repo`/`tool` from `defaults.yaml`, so `config.tool` is `{}`.

- [ ] **Step 4: Split `DefaultsSchema` into the file schema and the assembled type**

In `apps/cli/src/core/config.ts`, replace `DefaultsSchema` and the `Config` type. Note `repo`/`tool` are simply absent here — Task 3 adds the rejection.

```ts
/**
 * What defaults.yaml itself holds: settings, not catalog entries. Still loose, so another
 * area can add its own section without touching this schema. `repo` and `tool` come from
 * config/repo/ and config/tool/ instead.
 */
const DefaultsFileSchema = z.looseObject({
  /** Where ops gets mise when a machine has none; the preflight reads it. */
  mise: MiseSchema.optional(),
  package: z.looseObject({
    /** Plain names installed with apt/dnf instead of a mise tool. */
    system: NameList,
  }),
  /** Named machine profiles; `ops bootstrap <name>` converges the machine to one. */
  profile: z.record(ProfileName, ProfileSchema).default({}),
})

/** The assembled config: the file's settings plus the two catalogs. Unchanged for consumers. */
export type Config = z.infer<typeof DefaultsFileSchema> & {
  repo: Record<string, z.infer<typeof RepoSchema>>
  tool: Record<string, z.infer<typeof RecipeSchema>>
}
```

Delete the old `export type Config = z.infer<typeof DefaultsSchema>` line. `UserSchema` and `UserConfig` are unchanged.

- [ ] **Step 5: Assemble the catalogs in `loadConfig`**

Add `readdir as fsReaddir` to the `node:fs/promises` import and `dirname` to the `node:path` import:

```ts
import {readFile as fsReadFile, readdir as fsReaddir} from 'node:fs/promises'
import {dirname, join} from 'node:path'
```

Replace `loadConfig`:

```ts
/** Built-in defaults overlaid with the user config; a missing user file means defaults only. */
export async function loadConfig(
  readFile: ReadFile = (path) => fsReadFile(path, 'utf8'),
  path: string = configPath(),
  defaults: string = defaultsPath(),
  readDir: ReadDir = (dir) => fsReaddir(dir),
): Promise<Config> {
  // The catalogs sit beside defaults.yaml, so they need no path of their own.
  const dir = dirname(defaults)
  const base: Config = {
    ...(await readYaml(readFile, defaults, DefaultsFileSchema)),
    repo: await readCatalog(readFile, readDir, join(dir, 'repo'), RepoSchema),
    tool: await readCatalog(readFile, readDir, join(dir, 'tool'), RecipeSchema),
  }

  let user: UserConfig
  try {
    user = await readYaml(readFile, path, UserSchema)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return base
    throw error
  }

  return mergeConfig(base, user)
}
```

`mergeConfig` is **not** touched.

- [ ] **Step 6: Create the catalog files**

`apps/cli/config/repo/mozilla.yaml` — the entry body, de-indented, comments carried over verbatim:

```yaml
uri: https://packages.mozilla.org/apt
suite: mozilla
components: [main]
keyring: https://packages.mozilla.org/apt/repo-signing-key.gpg
# This repo publishes an internal path as its Release `Origin:`, so the pin matches the
# site hostname instead. Do not "correct" this to `release o=` -- that breaks the pin.
# 1000 beats the Ubuntu archive's 500, whose `firefox` is a 121 KB transitional package
# that installs the Firefox snap.
pin:
  origin: packages.mozilla.org
  priority: 1000
```

`apps/cli/config/tool/agent-browser.yaml`:

```yaml
summary: Browser automation CLI for AI agents
# Already in the mise registry (aqua:vercel-labs/agent-browser); the recipe
# exists to carry `setup`, and pins resolution so no registry lookup runs.
package: mise:agent-browser
setup:
  # The binary alone cannot drive anything: `install` downloads Chrome for
  # Testing and, with --with-deps, the system libraries it needs. `doctor`
  # exits 1 when any check fails; --quick skips its live headless launch and
  # --offline skips network probes, keeping the probe fast and local.
  - name: browser binaries
    check: [agent-browser, doctor, --quick, --offline]
    run: [agent-browser, install, --with-deps]
```

`apps/cli/config/tool/firefox.yaml`:

```yaml
summary: Mozilla Firefox
# Mozilla publishes no standalone .deb, so there is nothing to `prepare`; the repo is what
# makes `apt:firefox` mean Mozilla's build rather than Ubuntu's snap shim.
package: apt:firefox
repo: mozilla
```

`apps/cli/config/tool/google-chrome.yaml`:

```yaml
summary: Google Chrome
package: apt:google-chrome-stable
prepare:
  # Google's own .deb; its postinst configures the apt repo for later updates.
  deb: https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
uninstall:
  # `--purge` only, and only what dpkg does not own. Verified with `dpkg -S`
  # against a real install: /opt/google/chrome and the
  # /etc/cron.daily/google-chrome symlink belong to the package and go with
  # `apt-get purge`, while the two repo files below belong to nobody --
  # Chrome's postinst writes them ("This file will not be recreated if
  # removed") and they would re-add the repo on the next `apt update`.
  # `.sources` is the deb822 name current Chrome writes and `.list` the
  # older one; the keyring moved between releases. A path that does not
  # exist is a no-op, so every known variant is listed.
  purge:
    paths:
      - /etc/apt/sources.list.d/google-chrome.sources
      - /etc/apt/sources.list.d/google-chrome.list
      - /usr/share/keyrings/google-chrome.gpg
      - /etc/apt/keyrings/google-chrome.gpg
      - ~/.config/google-chrome
      - ~/.cache/google-chrome
```

`apps/cli/config/tool/README.md` — the shared prose that sits above `tool:` in `defaults.yaml` today:

```markdown
# Tool recipes

One file per tool; the filename is the tool's name (`firefox.yaml` -> `firefox`),
and the file is the recipe body.

A plain name resolves to `package` before any heuristic (the system list, the mise
registry), so `ops tool install google-chrome` knows the real package name.

- `prepare` runs only when the tool is missing: it makes the package installable on a
  machine that has never seen it. Today the only kind is an https `.deb`.
- `repo` names an entry in `../repo/` instead, for a vendor that ships no standalone
  `.deb`. `prepare` and `repo` are opposites and mutually exclusive.
- `setup` configures a tool once it exists. Each step's `check` decides whether `run` is
  needed and verifies it afterwards, so **a check must fail only for what its `run`
  repairs**.
- `uninstall.purge.paths` names what `ops tool uninstall --purge` deletes after the
  package is gone: only what the package manager does not own itself. Paths are absolute
  or `~/`-rooted, validated at load, and never expanded as globs.

The schema for every field is `RecipeSchema` in `src/core/config.ts`.
```

`apps/cli/config/repo/README.md`:

```markdown
# Vendor apt repositories

One file per repository; the filename is the repo's name, referenced from a recipe's
`repo:` field in `../tool/`.

For `<name>.yaml` ops writes `/etc/apt/keyrings/ops-<name>.asc`,
`/etc/apt/sources.list.d/ops-<name>.sources` and `/etc/apt/preferences.d/ops-<name>.pref`,
runs `apt-get update`, then checks with `apt-cache policy` that apt's candidate really
comes from this repo before anything is installed.

`pin.origin` is the **site hostname** (apt's `Pin: origin <host>`), not the Release file's
`Origin:` field. A priority above 500 beats the distro archive.

The schema is `RepoSchema` in `src/core/config.ts`.
```

- [ ] **Step 7: Strip the catalog out of `defaults.yaml`**

Delete the `repo:` block (with its comment) and the `tool:` block (with its comment) from `apps/cli/config/defaults.yaml`. Replace the ordering paragraph in the header with:

```yaml
# Built-in defaults for ops. Override in ~/.config/ops/config.yaml (or $OPS_CONFIG).
#
# This file holds settings. The catalogs live beside it, one file per entry:
# config/tool/<name>.yaml (recipes) and config/repo/<name>.yaml (vendor apt
# repositories) -- see the README.md in each. Declaring `tool:` or `repo:` here is an
# error, not a no-op.
#
# Ordering: top-level sections go in dependency order -- each one refers only to
# something defined above it. `profile` follows its `extends` chain (base -> minimal ->
# dev) rather than alphabetical order, because a profile reads as an extension of the one
# above it, and test/core/config.test.ts pins that order.
```

The remaining file is `mise:`, `package:`, `profile:` in that order.

- [ ] **Step 8: Rewrite the tests that fed the catalog through `defaults`**

Nine tests supply `repo:`/`tool:` in the **defaults** string and must move to the catalog argument. Tests that supply them in the **user** string are unaffected — `UserSchema` still carries both sections.

In `describe('repo config')`, change `MOZILLA` from a nested block to an entry body and update every use:

```ts
describe('repo config', () => {
  const MOZILLA = [
    'uri: https://packages.mozilla.org/apt',
    'suite: mozilla',
    'components: [main]',
    'keyring: https://packages.mozilla.org/apt/repo-signing-key.gpg',
    'pin:',
    '  origin: packages.mozilla.org',
    '  priority: 1000',
    '',
  ].join('\n')

  /** The built-in catalog for these tests: one repo, named by its filename. */
  const mozilla = (body = MOZILLA) => ({repo: {mozilla: body}})

  it('defaults to no repos', async () => {
    expect((await load()).repo).toEqual({})
  })

  it('parses a repo with a pin', async () => {
    const config = await load(undefined, DEFAULTS, mozilla())
    expect(config.repo.mozilla).toEqual({
      uri: 'https://packages.mozilla.org/apt',
      suite: 'mozilla',
      components: ['main'],
      keyring: 'https://packages.mozilla.org/apt/repo-signing-key.gpg',
      pin: {origin: 'packages.mozilla.org', priority: 1000},
    })
  })

  it('rejects a misspelled key inside a repo, naming the file and the key', async () => {
    const error = await errorOf(load(undefined, DEFAULTS, mozilla(MOZILLA.replace('suite:', 'suit:'))))
    expect(error.code).toBe('CONFIG_INVALID')
    expect(error.message).toContain('/repo/mozilla.yaml')
    expect(error.message).toContain('suit')
  })

  it('rejects a non-https uri and keyring, naming the field', async () => {
    const uri = await errorOf(load(undefined, DEFAULTS, mozilla(MOZILLA.replace('uri: https://', 'uri: http://'))))
    expect(uri.message).toContain('uri')

    const keyring = await errorOf(load(undefined, DEFAULTS, mozilla(MOZILLA.replace('keyring: https://', 'keyring: http://'))))
    expect(keyring.message).toContain('keyring')
  })

  it('rejects a user repo name that would not be a usable filename', async () => {
    // A built-in repo's name is its filename, guarded by readCatalog; a user's is a map key.
    const user = 'repo:\n  Mozilla/1:\n    uri: https://x.test/apt\n    suite: m\n    components: [main]\n    keyring: https://x.test/k.gpg\n'
    const error = await errorOf(load(user))
    expect(error.code).toBe('CONFIG_INVALID')
    expect(error.message).toContain('Mozilla/1')
  })

  it('merges repos by name, with the user winning and other repos kept', async () => {
    const other = 'uri: https://other.test/apt\nsuite: o\ncomponents: [main]\nkeyring: https://other.test/k.gpg\n'
    const user = 'repo:\n  mozilla:\n    uri: https://mirror.test/apt\n    suite: m\n    components: [main]\n    keyring: https://mirror.test/k.gpg\n'
    const config = await load(user, DEFAULTS, {repo: {mozilla: MOZILLA, other}})

    expect(config.repo.mozilla.uri).toBe('https://mirror.test/apt')
    expect(config.repo.mozilla.pin).toBeUndefined()
    // A user `repo` section must not drop the built-in repos it does not mention.
    expect(config.repo.other.uri).toBe('https://other.test/apt')
  })

  it('rejects a pin priority that is not a positive integer', async () => {
    const zero = await errorOf(load(undefined, DEFAULTS, mozilla(MOZILLA.replace('priority: 1000', 'priority: 0'))))
    expect(zero.code).toBe('CONFIG_INVALID')

    const text = await errorOf(load(undefined, DEFAULTS, mozilla(MOZILLA.replace('priority: 1000', 'priority: high'))))
    expect(text.code).toBe('CONFIG_INVALID')
  })
})
```

Then fix the two `tool` merge tests, which currently build a `defaults` string containing `tool:`:

```ts
it('merges tool recipes by name, letting the user replace one', async () => {
  const config = await load(
    'tool:\n  chrome:\n    package: apt:chromium\n  code:\n    package: apt:code\n',
    DEFAULTS,
    {tool: {chrome: 'package: apt:google-chrome-stable\n'}},
  )
  expect(config.tool.chrome.package).toBe('apt:chromium')
  expect(config.tool.code.package).toBe('apt:code')
})
```

and

```ts
it('lets a user recipe replace the built-in setup steps wholesale', async () => {
  const config = await load(
    'tool:\n  ab:\n    package: mise:ab\n    setup:\n      - name: mine\n        check: [ab, ok]\n        run: [ab, go]\n',
    DEFAULTS,
    {tool: {ab: 'package: mise:ab\nsetup:\n  - name: built-in\n    check: [ab, doctor]\n    run: [ab, install]\n'}},
  )
  expect(config.tool.ab.setup?.map((s) => s.name)).toEqual(['mine'])
})
```

Keep the existing assertion of whichever of these two tests differs from the above; only the *source* of the built-in recipe changes, never what is asserted.

- [ ] **Step 9: Run the full suite**

Run: `pnpm typecheck && pnpm test`
Expected: PASS. The four tests that load the **real** `defaultsPath()` now exercise the real directory scan, because they pass three arguments and `readDir` falls back to real `fs.readdir`.

- [ ] **Step 10: Prove the loaded config did not change**

```bash
pnpm build
node /tmp/ops-split/dump-config.mjs "$PWD/apps/cli/dist/core/config.js" > /tmp/ops-split/after.json
diff /tmp/ops-split/before.json /tmp/ops-split/after.json && echo "IDENTICAL"
```

Expected: `IDENTICAL`, with an empty diff. Sorted filenames reproduce today's `agent-browser, firefox, google-chrome` order exactly. **If this diff is not empty, the migration dropped or altered data — stop and fix before committing.**

- [ ] **Step 11: Run the real CLI**

```bash
pnpm ops profile show dev
pnpm ops bootstrap dev --dry-run --json | tail -20
```

Expected: `profile show dev` still lists `ca-certificates curl git unzip build-essential openssh-client tmux wget zsh` and `node@lts pnpm`; the dry run plans without error.

- [ ] **Step 12: Commit**

```bash
git add apps/cli/config apps/cli/src/core/config.ts apps/cli/test/core/config.test.ts
git commit -m "$(cat <<'EOF'
feat(config): load recipes and repos from config/{tool,repo}/

defaults.yaml held settings and a catalog in one file, and only the catalog grows:
80 of its 140 lines were three recipes and one repo. Each entry now gets a file
named after it, assembled by loadConfig through readCatalog.

The loaded Config is byte-identical -- verified by diffing a deep-sorted dump
before and after -- so nothing that reads it changes.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Reject `repo:` and `tool:` in `defaults.yaml`

`DefaultsFileSchema` is loose, so a leftover `tool:` block would be kept by Zod and read by nobody: a recipe that exists, converges the wrong machine, and reports success.

**Files:**
- Modify: `apps/cli/src/core/config.ts`
- Test: `apps/cli/test/core/config.test.ts`

**Interfaces:**
- Consumes: `DefaultsFileSchema` from Task 2.
- Produces: no new exports; `DefaultsFileSchema` gains a `superRefine`.

- [ ] **Step 1: Write the failing test**

Add to the `loadConfig` describe block:

```ts
it('refuses a catalog section left behind in defaults.yaml', async () => {
  // looseObject would keep it and nobody would read it: a recipe that silently does nothing.
  const tool = await errorOf(load(undefined, DEFAULTS + 'tool:\n  ab:\n    package: apt:ab\n'))
  expect(tool.code).toBe('CONFIG_INVALID')
  expect(tool.message).toContain('/defaults.yaml')
  expect(tool.message).toContain('config/tool/')

  const repo = await errorOf(load(undefined, DEFAULTS + 'repo:\n  m:\n    uri: https://x.test/apt\n'))
  expect(repo.code).toBe('CONFIG_INVALID')
  expect(repo.message).toContain('config/repo/')
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @ops/cli exec vitest run test/core/config.test.ts -t 'catalog section left behind'`
Expected: FAIL — no error is thrown; `errorOf` reports the value is not an `OpsError`.

- [ ] **Step 3: Add the rejection**

Wrap `DefaultsFileSchema` in `apps/cli/src/core/config.ts`:

```ts
const DefaultsFileSchema = z
  .looseObject({
    /** Where ops gets mise when a machine has none; the preflight reads it. */
    mise: MiseSchema.optional(),
    package: z.looseObject({
      /** Plain names installed with apt/dnf instead of a mise tool. */
      system: NameList,
    }),
    /** Named machine profiles; `ops bootstrap <name>` converges the machine to one. */
    profile: z.record(ProfileName, ProfileSchema).default({}),
  })
  .superRefine((value, ctx) => {
    // Loose keeps unknown keys, so a catalog block left here would be kept and never read.
    for (const key of ['repo', 'tool'] as const) {
      if (key in value) {
        ctx.addIssue({code: 'custom', path: [key], message: `${key} entries live in config/${key}/<name>.yaml, not here`})
      }
    }
  })
```

Because `Config` is derived from `z.infer<typeof DefaultsFileSchema>`, confirm the type still resolves after wrapping — a `ZodEffects`/refined schema infers the same output type. If `z.infer` no longer resolves cleanly, base the `Config` intersection on the inner object schema by extracting it to a named `const DefaultsFileShape = z.looseObject({…})` and refining that.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @ops/cli exec vitest run test/core/config.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck and full suite**

Run: `pnpm typecheck && pnpm test`
Expected: both clean.

- [ ] **Step 6: Commit**

```bash
git add apps/cli/src/core/config.ts apps/cli/test/core/config.test.ts
git commit -m "$(cat <<'EOF'
feat(config): refuse a catalog section left in defaults.yaml

The file schema is loose so other areas can add sections, which means a `tool:`
block left behind after the split would be kept by Zod and read by nobody -- a
recipe that exists, converges the wrong machine, and reports success. Same
failure class SetupStepSchema and RepoSchema already use strictObject to stop.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Documentation and user-facing help text

**Files:**
- Modify: `apps/cli/src/commands/tool/install.ts`, `setup.ts`, `uninstall.ts`
- Modify: `CLAUDE.md`, `docs/architecture.md`, `docs/commands.md`

- [ ] **Step 1: Find every claim that recipes live in `defaults.yaml`**

```bash
grep -rn "config/defaults.yaml" --include=*.ts --include=*.md . | grep -v node_modules | grep -v docs/superpowers
```

Read each hit and classify it. **Statements about `profile.<name>` living in `config/defaults.yaml` remain true and must not be "corrected".** Only claims about recipes (`tool.<name>`), setup steps and repos change.

- [ ] **Step 2: Update the three command descriptions**

In `apps/cli/src/commands/tool/install.ts`, `setup.ts` and `uninstall.ts`, the `description` strings tell users where to edit recipes. Change the phrase naming `config/defaults.yaml` as the home of recipes/setup steps to `config/tool/<name>.yaml`, keeping the rest of each sentence — including the pointer to `~/.config/ops/config.yaml` (or `$OPS_CONFIG`), which is still where a user overrides one. In `install.ts` the sentence naming `package.system` still points at `config/defaults.yaml`, which stays correct.

- [ ] **Step 3: Update the prose docs**

- `CLAUDE.md`: the Config sentence, including the ordering clause. It currently reads that entries are alphabetical inside each section of `defaults.yaml`; it must now say the catalog lives in `config/{repo,tool}/<name>.yaml`, one entry per file, discovered by a sorted scan, and that `defaults.yaml` holds `mise`, `package` and `profile` and rejects the catalog sections.
- `docs/architecture.md`: the Configuration section's note about which layers exist today.
- `docs/commands.md`: hits from Step 1 that describe where recipes live.

- [ ] **Step 4: Verify no stale claim survives**

```bash
grep -rn "config/defaults.yaml" --include=*.ts --include=*.md . | grep -v node_modules | grep -v docs/superpowers
```

Expected: every remaining hit is about `package.system`, `profile.<name>`, or `mise:` — never about a recipe or a repo.

- [ ] **Step 5: Run the suite**

Run: `pnpm test`
Expected: PASS. No test currently asserts on a command's `description` text, so this step is a regression check rather than an expected-failure step — if it goes red, a test grew such an assertion since this plan was written.

- [ ] **Step 6: Commit**

```bash
git add CLAUDE.md docs apps/cli/src/commands/tool
git commit -m "$(cat <<'EOF'
docs: point recipes and repos at their own files

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Prove the catalog ships

The one failure local tests cannot catch: `files: ["bin","config","dist"]` should carry subdirectories into the release tarball, but if it did not, ops would ship with an empty catalog **and no error**, because a missing directory means no entries.

**Files:**
- Modify (only if the proof fails): `apps/cli/package.json`

- [ ] **Step 1: Pack the CLI the way the release does and look inside**

`.github/workflows/release.yml` runs `pnpm deploy` outside the workspace, then `oclif pack tarballs`. The packaging question is answered by what `npm pack` includes, which is what both respect:

```bash
cd apps/cli && npm pack --dry-run 2>&1 | grep -E "config/" ; cd -
```

Expected: the listing includes `config/defaults.yaml`, `config/repo/mozilla.yaml`, `config/repo/README.md` and all three `config/tool/*.yaml` files.

- [ ] **Step 2: If any catalog file is missing, make `files` explicit**

Only if Step 1 came up short, change `files` in `apps/cli/package.json` to list the subdirectories explicitly:

```json
"files": [
  "bin",
  "config",
  "config/repo",
  "config/tool",
  "dist"
]
```

Re-run Step 1 and confirm the files now appear. If Step 1 already listed everything, change nothing.

- [ ] **Step 3: Prove it end to end in a container**

The container is the only place the real install path runs:

```bash
mise run docker:run ops tool install firefox --dry-run
```

Expected: firefox resolves to `apt:firefox` through the mozilla repo — proving the catalog was found from an installed layout, not just from the source tree.

- [ ] **Step 4: Commit if anything changed**

```bash
git add apps/cli/package.json
git commit -m "$(cat <<'EOF'
fix(release): ship the catalog directories in the tarball

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

If Step 1 passed and nothing changed, skip this commit and note the proof in the task report instead.

---

## Self-Review

**Spec coverage**

| Spec decision | Task |
|---|---|
| 1. Split the catalog only; `profile` stays | Task 2 (steps 6–7) |
| 2. Directory scan, sorted, injected `ReadDir` | Task 1 (steps 4), Task 2 (step 5) |
| 3. Filename is the key; key validated; `UserSchema.tool` untouched | Task 1 (steps 3–4), Task 2 (step 8 user-name test) |
| 4. `defaults.yaml` forbids `repo:`/`tool:` | Task 3 |
| 5. Directory contents rule (`.yaml`, `README.md`, dotfiles, else error) | Task 1 (steps 1, 4) |
| 6. Missing directory → `{}` | Task 1 (steps 1, 4) |
| 7. Deterministic order by sorted filename | Task 1 (step 1, reverse-order test) |
| Migration with comments carried over | Task 2 (step 6) |
| Verification: empty dump diff | Task 2 (step 10) |
| Verification: real CLI | Task 2 (step 11) |
| Verification: packaging | Task 5 |
| Docs and help text | Task 4 |

**Type consistency:** `ReadDir` is declared once (Task 1, step 4) and used in `loadConfig`'s signature (Task 2, step 5). `readCatalog`'s four parameters are the same in its tests (Task 1), its definition (Task 1) and both call sites (Task 2). `EntryName` replaces `RepoName` in Task 1 and is referenced nowhere later by its old name. `DefaultsFileSchema` is introduced in Task 2 and refined — not renamed — in Task 3.

**Known risk carried from the spec:** a packaging failure that removes a catalog directory presents as "no recipes" rather than as an error, because decision 6 trades a crash for robustness. Task 5 is the guard, and it is the step that must not be skipped.
