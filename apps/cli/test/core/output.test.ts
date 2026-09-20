import {describe, expect, it} from 'vitest'
import {renderInstallResult} from '../../src/core/output.js'

describe('renderInstallResult', () => {
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
