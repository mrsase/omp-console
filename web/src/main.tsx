import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles/index.css";
import { App } from "./App";
import { StoreProvider, defaultStore } from "./store/hooks";

const root = document.getElementById("root");
if (!root) throw new Error("root element missing");

createRoot(root).render(
  <StrictMode>
    <StoreProvider store={defaultStore}>
      <App />
    </StoreProvider>
  </StrictMode>,
);
