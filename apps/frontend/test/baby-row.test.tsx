import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { BabyRow } from "../src/components/BabyHeader";
import { babyStatus } from "../src/lib/baby-status";

// The baby row is the same on every baby screen: the babies in a FIXED
// order (the list's, oldest first), the selected one as a pill carrying
// name and age, the others as bare faces beside it — so each child keeps
// a fixed spot under the thumb and the ring says which is current.
const babies = [
  {
    id: "b1",
    name: "Emma",
    birthDate: "2026-06-15T00:00:00.000Z",
    sex: "girl" as const,
    avatarUrl: "/api/babies/b1/avatar?v=k.jpg",
    features: [],
  },
  {
    id: "b2",
    name: "Oskar",
    birthDate: "2024-01-10T00:00:00.000Z",
    sex: "boy" as const,
    avatarUrl: null,
    features: [],
  },
];

describe("BabyRow", () => {
  it("renders the selected baby as a pill with name and age, the rest as faces", () => {
    const html = renderToStaticMarkup(
      <BabyRow babies={babies} selectedId="b2" onSelect={() => {}} />,
    );
    // Both are buttons; the selected one is pressed and carries the name
    // as text, the other names itself for the screen reader only.
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('aria-pressed="false"');
    expect(html).toContain(">Oskar<");
    expect(html).not.toContain(">Emma<");
    expect(html).toContain('aria-label="Emma"');
    // The photo shows where there is one; the initial stands in otherwise.
    expect(html).toContain('src="/api/babies/b1/avatar?v=k.jpg"');
    expect(html).toContain(">O<");
  });

  it("keeps the list's order whichever baby is selected", () => {
    const html = renderToStaticMarkup(
      <BabyRow babies={babies} selectedId="b2" onSelect={() => {}} />,
    );
    expect(html.indexOf('aria-label="Emma"')).toBeLessThan(
      html.indexOf(">Oskar<"),
    );
  });

  it("is a plain heading with one baby, not a control", () => {
    const html = renderToStaticMarkup(
      <BabyRow
        babies={babies.slice(0, 1)}
        selectedId="b1"
        onSelect={() => {}}
      />,
    );
    expect(html).not.toContain("<button");
    expect(html).not.toContain("aria-pressed");
    expect(html).toContain(">Emma<");
  });

  // The ring says what she is doing right now: sleep purple while a
  // session runs, barnehage green while she is there, the accent otherwise.
  it("colours the selected pill's ring by the baby's status", () => {
    const none = renderToStaticMarkup(
      <BabyRow babies={babies} selectedId="b2" onSelect={() => {}} />,
    );
    expect(none).toContain('data-status="none"');
    expect(none).toMatch(/aria-pressed="true"[^>]*ring-accent/);
    const sleeping = renderToStaticMarkup(
      <BabyRow
        babies={babies}
        selectedId="b2"
        status="sleeping"
        onSelect={() => {}}
      />,
    );
    expect(sleeping).toContain('data-status="sleeping"');
    expect(sleeping).toMatch(/aria-pressed="true"[^>]*ring-sleep/);
    expect(sleeping).not.toMatch(/aria-pressed="true"[^>]*ring-accent/);
    const there = renderToStaticMarkup(
      <BabyRow
        babies={babies}
        selectedId="b2"
        status="daycare"
        onSelect={() => {}}
      />,
    );
    expect(there).toMatch(/aria-pressed="true"[^>]*ring-daycare/);
  });

  it("gives a single baby a ring only while something is happening", () => {
    const quiet = renderToStaticMarkup(
      <BabyRow
        babies={babies.slice(0, 1)}
        selectedId="b1"
        onSelect={() => {}}
      />,
    );
    expect(quiet).not.toContain("ring-2");
    const there = renderToStaticMarkup(
      <BabyRow
        babies={babies.slice(0, 1)}
        selectedId="b1"
        status="daycare"
        onSelect={() => {}}
      />,
    );
    expect(there).toContain("ring-2");
    expect(there).toContain("ring-daycare");
    expect(there).toContain('data-status="daycare"');
    expect(there).not.toContain("<button");
  });
});

describe("babyStatus", () => {
  const base = { activeSleep: null, activeDaycare: null };
  it("is sleeping first, then at barnehage, else nothing", () => {
    expect(babyStatus(undefined)).toBeNull();
    expect(babyStatus(base)).toBeNull();
    expect(babyStatus({ ...base, activeDaycare: { id: "d" } })).toBe("daycare");
    expect(babyStatus({ ...base, activeSleep: { id: "s" } })).toBe("sleeping");
    expect(
      babyStatus({ activeSleep: { id: "s" }, activeDaycare: { id: "d" } }),
    ).toBe("sleeping");
  });
});
