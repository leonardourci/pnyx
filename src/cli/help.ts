// The usage lines and notes for one subcommand, cut from its command's help: `task create --help`
// shows `task create`, not every task subcommand. Unmatched subcommands keep the whole help.
export function focusedHelp({
  help,
  command,
  sub,
}: {
  help: string
  command: string
  sub?: string
}): string {
  if (!sub || sub.startsWith('-')) {
    return help
  }

  const prefix = `pnyx-axi ${command} `
  const bare = ({ line }: { line: string }) => line.replace(
    /^usage:/,
    '',
  ).trim()
  const names = ({ line }: { line: string }) => bare({ line })
    .slice(prefix.length)
    .split(/[<[]|--/)[0]
    .split(/[\s|]+/)
    .filter(Boolean)
  const kept: string[] = []
  let keep = false

  for (const line of help.split('\n')) {
    const usage = bare({ line }).startsWith(prefix)

    if (usage) {
      keep = names({ line }).includes(sub)
    }

    if (keep) {
      kept.push(usage ? bare({ line }) : line)
    }
  }

  return kept.length ? `usage: ${kept.join('\n')}\n` : help
}

// The flags a help text names, for an unknown-flag error.
export function helpFlags({ help }: { help: string }): string[] {
  return [...new Set(help.match(/--[a-z][a-z-]*/g) ?? [])]
}
