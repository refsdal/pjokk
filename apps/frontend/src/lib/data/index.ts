import type { QueryClient } from "@tanstack/react-query";
import { registerFeedTimerMutationDefaults } from "./feed-timer";
import { registerLogMutationDefaults } from "./logs";
import { registerOtherMutationDefaults } from "./other";
import { registerPlayMutationDefaults } from "./play";

// One import site for the data layer; modules are split by domain.
export * from "./calendar";
export * from "./config";
export * from "./contacts";
export * from "./family";
export * from "./feed-timer";
export * from "./help";
export * from "./insights";
export * from "./keys";
export * from "./logs";
export * from "./other";
export * from "./photos";
export * from "./play";
export * from "./profile";
export * from "./reminders";
export * from "./sleep-locations";
export * from "./vaccines";

export function registerMutationDefaults(qc: QueryClient) {
  registerLogMutationDefaults(qc);
  registerFeedTimerMutationDefaults(qc);
  registerOtherMutationDefaults(qc);
  registerPlayMutationDefaults(qc);
}
