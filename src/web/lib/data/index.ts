import type { QueryClient } from "@tanstack/react-query";
import { registerLogMutationDefaults } from "./logs";
import { registerOtherMutationDefaults } from "./other";
import { registerPlayMutationDefaults } from "./play";

// One import site for the data layer; modules are split by domain.
export * from "./calendar";
export * from "./contacts";
export * from "./family";
export * from "./insights";
export * from "./keys";
export * from "./logs";
export * from "./other";
export * from "./play";
export * from "./sleep-locations";

export function registerMutationDefaults(qc: QueryClient) {
  registerLogMutationDefaults(qc);
  registerOtherMutationDefaults(qc);
  registerPlayMutationDefaults(qc);
}
