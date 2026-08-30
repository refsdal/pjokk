import { describe, expect, it } from "bun:test";
import { isRedirect } from "@tanstack/react-router";
import { routeTree } from "../src/router";

// Regression coverage for a coordinator-caught bug: the landing split moved
// the public landing page off "/" without giving the SPA a "/" route of its
// own, so app.pjokk.no/ served the SPA shell (200 OK) into a router that
// matched nothing — a bare not-found screen at the app's own front door.
//
// This calls the route's beforeLoad directly rather than driving a full
// router.load(): TanStack Router decides "server" vs "client" loading by
// checking for a global `document`, and the frontend suite has no DOM (no
// jsdom/happy-dom configured) to make that check come out the client way —
// forcing `isServer: false` on a router built with `createMemoryHistory`
// throws on the very next line (`window is not defined`), since the client
// path also reaches for `window.origin`. Exercising beforeLoad directly
// tests exactly the thing that regressed (does "/" resolve to a redirect,
// and where to) without needing a browser this suite doesn't have.
describe('the "/" route', () => {
  it("redirects to /home instead of matching nothing", () => {
    const rootIndex = (
      routeTree as unknown as {
        children: Array<{ id: string; options: { beforeLoad?: () => void } }>;
      }
    ).children.find((child) => child.id === "/");
    expect(rootIndex).toBeDefined();

    let caught: unknown;
    try {
      rootIndex?.options.beforeLoad?.();
    } catch (err) {
      caught = err;
    }

    expect(isRedirect(caught)).toBe(true);
    expect((caught as { options: { to?: string } }).options.to).toBe("/home");
  });
});
