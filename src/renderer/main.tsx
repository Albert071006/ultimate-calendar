import { createRoot } from "react-dom/client";
import { useState } from 'react';
// Legacy page styles load first so the A2 theme imported by App wins on equal specificity.
import "./styles.css";
import { App } from "./App";
import { RemoteApp } from './remote/RemoteApp';
import { StartupBoundary } from './remote/StartupBoundary';
import { createRemoteClient } from './remote/client';
import { resolveConnection } from './client-context';
const container = document.getElementById("root");
if (!container) throw Error("缺少应用容器");
const desktop = resolveConnection({});
function BrowserApp() {
  const [controller] = useState(() => createRemoteClient());
  return <RemoteApp controller={controller} />;
}
createRoot(container).render(desktop.client ? <App client={desktop.client} host={desktop.host} /> : <StartupBoundary><BrowserApp /></StartupBoundary>);
// Caching the static application shell is separate from notification permission and subscription.
if (!desktop.client && import.meta.env.PROD && 'serviceWorker' in navigator) {
  void navigator.serviceWorker.register('/sw.js').catch(() => console.warn('离线应用壳未就绪；请保持联网并重新打开。'));
}
