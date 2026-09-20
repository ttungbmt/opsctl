import {readFileSync} from 'node:fs'
import {fileURLToPath} from 'node:url'
import {defineConfig} from 'vitest/config'

// The `#...` specifiers are declared in package.json `imports`, which maps them to `src` under
// the `ops-src` condition and to `dist` otherwise. Vite does not apply `resolve.conditions` to
// the node branch vitest runs in, so `ops-src` never fires and a test would silently load the
// built copy of a module the source loads from `src` — two instances of one file, across which
// `instanceof` fails. An alias resolves before conditions do, so it wins. Derived from
// package.json rather than restated here, so the mapping keeps a single home.
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {
  imports: Record<string, {'ops-src'?: string}>
}

const alias = Object.entries(pkg.imports).flatMap(([specifier, target]) => {
  const source = target['ops-src']
  if (!source) return []
  // '#core/*.js' -> '#core/'  and  './src/core/*.ts' -> '<pkg>/src/core/'
  return [
    {
      find: specifier.slice(0, specifier.indexOf('*')),
      replacement: fileURLToPath(new URL(source.slice(0, source.indexOf('*')), import.meta.url)),
    },
  ]
})

export default defineConfig({
  resolve: {alias},
  test: {
    // ansis turns colour off when stdout is not a TTY, which it never is under vitest.
    // The style tests need real escape codes to assert on.
    env: {FORCE_COLOR: '1'},
  },
})
