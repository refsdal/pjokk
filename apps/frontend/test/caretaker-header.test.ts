import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { CARETAKER_HEADER, caretakerInit, client } from "../src/lib/api";
import { registerMutationDefaults } from "../src/lib/data";

// A kiosk write names who is logging (spec 2026-09-10-kiosk-devices §6). The
// caretaker rides in the mutation's VARIABLES — persisted with a paused
// mutation, so a feed queued offline still carries the person who tapped it
// — and the request function turns it into a header. It must never reach
// the body: the server validates bodies against the spec.

const ok = (data: unknown = { id: "x1" }) =>
  ({ data, error: undefined, response: new Response(null) }) as never;

function run(key: string, vars: unknown) {
  const qc = new QueryClient();
  registerMutationDefaults(qc);
  const fn = qc.getMutationDefaults([key]).mutationFn as (
    v: unknown,
  ) => Promise<unknown>;
  return fn(vars);
}

afterEach(() => mock.restore());

describe("caretakerInit", () => {
  test("names the caretaker in a header", () => {
    expect(caretakerInit("u1")).toEqual({
      headers: { [CARETAKER_HEADER]: "u1" },
    });
  });
  test("adds nothing without one", () => {
    expect(caretakerInit()).toEqual({});
  });
});

describe("kiosk writes carry the caretaker as a header, never in the body", () => {
  test("logDiaper", async () => {
    const post = spyOn(client, "POST").mockResolvedValue(ok());
    await run("logDiaper", {
      babyId: "b1",
      time: "t",
      type: "wet",
      caretakerId: "u1",
    });
    expect(post).toHaveBeenCalledWith("/api/diapers", {
      body: { babyId: "b1", time: "t", type: "wet" },
      headers: { [CARETAKER_HEADER]: "u1" },
    });
  });

  test("logDiaper from Home sends no header", async () => {
    const post = spyOn(client, "POST").mockResolvedValue(ok());
    await run("logDiaper", { babyId: "b1", time: "t", type: "wet" });
    expect(post).toHaveBeenCalledWith("/api/diapers", {
      body: { babyId: "b1", time: "t", type: "wet" },
    });
  });

  test("logFeed", async () => {
    const post = spyOn(client, "POST").mockResolvedValue(ok());
    await run("logFeed", {
      babyId: "b1",
      time: "t",
      type: "bottle",
      amountMl: 120,
      caretakerId: "u1",
    });
    expect(post).toHaveBeenCalledWith("/api/feeds", {
      body: { babyId: "b1", time: "t", type: "bottle", amountMl: 120 },
      headers: { [CARETAKER_HEADER]: "u1" },
    });
  });

  test("startSleep and wakeSleep", async () => {
    const post = spyOn(client, "POST").mockResolvedValue(ok());
    await run("startSleep", {
      babyId: "b1",
      startTime: "t",
      caretakerId: "u1",
    });
    expect(post).toHaveBeenCalledWith("/api/sleep", {
      body: { babyId: "b1", startTime: "t" },
      headers: { [CARETAKER_HEADER]: "u1" },
    });
    await run("wakeSleep", { id: "s1", endTime: "t2", caretakerId: "u2" });
    expect(post).toHaveBeenLastCalledWith("/api/sleep/{id}/wake", {
      params: { path: { id: "s1" } },
      body: { endTime: "t2" },
      headers: { [CARETAKER_HEADER]: "u2" },
    });
  });

  test("resumeSleep", async () => {
    const patch = spyOn(client, "PATCH").mockResolvedValue(ok());
    await run("resumeSleep", { id: "s1", babyId: "b1", caretakerId: "u1" });
    expect(patch).toHaveBeenCalledWith("/api/sleep/{id}", {
      params: { path: { id: "s1" } },
      body: { endTime: null },
      headers: { [CARETAKER_HEADER]: "u1" },
    });
  });

  test("the Undo deletes", async () => {
    const del = spyOn(client, "DELETE").mockResolvedValue(ok(null));
    await run("deleteDiaper", { id: "d1", caretakerId: "u1" });
    expect(del).toHaveBeenCalledWith("/api/diapers/{id}", {
      params: { path: { id: "d1" } },
      headers: { [CARETAKER_HEADER]: "u1" },
    });
    await run("deleteOther", { kind: "medicine", id: "m1", caretakerId: "u1" });
    expect(del).toHaveBeenLastCalledWith("/api/medicine/{id}", {
      params: { path: { id: "m1" } },
      headers: { [CARETAKER_HEADER]: "u1" },
    });
  });

  test("the medicine strip", async () => {
    const post = spyOn(client, "POST").mockResolvedValue(ok());
    await run("createOther", {
      kind: "medicine",
      babyId: "b1",
      time: "t",
      name: "Paracet",
      caretakerId: "u1",
    });
    expect(post).toHaveBeenCalledWith("/api/medicine", {
      body: { babyId: "b1", time: "t", name: "Paracet" },
      headers: { [CARETAKER_HEADER]: "u1" },
    });
  });

  test("the nursing timer", async () => {
    const post = spyOn(client, "POST").mockResolvedValue(ok());
    await run("startFeedTimer", {
      babyId: "b1",
      kind: "breast",
      side: "left",
      startTime: "t",
      caretakerId: "u1",
    });
    expect(post).toHaveBeenCalledWith("/api/feeds/timer", {
      body: { babyId: "b1", kind: "breast", side: "left", startTime: "t" },
      headers: { [CARETAKER_HEADER]: "u1" },
    });
    await run("setFeedTimerSide", {
      id: "f1",
      babyId: "b1",
      side: "right",
      caretakerId: "u1",
    });
    expect(post).toHaveBeenLastCalledWith("/api/feeds/timer/{id}/side", {
      params: { path: { id: "f1" } },
      body: { side: "right" },
      headers: { [CARETAKER_HEADER]: "u1" },
    });
    await run("stopFeedTimer", {
      id: "f1",
      babyId: "b1",
      kind: "breast",
      time: "t2",
      caretakerId: "u1",
    });
    expect(post).toHaveBeenLastCalledWith("/api/feeds/timer/{id}/stop", {
      params: { path: { id: "f1" } },
      body: { time: "t2" },
      headers: { [CARETAKER_HEADER]: "u1" },
    });
  });
});
