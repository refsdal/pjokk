import { describe, expect, test } from "bun:test";
import {
  formatMeasurementIn,
  formatVolume,
  measurementScale,
  volumeScale,
} from "../src/lib/units";

describe("volume", () => {
  test("metric passes through, imperial rounds to a tenth of an ounce", () => {
    expect(formatVolume(120, "metric")).toBe("120 ml");
    expect(formatVolume(120, "imperial")).toBe("4.1 oz");
    expect(volumeScale("imperial").toCanonical(4)).toBe(118);
  });
  test("an untouched prefill survives: conversion only happens on change", () => {
    const s = volumeScale("imperial");
    // The sheet shows 4.1 oz for 120 ml but keeps 120 ml until stepped.
    expect(s.toDisplay(120)).toBe(4.1);
    expect(s.toCanonical(s.toDisplay(120) + s.step)).toBe(136);
  });
});

describe("measurements", () => {
  test("weight, length and temperature in imperial", () => {
    expect(formatMeasurementIn("weight", 3.2, "imperial")).toBe("7.1 lb");
    expect(formatMeasurementIn("length", 52, "imperial")).toBe("20.47 in");
    expect(formatMeasurementIn("temperature", 38.4, "imperial")).toBe(
      "101.1 °F",
    );
    expect(formatMeasurementIn("temperature", 38.4, "metric")).toBe("38.4 °C");
  });
  test("imperial steppers cover the same clinical range and convert back", () => {
    const f = measurementScale("temperature", "imperial");
    expect(f.min).toBe(89.6);
    expect(f.max).toBe(109.4);
    expect(f.toCanonical(100.4)).toBe(38);
    const lb = measurementScale("weight", "imperial");
    expect(lb.toCanonical(7.1)).toBe(3.22);
    const inch = measurementScale("head", "imperial");
    expect(inch.toCanonical(15.75)).toBe(40);
  });
});
