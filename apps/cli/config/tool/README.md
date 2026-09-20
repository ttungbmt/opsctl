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
