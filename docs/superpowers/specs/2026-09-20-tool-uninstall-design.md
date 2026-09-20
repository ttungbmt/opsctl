# `ops tool uninstall` — Design

Date: 2026-09-20 · Status: implemented

Builds on [`2026-09-20-tool-recipes-design.md`](2026-09-20-tool-recipes-design.md).

## Problem

`ops tool install` had no inverse, and the gap was not merely a missing
convenience: install writes state that nothing could undo.

Every system install calls `mise.declare(specs)`, which records the package in
`[bootstrap.packages]` in mise's global config. Removing the package by hand
leaves that line behind, so the machine sits in a contradiction — the
declaration says the package must be present, the system says it is not — and
the next `ops bootstrap` reinstalls it. This was observable on a real machine
while the feature was being written:

```
$ dpkg-query -W google-chrome-stable   → no packages found
$ mise bootstrap packages status --json
  {'package': 'google-chrome-stable', 'desired_state': 'present', 'state': 'missing'}
```

`ops` had no way out of that state.

Three facts about mise 2026.9.11 shaped everything that follows:

| Need | What mise offers | Consequence |
|------|------------------|-------------|
| Remove a mise tool | `mise unuse -g <tool>` drops the request **and** prunes the install | Usable directly |
| Remove an apt package | `mise bootstrap packages prune -m apt` → `package manager 'apt' does not support pruning` | ops must run apt itself |
| Undeclare a package | no `bootstrap packages unuse`; `bootstrap packages use` has no `--remove` | ops must edit the TOML |

## Decision

`ops tool uninstall <name>` removes the package and the declaration install
wrote. `--purge` additionally deletes what no package manager owns.

The name is `uninstall`, not the `remove` two docs used to promise, because it
reads as the inverse of `install`. `ToolProvider.remove()` and
`PackageManager.remove()` keep their names: those are interface methods, not
commands.

### Removal per kind

- **mise tool** — `mise unuse -g <tool>`, with the **bare** name. `mise unuse`
  matches the configured request literally, so passing `node@latest` would miss
  a config that says `node = "lts"`. This is why the removal path uses
  `toolKey()` and never `withVersion()`.
- **apt/dnf package** — `sudo apt-get remove|purge -y -- <names>`, or
  `sudo dnf remove -y -- <names>`. rpm has no conffile concept, so on dnf
  `--purge` means "remove, then delete the purge paths".
- **anything else** — refused before any I/O, naming the command that would
  work. A half-removed brew package is worse than an honest no.

### Undeclaring by editing the TOML

`src/providers/mise-config.ts` deletes one key line from one table. No TOML
library is added: every candidate round-trips through a plain object and drops
comments, and the global config contains comments the user wrote. Deleting a
single line keeps the rest byte-identical — verified against the real file,
which lost exactly one line and kept all 8 comments.

The edit is bracketed by an independent oracle. `mise config get -g
'<table>.<key>'` exits 0 when declared and 1 when not, so `undeclare` asks
before (and skips the file entirely if there is nothing to do) and asks again
after. A wrong config path, the wrong table and a parser bug all surface as the
same loud `MISE_CONFIG_EDIT_FAILED` instead of a silent success. The parser
returns `undefined` — a no-op — rather than guessing whenever the value does not
end on its line.

Writes go through a temp file in the same directory, `fsync`ed and `rename`d, so
the original is never truncated.

### Purge as data, not commands

Purge paths live in the recipe:

```yaml
uninstall:
  purge:
    paths:
      - /etc/apt/sources.list.d/google-chrome.sources
      - ~/.config/google-chrome
```

Paths only. A config file can never run a command as root; the single privileged
operation `--purge` can emit is `sudo rm -rf -- <path>`.

Which paths belong there was settled with `dpkg -S` against a real install:

| Path | dpkg owns it | In `purge.paths` |
|------|--------------|------------------|
| `/opt/google/chrome` | yes | no — `apt-get purge` handles it |
| `/etc/cron.daily/google-chrome` (symlink) | yes | no — same |
| `/etc/apt/sources.list.d/google-chrome.sources` | **no** | yes |
| `/usr/share/keyrings/google-chrome.gpg` | **no** | yes |
| `~/.config`, `~/.cache/google-chrome` | no | yes |

The `.sources` file says so itself: *"This file will not be recreated if
removed."* Chrome's postinst writes it, dpkg does not track it, and left behind
it re-adds the repo on the next `apt update`. A listed path that does not exist
is simply absent, so a recipe can name every known variant.

Whether a path needs root is discovered by the provider (is the **parent**
directory writable?), not declared in the recipe: the recipe says what, the
provider works out how.

## Flow

Same shape as `setupTools`: inspect everything, plan, confirm, apply, verify.

1. Resolve names with `resolveSpecs`, unchanged, so `uninstall chrome` lands on
   the spec `install chrome` produced.
2. Refuse unsupported managers, before any I/O.
3. Inspect: `dpkg-query`/`rpm` for packages, `mise ls` for tools,
   `mise config get -g` for declarations, `lstat` for purge paths.
4. `--dry-run` returns here with the full command list.
5. Confirm, then print the plan.
6. Remove tools, then packages; verify each by re-probing.
7. Undeclare — **last**, so a failed removal leaves the declaration to restore
   from rather than stranding the machine half-removed.
8. Delete purge paths, re-`lstat`ing each to verify.

Before any package removal, `apt-get -s` simulates it. apt reports dependents
but does not refuse them, so ops does: anything in the `REMOVED` block that was
not requested raises `UNINSTALL_WOULD_REMOVE_DEPENDENTS` and nothing is removed.
The simulation runs without root. dnf returns "no opinion" rather than a parse
that might be wrong.

## Shape of the code

| File | Role |
|------|------|
| `src/commands/tool/uninstall.ts` | oclif, thin |
| `src/core/package/uninstall.ts` | `uninstallPackages` — the whole flow |
| `src/providers/mise-config.ts` | `removeTableKey` (pure), `createMiseDeclarations` |
| `src/providers/system.ts` | apt/dnf verbs, dpkg/rpm probes, `apt-get -s` |
| `src/providers/paths.ts` | the only `rm -rf` in the codebase |
| `src/core/tool/recipe.ts` | `expandPurgePath`, `purgeFor` |

`system.ts` is separate from `deb.ts` deliberately: `deb.ts` has a URL-shaped
surface (`installFromUrl`, `describe(url)`) and removal has no URL, no download
and must also speak dnf.

`status()` probes dpkg/rpm rather than `mise bootstrap packages status`, which
only reflects the declaration — after undeclaring, a package would vanish from
it and post-removal verification would be impossible.

## Safety

Destructive, so: inspect → plan → confirm → execute → verify, with `--dry-run`
and `--yes`.

Every mutation has an independent post-check. The dry-run's command list and the
real run share one predicate (`needsPackageRemoval`) so they cannot drift — an
early version filtered the plan on "installed" while the run also acted on
`config-files` packages, and the dry-run under-reported what would happen.

`--purge` requires `--yes` even on a terminal. It deletes files outside any
package manager, which deserves a second consent, and the CLI has no prompt
primitive yet: `installPackages` delegates prompting to mise and `onPlan` only
prints. When a prompt primitive exists, an inline confirmation would be the
natural replacement.

Purge paths are validated when the config loads, not when they are deleted, and
the rules are aimed at `rm -rf`: `~` expands (but never `~user`), the path must
be absolute, must contain no `..` **checked on the raw segments** (`normalize`
would erase the escape it is meant to catch), must be at least two directories
deep, must not be a shared root such as `~/.config`, and must contain no glob or
control character. A glob is rejected rather than handed to `rm`, which does not
expand it and would silently do nothing that looks like success.

## Out of scope

`ops tool update|status|list|doctor`; removing a tool's dependencies
(`apt autoremove`); undoing a `repo` entry; rolling an uninstall back.
