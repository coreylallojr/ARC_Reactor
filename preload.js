'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('jarvis', {
  getAppDir:       ()      => ipcRenderer.invoke('get-app-dir'),
  getNeuralDir:    ()      => ipcRenderer.invoke('get-neural-dir'),
  getConfig:       ()      => ipcRenderer.invoke('get-config'),
  getHomeDir:      ()      => ipcRenderer.invoke('get-home-dir'),
  getPlatform:     ()      => ipcRenderer.invoke('get-platform'),
  probePython:     (p)     => ipcRenderer.invoke('probe-python', p),
  probeOllama:     ()      => ipcRenderer.invoke('probe-ollama'),
  probePiperModel: ()      => ipcRenderer.invoke('probe-piper-model'),
  probeClaudeCode: ()      => ipcRenderer.invoke('probe-claude-code'),
  saveConfig:      (u)     => ipcRenderer.invoke('save-config', u),
  writeHooks:      ()      => ipcRenderer.invoke('write-hooks'),
  writeShellAlias: ()      => ipcRenderer.invoke('write-shell-alias'),
  writeMcpConfig:  (d)     => ipcRenderer.invoke('write-mcp-config', d),
  openFileDialog:  (o)     => ipcRenderer.invoke('open-file-dialog', o),
  launchJarvis:    ()      => ipcRenderer.invoke('launch-jarvis'),
});
