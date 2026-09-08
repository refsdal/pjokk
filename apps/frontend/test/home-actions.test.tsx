import { describe, expect, it } from "bun:test";
import { IconPill } from "@tabler/icons-react";
import { renderToStaticMarkup } from "react-dom/server";
import { HomeActions } from "../src/components/HomeActions";

// No DOM here (see router.test.ts): the markup is checked statically. The
// tier is CSS — the More button is `md:hidden`, the unfolded tiles are
// `hidden md:...` — so both are always in the markup and what changes is
// which one the viewport shows (e2e/layout.spec.ts checks that).
const noop = () => {};
const actions = [
  {
    key: "medicine",
    label: "Medicine",
    icon: IconPill,
    tint: "text-growth",
    pick: noop,
  },
  {
    key: "help",
    label: "Ask for help",
    icon: IconPill,
    tint: "text-danger",
    pick: noop,
  },
];

describe("HomeActions", () => {
  const html = renderToStaticMarkup(
    <HomeActions
      active={false}
      onFeed={noop}
      onDiaper={noop}
      onSleep={noop}
      onMore={noop}
      actions={actions}
    />,
  );

  it("renders the three primaries and a More button hidden from md up", () => {
    expect(html).toContain(">Feed<");
    expect(html).toContain(">Diaper<");
    expect(html).toContain(">Sleep<");
    expect(html).toMatch(/md:hidden[^>]*>[\s\S]*?>More</);
  });

  it("renders every action as a row tile under a 'Log something' label, hidden below md", () => {
    expect(html).toContain("Log something");
    expect(html).toContain(">Medicine<");
    expect(html).toContain(">Ask for help<");
    expect(html).toContain('data-testid="home-actions-unfolded"');
    expect(html).toMatch(
      /data-testid="home-actions-unfolded"[^>]*class="[^"]*\bhidden\b[^"]*md:flex/,
    );
  });

  it("disables Sleep while a session runs", () => {
    const running = renderToStaticMarkup(
      <HomeActions
        active
        onFeed={noop}
        onDiaper={noop}
        onSleep={noop}
        onMore={noop}
        actions={[]}
      />,
    );
    expect(running).toContain(">Sleeping…<");
    expect(running).toMatch(/disabled=""[^>]*>[\s\S]*?>Sleeping…</);
  });
});
