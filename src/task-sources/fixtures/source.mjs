// An external source: records its launch, prints its payload and a diagnostic, and exits.
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'

const [
  folder,
  payload,
] = process.argv.slice(2)
appendFileSync(
  join(
    folder,
    'launches',
  ),
  `${process.pid}\n`,
)
process.stdout.write(payload)
process.stderr.write('fixture diagnostic')
