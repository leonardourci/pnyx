// The usage lines and notes for one subcommand, cut from its command's help: `task create --help`
// shows `task create`, not every task subcommand. Unmatched subcommands keep the whole help.
export function focusedHelp({
  help,
  command,
  sub,
  rest = [],
}: {
  help: string
  command: string
  sub?: string
  rest?: string[]
}): string {
  if (!sub || sub.startsWith('-')) {
    return help
  }

  const words = [
    sub,
    ...rest,
  ].filter(word => !word.startsWith('-'))
  const prefix = `pnyx-axi ${command} `
  const bare = ({ line }: { line: string }) => line.replace(
    /^usage:/,
    '',
  ).trim()
  // The subcommand word, or its alternatives: `hide|unhide <id>` names hide and unhide.
  const names = ({ line }: { line: string }) => bare({ line })
    .slice(prefix.length)
    .split(/\s/)
  const kept: string[] = []
  let keep = false

  for (const line of help.split('\n')) {
    const usage = bare({ line }).startsWith(prefix)

    if (usage) {
      const syntax = names({ line })
      keep = words.every((
        word,
        index,
      ) => {
        const token = syntax[index]

        return !token || token.startsWith('<') || token.startsWith('[') || token.split('|').includes(word)
      })
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

export function nextCommands({
  output,
  fallback,
  hydraId,
  args,
}: {
  output: object
  fallback: string
  hydraId: string
  args: string[]
}): string[] {
  const hydraFlag = args.find(arg => arg.startsWith('--hydra='))
  const hydraIndex = args.indexOf('--hydra')
  const selected = hydraFlag?.slice('--hydra='.length) ?? args[hydraIndex + 1]
  const hydra = hydraFlag || hydraIndex >= 0 ? selected : hydraId

  if ('card' in output && output.card && typeof output.card === 'object' && 'id' in output.card) {
    return [`Run \`pnyx-axi task show ${output.card.id} --hydra ${hydra}\` to inspect the changed task`]
  }

  return [fallback]
}
