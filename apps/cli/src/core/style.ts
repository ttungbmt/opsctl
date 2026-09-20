import ansis from 'ansis'

/**
 * How rendered output is emphasised. Injected rather than baked in, so the render
 * functions stay plain strings for tests and for a future Ink UI that styles its own way.
 */
export interface Style {
  /** Already in the desired state. */
  ok(s: string): string
  /** Changed to reach the desired state. */
  add(s: string): string
  /** Planned but not done (dry run). */
  warn(s: string): string
  fail(s: string): string
  /** Secondary detail: versions, status words, commands, skipped steps. */
  muted(s: string): string
  heading(s: string): string
}

const identity = (s: string) => s

/** The default: no escape codes, so output stays comparable in tests and pipes. */
export const plainStyle: Style = {
  add: identity,
  fail: identity,
  heading: identity,
  muted: identity,
  ok: identity,
  warn: identity,
}

export const ansiStyle: Style = {
  add: (s) => ansis.green(s),
  fail: (s) => ansis.red(s),
  heading: (s) => ansis.bold(s),
  muted: (s) => ansis.dim(s),
  ok: (s) => ansis.green(s),
  warn: (s) => ansis.yellow(s),
}

/** ansis already honours NO_COLOR, FORCE_COLOR and whether stdout is a TTY. */
export function styleFor(json: boolean): Style {
  return json || !ansis.isSupported() ? plainStyle : ansiStyle
}
