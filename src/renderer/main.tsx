import { createRoot } from "react-dom/client";
// Legacy page styles load first so the A2 theme imported by App wins on equal specificity.
import "./styles.css";
import { App } from "./App";
const container = document.getElementById("root");
if (!container) throw Error("缺少应用容器");
createRoot(container).render(<App />);
