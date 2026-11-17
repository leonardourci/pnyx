import type { ComponentProps } from 'react'

export function Prose({ ...props }: ComponentProps<'div'>) {
  return <div {...props} className="markdown min-w-0 max-w-full font-chat text-chat font-normal not-italic leading-(--chat-line) wrap-anywhere [&_p]:my-(--block-gap) [&_p]:mx-0 [&>:first-child]:mt-0 [&>.message-block:first-child>:first-child]:mt-0 [&>:last-child]:mb-0 [&>.message-block:last-child>:last-child]:mb-0 [&_:is(h1,h2,h3,h4,h5,h6)]:font-chat [&_:is(h1,h2,h3,h4,h5,h6)]:text-pane [&_:is(h1,h2,h3,h4,h5,h6)]:font-bold [&_:is(h1,h2,h3,h4,h5,h6)]:leading-prose-heading [&_:is(h1,h2,h3,h4,h5,h6)]:mt-prose-heading [&_:is(h1,h2,h3,h4,h5,h6)]:mx-0 [&_:is(h1,h2,h3,h4,h5,h6)]:mb-prose-heading-bottom [&_:is(ul,ol)]:pl-prose-list [&_:is(ul,ol)]:my-(--block-gap) [&_:is(ul,ol)]:mx-0 [&_ul]:list-disc [&_ol]:list-decimal [&_li]:my-prose-item [&_li]:mx-0 [&_li_p]:inline [&_a]:text-blue [&_a]:underline [&_a]:underline-offset-3 [&_blockquote]:border-l-2 [&_blockquote]:border-gold-line [&_blockquote]:my-(--block-gap) [&_blockquote]:mx-0 [&_blockquote]:pl-3 [&_blockquote]:text-muted [&_hr]:border-0 [&_hr]:border-t [&_hr]:border-line [&_hr]:my-(--block-gap) [&_hr]:mx-0 in-[:is(.card,.ask)]:[font-weight:inherit] in-[:is(.card,.ask)]:[&_:is(h1,h2,h3,h4,h5,h6)]:text-prose-question-heading in-[:is(.card,.ask)]:[&_:is(h1,h2,h3,h4,h5,h6)]:mt-prose-question-heading in-[:is(.card,.ask)]:[&_:is(h1,h2,h3,h4,h5,h6)]:mb-prose-question-heading-bottom in-[:is(.card,.ask)]:[&_:is(p,ul,ol)]:my-prose-question in-[:is(.card,.ask)]:[&_:is(p,ul,ol):first-child]:mt-prose-question in-[:is(.card,.ask)]:[&_:is(p,ul,ol):last-child]:mb-prose-question in-[:is(.card,.ask)]:[&_li]:my-prose-question-item in-[:is(.card,.ask)]:[&_:is(ul,ol)]:pl-prose-question-list in-[:is(.card,.ask)]:[&_blockquote]:my-prose-question in-[:is(.card,.ask)]:[&_blockquote]:pl-1.75" />
}

export function ProseCode({
  block = false,
  ...props
}: ComponentProps<'code'> & { block?: boolean }) {
  const appearance = block ? 'p-0 bg-transparent' : 'py-px px-1 bg-raised rounded-preview'

  return <code {...props} className={`font-mono text-code font-normal not-italic leading-[normal] in-[:is(.card,.ask)]:text-prose-question-code ${appearance}`} />
}
