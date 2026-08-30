// The adapters. Imported ONLY by apps/server, through the
// "@pjokk/api/infrastructure" package entry.
//
// They live in this package because they are the implementations of this
// package's ports and are tested against a real Postgres alongside the
// queries they serve. What makes the boundary real is not their location but
// the rule that nothing under routes/ or middleware/ may import them — see
// the noRestrictedImports rule in biome.json.

export { createDb } from "./db";
export { createStorage, type S3Config } from "./storage";
export { createRateLimitStore } from "./rate-limit";
export { createStripe } from "./stripe";
export { createAuth, type AuthConfig } from "./auth";
export { createPushSender, type VapidConfig } from "./push";
