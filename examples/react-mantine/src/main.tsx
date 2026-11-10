import { MantineProvider } from "@mantine/core";
import "@mantine/core/styles.css";
import { QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "react-router-dom";

import { queryClient, router } from "./App";
import { maybeInstallStalker } from "./shared/stalker/bootstrap";

// Installed before the first request so that early failures reach errors().
maybeInstallStalker();
createRoot(document.getElementById("root")!).render(
  <MantineProvider>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </MantineProvider>,
);
