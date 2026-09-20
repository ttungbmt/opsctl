import {fileURLToPath} from 'node:url'

import {execa} from 'execa'
import {describe, expect, it} from 'vitest'

/**
 * Proves the packaging invariant the design relies on: `files` in package.json must keep
 * carrying config/tool/ and config/repo/ into the published tarball. `readCatalog` treats a
 * missing catalog directory as "no entries" rather than an error (git cannot store an empty
 * directory), so if `files` is ever narrowed, or the packer's copy step changes, nothing
 * crashes -- `ops tool install firefox` just silently stops knowing what firefox is and falls
 * through to Ubuntu's snap shim, the exact failure the mozilla repo exists to prevent. This
 * test runs the real packer (no mocking) so it exercises the artifact, not the repo tree.
 */
describe('packaging', () => {
  it('includes the firefox recipe and the mozilla repo in the packed tarball', async () => {
    const cliDir = fileURLToPath(new URL('..', import.meta.url))

    const result = await execa('npm', ['pack', '--dry-run', '--json'], {cwd: cliDir, reject: false})

    expect(result.exitCode, `npm pack failed:\n${result.stderr}`).toBe(0)

    const [pack] = JSON.parse(result.stdout) as [{files: Array<{path: string}>}]
    const paths = pack.files.map((file) => file.path)

    expect(paths).toContain('config/tool/firefox.yaml')
    expect(paths).toContain('config/repo/mozilla.yaml')
  }, 30_000)
})
