/**
 * What a long-running install step is doing, so a caller can label a spinner. Shared
 * vocabulary rather than a provider detail: `tool install` drives one terminal, and every
 * provider that can sit busy for seconds has to be able to say so. Output is captured
 * while a spinner runs, so a stage nobody reports looks exactly like a hang.
 */
export type WorkStage = 'downloading' | 'installing' | 'repo-key' | 'repo-files' | 'repo-update' | 'repo-check'

/**
 * A subprocess is about to write to the terminal itself, so whoever holds the spinner has
 * to let go. A spinner may only run while every subprocess is captured: otherwise both
 * repaint the same row and the output comes out shredded.
 */
export type Stage = WorkStage | 'streaming'

/** `subject` is the package spec for package work, and `repo.<name>` for repository work. */
export function stageLabel(stage: WorkStage, subject: string): string {
  switch (stage) {
    case 'downloading': {
      return `downloading ${subject}`
    }

    case 'installing': {
      return `installing ${subject}`
    }

    case 'repo-key': {
      return `fetching signing key for ${subject}`
    }

    case 'repo-files': {
      return `configuring ${subject}`
    }

    case 'repo-update': {
      return `updating package lists for ${subject}`
    }

    case 'repo-check': {
      return `checking ${subject}`
    }
  }
}
