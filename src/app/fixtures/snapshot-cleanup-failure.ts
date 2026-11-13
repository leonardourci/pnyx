import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'

// Loaded into a snapshot worker: publishing the cache fails, and so does removing its staging file.
fs.renameSync = () => {
  throw new Error('snapshot rename refused')
}

fs.rmSync = () => {
  throw new Error('snapshot cleanup refused')
}

syncBuiltinESMExports()
