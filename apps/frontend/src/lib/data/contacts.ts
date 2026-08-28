import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Contact, CreateContact, UpdateContact } from "@pjokk/shared";
import { api, unwrap } from "../api";

export function useContacts() {
  return useQuery({
    queryKey: ["contacts"],
    queryFn: async () => unwrap<Contact[]>(await api.contacts.$get()),
  });
}

export function useSaveContact(id?: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (json: CreateContact | UpdateContact) =>
      id
        ? unwrap<Contact>(
            await api.contacts[":id"].$patch({
              param: { id },
              json: json as UpdateContact,
            }),
          )
        : unwrap<Contact>(
            await api.contacts.$post({ json: json as CreateContact }),
          ),
    onSuccess: () =>
      void queryClient.invalidateQueries({ queryKey: ["contacts"] }),
  });
}

export function useDeleteContact() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) =>
      unwrap(await api.contacts[":id"].$delete({ param: { id } })),
    onSuccess: () =>
      void queryClient.invalidateQueries({ queryKey: ["contacts"] }),
  });
}
