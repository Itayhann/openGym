import { defineConfig } from 'vitest/config'

// Root config covers the API only; the frontend has its own vitest run under frontend/.
export default defineConfig({
  test: {
    include: ['server/**/*.test.js', 'scripts/**/*.test.js'],
    testTimeout: 20000
  }
})
