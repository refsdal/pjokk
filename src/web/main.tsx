import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "@tanstack/react-router";
import { PersistQueryClientProvider } from "@tanstack/react-query-persist-client";
import { registerSW } from "virtual:pwa-register";
import { registerMutationDefaults } from "@/lib/data";
import { announceUpdate } from "@/lib/pwa";
import { persistOptions, queryClient } from "@/lib/query";
import { router } from "@/router";
import "./styles.css";

registerMutationDefaults(queryClient);

const updateSW = registerSW({
  onNeedRefresh() {
    announceUpdate(() => void updateSW(true));
  },
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <PersistQueryClientProvider
      client={queryClient}
      persistOptions={persistOptions}
      onSuccess={() => {
        // Mutations queued offline resume as soon as the cache is restored.
        void queryClient.resumePausedMutations();
      }}
    >
      <RouterProvider router={router} />
    </PersistQueryClientProvider>
  </StrictMode>,
);
