import ansis from 'ansis'
import {describe, expect, it} from 'vitest'
import {downloadProgress, renderBootstrapPlan, renderBootstrapResult, renderInstallResult, renderMiseReachNote, renderPreflight, renderPreflightPlan, renderProfileList, renderProfileShow, renderSetupPlan, renderSetupResult, renderUninstallPlan, renderUninstallResult, stageReporter} from '../../src/core/output.js'
import type {BootstrapResult} from '../../src/core/bootstrap/run.js'
import type {PreflightResult} from '../../src/core/preflight.js'
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

describe('stageReporter', () => {
  /** Records writes and spinner starts in order. */
  function recorder(showsProgress: boolean, withSpinner = true) {
    const events: string[] = []
    const report = stageReporter(
      (text) => events.push(text === '\n' ? 'newline' : `write:${text.replace(/\n$/, '')}`),
      showsProgress,
      withSpinner ? (label) => events.push(`start:${label}`) : undefined,
      withSpinner ? () => events.push('stop') : undefined,
    )
    return {events, report}
  }

  it('names the download, then closes the line before the spinner takes the row', () => {
    const r = recorder(true)
    r.report('downloading', 'apt:google-chrome-stable')
    r.report('installing', 'apt:google-chrome-stable')
    expect(r.events).toEqual([
      'write:downloading apt:google-chrome-stable',
      'newline',
      'start:installing apt:google-chrome-stable',
    ])
  })

  // Repo work has no \r progress line to close, so it must not steal a newline -- but it
  // must still name what it is doing, because apt's own output is captured while spinning.
  it('spins for repo stages without touching the progress line', () => {
    const r = recorder(true)
    r.report('repo-key', 'repo.mozilla')
    r.report('repo-files', 'repo.mozilla')
    r.report('repo-update', 'repo.mozilla')
    r.report('repo-check', 'repo.mozilla')
    expect(r.events).toEqual([
      'start:fetching signing key for repo.mozilla',
      'start:configuring repo.mozilla',
      'start:updating package lists for repo.mozilla',
      'start:checking repo.mozilla',
    ])
  })

  // A spinner may only run while every subprocess is captured. apt streams its own
  // download, so the spinner has to let go of the row before that starts.
  it('releases the row when a subprocess takes the terminal', () => {
    const r = recorder(false)
    r.report('repo-update', 'repo.mozilla')
    r.report('streaming', 'apt:firefox')
    expect(r.events).toEqual(['start:updating package lists for repo.mozilla', 'stop'])
  })

  it('has nothing to release when no spinner is running', () => {
    const r = recorder(true, false)
    r.report('streaming', 'apt:firefox')
    expect(r.events).toEqual([])
  })

  it('writes nothing of its own when no progress is being shown', () => {
    const r = recorder(false)
    r.report('downloading', 'apt:zsh')
    r.report('installing', 'apt:zsh')
    expect(r.events).toEqual(['start:installing apt:zsh'])
  })

  it('still closes the progress line when there is no spinner', () => {
    const r = recorder(true, false)
    r.report('downloading', 'apt:zsh')
    r.report('installing', 'apt:zsh')
    expect(r.events).toEqual(['write:downloading apt:zsh', 'newline'])
  })
})

const bootstrapResult = (over: Partial<BootstrapResult> = {}): BootstrapResult => ({
  action: 'bootstrap',
  counts: {changed: 1, failed: 0, satisfied: 1, skipped: 0, 'would-change': 0},
  dryRun: false,
  lineage: ['base', 'dev'],
  profile: 'dev',
  sections: [
    {section: 'packages', status: 'ok', changes: [{id: 'apt:git', status: 'satisfied', detail: '2.43.0'}]},
    {section: 'tools', status: 'ok', changes: [{id: 'mise:node', status: 'changed', detail: '22.11.0'}]},
  ],
  success: true,
  ...over,
})

describe('renderBootstrapResult', () => {
  it('heads with the profile and its lineage, then groups by section', () => {
    expect(renderBootstrapResult(bootstrapResult())).toEqual([
      'Profile: dev  (base -> dev)',
      '',
      'packages',
      '✓ apt:git  already satisfied (2.43.0)',
      '',
      'tools',
      '+ mise:node  changed (22.11.0)',
      '',
      '1 changed · 1 already satisfied',
    ])
  })

  it('omits the lineage when a profile extends nothing', () => {
    expect(renderBootstrapResult(bootstrapResult({lineage: ['dev']}))[0]).toBe('Profile: dev')
  })

  it('shows an error beside the change that failed', () => {
    const lines = renderBootstrapResult(
      bootstrapResult({sections: [{section: 'packages', status: 'failed', changes: [{id: 'apt:nope', status: 'failed', error: 'no candidate'}]}]}),
    )
    expect(lines).toContain('✗ apt:nope  failed: no candidate')
  })

  it('names a skipped section instead of leaving it blank', () => {
    const lines = renderBootstrapResult(bootstrapResult({sections: [{section: 'tools', status: 'skipped', changes: []}]}))
    expect(lines).toContain('tools')
    expect(lines).toContain('· skipped')
  })

  it('appends the would-run block on a dry run', () => {
    const lines = renderBootstrapResult(bootstrapResult({commands: ['apt-get install git'], dryRun: true}))
    expect(lines.slice(-2)).toEqual(['Would run:', '  apt-get install git'])
  })

  it('pads before painting, so colour never skews the columns', () => {
    const wide = bootstrapResult({
      sections: [
        {
          section: 'packages',
          status: 'ok',
          changes: [
            {id: 'apt:git', status: 'satisfied'},
            {id: 'apt:build-essential', status: 'changed'},
          ],
        },
      ],
    })
    const plain = renderBootstrapResult(wide)
    const painted = renderBootstrapResult(wide, ansiStyle)
    const at = (line: string) => line.replace(/\u001B\[[\d;]*m/g, '').indexOf('  ')
    expect(at(painted[3])).toBe(at(plain[3]))
    expect(at(painted[4])).toBe(at(plain[4]))
  })
})

describe('renderBootstrapPlan', () => {
  it('lists only the pending changes, grouped by section', () => {
    expect(
      renderBootstrapPlan([
        {
          section: 'packages',
          commands: [],
          changes: [
            {id: 'apt:git', status: 'would-change', command: 'apt-get install git'},
            {id: 'apt:curl', status: 'satisfied'},
          ],
        },
      ]),
    ).toEqual(['Plan:', '  packages  apt:git  apt-get install git', ''])
  })
})

describe('renderProfileList', () => {
  it('shows name, summary and parents', () => {
    expect(
      renderProfileList([
        {name: 'base', summary: 'Essentials', extends: [], sections: ['packages']},
        {name: 'dev', summary: 'Local dev box', extends: ['base'], sections: ['packages', 'tools']},
      ]),
    ).toEqual(['base  Essentials', 'dev   Local dev box  (extends base)'])
  })
})

describe('renderProfileShow', () => {
  it('lists each declared section, and nothing for the empty ones', () => {
    expect(
      renderProfileShow({
        name: 'dev',
        summary: 'Local dev box',
        lineage: ['base', 'dev'],
        packages: ['git'],
        tools: ['node'],
        setup: [],
        services: [],
      }),
    ).toEqual(['Profile: dev  (base -> dev)', 'Local dev box', '', 'packages  git', 'tools     node'])
  })
})

const preflight = (over: Partial<PreflightResult> = {}): PreflightResult => ({
  action: 'preflight',
  changes: [{id: 'mise', status: 'satisfied', detail: '2026.9.11'}],
  dryRun: false,
  satisfied: true,
  ...over,
})

describe('renderPreflight', () => {
  it('says nothing at all when mise was already there', () => {
    // The common path must cost the reader nothing.
    expect(renderPreflight(preflight())).toEqual([])
  })

  it('reports an install', () => {
    expect(renderPreflight(preflight({changes: [{id: 'mise', status: 'changed', detail: '2026.9.11'}]}))).toEqual([
      'preflight',
      '+ mise  changed (2026.9.11)',
      '',
    ])
  })

  it('explains why a dry run can go no further', () => {
    const lines = renderPreflight(
      preflight({
        changes: [{id: 'mise', status: 'would-change', detail: 'not installed', command: 'sudo env ... sh <installer>'}],
        commands: ['download https://mise.run', 'sudo env ... sh <installer>'],
        dryRun: true,
        satisfied: false,
      }),
    )
    expect(lines).toContain('~ mise  would change (not installed)')
    expect(lines).toContain('Would run:')
    expect(lines).toContain('  download https://mise.run')
    expect(lines.some((l) => l.includes('nothing further can be planned'))).toBe(true)
  })

  it('reports a broken mise without claiming to have fixed it', () => {
    const lines = renderPreflight(
      preflight({changes: [{id: 'mise', status: 'skipped', detail: 'on PATH but did not answer --version: boom'}]}),
    )
    expect(lines).toContain('· mise  skipped (on PATH but did not answer --version: boom)')
  })
})

describe('renderPreflightPlan', () => {
  it('heads differently from a section plan, since a bare machine prints both', () => {
    expect(renderPreflightPlan([{id: 'mise', status: 'would-change', command: 'sudo env ... sh <installer>'}])).toEqual([
      'Preflight:',
      '  mise  sudo env ... sh <installer>',
      '',
    ])
  })
})

describe('renderMiseReachNote', () => {
  it('warns only when neither route to the tools exists', () => {
    expect(renderMiseReachNote({activated: false, shimsOnPath: false})).toEqual([
      '',
      'note: mise is not activated and its shims are not on PATH, so the tools it just',
      'installed are not callable yet. Run `mise activate bash` (or see https://mise.jdx.dev).',
    ])
  })

  it('says nothing when either route works', () => {
    // Shims on PATH is a complete setup; so is the shell hook. Warning would be a false alarm.
    expect(renderMiseReachNote({activated: false, shimsOnPath: true})).toEqual([])
    expect(renderMiseReachNote({activated: true, shimsOnPath: false})).toEqual([])
    expect(renderMiseReachNote({activated: true, shimsOnPath: true})).toEqual([])
  })

  it('says nothing when mise could not answer', () => {
    expect(renderMiseReachNote(undefined)).toEqual([])
  })
})
