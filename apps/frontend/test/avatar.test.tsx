import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Avatar, initialOf } from "../src/components/Avatar";

// No DOM in this suite (see router.test.ts), so the component is checked
// through static markup: with a src it is an <img>, without one it is the
// initial. The onError fallback needs a browser and is covered by the
// Playwright spec (an offline image falls back to the initial).
describe("Avatar", () => {
  it("renders the photo when there is one", () => {
    const html = renderToStaticMarkup(
      <Avatar src="/api/users/u1/avatar?v=k.jpg" name="Anders" size={8} />,
    );
    expect(html).toContain("<img");
    expect(html).toContain('src="/api/users/u1/avatar?v=k.jpg"');
  });

  it("falls back to the initial without a photo", () => {
    const html = renderToStaticMarkup(
      <Avatar src={null} name="anders" size={8} />,
    );
    expect(html).not.toContain("<img");
    expect(html).toContain(">A<");
  });
});

describe("initialOf", () => {
  it("upper-cases the first letter and copes with blanks", () => {
    expect(initialOf("pappa")).toBe("P");
    expect(initialOf("  Liv ")).toBe("L");
    expect(initialOf("")).toBe("?");
  });
});
