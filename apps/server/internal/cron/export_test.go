package cron

import "context"

// Test-only seams for the package's tests, which live in package cron_test:
// they need internal/testrig, which imports internal/api, which imports this
// package — so an in-package test importing the rig would be an import
// cycle. This file compiles only under `go test` and imports no rig.

// MaxRunError is maxRunError, the cap on a stored error.
const MaxRunError = maxRunError

// SetJobBody swaps the work every run does — so a test can make a job fail,
// panic or block — and returns the function that puts RunJob back.
func SetJobBody(body func(context.Context, string, Deps) error) (restore func()) {
	jobBody = body
	return func() { jobBody = RunJob }
}

// RunSafely is runSafely, the scheduler's recover-and-log wrapper.
func RunSafely(ctx context.Context, name string, fn func(context.Context) error) {
	runSafely(ctx, name, fn)
}
