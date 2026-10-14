#!/bin/sh
# Fake terminal host for tests, linked as tmux, paseo, herdr, osascript and ps.
# Each call appends its name, arguments and stdin to $STUB_DIR/calls.log. For the
# n-th call to a name, prints <name>.out.<n> (else <name>.out), writes <name>.err
# to stderr and exits with <name>.exit.<n> (else <name>.exit, else 0), all read
# from $STUB_DIR. When <name>.spool.<n> exists, the n-th call also drops it into the
# default board's hook spool under $PNYX_HOME, as a hook firing meanwhile would, and
# <name>.append.<n> is appended to the file named in $STUB_DIR/append.path, as a
# harness recording the change in its transcript would.
# Never touches a real terminal.
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
if [ -f "$dir/$name.spool.$n" ]; then
  mkdir -p "$PNYX_HOME/boards/default/spool"
  cp "$dir/$name.spool.$n" "$PNYX_HOME/boards/default/spool/000000000000000-$name-$n.json"
fi
[ -f "$dir/$name.append.$n" ] && cat "$dir/$name.append.$n" >>"$(cat "$dir/append.path")"
pick() { if [ -f "$dir/$name.$1.$n" ]; then cat "$dir/$name.$1.$n"; elif [ -f "$dir/$name.$1" ]; then cat "$dir/$name.$1"; fi; }
pick out
pick err >&2
code=$(pick exit)
exit "${code:-0}"
