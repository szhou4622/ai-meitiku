#!/bin/sh
set -eu

launcher_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec "$launcher_dir/runtime/bin/python3" "$launcher_dir/engine/engine_entry.py" "$@"
