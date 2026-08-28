import { useQuery } from "@tanstack/react-query";
import type { Baby, Family, Invite, Member } from "@pjokk/shared";
import { api, unwrap } from "../api";

export function useFamily() {
  return useQuery({
    queryKey: ["family"],
    queryFn: async () => unwrap<Family>(await api.family.$get()),
  });
}

// Shared premium check — the same `plan !== "free"` read used across every
// client-side entitlement gate.
export function usePremium(): boolean {
  return (useFamily().data?.plan ?? "free") !== "free";
}

export function useBabies() {
  return useQuery({
    queryKey: ["babies"],
    queryFn: async () => unwrap<Baby[]>(await api.babies.$get()),
  });
}

export function useMembers() {
  return useQuery({
    queryKey: ["members"],
    queryFn: async () => unwrap<Member[]>(await api.family.members.$get()),
  });
}

export function useInvites(enabled: boolean) {
  return useQuery({
    queryKey: ["invites"],
    enabled,
    queryFn: async () => unwrap<Invite[]>(await api.invites.$get()),
  });
}
