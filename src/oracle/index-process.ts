import { updateIndex } from './index.ts'

// The server catches up here: node:sqlite is synchronous, and a first build takes seconds.
process.stdout.write(JSON.stringify(updateIndex({ hydraId: process.argv[2]! })))
