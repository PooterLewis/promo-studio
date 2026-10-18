'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('studio', {
  info: () => ipcRenderer.invoke('app:info'),
  listSources: () => ipcRenderer.invoke('sources:list'),
  chooseSource: (id, audio) => ipcRenderer.invoke('sources:choose', id, audio),
  recOpen: name => ipcRenderer.invoke('rec:open', name),
  recWrite: (id, buf) => ipcRenderer.invoke('rec:write', id, buf),
  recClose: id => ipcRenderer.invoke('rec:close', id),
  saveFile: (name, buf) => ipcRenderer.invoke('file:save', name, buf),
  reveal: file => ipcRenderer.invoke('file:reveal', file),
  openFolder: () => ipcRenderer.invoke('folder:open'),
  recState: on => ipcRenderer.send('rec:state', !!on),
  setTheme: t => ipcRenderer.send('theme:set', t),
  nativeInfo: () => ipcRenderer.invoke('native:info'),
  nativeStart: opts => ipcRenderer.invoke('native:start', opts),
  nativeStop: (id, name) => ipcRenderer.invoke('native:stop', id, name),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  checkUpdate: () => ipcRenderer.invoke('update:check'),
  onHotkey: fn => ipcRenderer.on('hotkey', (e, action) => fn(action)),
  onUpdate: fn => ipcRenderer.on('update', (e, info) => fn(info)),
});
