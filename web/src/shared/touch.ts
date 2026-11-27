// The `touch` variant in index.css: a touch screen without hover, typed on with the on-screen keyboard.
export const touchFirst = () => matchMedia('(pointer: coarse) and (hover: none)').matches
