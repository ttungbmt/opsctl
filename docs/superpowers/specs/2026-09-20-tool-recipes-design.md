# Tool recipes — Design

Date: 2026-09-20 · Status: implemented

Builds on [`2026-09-20-tool-command-surface-design.md`](2026-09-20-tool-command-surface-design.md).

## Problem

`ops tool install` assumes the package is already reachable from a configured
repository. Chrome is the first tool where that is false, and it breaks in a way
that is invisible on a developer's own machine:

| | |
|---|---|
| `google-chrome` in the mise registry | no (only `chromedriver`) |
| `google-chrome` is an apt package name | no — the package is `google-chrome-stable` |
| `google-chrome-stable` installable | only because `/etc/apt/sources.list.d/google-chrome.sources` exists |

That `.sources` file is written by the Chrome `.deb`'s own `postinst`, so a
machine that has Chrome can install Chrome and a machine that does not, cannot.
`ops tool install google-chrome` today falls through resolution to
`apt:google-chrome` and apt reports no such package.

`mise bootstrap` cannot cover this: it accepts only `manager:package[@version]`
and has Homebrew taps but no third-party apt repository mechanism.

## Decision

A **tool recipe** is config data, not code — per the repo's "defaults as data"
rule:

```yaml
tool:
  google-chrome:
    summary: Google Chrome
    package: apt:google-chrome-stable
    prepare:
      deb: https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
```

Installing Google's `.deb` directly is Google's documented path, and its
`postinst` configures the apt repository for later updates. ops therefore never
manages keyrings or `sources.list.d` itself.

Adding VS Code or Zoom later is a YAML entry, not a TypeScript file.

### Resolution order

An explicit prefix always wins; a recipe beats every heuristic because it knows
the real package name.

1. `manager:name` → as given
2. **recipe** → `recipe.package`
3. `package.system` → `apt:`/`dnf:`
4. mise registry → `mise:`
5. otherwise → `apt:`/`dnf:`

### Where prepare runs

`installSystem` splits the missing specs:

- **has `prepare`** → download and install the `.deb`, then `mise.declare` to
  record desired state, then re-check status to verify.
- **no `prepare`** → `mise.apply`, unchanged.

Already-installed tools skip `prepare` entirely, keeping the operation
idempotent (inspect → compare → plan → apply → verify).

### Shape of the code

`resolveSpecs` keeps returning `PackageSpec[]`. Recipes are indexed twice from
one config source (`src/core/tool/recipe.ts`): by name for resolution, and by
resolved spec for the prepare lookup. This avoids threading a richer return type
through the whole pipeline for one optional field.

`src/providers/deb.ts` is the only new provider — it alone knows `apt-get` and
HTTP, per the layering rule.

## Safety

Downloading a `.deb` and installing it with sudo is a privileged action on
attacker-influenceable input (a user's `~/.config/ops/config.yaml` can define
recipes), so:

- **`https:` only.** Any other scheme is rejected before any I/O.
- The URL is printed before it is used, and `--dry-run` shows it without
  downloading anything.
- The existing confirmation gate applies — it is a system spec, so `--yes` or a
  TTY is required.
- The download goes to a fresh temp file, which is removed in a `finally`.

**Accepted risk: no checksum.** Google publishes no stable hash for the
`_current_` artifact, so the guarantee is HTTPS plus a pinned host. A recipe
pointing somewhere else is as trusted as the config file it came from.

## Out of scope

A full `ToolProvider` registry; `ops tool setup|doctor|status|list|remove`;
general apt repository/keyring management; recipes for tools other than Chrome;
`dnf`/`brew` prepare steps (the schema leaves room, nothing implements them).
