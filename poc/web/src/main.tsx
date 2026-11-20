import { createRoot } from "react-dom/client";
import { App } from "./app";
import { boot, pollRunningThread } from "./lib/store";
import "./styles.css";

const container = document.getElementById("root");
if (!container) throw new Error("missing #root");

createRoot(container).render(<App />);

void boot();
window.setInterval(pollRunningThread, 3000);
