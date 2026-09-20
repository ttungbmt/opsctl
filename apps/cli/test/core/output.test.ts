import ansis from 'ansis'
import {describe, expect, it} from 'vitest'
import {
  downloadProgress,
  renderInstallResult,
  renderSetupPlan,
  renderSetupResult,
  renderUninstallPlan,
  renderUninstallResult,
} from '../../src/core/output.js'
import {ansiStyle, plainStyle} from '../../src/core/style.js'

describe('renderInstallResult', () => {
  it('spells out why a package failed, so a wrong-origin build is actionable', () => {
    expect(
      renderInstallResult({
        action: 'install',
        dryRun: false,
        managers: ['apt'],
        packages: [
          {
            spec: 'apt:firefox',
            status: 'failed',
            version: '1:1snap1-0ubuntu5',
            error: 'installed 1:1snap1-0ubuntu5 is not from packages.mozilla.org; re-run with --force to switch',
          },
        ],
        success: false,
      }),
    ).toEqual([
      'Installed with: apt',
      '✗ apt:firefox  failed (1:1snap1-0ubuntu5): installed 1:1snap1-0ubuntu5 is not from packages.mozilla.org; re-run with --force to switch',
    ])
  })

  it('renders one aligned line per package', () => {
    expect(
      renderInstallResult({
        action: 'install',
        dryRun: false,
        managers: ['apt'],
        packages: [
          {spec: 'apt:zsh', status: 'already-installed', version: '5.9-6ubuntu2'},
          {spec: 'apt:ripgrep', status: 'installed', version: '14.1.0'},
          {spec: 'apt:foo', status: 'failed'},
        ],
        success: false,
      }),
    ).toEqual([
      'Installed with: apt',
      '✓ apt:zsh      already installed (5.9-6ubuntu2)',
      '+ apt:ripgrep  installed (14.1.0)',
      '✗ apt:foo      failed',
    ])
  })

  it('shows planned commands for a dry run', () => {
    expect(
      renderInstallResult({
        action: 'install',
        commands: ['sudo apt-get install -y -- sl'],
        dryRun: true,
        managers: ['apt'],
        packages: [{spec: 'apt:sl', status: 'would-install'}],
        success: true,
      }),
    ).toEqual(['Installed with: apt', '~ apt:sl  would install', '', 'Would run:', '  sudo apt-get install -y -- sl'])
  })
})

describe('renderSetupResult', () => {
  it('renders one aligned line per step, labelled by tool', () => {
    expect(
      renderSetupResult({
        action: 'setup',
        dryRun: false,
        steps: [
          {tool: 'agent-browser', step: 'browsers', status: 'configured'},
          {tool: 'agent-browser', step: 'deps', status: 'already-configured'},
          {tool: 'git', step: 'identity', status: 'failed', error: 'no user.email'},
          {tool: 'git', step: 'aliases', status: 'skipped'},
        ],
        success: false,
        tools: ['agent-browser', 'git'],
      }),
    ).toEqual([
      '+ agent-browser  browsers  configured',
      '\u2713 agent-browser  deps      already configured',
      '\u2717 git            identity  failed: no user.email',
      '\u00b7 git            aliases   skipped',
    ])
  })

  it('shows the commands a dry run would have run', () => {
    expect(
      renderSetupResult({
        action: 'setup',
        dryRun: true,
        steps: [{tool: 'ab', step: 'browsers', status: 'would-configure', command: 'ab install --with-deps'}],
        success: true,
        tools: ['ab'],
      }),
    ).toEqual(['~ ab  browsers  would configure', '', 'Would run:', '  ab install --with-deps'])
  })

  it('renders nothing but survives an empty step list', () => {
    expect(renderSetupResult({action: 'setup', dryRun: false, steps: [], success: true, tools: []})).toEqual([])
  })
})

describe('renderSetupPlan', () => {
  it('lists what is about to run', () => {
    expect(renderSetupPlan([{tool: 'ab', step: 'browsers', status: 'would-configure', command: 'ab install'}])).toEqual([
      'Plan:',
      '  ab  browsers  ab install',
      '',
    ])
  })
})

describe('downloadProgress', () => {
  /** A clock the test advances by hand, plus the lines written so far. */
  function reporter(columns = 80) {
    const lines: string[] = []
    let clock = 1000
    const report = downloadProgress((line) => lines.push(line), () => clock, () => columns)
    return {advance: (ms: number) => (clock += ms), lines, report}
  }

  it('throttles to one line per interval', () => {
    const r = reporter()
    r.advance(1000)
    r.report(1 * 1024 * 1024, 100 * 1024 * 1024)
    r.report(2 * 1024 * 1024, 100 * 1024 * 1024) // same instant
    r.advance(100)
    r.report(3 * 1024 * 1024, 100 * 1024 * 1024) // too soon
    r.advance(150)
    r.report(4 * 1024 * 1024, 100 * 1024 * 1024) // 250ms since the last write
    expect(r.lines).toHaveLength(2)
  })

  it('always writes the final line, however soon it arrives', () => {
    const r = reporter()
    r.advance(1000)
    r.report(50 * 1024 * 1024, 100 * 1024 * 1024)
    r.report(100 * 1024 * 1024, 100 * 1024 * 1024) // same instant, but done
    expect(r.lines).toHaveLength(2)
    expect(r.lines[1]).toContain('100%')
  })

  it('shows a bar, percent, size, speed and eta', () => {
    const r = reporter()
    r.advance(2000) // 2s elapsed, so 25 MB/s and 6s left
    r.report(50 * 1024 * 1024, 200 * 1024 * 1024)
    expect(r.lines[0]).toContain(' 25% ')
    expect(r.lines[0]).toContain('50.0/200.0 MiB')
    expect(r.lines[0]).toContain('25.0 MB/s')
    expect(r.lines[0]).toContain('eta     6s')
    expect(r.lines[0]).toMatch(/█+░+/)
  })

  it('reports elapsed time instead of eta on the final line', () => {
    const r = reporter()
    r.advance(21_700)
    r.report(100 * 1024 * 1024, 100 * 1024 * 1024)
    expect(r.lines[0]).toContain('100.0 MiB  21.7s')
    expect(r.lines[0]).not.toContain('eta')
    expect(r.lines[0]).toMatch(/█+(?!░)/)
  })

  it('holds the bar width steady as the numbers beside it change', () => {
    const r = reporter()
    const widths = new Set<number>()
    for (const [ms, mib] of [[1000, 10], [2000, 40], [8000, 90], [9000, 100]]) {
      r.advance(ms)
      r.report(mib * 1024 * 1024, 100 * 1024 * 1024)
      widths.add((r.lines.at(-1)?.match(/[█░]/g) ?? []).length)
    }
    // A bar recomputed per tick jitters as the speed and eta fields change width.
    expect(widths.size).toBe(1)
  })

  it('caps the bar so a wide terminal does not get a giant one', () => {
    const r = reporter(400)
    r.advance(1000)
    r.report(1 * 1024 * 1024, 100 * 1024 * 1024)
    expect((r.lines[0].match(/[█░]/g) ?? []).length).toBe(40)
  })

  it('never writes past the terminal width', () => {
    for (const columns of [40, 60, 80, 120]) {
      const r = reporter(columns)
      r.advance(2000)
      r.report(50 * 1024 * 1024, 200 * 1024 * 1024)
      expect(r.lines[0].length).toBeLessThan(columns)
    }
  })

  it('drops the bar, then the speed and eta, as the terminal narrows', () => {
    const wide = reporter(80)
    wide.advance(2000)
    wide.report(50 * 1024 * 1024, 200 * 1024 * 1024)
    expect(wide.lines[0]).toMatch(/[█░]/)

    const narrow = reporter(40)
    narrow.advance(2000)
    narrow.report(50 * 1024 * 1024, 200 * 1024 * 1024)
    expect(narrow.lines[0]).not.toMatch(/[█░]/)
    expect(narrow.lines[0]).not.toContain('eta')
    expect(narrow.lines[0]).toContain('50.0/200.0 MiB')
  })

  it('drops the percentage when the server sent no content-length', () => {
    const r = reporter()
    r.advance(1000)
    r.report(10 * 1024 * 1024, undefined)
    expect(r.lines[0]).toBe('10.0 MiB  10.0 MB/s')
  })
})

describe('renderInstallResult with a style', () => {
  const result = {
    action: 'install' as const,
    commands: ['sudo apt-get install -y -- sl'],
    dryRun: false,
    managers: ['apt'],
    packages: [
      {spec: 'apt:zsh' as const, status: 'already-installed' as const, version: '5.9'},
      {spec: 'apt:ripgrep-and-more' as const, status: 'failed' as const},
      {spec: 'apt:sl' as const, status: 'would-install' as const},
    ],
    success: false,
  }

  it('paints each status differently', () => {
    const lines = renderInstallResult(result, ansiStyle)
    const symbols = lines.slice(1, 4).map((l) => l.slice(0, l.indexOf(' ')))
    expect(new Set(symbols).size).toBe(3)
    for (const s of symbols) expect(s).toMatch(/\u001B\[/)
  })

  it('keeps columns aligned once the colour is stripped', () => {
    // The classic bug: painting before padEnd makes escape codes count towards width.
    const painted = renderInstallResult(result, ansiStyle).map((l) => ansis.strip(l))
    expect(painted).toEqual(renderInstallResult(result, plainStyle))
  })

  it('leaves the machine-readable shape alone by default', () => {
    for (const line of renderInstallResult(result)) expect(line).not.toMatch(/\u001B\[/)
  })
})

describe('renderUninstallResult', () => {
  const result = {
    action: 'uninstall' as const,
    dryRun: false,
    managers: ['apt', 'mise'],
    purge: false,
    packages: [
      {spec: 'apt:google-chrome-stable' as const, status: 'uninstalled' as const, version: '153.0', undeclared: true},
      {spec: 'mise:fastfetch' as const, status: 'already-absent' as const},
    ],
    success: true,
  }

  it('renders one aligned line per package under a Removed with: heading', () => {
    expect(renderUninstallResult(result)).toEqual([
      'Removed with: apt, mise',
      '- apt:google-chrome-stable  uninstalled (153.0)',
      '· mise:fastfetch            not installed',
    ])
  })

  it('lists purged paths in their own section, marking the privileged ones', () => {
    const lines = renderUninstallResult({
      ...result,
      purge: true,
      paths: [
        {tool: 'google-chrome', path: '/etc/apt/sources.list.d/google-chrome.sources', status: 'removed' as const, privileged: true},
        {tool: 'google-chrome', path: '/home/t/.config/google-chrome', status: 'already-absent' as const, privileged: false},
      ],
    })
    expect(lines).toContain('Purged:')
    expect(lines.some((l) => l.includes('/etc/apt/sources.list.d/google-chrome.sources') && l.includes('(sudo)'))).toBe(true)
    expect(lines.some((l) => l.includes('/home/t/.config/google-chrome') && l.includes('absent'))).toBe(true)
  })

  it('shows an error on the row that failed', () => {
    const lines = renderUninstallResult({
      ...result,
      packages: [{spec: 'apt:zsh' as const, status: 'failed' as const, error: 'still installed'}],
      success: false,
    })
    expect(lines[1]).toContain('failed: still installed')
  })

  it('appends the dry-run command list', () => {
    const lines = renderUninstallResult({...result, dryRun: true, commands: ['sudo apt-get remove -y -- zsh']})
    expect(lines.slice(-2)).toEqual(['Would run:', '  sudo apt-get remove -y -- zsh'])
  })

  it('keeps columns aligned once the colour is stripped', () => {
    const painted = renderUninstallResult(result, ansiStyle).map((l) => ansis.strip(l))
    expect(painted).toEqual(renderUninstallResult(result, plainStyle))
  })
})

describe('renderUninstallPlan', () => {
  it('lists what is about to go, paths included', () => {
    expect(
      renderUninstallPlan({
        packages: [{spec: 'apt:google-chrome-stable' as const, status: 'would-uninstall' as const}],
        paths: [{tool: 'google-chrome', path: '/etc/apt/x.sources', status: 'would-remove' as const, privileged: true}],
      }),
    ).toEqual(['Plan:', '  apt:google-chrome-stable', '  /etc/apt/x.sources  (sudo)', ''])
  })
})
