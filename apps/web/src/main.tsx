import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@assessiq/ui-system/styles/tokens.css";
import "./styles/globals.css";
import { App } from "./App";

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("Root element #root missing in index.html");

createRoot(rootEl).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
