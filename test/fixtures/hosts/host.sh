#!/bin/sh
# Fake terminal host for tests, linked as tmux, paseo, herdr, osascript and ps.
# Each call appends its name, arguments and stdin to $STUB_DIR/calls.log. For the
# n-th call to a name, prints <name>.out.<n> (else <name>.out), writes <name>.err
# to stderr and exits with <name>.exit.<n> (else <name>.exit, else 0), all read
# from $STUB_DIR. Never touches a real terminal.
name=${0##*/}
dir=$STUB_DIR
n=$(($(cat "$dir/$name.count" 2>/dev/null || echo 0) + 1))
echo "$n" >"$dir/$name.count"
# ps, like the real one, reads no stdin: the hook calls it with the payload still unread.
input=
[ "$name" = ps ] || input=$(cat)
{
  printf 'call=%s\n' "$name"
  for arg in "$@"; do printf 'arg=%s\n' "$arg"; done
  [ -z "$input" ] || printf 'stdin=%s\n' "$input"
  printf -- '---\n'
} >>"$dir/calls.log"
pick() { if [ -f "$dir/$name.$1.$n" ]; then cat "$dir/$name.$1.$n"; elif [ -f "$dir/$name.$1" ]; then cat "$dir/$name.$1"; fi; }
pick out
pick err >&2
code=$(pick exit)
exit "${code:-0}"
