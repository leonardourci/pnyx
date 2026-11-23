#!/usr/bin/env python3
"""Repeatable source rename; durable schema tokens and recorded fixtures stay intact."""
import json
import pathlib
import sys
import subprocess

ROOT = pathlib.Path(__file__).resolve().parents[2]
if json.loads((ROOT / 'package.json').read_text())['name'] == 'othrys':
    print('Othrys rename already applied; semantic compatibility edits left intact.')
    sys.exit(0)

BASE = '3ae368f7f4a175793de92e58dc160520ed358032'
planned = []
EXCLUDED = ('tests/setup/fixtures/', 'docs/media/', 'docs/superpowers/')
MOVES = {'docs/pnyx.md': 'docs/othrys.md', 'src/cli/pnyx.ts': 'src/cli/othrys.ts', 'tests/setup/pnyx.ts': 'tests/setup/othrys.ts'}
for name in subprocess.check_output(['git', 'ls-files'], cwd=ROOT, text=True).splitlines():
    path = ROOT / name
    if path.is_symlink() or name.startswith(EXCLUDED) or name == 'scripts/rebrand/othrys.py':
        continue
    try:
        before = path.read_text()
    except (UnicodeDecodeError, IsADirectoryError, FileNotFoundError):
        continue
    original = subprocess.run(['git', 'show', f'{BASE}:{name}'], cwd=ROOT, capture_output=True)
    if original.returncode or original.stdout != path.read_bytes():
        continue
    planned.append(name)
    text = before
    # These literals are persisted host/actor/route values, not product labels.
    if name.startswith(('src/', 'web/', 'tests/')):
        text = text.replace("'pnyx'", "'__LEGACY_HOST__'")
    for old, new in [('PNYX', 'OTHRYS'), ('Pnyx', 'Othrys'), ('pnyx', 'othrys'), ('HYDRA', 'TITAN'), ('Hydra', 'Titan'), ('Heads dispatch', 'Titan dispatch'), ('HeadsDispatch', 'TitanDispatch')]:
        text = text.replace(old, new)
    text = text.replace('__LEGACY_HOST__', 'pnyx')
    # Source folders are renamed independently of the durable lower-case schema.
    text = text.replace('#hydra/', '#titan/').replace('#web-hydra/', '#web-titan/').replace('src/hydra/', 'src/titan/')
    text = text.replace('hydra-names.ts', 'titan-names.ts').replace('hydra-session.ts', 'titan-session.ts').replace('/hydra.ts', '/titan.ts').replace('./hydra.ts', './titan.ts')
    if text != before:
        path.write_text(text)
for name in planned:
    if name.startswith(EXCLUDED):
        continue
    target = MOVES.get(name, name)
    if name.startswith('skills/pnyx-'):
        target = name.replace('skills/pnyx-', 'skills/othrys-', 1)
    if name.startswith(('src/hydra/', 'web/src/hydra/')):
        target = target.replace('/hydra/', '/titan/', 1).replace('pnyx-action.ts', 'othrys-action.ts')
        if target.endswith(('/hydra.ts', '/hydra-names.ts', '/hydra-session.ts')):
            target = target.rsplit('/', 1)[0] + '/' + target.rsplit('/', 1)[1].replace('hydra', 'titan')
    if name == 'setup/hooks/pnyx-hook.sh':
        target = 'setup/hooks/othrys-hook.sh'
    source = ROOT / name
    destination = ROOT / target
    if source.exists() and source != destination:
        destination.parent.mkdir(parents=True, exist_ok=True)
        if destination.exists():
            raise RuntimeError(f'Refusing to overwrite {destination}')
        source.rename(destination)
