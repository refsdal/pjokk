import type { QueryClient } from "@tanstack/react-query";
import { registerLogMutationDefaults } from "./logs";
import { registerOtherMutationDefaults } from "./other";

// One import site for the data layer; modules are split by domain.
export * from "./calendar";
export * from "./family";
export * from "./insights";
export * from "./keys";
export * from "./logs";
export * from "./other";
export * from "./sleep-locations";

export function registerMutationDefaults(qc: QueryClient) {
  registerLogMutationDefaults(qc);
  registerOtherMutationDefaults(qc);
}
