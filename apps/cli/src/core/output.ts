import type {OnProgress} from '../providers/deb.js'
import type {BootstrapResult} from './bootstrap/run.js'
import type {Change, ChangeStatus, SectionPlan} from './bootstrap/section.js'
import type {ProfileSummary, ResolvedProfile} from './profile/resolve.js'
import {type Style, plainStyle} from './style.js'
import {type Stage, stageLabel} from './stage.js'
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
    const label = `${text}${p.version ? ` (${p.version})` : ''}${p.error ? `: ${p.error}` : ''}`
    const detail = p.error ? style.fail(label) : style.muted(label)
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
/** The bar takes whatever the text leaves, within these bounds, so narrow terminals stay on one line. */
const BAR_MIN = 10
const BAR_MAX = 40

function mib(bytes: number): string {
  return `${(bytes / MIB).toFixed(1)} MiB`
}

function duration(seconds: number, decimals = 0): string {
  if (seconds < 60) return `${seconds.toFixed(decimals)}s`
  const minutes = Math.floor(seconds / 60)
  return `${minutes}m ${(seconds % 60).toFixed(0).padStart(2, '0')}s`
}

function bar(fraction: number, width: number): string {
  const filled = Math.round(Math.min(1, Math.max(0, fraction)) * width)
  return '█'.repeat(filled) + '░'.repeat(width - filled)
}

/**
 * A throttled progress reporter. Stateful (start time, last write), so it is a factory
 * rather than a pure render function; `now` and `columns` are injected so tests need
 * neither a real clock nor a real terminal.
 */
export function downloadProgress(
  write: (line: string) => void,
  now: () => number = Date.now,
  columns: () => number = () => 80,
): OnProgress {
  const started = now()
  let last = 0
  // Decided once: a bar recomputed per tick jitters as the numbers beside it change width.
  let width: number | undefined

  return (done, total) => {
    const at = now()
    const finished = total !== undefined && done >= total
    if (!finished && at - last < PROGRESS_INTERVAL_MS) return
    last = at

    const seconds = (at - started) / 1000
    const perSecond = seconds > 0 ? done / seconds : 0
    const speed = `${(perSecond / MIB).toFixed(1).padStart(5)} MB/s`

    // Without content-length there is nothing to fill a bar with, so keep a plain counter.
    if (total === undefined) {
      write(seconds > 0 ? `${mib(done)}  ${speed.trimStart()}` : mib(done))
      return
    }

    const size = mib(total)
    const eta = perSecond > 0 ? duration((total - done) / perSecond) : '—'
    // Every field is padded, so the running line keeps one length and the bar holds still.
    const detail = finished
      ? `  ${size}  ${duration(seconds, 1)}`
      : `  ${(done / MIB).toFixed(1).padStart(size.length - 4)}/${size}  ${speed}  eta ${eta.padStart(6)}`

    const percent = `${String(Math.floor((done / total) * 100)).padStart(3)}%`
    // -2: one for the space after the percentage, one so the line never touches the last
    // column, which wraps the cursor on some terminals.
    width ??= Math.min(BAR_MAX, columns() - percent.length - detail.length - 2)

    // Shed detail rather than wrap onto a second line: the bar first, then speed and eta.
    if (width >= BAR_MIN) {
      write(`${percent} ${bar(done / total, width)}${detail}`)
    } else if (percent.length + detail.length <= columns()) {
      write(`${percent}${detail}`)
    } else {
      write(`${percent}  ${finished ? size : `${(done / MIB).toFixed(1)}/${size}`}`)
    }
  }
}

/**
 * Drives the terminal around the .deb work: names the file before the progress line
 * starts, then closes that line off so the spinner does not overwrite it. The progress
 * line is written with \r and never newline-terminated, hence the handover.
 */
export function stageReporter(
  write: (s: string) => void,
  showsProgress: boolean,
  start?: (label: string) => void,
  stop?: () => void,
): (stage: Stage, subject: string) => void {
  return (stage, subject) => {
    // apt prints its own download and install; a spinner repainting over it shreds both.
    if (stage === 'streaming') {
      stop?.()
      return
    }

    if (stage === 'downloading') {
      if (showsProgress) write(`downloading ${subject}\n`)
      return
    }

    // Only the .deb download leaves an unterminated \r line, so only its successor
    // has a row to hand over; repo stages must not steal a newline they never needed.
    if (stage === 'installing' && showsProgress) write('\n')
    start?.(stageLabel(stage, subject))
  }
}

const CHANGE_LABELS: Record<ChangeStatus, [symbol: string, text: string, paint: Paint]> = {
  changed: ['+', 'changed', 'add'],
  failed: ['✗', 'failed', 'fail'],
  satisfied: ['✓', 'already satisfied', 'ok'],
  skipped: ['·', 'skipped', 'muted'],
  'would-change': ['~', 'would change', 'warn'],
}

/** "Profile: dev  (base -> dev)", without the chain when a profile extends nothing. */
function lineageOf(name: string, lineage: string[], style: Style): string {
  const heading = `${style.heading('Profile:')} ${name}`
  return lineage.length > 1 ? `${heading}  ${style.muted(`(${lineage.join(' -> ')})`)}` : heading
}

function changeLines(changes: Change[], style: Style): string[] {
  const width = column(changes.map((c) => c.id))
  return changes.map((c) => {
    const [symbol, text, paint] = CHANGE_LABELS[c.status]
    const label = `${text}${c.detail ? ` (${c.detail})` : ''}${c.error ? `: ${c.error}` : ''}`
    // Pad before painting: escape codes count towards .length and would skew the columns.
    return `${style[paint](symbol)} ${c.id.padEnd(width)}  ${c.error ? style.fail(label) : style.muted(label)}`
  })
}

export function renderBootstrapResult(result: BootstrapResult, style: Style = plainStyle): string[] {
  const lines = [lineageOf(result.profile, result.lineage, style)]

  for (const section of result.sections) {
    lines.push('', style.heading(section.section))
    // A skipped section has no changes to show, and a blank block reads like a bug.
    lines.push(...(section.changes.length > 0 ? changeLines(section.changes, style) : [style.muted('· skipped')]))
  }

  const {counts} = result
  const summary = [
    counts.changed > 0 ? `${counts.changed} changed` : '',
    counts['would-change'] > 0 ? `${counts['would-change']} would change` : '',
    counts.satisfied > 0 ? `${counts.satisfied} already satisfied` : '',
    counts.failed > 0 ? `${counts.failed} failed` : '',
    counts.skipped > 0 ? `${counts.skipped} skipped` : '',
  ].filter(Boolean)
  if (summary.length > 0) lines.push('', summary.join(' · '))

  if (result.commands && result.commands.length > 0) {
    lines.push('', style.heading('Would run:'), ...result.commands.map((c) => style.muted(`  ${c}`)))
  }

  return lines
}

/** Shown before the first section applies, so nothing runs unseen. */
export function renderBootstrapPlan(plans: SectionPlan[], style: Style = plainStyle): string[] {
  const pending = plans.flatMap((plan) =>
    plan.changes.filter((c) => c.status === 'would-change').map((change) => ({change, section: plan.section})),
  )
  const section = column(pending.map((p) => p.section))
  const id = column(pending.map((p) => p.change.id))
  const rows = pending.map((p) =>
    `  ${p.section.padEnd(section)}  ${p.change.id.padEnd(id)}  ${style.muted(p.change.command ?? '')}`.trimEnd(),
  )
  return [style.heading('Plan:'), ...rows, '']
}

export function renderProfileList(profiles: ProfileSummary[], style: Style = plainStyle): string[] {
  const width = column(profiles.map((p) => p.name))
  return profiles.map((p) => {
    const parents = p.extends.length > 0 ? `  ${style.muted(`(extends ${p.extends.join(', ')})`)}` : ''
    return `${p.name.padEnd(width)}  ${p.summary ?? ''}${parents}`.trimEnd()
  })
}

export function renderProfileShow(profile: ResolvedProfile, style: Style = plainStyle): string[] {
  const sections: [name: string, value: string][] = [
    ['packages', profile.packages.join(' ')],
    ['tools', profile.tools.join(' ')],
    ['setup', profile.setup.join(' ')],
    ['services', profile.services.map((s) => s.name).join(' ')],
    ['shell', profile.shell?.name ?? ''],
    ['dotfiles', profile.dotfiles?.repo ?? ''],
  ]
  const declared = sections.filter(([, value]) => value !== '')

  const width = column(declared.map(([name]) => name))
  return [
    lineageOf(profile.name, profile.lineage, style),
    ...(profile.summary ? [profile.summary] : []),
    '',
    ...declared.map(([name, value]) => `${style.heading(name.padEnd(width))}  ${value}`),
  ]
}
