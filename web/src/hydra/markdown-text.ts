import { Marked, type Token } from 'marked'

export const markdown = new Marked({ gfm: true })
export const decodeEntities = ({ text }: { text: string }) => text.replace(
  /&(?:#x[\da-f]+|#\d+|[a-z][a-z\d]+);/gi,
  entity => {
  // Only a single character reference enters this inert decoder, never markup.
    const decoder = document.createElement('textarea')
    decoder.innerHTML = entity

    return decoder.value
  },
)

export const inlineText = ({ tokens }: { tokens: Token[] }): string => tokens.map(token => {
  if (token.type === 'codespan') {
    return token.text
  }

  if (token.type === 'br') {
    return ''
  }

  if ('tokens' in token && token.tokens) {
    return inlineText({ tokens: token.tokens })
  }

  return 'text' in token ? decodeEntities({ text: String(token.text) }) : token.raw
}).join('')

export const markdownText = ({ text }: { text: string }) => markdown.lexer(text).filter(token => token.type !== 'space')
  .map(token => {
    if (token.type === 'code') {
      return token.text
    }

    if ('tokens' in token && token.tokens) {
      return inlineText({ tokens: token.tokens })
    }

    return token.raw.trim()
  })
  .join('\n\n')
