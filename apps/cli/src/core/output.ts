import type {InstallResult, PackageStatus} from './package/install.js'

const LABELS: Record<PackageStatus, [symbol: string, text: string]> = {
  'already-installed': ['✓', 'already installed'],
  failed: ['✗', 'failed'],
  installed: ['+', 'installed'],
  'would-install': ['~', 'would install'],
}

export function renderInstallResult(result: InstallResult): string[] {
  const width = Math.max(...result.packages.map((p) => p.spec.length))
  const lines = [`Installed with: ${result.managers.join(', ')}`]

  for (const p of result.packages) {
    const [symbol, text] = LABELS[p.status]
    lines.push(`${symbol} ${p.spec.padEnd(width)}  ${text}${p.version ? ` (${p.version})` : ''}`)
  }

  if (result.commands && result.commands.length > 0) {
    lines.push('', 'Would run:', ...result.commands.map((c) => `  ${c}`))
  }

  return lines
}
