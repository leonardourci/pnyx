import { createRequire } from 'node:module'

// A leaf module: `--version` reads it before the command graph loads.
export const { version } = createRequire(import.meta.url)('../../package.json') as { version: string }
