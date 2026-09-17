import { describe, expect, it } from "bun:test";
import { eventFaces } from "../src/lib/calendar-ui";

// The faces at the right edge of an upcoming-events row: the babies the
// event is about, then the people responsible, each looked up in the two
// avatar maps the screen already has. A face missing from a map is an
// initial, never a hole.
describe("eventFaces", () => {
  const event = {
    babies: [{ id: "b1", name: "Emma" }],
    assignees: [
      { userId: "u1", name: "Anne" },
      { userId: "u2", name: "Bo" },
    ],
  };

  it("lists the babies first, then the assignees", () => {
    const faces = eventFaces(
      event,
      { b1: "/api/babies/b1/avatar?v=k.jpg" },
      { u1: "/api/users/u1/avatar?v=a.jpg" },
    );
    expect(faces).toEqual([
      { key: "baby:b1", name: "Emma", src: "/api/babies/b1/avatar?v=k.jpg" },
      { key: "user:u1", name: "Anne", src: "/api/users/u1/avatar?v=a.jpg" },
      { key: "user:u2", name: "Bo", src: null },
    ]);
  });

  it("is empty for an event about nobody in particular", () => {
    expect(eventFaces({ babies: [], assignees: [] }, {}, {})).toEqual([]);
  });
});
