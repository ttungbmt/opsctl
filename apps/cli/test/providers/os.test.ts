import {describe, expect, it} from 'vitest'
import {OpsError} from '#core/errors.js'
import {detectSystemManager, managerFor, parseOsRelease} from '#providers/os.js'

const UBUNTU = 'PRETTY_NAME="Ubuntu 24.04 LTS"\nID=ubuntu\nID_LIKE=debian\n'
const DEBIAN = 'ID=debian\n'
const FEDORA = 'ID=fedora\n'
const ROCKY = 'ID="rocky"\nID_LIKE="rhel centos fedora"\n'
const ALPINE = 'ID=alpine\n'

describe('parseOsRelease', () => {
  it('reads ID and ID_LIKE, stripping quotes', () => {
    expect(parseOsRelease(ROCKY)).toEqual({id: 'rocky', idLike: ['rhel', 'centos', 'fedora']})
    expect(parseOsRelease(DEBIAN)).toEqual({id: 'debian', idLike: []})
  })
})

describe('managerFor', () => {
  it.each([
    [UBUNTU, 'apt'],
    [DEBIAN, 'apt'],
    [FEDORA, 'dnf'],
    [ROCKY, 'dnf'],
  ])('maps %j to %s', (text, manager) => {
    expect(managerFor(parseOsRelease(text))).toBe(manager)
  })

  it('rejects unsupported distros', () => {
    expect(() => managerFor(parseOsRelease(ALPINE))).toThrow(/Unsupported platform: alpine/)
  })
})

describe('detectSystemManager', () => {
  it('reads /etc/os-release', async () => {
    let asked = ''
    const manager = await detectSystemManager(async (path) => {
      asked = path
      return UBUNTU
    })
    expect(asked).toBe('/etc/os-release')
    expect(manager).toBe('apt')
  })

  it('fails with UNSUPPORTED_PLATFORM when the file is missing', async () => {
    const error = await detectSystemManager(async () => {
      throw new Error('ENOENT')
    }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(OpsError)
    expect((error as OpsError).code).toBe('UNSUPPORTED_PLATFORM')
  })
})
