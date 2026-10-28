// A text file attached to a message travels as a `File: <name>` line and a fenced block.
export const FILE_BLOCK = /^File: ([^\n]+)\n\n(`{3,})\n[\s\S]*?\n\2$/gm

// A fence longer than any backtick run inside keeps the file one block.
export function fileBlock({
  name,
  text,
}: {
  name: string
  text: string
}) {
  const longest = Math.max(
    2,
    ...[...text.matchAll(/`+/g)].map(match => match[0].length),
  )
  const fence = '`'.repeat(longest + 1)

  return `File: ${name}\n\n${fence}\n${text.replace(
    /\n$/,
    '',
  )}\n${fence}`
}
