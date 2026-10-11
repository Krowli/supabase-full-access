import { defineConfig } from 'vitest/config'

// The live test talks to the real Coolify and a server; it runs only through `npm run test:live`.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    exclude: process.env.LIVE ? [] : ['test/**/*.live.test.ts'],
  },
})
