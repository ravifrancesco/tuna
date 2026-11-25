#!/bin/sh
# Make sure the data folder (often a bind mount Docker created as root) belongs to
# the app user, then drop root and start Tuna. PUID/PGID match your other
# containers (default 1000).
set -e
PUID="${PUID:-1000}"
PGID="${PGID:-1000}"
if [ "$(id -u)" = "0" ]; then
  mkdir -p "$TUNA_DATA_DIR"
  if chown -R "$PUID:$PGID" "$TUNA_DATA_DIR" 2>/dev/null; then
    echo "tuna: data folder $TUNA_DATA_DIR ready for $PUID:$PGID"
  else
    echo "tuna: couldn't change owner of $TUNA_DATA_DIR (network share?); settings may not save"
  fi
  exec su-exec "$PUID:$PGID" node /app/server.cjs
fi
exec node /app/server.cjs
