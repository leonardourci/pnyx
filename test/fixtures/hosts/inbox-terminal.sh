#!/bin/sh
case "${0##*/}" in
  ps) printf 'ttys042\n' ;;
  tmux)
    case "$*" in
      *capture-pane*) cat "$STUB_DIR/composer" ;;
      *cursor_y*) printf '/dev/ttys042\t1\n' ;;
      *display-message*) printf '/dev/ttys042\n' ;;
      *load-buffer*) cat >> "$STUB_DIR/notices" ;;
    esac
    ;;
esac
