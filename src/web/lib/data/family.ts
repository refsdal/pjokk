import { useQuery } from "@tanstack/react-query";
import type { Baby, Invite, Member } from "@shared/schemas";
import { api, unwrap } from "../api";

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
