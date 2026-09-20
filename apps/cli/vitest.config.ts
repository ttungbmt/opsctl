import {defineConfig} from 'vitest/config'

export default defineConfig({
  test: {
    // ansis turns colour off when stdout is not a TTY, which it never is under vitest.
    // The style tests need real escape codes to assert on.
    env: {FORCE_COLOR: '1'},
  },
})
