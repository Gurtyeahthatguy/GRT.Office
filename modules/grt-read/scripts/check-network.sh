#!/usr/bin/env bash
# Watches the program for outgoing connections.
set -uo pipefail

BINARY="${1:-}"

if [[ -z "$BINARY" || ! -x "$BINARY" ]]; then
  echo "Usage: $0 <path-to-binary>" >&2
  exit 2
fi

if ! command -v strace >/dev/null 2>&1; then
  echo "ERROR: strace is not installed (sudo apt install strace)" >&2
  exit 2
fi

LOG="$(mktemp -t grt-network-XXXXXX.log)"
echo "Tracing $BINARY"
echo "Use the program, then close it to see the result."
echo

strace -f -qq -e trace=socket,connect,sendto -o "$LOG" "$BINARY" >/dev/null 2>&1

# Local sockets are how the window talks to its own webview process; only
# AF_INET and AF_INET6 mean the machine's network was actually used.
HITS=$(grep -E 'socket\(AF_INET6?|connect\(.*(sin_addr|sin6_addr)' "$LOG" | grep -v '127\.0\.0\.1' | grep -v '::1')

echo "----------------------------------------"
if [[ -z "$HITS" ]]; then
  echo "RESULT: no outbound network activity."
else
  echo "RESULT: network activity found:"
  echo "$HITS" | head -20
fi
echo
echo "Full trace kept at: $LOG"

[[ -z "$HITS" ]]
