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
