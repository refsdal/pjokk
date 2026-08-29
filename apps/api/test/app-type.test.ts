import { describe, expect, it } from "bun:test";
import type { hc } from "hono/client";
import type { AppType } from "../src/app";

// The RPC client's types come from the accumulated .route() chain. Moving
// that chain inside createApi() risks collapsing it to `any`, which no
// runtime test can see: every call still compiles, the frontend just stops
// being typed. These assertions fail `bun run typecheck` if that happens.

type IsAny<T> = 0 extends 1 & T ? true : false;
type Assert<T extends true> = T;

// If AppType is `any`, this line is an error.
type _AppTypeIsNotAny = Assert<IsAny<AppType> extends true ? false : true>;

type Client = ReturnType<typeof hc<AppType>>;

// A known route must still be reachable through the client's shape. If the
// chain collapsed, `api` or `feeds` would not exist as keys.
type _HasFeedsGet = Assert<
  "$get" extends keyof Client["api"]["feeds"] ? true : false
>;
type _HasSleepPost = Assert<
  "$post" extends keyof Client["api"]["sleep"] ? true : false
>;

describe("AppType", () => {
  it("survives being derived from createApi's return", () => {
    // The assertions above are compile-time; this keeps the file in the test
    // run so a future reader does not delete it as dead code.
    expect(true).toBe(true);
  });
});
