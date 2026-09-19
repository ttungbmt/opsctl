import {readFile as fsReadFile} from 'node:fs/promises'

import {OpsError} from '../core/errors.js'

export type SystemManager = 'apt' | 'dnf'

export interface OsRelease {
  id: string
  idLike: string[]
}

const MANAGERS: Record<string, SystemManager> = {
  centos: 'dnf',
  debian: 'apt',
  fedora: 'dnf',
  rhel: 'dnf',
  ubuntu: 'apt',
}

export function parseOsRelease(text: string): OsRelease {
  const values: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const match = /^([A-Z_]+)=(.*)$/.exec(line.trim())
    if (match) values[match[1]] = match[2].replace(/^["']|["']$/g, '')
  }

  return {id: values.ID ?? '', idLike: (values.ID_LIKE ?? '').split(/\s+/).filter(Boolean)}
}

export function managerFor(os: OsRelease): SystemManager {
  for (const token of [os.id, ...os.idLike]) {
    const manager = MANAGERS[token]
    if (manager) return manager
  }

  throw new OpsError('UNSUPPORTED_PLATFORM', `Unsupported platform: ${os.id || 'unknown'} (supported: Debian/Ubuntu via apt, RHEL/Fedora/CentOS via dnf)`)
}

export async function detectSystemManager(
  readFile: (path: string) => Promise<string> = (path) => fsReadFile(path, 'utf8'),
): Promise<SystemManager> {
  let text: string
  try {
    text = await readFile('/etc/os-release')
  } catch {
    throw new OpsError('UNSUPPORTED_PLATFORM', 'Cannot read /etc/os-release; use manager:package (e.g. brew:jq)')
  }

  return managerFor(parseOsRelease(text))
}
