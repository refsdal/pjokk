import { describe, expect, it } from "bun:test";
import { detectInstallState } from "../src/lib/install";

// The install hint exists because iOS never fires an install prompt: the only
// way onto the home screen is Share -> Add to Home Screen, and nothing in the
// app used to say so (a real user could not find it). Getting the *state*
// right is the whole feature — the wrong hint is worse than none, because
// "tap Share -> Add to Home Screen" is impossible to follow inside a Facebook
// or Mail webview, where that menu item does not exist at all.
//
// detectInstallState is deliberately pure: this suite has no DOM (see
// router.test.ts for why), and the real navigator values are read once at the
// call site. That also makes the UA matrix below cheap to extend when a new
// in-app browser turns up.

const IOS_SAFARI =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1";
// Facebook's webview: no Version/ token and no Safari/ token.
const IOS_FACEBOOK =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBAV/450.0.0.35.108]";
// A plain WKWebView (Mail, many "open in app" browsers): Safari-like, but
// carries neither Version/ nor Safari/.
const IOS_WEBVIEW =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148";
// Chrome on iOS: has Safari/ but no Version/, plus its own CriOS token.
const IOS_CHROME =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/131.0.6778.73 Mobile/15E148 Safari/604.1";
// iPadOS 13+ lies and calls itself a Macintosh; only maxTouchPoints betrays it.
const IPADOS_SAFARI =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15";
const MAC_SAFARI =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15";
const ANDROID_CHROME =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36";

const env = (over: {
  userAgent: string;
  standalone?: boolean;
  displayModeStandalone?: boolean;
  hasPrompt?: boolean;
  maxTouchPoints?: number;
}) => ({
  standalone: false,
  displayModeStandalone: false,
  hasPrompt: false,
  maxTouchPoints: 0,
  ...over,
});

describe("detectInstallState", () => {
  it("reports installed when the display mode is standalone", () => {
    expect(
      detectInstallState(
        env({ userAgent: ANDROID_CHROME, displayModeStandalone: true }),
      ),
    ).toBe("installed");
  });

  it("reports installed from navigator.standalone on iOS", () => {
    // iOS home-screen apps set navigator.standalone; older WebKit does not
    // report the standalone display-mode media query, so this is the only
    // signal there and must be honoured on its own.
    expect(
      detectInstallState(env({ userAgent: IOS_SAFARI, standalone: true })),
    ).toBe("installed");
  });

  it("offers the native prompt when one has been captured", () => {
    expect(
      detectInstallState(env({ userAgent: ANDROID_CHROME, hasPrompt: true })),
    ).toBe("prompt-available");
  });

  it("gives iOS Safari the Share-sheet instructions", () => {
    expect(detectInstallState(env({ userAgent: IOS_SAFARI }))).toBe(
      "ios-safari",
    );
  });

  it("treats iPadOS Safari as iOS despite the Macintosh user agent", () => {
    expect(
      detectInstallState(env({ userAgent: IPADOS_SAFARI, maxTouchPoints: 5 })),
    ).toBe("ios-safari");
  });

  it("sends an in-app webview to Safari instead", () => {
    // Add to Home Screen does not exist in these; telling the user to look
    // for it is the failure this whole feature is fixing.
    expect(detectInstallState(env({ userAgent: IOS_FACEBOOK }))).toBe(
      "ios-needs-safari",
    );
    expect(detectInstallState(env({ userAgent: IOS_WEBVIEW }))).toBe(
      "ios-needs-safari",
    );
  });

  it("sends third-party iOS browsers to Safari too", () => {
    // Chrome on iOS carries a Safari/ token, so the Version/ check is what
    // keeps it out of the ios-safari branch.
    expect(detectInstallState(env({ userAgent: IOS_CHROME }))).toBe(
      "ios-needs-safari",
    );
  });

  it("reports unsupported on a desktop browser with no prompt", () => {
    // Desktop Safari has no install path worth explaining; the hint should
    // stay hidden rather than invent instructions.
    expect(
      detectInstallState(env({ userAgent: MAC_SAFARI, maxTouchPoints: 0 })),
    ).toBe("unsupported");
  });

  it("trusts the iOS user agent over a captured prompt", () => {
    // WebKit never fires beforeinstallprompt, so on a real iPhone these two
    // signals cannot both be true — a prompt alongside an iOS UA means an
    // emulated or spoofed environment (Chromium with an iPhone UA, which is
    // exactly what e2e/install.spec.ts drives). Answering "ios-safari" there
    // keeps the browser test deterministic AND stays correct for every real
    // device, where the prompt simply never arrives.
    expect(
      detectInstallState(env({ userAgent: IOS_SAFARI, hasPrompt: true })),
    ).toBe("ios-safari");
  });

  it("prefers the installed state over a stale captured prompt", () => {
    expect(
      detectInstallState(
        env({
          userAgent: ANDROID_CHROME,
          displayModeStandalone: true,
          hasPrompt: true,
        }),
      ),
    ).toBe("installed");
  });
});
