import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import { App } from "./App.tsx";
import { tauriApi } from "./api.ts";

createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    <App api={tauriApi} />
  </StrictMode>,
);
