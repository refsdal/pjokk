import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Avatar } from "../src/components/Avatar";
import { ChipGroup, MultiChipGroup } from "../src/components/Chips";

// Both chip groups take a `leading` node so a chip that names a person can
// carry their face (the help sheet's Who? row, the event sheet's assignees).
// A face in one place and an initial-less name in another is the bug this
// pins: the two groups must render the slot the same way.
describe("chip leading slot", () => {
  const options = [
    {
      value: "u1",
      label: "Kari",
      leading: (
        <Avatar src="/api/users/u1/avatar?v=k.jpg" name="Kari" size={5} />
      ),
    },
    { value: "u2", label: "Bo" },
  ];

  it("ChipGroup renders the leading node before the label", () => {
    const html = renderToStaticMarkup(
      <ChipGroup options={options} value="u1" onChange={() => {}} />,
    );
    expect(html).toContain('src="/api/users/u1/avatar?v=k.jpg"');
    expect(html.indexOf("<img")).toBeLessThan(html.indexOf(">Kari<"));
  });

  it("MultiChipGroup renders the leading node before the label", () => {
    const html = renderToStaticMarkup(
      <MultiChipGroup options={options} values={["u1"]} onToggle={() => {}} />,
    );
    expect(html).toContain('src="/api/users/u1/avatar?v=k.jpg"');
    expect(html.indexOf("<img")).toBeLessThan(html.indexOf(">Kari<"));
  });
});
