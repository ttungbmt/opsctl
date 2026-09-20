/**
 * A third-party apt repository (`repo.<name>` in the config), referenced by name from a
 * recipe's `repo`. It lives here rather than beside PrepareStep because a repository is
 * not a *tool* concept: several tools can share one, and it configures a package manager
 * rather than installing anything itself.
 */
export interface AptRepo {
  /** The config key. Becomes the filename stem of every file ops writes for this repo. */
  name: string
  /** Base URL of the repository (deb822 `URIs`). */
  uri: string
  /** deb822 `Suites`, e.g. "mozilla". */
  suite: string
  /** deb822 `Components`, e.g. ["main"]. */
  components: string[]
  /** URL of the repository's OpenPGP signing key; its local path becomes `Signed-By`. */
  keyring: string
  /**
   * apt pin, so this repo beats the distro's own package of the same name. `origin` is the
   * site hostname (apt's `Pin: origin <host>`), not the Release file's `Origin:` field --
   * some repositories publish an unusable Origin, so matching the host is what works.
   */
  pin?: {origin: string; priority: number}
}

/** A repo as the config carries it: `name` is the record key, injected when indexed. */
export type RepoConfig = Omit<AptRepo, 'name'>
