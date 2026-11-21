from pathlib import Path
import os
import subprocess

path = Path('tests/browser/chat.test.ts')
original = path.read_bytes()
source = original.decode()
start = source.index("  'plain send and answer calls")
end = source.index('\ntest(', start)
case = source[start:end]
anchor = '      const conversation = page.locator(`[data-hydra-workspace="${hydra.id}"]`).getByRole('
assert case.count(anchor) == 1
case = case.replace(anchor, '''      const devtools = await page.context().newCDPSession(page)
      await devtools.send('Emulation.setCPUThrottlingRate', { rate: 6 })
''' + anchor)
try:
    path.write_text(source[:start] + case + source[end:])
    result = subprocess.run([
        'pnpm', 'exec', 'vitest', 'run', 'tests/browser/chat.test.ts',
        '--reporter=verbose', '--sequence.seed=1795295082062',
    ], env={**os.environ, 'CI': '1'})
finally:
    path.write_bytes(original)
raise SystemExit(result.returncode)
