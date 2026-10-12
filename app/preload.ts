import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('simcrawler', {
  getInitial: () => ipcRenderer.invoke('app:getInitial'),
  listDevices: () => ipcRenderer.invoke('adb:listDevices'),
  listPackages: (serial: string) => ipcRenderer.invoke('adb:listPackages', serial),
  listAvds: () => ipcRenderer.invoke('emulator:listAvds'),
  start: (settings: unknown) => ipcRenderer.invoke('run:start', settings),
  stop: () => ipcRenderer.invoke('run:stop'),
  getState: () => ipcRenderer.invoke('run:getState'),
  getShot: (index: number) => ipcRenderer.invoke('run:getShot', index),
  openLogs: () => ipcRenderer.invoke('run:openLogs'),

  onStatus: (callback: (message: string) => void) => {
    const handler = (_event: any, message: string) => callback(String(message));
    ipcRenderer.on('run:status', handler);
    return () => {
      ipcRenderer.removeListener('run:status', handler);
    };
  },

  onStarted: (callback: (snapshot: any) => void) => {
    const handler = (_event: any, snapshot: any) => callback(snapshot);
    ipcRenderer.on('run:started', handler);
    return () => {
      ipcRenderer.removeListener('run:started', handler);
    };
  },

  onUpdate: (callback: (payload: any) => void) => {
    const handler = (_event: any, payload: any) => callback(payload);
    ipcRenderer.on('run:update', handler);
    return () => {
      ipcRenderer.removeListener('run:update', handler);
    };
  },

  onFinished: (callback: (result: any) => void) => {
    const handler = (_event: any, result: any) => callback(result);
    ipcRenderer.on('run:finished', handler);
    return () => {
      ipcRenderer.removeListener('run:finished', handler);
    };
  },
});
