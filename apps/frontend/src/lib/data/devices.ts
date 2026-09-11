import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Member } from "@pjokk/shared";
import type { components } from "@pjokk/shared";
import { ApiError, client, unwrap } from "../api";

// Kiosk devices (docs/superpowers/specs/2026-09-10-kiosk-devices-design.md):
// the family admin's Settings → Family → Devices, and the tablet's own side
// — enrolling with a one-time code, reading itself, leaving with the PIN.

type Schemas = components["schemas"];
export type Device = Schemas["Device"];
export type DeviceCode = Schemas["DeviceCode"];
export type DeviceSelf = Schemas["DeviceSelf"];
export type DeviceThreshold = Schemas["DeviceThreshold"];

// --- the admin's side ------------------------------------------------------

const DEVICES = ["devices"] as const;

export function useDevices(enabled: boolean) {
  return useQuery({
    queryKey: DEVICES,
    enabled,
    queryFn: async () => unwrap<Device[]>(client.GET("/api/devices")),
  });
}

export function useCreateDevice() {
  const qc = useQueryClient();
  return useMutation<DeviceCode, Error, string>({
    mutationFn: async (name) =>
      unwrap<DeviceCode>(client.POST("/api/devices", { body: { name } })),
    onSettled: () => qc.invalidateQueries({ queryKey: DEVICES }),
  });
}

export function useRenewDeviceCode() {
  const qc = useQueryClient();
  return useMutation<DeviceCode, Error, string>({
    mutationFn: async (id) =>
      unwrap<DeviceCode>(
        client.POST("/api/devices/{id}/code", { params: { path: { id } } }),
      ),
    onSettled: () => qc.invalidateQueries({ queryKey: DEVICES }),
  });
}

export function useRevokeDevice() {
  const qc = useQueryClient();
  return useMutation<unknown, Error, string>({
    mutationFn: async (id) =>
      unwrap(client.DELETE("/api/devices/{id}", { params: { path: { id } } })),
    onSettled: () => qc.invalidateQueries({ queryKey: DEVICES }),
  });
}

// --- the tablet's side -----------------------------------------------------
//
// Everything under ["device", …] is persisted (lib/query.ts's NEVER_PERSIST
// does not list it): a kiosk that reloads with no signal must still start,
// and still show who can log. The family's members are read under this key
// too, rather than the shared ["members"], which is never persisted because
// on a person's session it is identity, not content.

export function useDeviceSelf() {
  return useQuery({
    queryKey: ["device"],
    retry: false,
    queryFn: async () => unwrap<DeviceSelf>(client.GET("/api/device")),
  });
}

export function useDeviceMembers() {
  return useQuery({
    queryKey: ["device", "members"],
    queryFn: async () => unwrap<Member[]>(client.GET("/api/family/members")),
  });
}

export function useDeviceThresholds() {
  return useQuery({
    queryKey: ["device", "thresholds"],
    queryFn: async () =>
      unwrap<DeviceThreshold[]>(client.GET("/api/device/thresholds")),
  });
}

export async function enrolDevice(
  code: string,
  pin: string,
): Promise<DeviceSelf> {
  return unwrap<DeviceSelf>(
    client.POST("/api/device/enrol", { body: { code, pin } }),
  );
}

export type UnenrolResult = "ok" | "wrong" | "limited" | "offline" | "error";

export async function unenrolDevice(pin: string): Promise<UnenrolResult> {
  try {
    await unwrap(client.POST("/api/device/unenrol", { body: { pin } }));
    return "ok";
  } catch (err) {
    return unenrolOutcome(err);
  }
}

// What the PIN pad does with an unenrol that failed. A fetch that threw
// (rather than answering) means no connection. A device already revoked
// elsewhere is "ok": leaving is what was asked for, and the clean-up is the
// same.
export function unenrolOutcome(err: unknown): UnenrolResult {
  if (!(err instanceof ApiError)) return "offline";
  if (err.code === "WRONG_PIN") return "wrong";
  if (err.status === 429) return "limited";
  if (err.code === "DEVICE_REVOKED") return "ok";
  return "error";
}
