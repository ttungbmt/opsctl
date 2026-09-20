# One command surface: `ops tool` — Design

Date: 2026-09-20 · Status: implemented

Supersedes the command name in [`2026-09-19-package-install-design.md`](2026-09-19-package-install-design.md).

## Problem

The planned command model exposed two groups, `ops package …` and `ops tool …`.
That forced the user to answer a question which belongs to the CLI's internals:

```
ops ??? install node     # tool or package?
ops ??? install git      # a tool... installed by apt?
ops ??? install unzip    # package. Probably?
```

`tool` vs `package` is an **internal layering boundary** — `ToolProvider`
(detect/install/setup/update/doctor) sits on top of `PackageManager`
(search/install/remove/update), per `docs/cheatsheet.md` §34. The boundary is
correct and stays. Publishing it as two command groups was the mistake.

The repo already had a rule against exactly this leak: **"Feature != provider —
public commands name the capability, not the tool behind it"** (`ops youtube
audio`, not `ops ytdlp audio`). Splitting `tool`/`package` leaks the *layer*
instead of the *provider*, but it is the same error.

## Decision

**One public noun: `tool`. No `ops package` command group.**

```bash
ops tool install node              # → mise (registry has node)
ops tool install build-essential   # → apt/dnf
ops tool install apt:git           # escape hatch: force a provider
```

| | Before | After |
|---|---|---|
| Public CLI | `ops package …` + `ops tool …` | **`ops tool …` only** |
| Layers in `src/` | package layer | **unchanged** |
| Rule "Tool != package" | architecture rule | **kept**, clarified as internal-only |

`ops package install` is **removed outright** — no alias, no deprecation shim.
The repo is early-scaffolding v0.x with no compatibility promise, and oclif
already suggests the nearest command on a typo. Breaking change; note it in the
release notes.

### Resolution

Unchanged, in `apps/cli/src/core/package/resolve.ts`:

1. `manager:name` → used as given.
2. Plain name on the system-preferred list (`package.system`) → `apt:`/`dnf:`.
3. Plain name in the mise registry → `mise:`.
4. Otherwise → `apt:`/`dnf:`.

### Config

`package.system` keeps its name. It configures *which layer a name routes to*,
so "package" is accurate there rather than a leak, and it is an opt-in advanced
knob — not a choice forced at the point of use.

## Scope of the change

Almost entirely the command layer plus docs.

- `src/commands/package/install.ts` → `src/commands/tool/install.ts`; class
  `PackageInstall` → `ToolInstall`; summary, description, examples and the
  `tools` arg reworded to lead with the capability, not the provider.
- Two user-visible strings: `'No packages given'` → `'No tools given'`;
  `Package manager: …` → `Installed with: …`.
- `pnpm build` now clears `dist` first — `tsc` leaves stale output behind, which
  would have kept a removed command reachable.

**Deliberately unchanged:** `src/core/package/*` (it *is* the package layer, and
`tool install` calling down into it is the intended layering), `OpsErrorCode`
values including `INVALID_PACKAGE_NAME`, and the `InstallResult` JSON shape —
those are the machine-readable contract.

No `src/core/tool/` yet (YAGNI). When a `ToolProvider` registry arrives in v0.2,
it slots in ahead of `resolveSpecs` and that is the moment to extract it.

## Out of scope

`ToolProvider` registry; `ops tool setup|doctor|status|list|update|remove`;
renaming the config key. All v0.2 per `docs/roadmap.md`.
