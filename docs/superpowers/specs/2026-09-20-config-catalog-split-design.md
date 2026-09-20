# Config catalog split — Design

Date: 2026-09-20 · Status: planned

Builds on [`2026-09-20-tool-recipes-design.md`](2026-09-20-tool-recipes-design.md)
and [`2026-09-20-apt-repo-design.md`](2026-09-20-apt-repo-design.md), which put
recipes and vendor repositories into `config/defaults.yaml` in the first place.

## Problem

`apps/cli/config/defaults.yaml` holds two kinds of thing that grow at different
rates, and it holds them in one file.

| Section | Lines | Entries | Cost per entry |
|---|---|---|---|
| `tool:` | 57 | 3 | ~19 lines (google-chrome alone ~35) |
| `repo:` | 23 | 1 | ~23 lines |
| `package:` | 21 | — | fixed |
| `profile:` | 18 | 3 | ~6 lines |
| `mise:` | 7 | — | fixed |

`package` and `mise` are settings: fixed size forever. `profile` is a handful of
cheap entries. But `tool` and `repo` are a **catalog** — an open-ended list of
vendor knowledge that grows with every tool ops learns to install, and whose
entries are expensive because the valuable part is the prose explaining *why*
(google-chrome's purge rationale, mozilla's pin warning).

At 140 lines this is not yet painful. The trigger is one milestone away: v0.3 in
the roadmap adds yt-dlp, ffmpeg, Docker, Git and GitHub CLI — roughly +100 lines
on its own. A realistic 20–30-recipe catalog is 500–700 lines in a single file,
where every contributor adding a tool edits the same file and collides with
every other contributor doing the same.

The cost of splitting is nearly constant whether the file is 140 lines or 700;
the cost of *not* splitting grows. Doing it now, while `config.test.ts` is the
only test that touches config loading, is the cheap moment.

## Goal

Adding a tool to ops becomes **adding one file**, touching nothing else.

Non-goal: changing anything a user or any other part of the codebase can
observe. The assembled `Config` object stays byte-identical, so commands, core
and providers are untouched.

## Decisions

### 1. Split the catalog only

`config/defaults.yaml` keeps `mise`, `package` and `profile`. `repo` and `tool`
move to sibling directories:

```
apps/cli/config/
  defaults.yaml          # mise, package, profile
  repo/
    README.md
    mozilla.yaml
  tool/
    README.md
    agent-browser.yaml
    firefox.yaml
    google-chrome.yaml
```

`profile` deliberately stays put. Its key order is a tested contract
(`test/core/config.test.ts`: `Object.keys(config.profile)` must equal
`['base', 'minimal', 'dev']`, an order that expresses the `extends` chain), and
at ~6 lines per entry it is not what bloats the file.

### 2. Discovery is a directory scan, sorted

`loadConfig` gains one injected primitive beside the existing `ReadFile`:

```ts
type ReadDir = (path: string) => Promise<string[]>
```

A scan is what makes "add a tool = add one file" true. A static manifest would
keep core's I/O surface as it is, but it breaks that promise: adding a tool
would mean editing two places, and forgetting the second leaves a recipe
silently inert.

The directories are derived from the defaults path (`dirname(defaults)/tool`,
`dirname(defaults)/repo`), so no new path parameter is needed and the existing
tests — which pass `'/defaults.yaml'` — naturally scan `'/tool'` and `'/repo'`.

### 3. The filename is the key

`tool/firefox.yaml` contributes the key `firefox`; the file body is the entry
body, with no name repeated inside:

```yaml
# config/tool/firefox.yaml
summary: Mozilla Firefox
# Mozilla publishes no standalone .deb, so there is nothing to `prepare`; the repo is what
# makes `apt:firefox` mean Mozilla's build rather than Ubuntu's snap shim.
package: apt:firefox
repo: mozilla
```

Each file is validated by the **unchanged** `RecipeSchema` (or `RepoSchema` for
`config/repo/`). No schema is rewritten; only the place they are applied moves.

The derived key is checked against the name regex already used for repos and
profiles (`^[a-z0-9][a-z0-9._-]*$`), so `repo/Mozilla.yaml` fails at load naming
the file.

`UserSchema.tool` stays `z.record(z.string(), RecipeSchema)`. Tightening it
would change the contract for user configs, which has nothing to do with
splitting built-in files. After the split every *built-in* tool key comes from a
filename, so the surface that needed tightening is tightened.

### 4. `defaults.yaml` may no longer declare `repo:` or `tool:`

Declaring either is `CONFIG_INVALID` at load.

`DefaultsSchema` is a `z.looseObject`, so a `tool:` block left behind after the
migration would be *kept* by Zod and then read by nobody: a recipe that exists,
converges the wrong machine, and reports success. That is precisely the failure
class `SetupStepSchema`, `RepoSchema` and `ProfileSchema` already use
`strictObject` to prevent.

A useful consequence: since each key has exactly one possible home, there is no
key conflict *among the defaults sources*, and therefore no merge rule to
invent. `mergeConfig` keeps doing its single job — defaults ↔ user — unchanged.

### 5. What a catalog directory may contain

The scan returns **names only**; nothing is stat'd, so classification is by name
alone:

- `*.yaml` — a catalog entry.
- `README.md` — allowed, ignored by the loader.
- a name starting with `.` — ignored (editor swapfiles, `.gitkeep`).
- anything else — `CONFIG_INVALID`, naming the file.

A subdirectory therefore falls under the last rule and is an error, which
matches "no nested subdirectories" below: the catalog is flat by construction,
and the loader needs no filesystem call beyond listing and reading.

Rejecting the rest is the same principle as decision 4: silently skipping a
`firefox.yml` typo is the failure this design exists to prevent. `README.md` is
the one exception because the shared prose that today sits above `tool:` in
`defaults.yaml` — what a recipe is, `prepare` vs `setup`, what `uninstall.purge`
deletes — documents every recipe file and belongs where contributors add them.
`README.md` is not a plausible typo of an entry filename, so allowing exactly
that name costs nothing.

### 6. A missing directory means no entries

`ENOENT` from the scan yields `{}`; any other error propagates. Git cannot store
an empty directory, so "no repos configured" legitimately presents as "no
directory".

### 7. Order is deterministic, by sorted filename

Filenames are sorted before insertion. The name regex restricts them to
`[a-z0-9._-]`, so byte order is alphabetical order, independent of locale and of
whatever order the filesystem returns. Tool key order is not observable today
(there is no `ops tool list`), but sorting makes it stable now and alphabetical
for free when such a command arrives.

## Shape of the code

The loader change is confined to `src/core/config.ts`. The only other source
files touched carry user-facing help text that names where recipes live — the
`description` strings in `src/commands/tool/install.ts`, `setup.ts` and
`uninstall.ts`. No consumer of `Config` changes, because `Config` does not.

```ts
type ReadDir = (dir: string) => Promise<string[]>

/**
 * What defaults.yaml itself may hold: settings, never catalog entries. Still
 * loose, so future settings sections need no change here -- but `repo` and
 * `tool` are rejected by name (decision 4).
 */
const DefaultsFileSchema = z
  .looseObject({
    mise: MiseSchema.optional(),
    package: z.looseObject({system: NameList}),
    profile: z.record(ProfileName, ProfileSchema).default({}),
  })
  .superRefine((value, ctx) => {
    for (const key of ['repo', 'tool'] as const) {
      if (key in value) ctx.addIssue({code: 'custom', path: [key], message: `${key} entries live in config/${key}/<name>.yaml`})
    }
  })

/** The assembled result: the shape every consumer already sees, unchanged. */
export type Config = z.infer<typeof DefaultsFileSchema> & {
  repo: Record<string, z.infer<typeof RepoSchema>>
  tool: Record<string, z.infer<typeof RecipeSchema>>
}

/** One catalog directory -> one record, keyed by filename, in sorted order. */
async function readCatalog<T>(
  readFile: ReadFile,
  readDir: ReadDir,
  dir: string,
  name: z.ZodType<string>,
  schema: z.ZodType<T>,
): Promise<Record<string, T>>

export async function loadConfig(
  readFile: ReadFile = (path) => fsReadFile(path, 'utf8'),
  path: string = configPath(),
  defaults: string = defaultsPath(),
  readDir: ReadDir = (dir) => fsReaddir(dir),
): Promise<Config> {
  const dir = dirname(defaults)
  const base = {
    ...(await readYaml(readFile, defaults, DefaultsFileSchema)),
    repo: await readCatalog(readFile, readDir, join(dir, 'repo'), RepoName, RepoSchema),
    tool: await readCatalog(readFile, readDir, join(dir, 'tool'), RepoName, RecipeSchema),
  }
  // ...user overlay and mergeConfig(base, user) exactly as today
}
```

`readCatalog` is the whole of the new logic: list, filter and sort by name,
parse each file through the existing `readYaml`, and validate each derived key.
Both catalogs use the same name schema — today's `RepoName`, which a rename to
something section-neutral (`EntryName`) would describe better.

Each file is parsed through the existing `readYaml` helper, which already
formats `CONFIG_INVALID` as `Invalid config ${path}: ${detail}` — so per-file
error messages name the offending file with no new code.

Cross-reference validation is untouched: `recipeIndex(config.tool, {repos:
config.repo})` still runs at all three call sites, so a `repo: mozilla` with no
`repo/mozilla.yaml` remains `CONFIG_INVALID` at load.

## Migration

Move three recipes and one repo out of `defaults.yaml` into four new files.
**Comments travel with their entry** — google-chrome's purge rationale and
mozilla's pin warning are the most valuable bytes in that data. The shared prose
above `tool:` becomes `config/tool/README.md`, with a one-line pointer left in
`defaults.yaml`.

`defaults.yaml`'s header comment, rewritten today to state the ordering
convention, needs updating: "entries inside a section are alphabetical" now
describes filenames in the catalog directories.

Prose naming `config/defaults.yaml` as the home of recipes has to follow:
`CLAUDE.md` (the config sentence, including the ordering clause added today),
`docs/architecture.md`, `docs/commands.md`, and the three command `description`
strings listed above. Statements about *profiles* living in `defaults.yaml`
stay true and must not be "corrected".

## Verification

1. **Data is unchanged.** Dump the loaded `Config` with every object key
   deep-sorted, before and after; the diff must be **empty**. (Sorted filenames
   reproduce today's `agent-browser, firefox, google-chrome` order exactly.)
2. New cases in `test/core/config.test.ts`, with a fake `readDir` beside the
   existing fake `readFile`:
   - filename failing the name regex → `CONFIG_INVALID` naming the file
   - missing directory (`ENOENT`) → `{}`
   - a `.yml` or otherwise unexpected file → `CONFIG_INVALID`; `README.md` ignored
   - `defaults.yaml` still declaring `tool:` → `CONFIG_INVALID`
   - **fake returns filenames in reverse order → keys still come out sorted**
     (proves order does not depend on the filesystem)
3. `pnpm typecheck`, `pnpm test`.
4. Real CLI: `ops profile show dev`, `ops bootstrap dev --dry-run --json`,
   `ops tool install firefox --dry-run`.
5. **Packaging.** Confirm `pnpm deploy` + `oclif pack tarballs` puts
   `config/tool/*.yaml` and `config/repo/*.yaml` in the tarball, by extracting
   it and looking. This is the only failure that local tests cannot catch and
   that would appear first in a release.

## Rejected alternatives

**Static manifest** (`catalog: [firefox, …]` in `defaults.yaml`, or a constant in
TypeScript). Keeps core's I/O surface unchanged, but contradicts the whole point:
adding a tool would touch two files, and omitting the manifest line leaves the
recipe inert — a silent failure, which is what decisions 4 and 5 exist to avoid.
A TypeScript constant would additionally violate the project rule that default
data lives in `config/`, not in code.

**Co-locating the repo inside the tool file** (`tool/firefox.yaml` carrying
`repo.mozilla` too). Tempting because it makes every tool exactly one file. It
breaks on repositories serving several tools — real and coming (`hashicorp` for
terraform, vault and packer) — which would then be declared in several files at
once, needing a duplicate-reconciliation rule and tests for it. A separate
`config/repo/` gives each shared repo one home and reuses the cross-reference
check that already exists.

**Splitting all five sections** into `config/defaults/{mise,package,repo,tool,profile}.yaml`.
Symmetric, but it splits things that do not grow, adds indirection for `mise`
(7 lines) and `package` (21), and would put `profile`'s tested key order at the
mercy of a directory listing.

**Splitting the user config** into `~/.config/ops/tool/*.yaml`. The user config
is small by nature — it holds overrides, not a catalog — and the planned
`ops config edit` / `ops config path` assume a single file. The loader shape
here does not preclude adding it later.

## Risks

- **Packaging breaks silently in a release.** `files: ["bin","config","dist"]`
  should cover subdirectories, but if it did not, ops would ship with an empty
  catalog and no error. Mitigated by verification step 5; this is the one check
  that must not be skipped.
- **A missing directory is indistinguishable from an empty one.** Decision 6
  trades a crash for robustness, which means a packaging failure that removes
  `config/tool/` presents as "no recipes" rather than as an error. Accepted
  because the legitimate empty case must work, and step 5 guards the other.
- **A new repo still costs two files.** For a tool needing a repository nobody
  has configured yet, the promise is "two files", not one. Judged worth it
  against the duplicate-repo problem it avoids.
- **Prose drifts from data.** Shared recipe documentation now lives in
  `config/tool/README.md`, away from `src/core/config.ts` where the schema is.

## Out of scope

- `ops tool list` (sorted order is prepared for it, not implemented here).
- Plugin-provided catalog directories (v0.6).
- `.yml` as an alternative extension; nested subdirectories in a catalog dir.
- Splitting `profile`, `package` or `mise`.
- Any change to `mergeConfig`, to the user-config contract, or to any schema
  describing an individual entry.
