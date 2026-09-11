import { describe, expect, test } from "bun:test";
import type { LanguageMode } from "../src/lib/i18n";
import { planLanguageSync } from "../src/lib/language-sync";

// A device whose own language is Norwegian: "auto" resolves to nb here.
const norwegianDevice = (m: LanguageMode) => (m === "auto" ? "nb" : m);

describe("planLanguageSync", () => {
  test("uploads the device's choice when the server has none yet", () => {
    expect(
      planLanguageSync(
        { languageMode: null, language: "en" },
        "auto",
        norwegianDevice,
      ),
    ).toEqual({ patch: { languageMode: "auto", language: "nb" } });
  });

  test("adopts the person's choice made on another device", () => {
    expect(
      planLanguageSync(
        { languageMode: "nb", language: "nb" },
        "en",
        norwegianDevice,
      ),
    ).toEqual({ adopt: "nb" });
  });

  test("reports what auto resolves to on this device", () => {
    // Auto was last resolved to English on the laptop; this phone is
    // Norwegian, so pushes switch to Norwegian.
    expect(
      planLanguageSync(
        { languageMode: "auto", language: "en" },
        "auto",
        norwegianDevice,
      ),
    ).toEqual({ patch: { language: "nb" } });
  });

  test("adopting can also correct the stored language", () => {
    expect(
      planLanguageSync(
        { languageMode: "auto", language: "en" },
        "en",
        norwegianDevice,
      ),
    ).toEqual({ adopt: "auto", patch: { language: "nb" } });
  });

  test("does nothing when device and server agree", () => {
    expect(
      planLanguageSync(
        { languageMode: "en", language: "en" },
        "en",
        norwegianDevice,
      ),
    ).toEqual({});
  });
});
