import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Contact, CreateContact, UpdateContact } from "@pjokk/shared";
import { client, unwrap } from "../api";

export function useContacts() {
  return useQuery({
    queryKey: ["contacts"],
    queryFn: async () => unwrap<Contact[]>(client.GET("/api/contacts")),
  });
}

export function useSaveContact(id?: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (json: CreateContact | UpdateContact) =>
      id
        ? unwrap<Contact>(
            client.PATCH("/api/contacts/{id}", {
              params: { path: { id } },
              body: json as UpdateContact,
            }),
          )
        : unwrap<Contact>(
            client.POST("/api/contacts", { body: json as CreateContact }),
          ),
    onSuccess: () =>
      void queryClient.invalidateQueries({ queryKey: ["contacts"] }),
  });
}

export function useDeleteContact() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) =>
      unwrap(client.DELETE("/api/contacts/{id}", { params: { path: { id } } })),
    onSuccess: () =>
      void queryClient.invalidateQueries({ queryKey: ["contacts"] }),
  });
}
