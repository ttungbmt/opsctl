export type OpsErrorCode =
  | 'UNSUPPORTED_PLATFORM'
  | 'INVALID_PACKAGE_NAME'
  | 'CONFIRMATION_REQUIRED'
  | 'SUDO_PASSWORD_REQUIRED'
  | 'MISE_BOOTSTRAP_UNAVAILABLE'
  | 'MISE_COMMAND_FAILED'
  | 'DOWNLOAD_FAILED'
  | 'DEB_INSTALL_FAILED'
  | 'CONFIG_INVALID'
  | 'SETUP_UNAVAILABLE'
  /** A privileged write or `apt-get update` while configuring a repo failed. */
  | 'REPO_SETUP_FAILED'
  /** The repo is configured but apt's candidate for the package is not served by it. */
  | 'REPO_PIN_UNSATISFIED'
  | 'UNINSTALL_UNAVAILABLE'
  | 'UNINSTALL_WOULD_REMOVE_DEPENDENTS'
  | 'MISE_CONFIG_EDIT_FAILED'

export class OpsError extends Error {
  readonly code: OpsErrorCode

  constructor(code: OpsErrorCode, message: string) {
    super(message)
    this.name = 'OpsError'
    this.code = code
  }
}

/**
 * A binary is missing from PATH. Thrown by the executor, but declared here:
 * every layer above translates it into its own message, so it is part of the
 * shared vocabulary rather than an executor detail.
 */
export class CommandNotFoundError extends Error {
  readonly command: string

  constructor(command: string) {
    super(`Command not found: ${command}`)
    this.name = 'CommandNotFoundError'
    this.command = command
  }
}
