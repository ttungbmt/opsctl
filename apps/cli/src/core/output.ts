import type {OnProgress} from '../providers/deb.js'
import {type Style, plainStyle} from './style.js'
import type {InstallResult, PackageStatus} from './package/install.js'
import type {SetupResult, SetupStatus, SetupStepResult} from './tool/setup.js'
import type {PurgeStatus, UninstallPlan, UninstallResult, UninstallStatus} from './package/uninstall.js'

type Paint = keyof Style

const LABELS: Record<PackageStatus, [symbol: string, text: string, paint: Paint]> = {
  'already-installed': ['✓', 'already installed', 'ok'],
  failed: ['✗', 'failed', 'fail'],
  installed: ['+', 'installed', 'add'],
  'would-install': ['~', 'would install', 'warn'],
}

/** Longest string in the column, or 0 for an empty list (Math.max of nothing is -Infinity). */
function column(values: string[]): number {
  return values.length === 0 ? 0 : Math.max(...values.map((v) => v.length))
}

export function renderInstallResult(result: InstallResult, style: Style = plainStyle): string[] {
  const width = column(result.packages.map((p) => p.spec))
  const lines = [`${style.heading('Installed with:')} ${result.managers.join(', ')}`]

  for (const p of result.packages) {
    const [symbol, text, paint] = LABELS[p.status]
    // Pad before painting: escape codes count towards .length and would skew the columns.
    const detail = style.muted(`${text}${p.version ? ` (${p.version})` : ''}`)
    lines.push(`${style[paint](symbol)} ${p.spec.padEnd(width)}  ${detail}`)
  }

  if (result.commands && result.commands.length > 0) {
    lines.push('', style.heading('Would run:'), ...result.commands.map((c) => style.muted(`  ${c}`)))
  }

  return lines
}

const SETUP_LABELS: Record<SetupStatus, [symbol: string, text: string, paint: Paint]> = {
  'already-configured': ['✓', 'already configured', 'ok'],
  configured: ['+', 'configured', 'add'],
  failed: ['✗', 'failed', 'fail'],
  skipped: ['·', 'skipped', 'muted'],
  'would-configure': ['~', 'would configure', 'warn'],
}

export function renderSetupResult(result: SetupResult, style: Style = plainStyle): string[] {
  const tool = column(result.steps.map((s) => s.tool))
  const step = column(result.steps.map((s) => s.step))

  const lines = result.steps.map((s) => {
    const [symbol, text, paint] = SETUP_LABELS[s.status]
    const detail = `${text}${s.error ? `: ${s.error}` : ''}`
    // Pad before painting: escape codes count towards .length and would skew the columns.
    const row = `${style[paint](symbol)} ${s.tool.padEnd(tool)}  ${s.step.padEnd(step)}  `
    return row + (s.error ? style.fail(detail) : style.muted(detail))
  })

  const commands = result.steps.map((s) => s.command).filter((c) => c !== undefined)
  if (commands.length > 0) lines.push('', style.heading('Would run:'), ...commands.map((c) => style.muted(`  ${c}`)))

  return lines
}

/** Shown before the first step runs, so a command is never applied unseen. */
export function renderSetupPlan(pending: SetupStepResult[], style: Style = plainStyle): string[] {
  const tool = column(pending.map((s) => s.tool))
  const step = column(pending.map((s) => s.step))

  const rows = pending.map((s) => `  ${s.tool.padEnd(tool)}  ${s.step.padEnd(step)}  ${style.muted(s.command ?? '')}`)
  return [style.heading('Plan:'), ...rows, '']
}

const UNINSTALL_LABELS: Record<UninstallStatus, [symbol: string, text: string, paint: Paint]> = {
  'already-absent': ['·', 'not installed', 'muted'],
  failed: ['✗', 'failed', 'fail'],
  skipped: ['·', 'skipped', 'muted'],
  uninstalled: ['-', 'uninstalled', 'add'],
  'would-uninstall': ['~', 'would uninstall', 'warn'],
}

const PURGE_LABELS: Record<PurgeStatus, [symbol: string, text: string, paint: Paint]> = {
  'already-absent': ['·', 'absent', 'muted'],
  failed: ['✗', 'failed', 'fail'],
  removed: ['-', 'removed', 'add'],
  skipped: ['·', 'skipped', 'muted'],
  'would-remove': ['~', 'would remove', 'warn'],
}

export function renderUninstallResult(result: UninstallResult, style: Style = plainStyle): string[] {
  const width = column(result.packages.map((p) => p.spec))
  const lines = [`${style.heading('Removed with:')} ${result.managers.join(', ')}`]

  for (const p of result.packages) {
    const [symbol, text, paint] = UNINSTALL_LABELS[p.status]
    const detail = `${text}${p.version ? ` (${p.version})` : ''}${p.error ? `: ${p.error}` : ''}`
    // Pad before painting: escape codes count towards .length and would skew the columns.
    const row = `${style[paint](symbol)} ${p.spec.padEnd(width)}  `
    lines.push(row + (p.error ? style.fail(detail) : style.muted(detail)))
  }

  if (result.paths && result.paths.length > 0) {
    const pathWidth = column(result.paths.map((p) => p.path))
    lines.push('', style.heading('Purged:'))
    for (const p of result.paths) {
      const [symbol, text, paint] = PURGE_LABELS[p.status]
      const detail = `${text}${p.error ? `: ${p.error}` : ''}${p.privileged ? ' (sudo)' : ''}`
      const row = `${style[paint](symbol)} ${p.path.padEnd(pathWidth)}  `
      lines.push(row + (p.error ? style.fail(detail) : style.muted(detail)))
    }
  }

  if (result.commands && result.commands.length > 0) {
    lines.push('', style.heading('Would run:'), ...result.commands.map((c) => style.muted(`  ${c}`)))
  }

  return lines
}

/** Shown before the first removal, so nothing is deleted unseen. */
export function renderUninstallPlan(plan: UninstallPlan, style: Style = plainStyle): string[] {
  const rows = [
    ...plan.packages.map((p) => `  ${p.spec}`),
    ...plan.paths.map((p) => `  ${p.path}${p.privileged ? style.muted('  (sudo)') : ''}`),
  ]
  return [style.heading('Plan:'), ...rows, '']
}

const MIB = 1024 * 1024
/** Minimum gap between progress lines; the final one is always emitted. */
const PROGRESS_INTERVAL_MS = 200

function mib(bytes: number): string {
  return `${(bytes / MIB).toFixed(1)} MiB`
}

/**
 * A throttled progress reporter. Stateful (start time, last write), so it is a factory
 * rather than a pure render function; `now` is injected so tests need no real clock.
 */
export function downloadProgress(write: (line: string) => void, now: () => number = Date.now): OnProgress {
  const started = now()
  let last = 0

  return (done, total) => {
    const at = now()
    const finished = total !== undefined && done >= total
    if (!finished && at - last < PROGRESS_INTERVAL_MS) return
    last = at

    const seconds = (at - started) / 1000
    const speed = seconds > 0 ? `  ${(done / MIB / seconds).toFixed(1)} MB/s` : ''
    const size = total === undefined ? mib(done) : `${mib(done)} / ${mib(total)}`
    const percent = total === undefined ? '' : `${String(Math.floor((done / total) * 100)).padStart(3)}%  `

    write(`${percent}${size}${speed}`)
  }
}
