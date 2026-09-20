# Vendor apt repositories — Design

Date: 2026-09-20 · Status: implemented

Builds on [`2026-09-20-tool-recipes-design.md`](2026-09-20-tool-recipes-design.md).

## Problem

A recipe's `prepare.deb` assumes the vendor publishes a standalone `.deb` whose
`postinst` wires up its own apt repository. Firefox is the first tool where that
is false, and the cheapest-looking option is the dangerous one:

| | |
|---|---|
| `firefox` in the mise registry | no — `mise registry firefox` reports "tool not found" |
| Mozilla publishes a standalone `.deb` | no — only an apt repo, or a `.tar.xz` |
| `apt:firefox` installs Firefox | no — on Ubuntu 24.04 the candidate is `1:1snap1-0ubuntu5` |

That candidate is a 121 KB transitional package: `Pre-Depends: snapd`,
`Description: Transitional package - firefox -> firefox snap`. It is worse than
installing the wrong thing, because **it makes verification lie**. `installSystem`
judges success by whether `mise bootstrap packages status --json` reports the spec
installed, and the shim reports `state: installed` exactly as a real build would.
`ops` would print `apt:firefox installed (1:1snap1-0ubuntu5)` and exit 0 while the
browser arrived as a snap, or not at all — breaking the inspect → compare → plan →
apply → **verify** rule (`docs/cheatsheet.md` §36).

`prepare.deb` cannot reach Mozilla's build, and neither can the registry fallback.
This is the capability the recipes spec deferred: *"ops therefore never manages
keyrings or `sources.list.d` itself."* Firefox is the tool that forces the answer,
and the answer generalises — VS Code, Docker, Tailscale and Signal all ship this
way.

## Decision

A **repo** is config data, like a recipe, and lives in its own top-level section so
several tools can share one:

```yaml
repo:
  mozilla:
    uri: https://packages.mozilla.org/apt
    suite: mozilla
    components: [main]
    keyring: https://packages.mozilla.org/apt/repo-signing-key.gpg
    pin:
      origin: packages.mozilla.org
      priority: 1000

tool:
  firefox:
    summary: Mozilla Firefox
    package: apt:firefox
    repo: mozilla
```

`prepare` and `repo` are **different concepts that are easy to conflate**, so they
stay separate keys and a recipe may carry only one:

- **`prepare`** installs outside the package manager and is self-terminating. The
  spec never reaches `mise.apply`.
- **`repo`** only makes the package reachable. The spec *does* continue to
  `mise.apply`, and apt performs the install.

Turning `prepare` into a `{deb} | {apt_repo}` union was rejected: it would give one
key two opposite control flows, and would duplicate the repo definition for every
tool that shares it.

### Where a repo is configured

`installSystem`, per missing spec:

- **has `prepare`** → install the `.deb`; unchanged.
- **has `repo`** → configure the repo, then push the spec to `mise.apply`.
- **neither** → `mise.apply`, unchanged.

### Pinning, and why it is hostname-based

Ubuntu's own `firefox` has priority 500, so Mozilla's repo needs a higher pin to
win. The pin matches the **site hostname** (apt's `Pin: origin <host>`), not the
Release file's `Origin:` field, because this repository's is an internal path:

```
Origin: namespaces/moz-fx-productdelivery-pr-38b5/repositories/mozilla
```

Rewriting the pin as `Pin: release o=…` therefore breaks it. The config carries a
comment saying so.

### Files ops owns

For `repo.<name>`, all mode 0644, each rendered from config and marked as managed:

```
/etc/apt/keyrings/ops-<name>.asc
/etc/apt/sources.list.d/ops-<name>.sources   (deb822)
/etc/apt/preferences.d/ops-<name>.pref       (omitted when the config has no pin)
```

`Architectures:` is deliberately absent, so apt uses `APT::Architectures` (host arch
plus `all`) — matching Mozilla's own instructions.

### Idempotency

"Already configured" means both rendered stanzas are byte-identical to what ops
would write now, and the keyring exists. All three are world-readable, so the
comparison needs no privileges.

`apt-get update` is skipped when nothing was written, but that skip is **proven**
rather than assumed: if the files match yet apt's candidate is not served by the
repo (someone ran `apt-get clean`, or the lists were never fetched), `ensure` runs
`apt-get update` once and re-checks. The whole inspect → compare → plan → apply →
verify loop lives in one method, which also avoids having to guess the mangled
`/var/lib/apt/lists/…_InRelease` filename.

The keyring is checked for presence only, not content. Fetching it to compare would
make the idempotent path depend on the network, and a CDN re-serialising the armour
would churn the file and re-trigger `apt-get update` on every run. The cost is that
a rotated key is not picked up; deleting the file refreshes it.

### Verification, in two places

The point of this design is that success cannot be claimed falsely, so apt's own
resolution is checked with `apt-cache policy <pkg>` (read-only, unprivileged, run
under `LC_ALL=C` because the field names are localised):

- **On the install path**, `ensure` verifies **the candidate** before `mise.apply` —
  "will apt install the right thing?". A candidate not served by the pinned origin
  throws `REPO_PIN_UNSATISFIED` and nothing is installed. It must be the candidate,
  not the installed version: `--force` replaces a wrong-origin build, and an
  installed-first check there would reject the very case it is being asked to fix.
- **On the already-installed path**, `verify` asks the other question — "is the right
  thing on this machine?" — and so judges **the installed version**, falling back to
  the candidate when nothing is installed. A package installed from the wrong origin
  (the Ubuntu shim on a machine that already had it) reports `failed` with an
  actionable message instead of `already-installed`, and `--force` treats it as
  missing so apt can switch it to Mozilla's build.

Judging the candidate in both places was the original mistake, and it fails in exactly
the case the design exists for: once the repo is configured, a machine still holding
the shim reports `Installed: 1:1snap1-0ubuntu5` but `Candidate: 156.0~build1`, so a
candidate-based check calls it healthy.

`apt-cache madison` was rejected: it is format-stable but knows nothing about pin
priority, so it cannot prove the pin took effect. `apt-get -s install` was rejected:
it is localised *and* labels the origin from the unusable `Origin:` field.

Parsing `apt-cache policy` has one trap worth naming, because it cost a release: apt
**right-aligns the priority in an 11-wide column**, so the indent shrinks as the number
grows — `500` gets eight spaces, `1000` gets seven. A pin that beats the distro archive
is four digits by definition, so an eight-space assumption breaks every pinned repo
while looking fine on unpinned ones. Fixtures for this parser must be captured from a
real machine, never retyped.

### Shape of the code

`AptRepo` lives in `src/core/repo.ts` rather than beside `PrepareStep`, because a
repository is not a *tool* concept and `recipe.ts` already carries the purge-path
rules.

`src/providers/apt-repo.ts` is the only new provider — it alone knows `apt-get`,
`apt-cache` and `/etc/apt`, per the layering rule. It exposes `ensure`, the
read-only `policy`, and a synchronous `describe` for `--dry-run`, plus pure helpers
(`sourcesStanza`, `pinStanza`, `parsePolicy`, `servedBy`) that are unit-tested
without any I/O.

`recipeIndex` gains repo lookup and four eager cross-reference checks, so a bad
config fails at load rather than halfway through a privileged install:

1. `prepare` and `repo` on one recipe.
2. `repo:` naming a repo that is not defined.
3. A defined repo that no recipe references. This is what closes the `looseObject`
   trap: `RecipeSchema` keeps unknown keys, so `repoo: mozilla` would validate
   silently and no verification would run — but the repo it meant to reference is
   then unreferenced, which trips this check.
4. Two recipes claiming the same resolved spec, which also fixes an existing silent
   last-writer-wins collision in the `prepare` lookup.

Because `/etc/apt` writes need root and the executor takes argv arrays rather than
shell strings, there is no `… | sudo tee`. Each file is rendered to an unprivileged
temp file and placed with `sudo install -D -m 0644 -o root -g root <tmp> <dest>`,
which handles owner, group, mode and parent directory in one argv.

## Safety

Configuring an apt repository is a privileged action on attacker-influenceable
input — a user's `~/.config/ops/config.yaml` can define repos — so:

- **`https:` only**, for both `uri` and `keyring`, rejected before any I/O.
- A repo name becomes a filename under `/etc/apt`, so it is restricted to
  `[a-z0-9][a-z0-9._-]*`.
- `RepoSchema` is **strict**, unlike the recipe that references it: these fields
  drive privileged writes, so a misspelled key must fail loudly.
- `--dry-run` prints every command, including the `apt-cache policy` check, and
  writes nothing.
- The existing confirmation gate applies — it is a system spec, so `--yes` or a TTY
  is required.
- Each temp file is created mode 0600 and removed in a `finally`.
- Only `apt` is supported. A recipe with `repo` on a `dnf` host throws
  `UNSUPPORTED_PLATFORM` rather than silently doing nothing.

**Accepted risk: the keyring's fingerprint is not verified.** The guarantee is
HTTPS plus a pinned host, the same posture as `prepare.deb`. This is a deliberate
choice for consistency and to avoid maintaining fingerprints across vendor key
rotations, but it is a broader grant than a single `.deb`: a keyring combined with
`Pin-Priority: 1000` is the trust anchor for every future package from that origin,
applied silently by unattended upgrades. Adding a `fingerprint` field later is
backwards compatible — introduce it as optional, then require it.

**Requires apt ≥ 2.4** (Ubuntu 22.04+, Debian 12+), which accepts an
ASCII-armoured keyring via `Signed-By`. Mozilla's key is armoured despite its
`.gpg` extension. Older apt would need `gpg --dearmor`; that is unsupported rather
than worked around, so ops needs no gpg dependency.

### Who owns the terminal

**A spinner may only run while every subprocess is captured.** ops shows a spinner when it
has silenced a subprocess, so the two must be decided together; a spinner repainting its
row while apt writes to the same row shreds both.

Configuring a repo is captured and therefore spins. The install that follows is not: apt's
own download progress is worth more than a spinner, so `install.ts` emits a `streaming`
stage before `mise.apply` (and before `mise use`), and whoever holds the spinner stands
down. This is why `Stage` splits into `WorkStage` (something to label) and the bare
`streaming` handover (nothing to label, only a row to release).

The same rule already governed the `.deb` download's `\r` progress line, which is handed
over to the spinner rather than overwritten by it.

## Out of scope

`dnf`/`brew` repositories (rejected loudly, not implemented); `ops tool doctor`;
a user-facing `ops repo` command group — a repo is config data, and exposing it
would leak internal layering the same way naming a command after its provider
would; verifying keyring fingerprints; recipes for VS Code, Docker or Tailscale
(this capability opens the door, but each is a separate YAML entry and a separate
decision).

## Known gaps

- apt does not record which repository an installed package came from — its source is
  `/var/lib/dpkg/status`. The installed-version check therefore asks whether the repo
  *still offers* that version. A version that has aged out of the repo reads as the
  wrong origin, and ops suggests `--force`; safe, but a false alarm. `gh` on the
  author's machine is a live example: installed 2.97.0, which the repo no longer lists.
- A rotated signing key is not detected; delete `/etc/apt/keyrings/ops-<name>.asc`
  to refresh it.
- `ops` never removes a repo it configured. Uninstalling a tool leaves the repo in
  place, which is why the files are named `ops-<name>` and marked as managed.
