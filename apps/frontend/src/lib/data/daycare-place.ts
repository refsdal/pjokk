import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  DaycarePlace,
  DaycarePlaceInput,
  PickupPlan,
  PickupPlanDay,
} from "@pjokk/shared";
import { client, unwrap } from "../api";
import { t } from "../i18n";
import { toast } from "../toast";

// The barnehage as a place, and who collects her (spec
// docs/superpowers/specs/2026-09-17-daycare-place-and-pickup-plan-design.md).
// Ordinary online mutations, like care-days: this is set up once on the
// sofa, and a save that fails should say so. Home reads the place and the
// plan off the summary, so every write here invalidates that too.

const PLACES = "daycare-places";
const PLAN = "pickup-plan";

const failed = (err: Error) =>
  toast(`${t("Could not save")}: ${err.message}`, "error");

export function useDaycarePlaces(on = true) {
  return useQuery({
    queryKey: [PLACES],
    enabled: on,
    queryFn: async () =>
      unwrap<DaycarePlace[]>(client.GET("/api/daycare-places")),
  });
}

function useSettled() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: [PLACES] });
    void qc.invalidateQueries({ queryKey: [PLAN] });
    void qc.invalidateQueries({ queryKey: ["summary"] });
  };
}

// One mutation for create and update: the body is the same whole place.
export function useSaveDaycarePlace() {
  const onSettled = useSettled();
  return useMutation<
    DaycarePlace,
    Error,
    { id?: string; place: DaycarePlaceInput }
  >({
    mutationFn: async ({ id, place }) =>
      id
        ? unwrap<DaycarePlace>(
            client.PUT("/api/daycare-places/{id}", {
              params: { path: { id } },
              body: place,
            }),
          )
        : unwrap<DaycarePlace>(
            client.POST("/api/daycare-places", { body: place }),
          ),
    onError: failed,
    onSettled,
  });
}

export function useRemoveDaycarePlace() {
  const onSettled = useSettled();
  return useMutation<unknown, Error, { id: string }>({
    mutationFn: async ({ id }) =>
      unwrap(
        client.DELETE("/api/daycare-places/{id}", {
          params: { path: { id } },
        }),
      ),
    onError: failed,
    onSettled,
  });
}

export function usePickupPlan(babyId: string | undefined) {
  return useQuery({
    queryKey: [PLAN, babyId],
    enabled: !!babyId,
    queryFn: async () =>
      unwrap<PickupPlan>(
        client.GET("/api/babies/{id}/pickup-plan", {
          params: { path: { id: babyId! } },
        }),
      ),
  });
}

export function useSetPickupPlan() {
  const onSettled = useSettled();
  return useMutation<
    PickupPlan,
    Error,
    { babyId: string; days: PickupPlanDay[] }
  >({
    mutationFn: async ({ babyId, days }) =>
      unwrap<PickupPlan>(
        client.PUT("/api/babies/{id}/pickup-plan", {
          params: { path: { id: babyId } },
          body: { days },
        }),
      ),
    onError: failed,
    onSettled,
  });
}

// Who collects on ONE day; a null userId hands the day back to the grid.
export function useSetPickupOverride() {
  const onSettled = useSettled();
  return useMutation<
    PickupPlan,
    Error,
    { babyId: string; date: string; userId: string | null }
  >({
    mutationFn: async ({ babyId, date, userId }) =>
      unwrap<PickupPlan>(
        client.PUT("/api/babies/{id}/pickup-override", {
          params: { path: { id: babyId } },
          body: { date, userId },
        }),
      ),
    onError: failed,
    onSettled,
  });
}
