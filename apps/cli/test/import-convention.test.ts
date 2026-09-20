import {readFileSync, readdirSync} from 'node:fs'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {describe, expect, it} from 'vitest'

const root = fileURLToPath(new URL('..', import.meta.url))

function sources(dir: string): string[] {
  return readdirSync(join(root, dir), {withFileTypes: true}).flatMap((entry) => {
    const rel = `${dir}/${entry.name}`
    if (entry.isDirectory()) return sources(rel)
    return entry.name.endsWith('.ts') ? [rel] : []
  })
}

// A specifier that climbs out of its own directory spells the same module differently for every
// importer, which is what the '#' aliases in package.json `imports` exist to stop. Nothing else
// enforces this yet: Biome is still only planned, and tsc is happy either way.
const climbing = /\bfrom\s+'(\.\.\/[^']*)'/g

describe('import convention', () => {
  it('reaches across directories through a # alias, never through ../', () => {
    const offenders = sources('src')
      .concat(sources('test'))
      .flatMap((file) => {
        const text = readFileSync(join(root, file), 'utf8')
        return [...text.matchAll(climbing)].map((m) => `${file}: ${m[1]}`)
      })

    expect(offenders).toEqual([])
  })
})
