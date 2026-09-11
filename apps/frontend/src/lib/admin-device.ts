// A user agent, the way a person would name the device it came from — for
// the operator console's session rows (spec 2026-09-11-admin-user-support
// §4): "Chrome on Android", not a 130-character header. A guide for an
// operator, not a fingerprint: anything it does not recognise is an
// unknown device, and nothing else in the app reads it.

// Order matters. Edge and Samsung Internet also say "Chrome", every
// Chromium also says "Safari", and Safari itself is only Safari when it
// carries a "Version/" and nothing earlier in the list matched.
const browsers: [RegExp, string][] = [
  [/\bEdg(A|iOS)?\//, "Edge"],
  [/\bOPR\//, "Opera"],
  [/\bSamsungBrowser\//, "Samsung Internet"],
  [/\b(Firefox|FxiOS)\//, "Firefox"],
  [/\b(CriOS|Chrome)\//, "Chrome"],
  [/\bVersion\/[\d.]+.*\bSafari\//, "Safari"],
];

// iPhone and iPad say "like Mac OS X", and Android and ChromeOS say "Linux":
// the specific ones come first.
const systems: [RegExp, string][] = [
  [/\biPhone\b/, "iPhone"],
  [/\biPad\b/, "iPad"],
  [/\bAndroid\b/, "Android"],
  [/\bCrOS\b/, "ChromeOS"],
  [/\bWindows\b/, "Windows"],
  [/\bMac OS X\b|\bMacintosh\b/, "Mac"],
  [/\bLinux\b/, "Linux"],
];

// `on` and `unknown` come from the caller, which translates them.
export function describeDevice(
  userAgent: string | null | undefined,
  on = "on",
  unknown = "Unknown device",
): string {
  if (!userAgent) return unknown;
  const browser = browsers.find(([re]) => re.test(userAgent))?.[1];
  const os = systems.find(([re]) => re.test(userAgent))?.[1];
  if (browser && os) return `${browser} ${on} ${os}`;
  return browser ?? os ?? unknown;
}
