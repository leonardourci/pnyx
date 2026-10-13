import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <main className="flex min-h-screen items-center justify-center bg-surface font-sans text-ink">
      <p>Pnyx board: no cards yet.</p>
    </main>
  </StrictMode>,
);
