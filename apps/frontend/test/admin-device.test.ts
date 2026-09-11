import { describe, expect, it } from "bun:test";
import { describeDevice } from "../src/lib/admin-device";

// The operator console's session rows (spec 2026-09-11-admin-user-support
// §4): a user agent, the way a person would name the device it came from.
// Real strings from real browsers; the order of the checks matters because
// Edge and Samsung Internet also say "Chrome", and every Chromium says
// "Safari".

const androidChrome =
  "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36";

const cases: [string, string][] = [
  [androidChrome, "Chrome on Android"],
  [
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
    "Safari on iPhone",
  ],
  [
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0.6478.54 Mobile/15E148 Safari/604.1",
    "Chrome on iPhone",
  ],
  [
    "Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
    "Safari on iPad",
  ],
  [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:127.0) Gecko/20100101 Firefox/127.0",
    "Firefox on Windows",
  ],
  [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0",
    "Edge on Windows",
  ],
  [
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15",
    "Safari on Mac",
  ],
  [
    "Mozilla/5.0 (Linux; Android 13; SM-S911B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0.0.0 Mobile Safari/537.36",
    "Samsung Internet on Android",
  ],
  [
    "Mozilla/5.0 (Android 14; Mobile; rv:127.0) Gecko/127.0 Firefox/127.0",
    "Firefox on Android",
  ],
  [
    "Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    "Chrome on ChromeOS",
  ],
  [
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    "Chrome on Linux",
  ],
];

describe("describeDevice", () => {
  for (const [ua, want] of cases) {
    it(want, () => {
      expect(describeDevice(ua)).toBe(want);
    });
  }

  it("says Unknown device when there is nothing to go on", () => {
    expect(describeDevice(null)).toBe("Unknown device");
    expect(describeDevice("")).toBe("Unknown device");
    expect(describeDevice("Go-http-client/1.1")).toBe("Unknown device");
  });

  it("takes the joining word and the fallback from the caller (the page translates them)", () => {
    expect(describeDevice(androidChrome, "på", "Ukjent enhet")).toBe(
      "Chrome på Android",
    );
    expect(describeDevice(null, "på", "Ukjent enhet")).toBe("Ukjent enhet");
  });
});
