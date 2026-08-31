// Command pjokk is the container's entrypoint. It will grow into the same
// dispatch-mode CLI as `/app/dispatch` on the Bun predecessor (see REF §A4:
// default mode migrates+serves, `server`/`worker`/`migrate`/`cron`/
// `healthcheck` modes). For now it is a stub: real dispatch lands in a
// later task.
package main

import (
	"fmt"
	"os"
)

func main() {
	fmt.Fprintln(os.Stderr, "usage: pjokk <mode> — dispatch modes not yet implemented")
	os.Exit(2)
}
