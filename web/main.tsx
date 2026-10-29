import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { TickProvider } from "./lib/clock.tsx";
import { CipherProvider } from "./lib/store.tsx";
import "./app.css";

const host = document.getElementById("root");
if (host === null) throw new Error("Missing #root");

createRoot(host).render(
  <StrictMode>
    <TickProvider>
      <CipherProvider>
        <App />
      </CipherProvider>
    </TickProvider>
  </StrictMode>,
);
