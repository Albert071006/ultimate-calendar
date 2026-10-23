import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";
import "./theme/tokens.css";
import "./theme/base.css";
const container = document.getElementById("root");
if (!container) throw Error("缺少应用容器");
createRoot(container).render(<App />);
