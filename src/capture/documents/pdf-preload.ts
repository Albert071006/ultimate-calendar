import { contextBridge, ipcRenderer } from 'electron';
contextBridge.exposeInMainWorld('documentPdf', Object.freeze({
  receive: (listener: (id: string, bytes: Uint8Array, kind: 'pdf' | 'image') => void) => {
    ipcRenderer.on('calendar:pdf:extract', (_event, id: unknown, bytes: unknown, kind: unknown) => {
      if (typeof id === 'string' && bytes instanceof Uint8Array && bytes.byteLength <= 25 * 1024 * 1024 && (kind === 'pdf' || kind === 'image')) listener(id, bytes, kind);
    });
  },
  complete: (id: string, result: unknown) => ipcRenderer.send('calendar:pdf:complete', id, result),
}));
