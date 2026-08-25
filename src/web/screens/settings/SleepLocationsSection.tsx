import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  useAddSleepLocation,
  useDeleteSleepLocation,
  useSleepLocations,
} from "@/lib/data";
import { t } from "@/lib/i18n";
import { toast } from "@/lib/toast";

export function SleepLocationsSection() {
  const [name, setName] = useState("");
  const locations = useSleepLocations();
  const addLocation = useAddSleepLocation();
  const deleteLocation = useDeleteSleepLocation();

  const add = () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    addLocation.mutate(trimmed, {
      onSuccess: () => setName(""),
      onError: (err) => toast(err.message, "error"),
    });
  };

  return (
    <Card className="space-y-4">
      <p className="text-sm text-muted">
        {t(
          "Extra sleep-location chips for this family, alongside Crib, Stroller & Contact nap.",
        )}
      </p>

      {(locations.data ?? []).map((loc) => (
        <div key={loc.id} className="flex items-center gap-3">
          <p className="flex-1 truncate text-sm font-semibold text-ink">
            {loc.name}
          </p>
          <Button
            size="sm"
            variant="ghost"
            className="text-danger"
            onClick={() =>
              deleteLocation.mutate(loc.id, {
                onError: (err) => toast(err.message, "error"),
              })
            }
          >
            {t("Delete")}
          </Button>
        </div>
      ))}

      <div className="flex items-center gap-2">
        <Input
          placeholder={t("Location (e.g. “Hammock”)")}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <Button
          variant="secondary"
          disabled={addLocation.isPending || name.trim().length === 0}
          onClick={add}
        >
          {t("Add location")}
        </Button>
      </div>
    </Card>
  );
}
