import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  BabyAbout,
  Contact,
  FeedLog,
  MedicineCatalogueEntry,
  SleepLog,
} from "@pjokk/shared";
import { client, unwrap } from "../api";

// Everything the "About <name>" page reads (issue #109): the four typed
// lines, and the ordinary list reads the routines are derived from — the
// same endpoints the screens use, at their 200-row cap, which is more than
// the two weeks the page looks at.
export function useAboutMe(babyId: string | undefined) {
  const on = !!babyId;
  const about = useQuery({
    queryKey: ["baby-about", babyId],
    enabled: on,
    queryFn: async () =>
      unwrap<BabyAbout>(
        client.GET("/api/babies/{id}/about", {
          params: { path: { id: babyId! } },
        }),
      ),
  });
  const sleeps = useQuery({
    queryKey: ["sleep", babyId, 200],
    enabled: on,
    queryFn: async () =>
      unwrap<SleepLog[]>(
        client.GET("/api/sleep", {
          params: { query: { babyId: babyId!, limit: 200 } },
        }),
      ),
  });
  const feeds = useQuery({
    queryKey: ["feeds", babyId, 200],
    enabled: on,
    queryFn: async () =>
      unwrap<FeedLog[]>(
        client.GET("/api/feeds", {
          params: { query: { babyId: babyId!, limit: 200 } },
        }),
      ),
  });
  const medicines = useQuery({
    queryKey: ["medicines", babyId ?? null],
    enabled: on,
    queryFn: async () =>
      unwrap<MedicineCatalogueEntry[]>(
        client.GET("/api/medicines", {
          params: { query: { babyId: babyId! } },
        }),
      ),
  });
  const contacts = useQuery({
    queryKey: ["contacts"],
    enabled: on,
    queryFn: async () => unwrap<Contact[]>(client.GET("/api/contacts")),
  });
  return {
    about: about.data,
    sleeps: sleeps.data ?? [],
    feeds: feeds.data ?? [],
    medicines: medicines.data ?? [],
    contacts: contacts.data ?? [],
    loading: about.isLoading || sleeps.isLoading || feeds.isLoading,
  };
}

export function useSaveBabyAbout() {
  const qc = useQueryClient();
  return useMutation<BabyAbout, Error, { babyId: string; about: BabyAbout }>({
    mutationFn: async ({ babyId, about }) =>
      unwrap<BabyAbout>(
        client.PUT("/api/babies/{id}/about", {
          params: { path: { id: babyId } },
          body: about,
        }),
      ),
    onSuccess: (saved, { babyId }) =>
      qc.setQueryData(["baby-about", babyId], saved),
  });
}
