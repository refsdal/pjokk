import { describe, expect, it } from "bun:test";
import { deviceGateVerdict } from "../src/lib/kiosk-ui";

// What the kiosk's DeviceGate makes of GET /api/device's answer (spec
// 2026-09-10-kiosk-devices §6).

const base = { code: null, hadDevice: true, revoked: false, leaving: false };

describe("deviceGateVerdict", () => {
  it("lets an enrolled device through", () => {
    expect(deviceGateVerdict(base)).toBe("ok");
  });

  it("sees a revoke, whichever request heard it", () => {
    expect(deviceGateVerdict({ ...base, code: "DEVICE_REVOKED" })).toBe(
      "revoked",
    );
    expect(deviceGateVerdict({ ...base, revoked: true })).toBe("revoked");
  });

  it("reads NOT_A_DEVICE on a tablet that HAD a device as a revoke", () => {
    // A sibling request's 401 cleared the cookie first; the device query,
    // sent after, answers NOT_A_DEVICE. Its cached answer gives it away.
    expect(deviceGateVerdict({ ...base, code: "NOT_A_DEVICE" })).toBe(
      "revoked",
    );
  });

  it("reads NOT_A_DEVICE on a tablet that never had one as an old-style kiosk", () => {
    expect(
      deviceGateVerdict({ ...base, code: "NOT_A_DEVICE", hadDevice: false }),
    ).toBe("not-a-device");
  });

  it("stays quiet while leaving is under way", () => {
    expect(
      deviceGateVerdict({
        ...base,
        code: "NOT_A_DEVICE",
        hadDevice: false,
        leaving: true,
      }),
    ).toBe("leaving");
    expect(deviceGateVerdict({ ...base, revoked: true, leaving: true })).toBe(
      "leaving",
    );
  });
});
