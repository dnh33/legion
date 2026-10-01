#!/bin/sh
# A node shim that does NOT exec: the core is a grandchild of whatever main spawned (what `LEGION_NODE=<wrapper>` does).
# It stays in the foreground so the stdin pipe (the admin secret) reaches the core.
node "$@"
rc=$?
exit $rc
