# `ops tool setup` — Design

Date: 2026-09-20 · Status: implemented

Builds on [`2026-09-20-tool-recipes-design.md`](2026-09-20-tool-recipes-design.md).

## Problem

Installing a tool does not make it usable. `ops tool install agent-browser`
puts the binary on PATH through mise, and the binary can do nothing: it drives a
browser it has not downloaded yet.

```
$ agent-browser open https://example.com
Chrome not installed. Run: agent-browser install
```

`agent-browser install --with-deps` fetches Chrome for Testing plus the system
libraries it needs. That second command is exactly the kind of knowledge ops
exists to absorb, and CLAUDE.md already names the split — *install makes sure a
tool exists; setup configures it* — but nothing implemented it.

The gap is not specific to this tool. `git` needs a user and a default branch,
`docker` needs a group, `mise` needs a shell hook. What they share is shape: a
thing to check, and a command to run when the check fails.

## Decision

A **setup step** is recipe data, extending `tool.<name>` rather than introducing
a second concept:

```yaml
tool:
  agent-browser:
    summary: Browser automation CLI for AI agents
    package: mise:agent-browser
    setup:
      - name: browser binaries
        check: [agent-browser, doctor, --quick, --offline]
        run: [agent-browser, install, --with-deps]
```

Adding setup for the next tool is a YAML entry, not a TypeScript file — the same
"defaults as data" rule the recipes spec follows.

### `check` is required

Every step must carry a probe, and `check` doubles as the verify step: it
decides whether `run` is needed, and it is re-run afterwards to confirm the step
took. That buys idempotency by construction — a satisfied step is never run
again — and makes `--dry-run` report real state rather than a guess.

The cost is a rule the schema cannot enforce: **a check must fail only for what
its `run` repairs.** A probe broader than its remedy turns into a step that runs
on every invocation and always fails. This is the recipe author's job, and the
reason `agent-browser`'s check is `doctor --quick --offline` rather than plain
`doctor`: the narrower probe skips the live headless launch and the network
reachability tests, neither of which `install` can fix.

Measured against agent-browser 0.38.1, the narrowed probe lines up exactly with
what its `run` repairs:

| State | `chrome.installed` | exit | Step |
|---|---|---|---|
| no Chrome on the machine | `fail` | 1 | pending, so `install --with-deps` runs |
| Chrome present (downloaded or a system one) | `pass` | 0 | already configured |
| ffmpeg absent | `warn` | 0 | not a failure; `install` does not provide it |

That last row is the case the rule exists to catch: `doctor` grades ffmpeg,
encryption keys and daemons too, and it grades them as warnings, which its
documented exit codes (`0` all pass, warnings OK; `1` at least one failed) keep
out of the check.

`check` takes no escape hatch. An argv array cannot compare stdout, pipe, negate
or expand `~`; the object form `check: {run: [...]}` is the reserved extension
point if one is ever needed.

### Alternatives considered

- **A `ToolProvider` per tool in TypeScript** (the shape `docs/cheatsheet.md`
  §34 sketches). Rejected for now: every new tool would mean a code change, a
  build and a release, and the one tool that motivated the work needs no logic
  at all. The registry still slots in ahead of the recipe lookup when a tool
  genuinely needs code.
- **`--setup` on `tool install`.** Rejected: it erases the install/setup line on
  the same day the verb appears. A separate command keeps `ops tool install`
  answering one question.
- **Optional `check`.** Rejected: a step without a probe runs every time and can
  report only "the command exited 0", which is not the same as "the machine is
  now in the desired state".

## Flow

1. Validate every name, and prove every name has steps, before touching the
   machine. An unknown tool and a recipe without `setup` both raise
   `SETUP_UNAVAILABLE`, with different messages.
2. **Inspect:** run every step's `check`.
3. **Compare:** the steps whose check failed are pending.
4. **Gate:** pending steps with neither `--yes` nor a terminal to print to
   raise `CONFIRMATION_REQUIRED`.
5. **Plan:** print the pending steps and the exact argv, always — including
   under `--yes`, so no command is ever applied unseen.
6. **Apply:** run each pending step in order.
7. **Verify:** re-run the step's `check`. Still failing is a failure, with a
   message distinct from "the command itself exited non-zero".

A failed step stops the rest of that tool (the remaining steps report `skipped`,
since they may have depended on it) and the next tool still runs.

Checks are all evaluated up front, before the first `run`. A step made
redundant by an earlier step in the same invocation therefore still runs; the
alternative — re-probing immediately before each apply — costs a subprocess per
step to fix a case no shipped recipe has.

## Shape of the code

| File | Responsibility |
|---|---|
| `src/commands/tool/setup.ts` | oclif wiring; renders the plan and the result |
| `src/core/tool/setup.ts` | `setupTools`: the whole flow above, no oclif, no execa |
| `src/core/tool/recipe.ts` | `SetupStep`, `RecipeIndex.setupFor` |
| `src/core/config.ts` | `SetupStepSchema` on the recipe |
| `src/core/output.ts` | `renderSetupPlan`, `renderSetupResult` |

`SetupDeps` takes the existing `Runner` port rather than a new one, so
`test/helpers/fake-runner.ts` covers the check → run → check sequence without a
bespoke fake. The core imports `Runner` as a type only and keeps no runtime edge
to execa; `CommandNotFoundError` moved from `src/executor/exec.ts` to
`src/core/errors.ts` to keep it that way, which is also where it belonged —
every layer above translates it into its own message.

Two supporting changes fall out:

- `RunOptions` gained `timeout`, which `docs/cheatsheet.md` §35 already required
  and the executor did not have. Checks run with 120 s; a probe that blocks
  would otherwise hang `ops` for good.
- `renderInstallResult` computed its column width with `Math.max(...[])`, which
  is `-Infinity` for an empty list. Latent there, reachable here.

### Not detecting whether the tool is installed

Setup does not probe for the tool first. `mise ls -g --json` sees only mise
tools, and a recipe's package may come from apt, so any up-front check would be
both a layering detour and wrong half the time. Instead the missing binary
surfaces where it actually bites — the `check` throws `CommandNotFoundError` —
and becomes:

```
✗ agent-browser  browser binaries  failed: agent-browser not found on PATH; run `ops tool install agent-browser` first
```

## Safety

A step runs an arbitrary command from a file the user can write, which is a
wider surface than the recipes spec's `https:`-only `.deb`:

- **The plan is always printed** before the first step runs, `--yes` included.
- `--json` or a non-terminal requires `--yes`, so nothing is applied where
  nobody could have read the plan.
- **No `env`, no `cwd`.** A config-supplied `PATH` in front of a step that runs
  `sudo` is a privilege-escalation surface, and an `env` block invites secrets
  into a file that gets printed. `RecipeSchema` is loose, so both remain
  addable later.
- A step is a **strict** object although the recipe around it is loose: a
  misspelled `chekc:` must fail loudly, not be silently kept.
- `run` inherits stdin unless `--non-interactive`, so a step's own sudo prompt
  works; under `--non-interactive` it is ignored, turning a silent hang into a
  fast failure. Checks always ignore stdin.

**`--dry-run` is not side-effect-free.** It executes every `check`, which is a
subprocess named by config. A check that changes something is a broken check,
but ops cannot know that — the guarantee is that `run` is never invoked.

## Out of scope

`ops tool doctor|status|list|update|remove`; `tool install --setup`; a
`ToolProvider` registry; `env`, `cwd` and `~` expansion in steps; comparing a
check's stdout; per-step `sudo` declaration; setup recipes for tools other than
`agent-browser`.
