import {describe, expect, it} from 'vitest'
import {createSystemPackages} from '../../src/providers/system.js'
import {FakeRunner} from '../helpers/fake-runner.js'

// Captured from `apt-get -s remove unzip` on Ubuntu; apt prints the autoremove
// block BEFORE the REMOVED block, and only the latter is what this run would do.
const SIMULATE_REMOVE = `NOTE: This is only a simulation!
Reading package lists...
The following packages were automatically installed and are no longer required:
  libauthen-sasl-perl libclone-perl libdata-dump-perl
  libfile-basedir-perl libfile-desktopentry-perl
Use 'sudo apt autoremove' to remove them.
The following packages will be REMOVED:
  unzip
0 upgraded, 0 newly installed, 1 to remove and 78 not upgraded.
Remv unzip [6.0-28ubuntu4.1]
`

/** `apt-get -s purge` marks each package with a trailing asterisk. */
const SIMULATE_PURGE = SIMULATE_REMOVE.replace('  unzip\n', '  unzip*\n').replace('Remv', 'Purg')

const SIMULATE_DEPENDENTS = `The following packages will be REMOVED:
  libssl3t64 openssl wget
  curl
0 upgraded, 0 newly installed, 4 to remove and 78 not upgraded.
`

describe('createSystemPackages (apt)', () => {
  const apt = (runner: FakeRunner) => createSystemPackages(runner, 'apt')

  it('removes with apt-get remove, and purges with apt-get purge', async () => {
    const runner = new FakeRunner().on('sudo apt-get', {exitCode: 0})
    await apt(runner).remove(['apt:unzip', 'apt:zsh'], {capture: false, nonInteractive: false, purge: false})
    expect(runner.calls[0]).toMatchObject({cmd: 'sudo', args: ['apt-get', 'remove', '-y', '--', 'unzip', 'zsh']})

    await apt(runner).remove(['apt:unzip'], {capture: false, nonInteractive: false, purge: true})
    expect(runner.calls[1]).toMatchObject({args: ['apt-get', 'purge', '-y', '--', 'unzip']})
  })

  it('streams output unless asked to capture, and never reads stdin when non-interactive', async () => {
    const runner = new FakeRunner().on('sudo apt-get', {exitCode: 0})
    await apt(runner).remove(['apt:unzip'], {capture: true, nonInteractive: true, purge: false})
    expect(runner.calls[0].opts).toMatchObject({stdin: 'ignore', stdout: 'capture'})
  })

  it('reads dpkg status: installed, absent, and removed-but-not-purged', async () => {
    const runner = new FakeRunner()
      .on('dpkg-query -W -f=${Status}|${Version}\n unzip', {exitCode: 0, stdout: 'install ok installed|6.0-28ubuntu4.1\n'})
      .on('dpkg-query -W -f=${Status}|${Version}\n gone', {exitCode: 1, stderr: 'no packages found matching gone'})
      .on('dpkg-query -W -f=${Status}|${Version}\n half', {exitCode: 0, stdout: 'deinstall ok config-files|1.2\n'})

    expect(await apt(runner).status(['apt:unzip', 'apt:gone', 'apt:half'])).toEqual([
      {spec: 'apt:unzip', installed: true, version: '6.0-28ubuntu4.1'},
      {spec: 'apt:gone', installed: false},
      {spec: 'apt:half', installed: false, configFiles: true, version: '1.2'},
    ])
  })

  // The autoremove block sits above the REMOVED block and is not what this run does.
  it('simulates without root and reads only the REMOVED block', async () => {
    const runner = new FakeRunner().on('apt-get -s', {exitCode: 0, stdout: SIMULATE_REMOVE})
    expect(await apt(runner).simulate(['apt:unzip'], {purge: false})).toEqual({removes: ['unzip']})
    expect(runner.calls[0]).toMatchObject({cmd: 'apt-get', args: ['-s', 'remove', '--', 'unzip']})
  })

  it('strips the asterisk apt-get -s purge puts on each name', async () => {
    const runner = new FakeRunner().on('apt-get -s', {exitCode: 0, stdout: SIMULATE_PURGE})
    expect(await apt(runner).simulate(['apt:unzip'], {purge: true})).toEqual({removes: ['unzip']})
    expect(runner.calls[0]).toMatchObject({args: ['-s', 'purge', '--', 'unzip']})
  })

  it('reads every name when the REMOVED block wraps across lines', async () => {
    const runner = new FakeRunner().on('apt-get -s', {exitCode: 0, stdout: SIMULATE_DEPENDENTS})
    expect(await apt(runner).simulate(['apt:libssl3t64'], {purge: false})).toEqual({
      removes: ['libssl3t64', 'openssl', 'wget', 'curl'],
    })
  })

  it('reports nothing to remove when apt prints no REMOVED block', async () => {
    const runner = new FakeRunner().on('apt-get -s', {exitCode: 0, stdout: "Package 'sl' is not installed, so not removed\n"})
    expect(await apt(runner).simulate(['apt:sl'], {purge: false})).toEqual({removes: []})
  })

  it('describes what it would run', () => {
    const runner = new FakeRunner()
    expect(apt(runner).describe(['apt:unzip', 'apt:zsh'], {purge: false})).toEqual(['sudo apt-get remove -y -- unzip zsh'])
    expect(apt(runner).describe(['apt:unzip'], {purge: true})).toEqual(['sudo apt-get purge -y -- unzip'])
  })
})

describe('createSystemPackages (dnf)', () => {
  const dnf = (runner: FakeRunner) => createSystemPackages(runner, 'dnf')

  // rpm has no conffile concept, so --purge adds nothing to the package removal itself.
  it('removes with dnf remove for both levels', async () => {
    const runner = new FakeRunner().on('sudo dnf', {exitCode: 0})
    await dnf(runner).remove(['dnf:unzip'], {capture: false, nonInteractive: false, purge: true})
    expect(runner.calls[0]).toMatchObject({cmd: 'sudo', args: ['dnf', 'remove', '-y', '--', 'unzip']})
  })

  it('reads rpm status', async () => {
    const runner = new FakeRunner()
      .on('rpm -q --qf %{VERSION}-%{RELEASE}\n unzip', {exitCode: 0, stdout: '6.0-63.fc41\n'})
      .on('rpm -q --qf %{VERSION}-%{RELEASE}\n gone', {exitCode: 1, stdout: 'package gone is not installed\n'})
    expect(await dnf(runner).status(['dnf:unzip', 'dnf:gone'])).toEqual([
      {spec: 'dnf:unzip', installed: true, version: '6.0-63.fc41'},
      {spec: 'dnf:gone', installed: false},
    ])
  })

  // dnf's simulate output is not worth parsing; the guard degrades to "no opinion".
  it('has no dependents opinion, rather than a wrong one', async () => {
    const runner = new FakeRunner()
    expect(await dnf(runner).simulate(['dnf:unzip'], {purge: false})).toEqual({removes: []})
    expect(runner.calls).toEqual([])
  })
})
