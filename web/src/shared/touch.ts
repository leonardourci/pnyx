const TOUCH_MEDIA_QUERY = '(pointer: coarse) and (hover: none)'

export const touchFirst = () => matchMedia(TOUCH_MEDIA_QUERY).matches
