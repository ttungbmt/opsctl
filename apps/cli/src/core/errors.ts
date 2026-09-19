export type OpsErrorCode =
  | 'UNSUPPORTED_PLATFORM'
  | 'INVALID_PACKAGE_NAME'
  | 'CONFIRMATION_REQUIRED'
  | 'SUDO_PASSWORD_REQUIRED'
  | 'MISE_BOOTSTRAP_UNAVAILABLE'
  | 'MISE_COMMAND_FAILED'

export class OpsError extends Error {
  readonly code: OpsErrorCode

  constructor(code: OpsErrorCode, message: string) {
    super(message)
    this.name = 'OpsError'
    this.code = code
  }
}
