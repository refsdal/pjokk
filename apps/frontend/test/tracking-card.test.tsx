import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { TrackingCard } from "../src/components/tracking/TrackingCard";
import {
  featureCatalogue,
  featureMeta,
  groupTitles,
} from "../src/lib/tracking";

const noop = () => {};

describe("TrackingCard", () => {
  it("is a switch, dimmed when off and lit when on", () => {
    const off = renderToStaticMarkup(
      <TrackingCard
        meta={featureMeta("diapers")}
        on={false}
        tag={null}
        readOnly={false}
        onToggle={noop}
      />,
    );
    expect(off).toContain('role="switch"');
    expect(off).toContain('aria-checked="false"');
    expect(off).toContain('data-on="false"');
    const on = renderToStaticMarkup(
      <TrackingCard
        meta={featureMeta("diapers")}
        on
        tag="Recommended at Ida's age"
        readOnly={false}
        onToggle={noop}
      />,
    );
    expect(on).toContain('aria-checked="true"');
    expect(on).toContain('data-on="true"');
    expect(on).toContain("Recommended at Ida");
  });

  it("shows On / Off text instead of a switch for a member", () => {
    const html = renderToStaticMarkup(
      <TrackingCard
        meta={featureMeta("sleep")}
        on
        tag={null}
        readOnly
        onToggle={noop}
      />,
    );
    expect(html).not.toContain('role="switch"');
    expect(html).toContain(">On<");
  });

  it("renders a mock for every key", () => {
    for (const meta of featureCatalogue) {
      const html = renderToStaticMarkup(
        <TrackingCard
          meta={meta}
          on
          tag={null}
          readOnly={false}
          onToggle={noop}
        />,
      );
      expect(html).toContain("tracking-mock");
      expect(html).toContain("tracking-anim");
    }
  });
});

// The catalogue's strings reach t() through variables, which
// scripts/check-i18n.mjs (literals only) cannot see — so this is where a
// label or description without Norwegian fails.
describe("catalogue translations", () => {
  const dict = readFileSync(
    new URL("../src/lib/i18n.ts", import.meta.url),
    "utf8",
  );
  const keys = new Set(
    [
      ...dict.matchAll(/^\s{2}(?:"((?:[^"\\]|\\.)*)"|([A-Za-z_$][\w$]*)):/gm),
    ].map((m) => (m[1] ?? m[2] ?? "").replaceAll('\\"', '"')),
  );
  it("has Norwegian for every label, description and group title", () => {
    const missing: string[] = [];
    for (const f of featureCatalogue) {
      if (!keys.has(f.label)) missing.push(f.label);
      if (!keys.has(f.description)) missing.push(f.description);
    }
    for (const title of Object.values(groupTitles)) {
      if (!keys.has(title)) missing.push(title);
    }
    expect(missing).toEqual([]);
  });
});
