import type { ComponentProps, SubmitEvent } from 'react'
import { Button } from '#web-shared/ui/controls.tsx'

export function ProjectForm({
  submit,
  ...props
}: Omit<ComponentProps<'form'>, 'onSubmit'> & { submit({ event }: { event: SubmitEvent<HTMLFormElement> }): void }) {
  return <form {...props} onSubmit={event => submit({ event })} className="project-form grid gap-2 mt-4 [&_fieldset]:border-0 [&_fieldset]:p-0 [&_fieldset]:m-0 [&_fieldset]:grid [&_fieldset]:gap-2 [&_fieldset]:min-w-0 [&_fieldset_label]:grid [&_fieldset_label]:gap-1 [&>label]:grid [&>label]:gap-1.5 [&>label]:text-meta" />
}

export function ProjectList({ ...props }: ComponentProps<'ul'>) {
  return <ul {...props} className="project-list list-none p-0 m-0" />
}

export function ProjectActions({ ...props }: ComponentProps<'div'>) {
  return <div {...props} className="project-actions flex items-center flex-wrap gap-1.5" />
}

export function FolderChoice({
  className = '',
  retainFocus = false,
  ...props
}: Omit<ComponentProps<'button'>, 'onPointerDown'> & { retainFocus?: boolean }) {
  return (
    <Button
      {...props}
      onPointerDown={event => {
        if (retainFocus) {
          event.preventDefault()
        }
      }}
      className={`w-full flex flex-col items-start gap-0.75 text-left ${className}`}
    />
  )
}

export function FolderDescription({ ...props }: ComponentProps<'small'>) {
  return <small {...props} className="block max-w-full text-muted text-meta wrap-anywhere" />
}
