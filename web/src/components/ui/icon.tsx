const paths: Record<string, string> = {
  board: 'M3 4h18v16H3zM9 4v16M15 4v16',
  search: 'M21 21l-5-5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0',
  close: 'm6 6 12 12M6 18 18 6',
  settings: 'M9 3h6l1 4 4 2v6l-4 2-1 4H9l-1-4-4-2V9l4-2zM15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0',
  history: 'M3 9a9 9 0 1 1 0 6M3 3v6h6M12 7v6l4 2',
  needs_you: 'm12 3 10 18H2zM12 8v6m0 3v1',
  workers_on_it: 'm9 5 10 7-10 7z',
  review: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zM15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0',
  done: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0M7 12l3 3 7-7',
  agent: 'M4 6h16v14H4zM12 2v4M8 11v2m8-2v2m-7 4h6',
  tool: 'm8 5-6 7 6 7m8-14 6 7-6 7m-3-17-2 20',
  thinking: 'M9 18v3h6v-3M9 17c0-3-4-3-4-8a7 7 0 0 1 14 0c0 5-4 5-4 8z',
  send: 'm3 3 18 9-18 9 3-9zM6 12h15',
  parent: 'M6 3v9a5 5 0 0 0 5 5h10m-4-4 4 4-4 4',
  link: 'm9 15 6-6M8 17l-2 2a4 4 0 0 1-6-6l5-5a4 4 0 0 1 6 0m2-1 2-2a4 4 0 0 1 6 6l-5 5a4 4 0 0 1-6 0',
  linear: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0M5 6l13 13M3 11l10 10M11 3l10 10',
  github_pr: 'M6 8v12M18 20V9a3 3 0 0 0-3-3h-3m3-3-3 3 3 3M8 5a2 2 0 1 1-4 0 2 2 0 0 1 4 0M8 20a2 2 0 1 1-4 0 2 2 0 0 1 4 0M20 20a2 2 0 1 1-4 0 2 2 0 0 1 4 0',
  pin: 'm9 3 9 3-3 5 1 5-5-1-6 6m3-8L5 8z',
  // Harnesses, drawn as neutral marks rather than their makers' logos.
  'claude-code': 'M12 3q1 8 9 9-8 1-9 9-1-8-9-9 8-1 9-9z',
  codex: 'M3 5h18v14H3zM7 10l3 2-3 2m5 1h5',
  // Agent settings.
  model: 'M7 7h10v10H7zM10 3v4m4-4v4m-4 10v4m4-4v4M3 10h4m-4 4h4m10-4h4m-4 4h4',
  effort: 'M4 17a8 8 0 0 1 16 0M12 17l4-5',
  mode: 'M12 3 20 6v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z',
  fast: 'M13 2 4 14h7l-1 8 9-12h-7z',
  context: 'M4 8V4h4m8 0h4v4m0 8v4h-4m-8 0H4v-4',
  client: 'M3 4h18v12H3zM8 20h8m-4-4v4',
  version: 'M3 12V3h9l9 9-9 9zM8 8h.01',
  approval: 'M4 12l5 5L20 6',
  sandbox: 'M12 3l8 4.5v9L12 21l-8-4.5v-9zM4 7.5l8 4.5 8-4.5M12 12v9',
  collaboration: 'M9 3h6v3H9zM6 5H5v16h14V5h-1M8 12h8m-8 4h5',
  summary: 'M4 6h16M4 12h16M4 18h10',
}

export function Icon({ name, size = 16 }: { name: string; size?: number }) {
  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={paths[name] ?? paths.board} />
    </svg>
  )
}
