import { describe, expect, test } from "bun:test";
import { ApiError } from "../src/lib/api";
import { unenrolOutcome } from "../src/lib/data/devices";
import { onDeviceRevoked, reportIfDeviceRevoked } from "../src/lib/query";

// The tablet's side of kiosk devices (spec 2026-09-10-kiosk-devices §6).

describe("unenrolOutcome", () => {
  test("maps the server's answers to what the PIN pad does", () => {
    expect(unenrolOutcome(new ApiError(403, "Wrong PIN", "WRONG_PIN"))).toBe(
      "wrong",
    );
    expect(unenrolOutcome(new ApiError(429, "Too many", "RATE_LIMITED"))).toBe(
      "limited",
    );
    // Revoked elsewhere meanwhile: leaving is what was asked for.
    expect(unenrolOutcome(new ApiError(401, "Revoked", "DEVICE_REVOKED"))).toBe(
      "ok",
    );
    expect(unenrolOutcome(new ApiError(500, "Boom", "INTERNAL"))).toBe("error");
  });
  test("a fetch that threw means no connection", () => {
    expect(unenrolOutcome(new TypeError("Failed to fetch"))).toBe("offline");
  });
});

describe("reportIfDeviceRevoked", () => {
  test("tells every listener about DEVICE_REVOKED, and nothing else", () => {
    let heard = 0;
    const off = onDeviceRevoked(() => heard++);
    reportIfDeviceRevoked(new ApiError(401, "Revoked", "DEVICE_REVOKED"));
    reportIfDeviceRevoked(
      new ApiError(401, "Not signed in", "UNAUTHENTICATED"),
    );
    reportIfDeviceRevoked(new Error("network"));
    expect(heard).toBe(1);
    off();
    reportIfDeviceRevoked(new ApiError(401, "Revoked", "DEVICE_REVOKED"));
    expect(heard).toBe(1);
  });
});
