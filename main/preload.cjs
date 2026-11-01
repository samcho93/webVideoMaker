const { contextBridge, ipcRenderer, webUtils } = require('electron');

const invoke = (channel) => (...args) => ipcRenderer.invoke(channel, ...args);
const subscribe = (channel) => (cb) => {
  const handler = (_e, payload) => cb(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};

contextBridge.exposeInMainWorld('api', {
  pickMedia: invoke('media:pick'),
  probe: invoke('media:probe'),
  allow: invoke('media:allow'),
  derive: invoke('media:derive'),
  peaks: invoke('media:peaks'),
  proxy: invoke('media:proxy'),
  pathForFile: (file) => webUtils.getPathForFile(file),

  saveProject: invoke('project:save'),
  openProject: invoke('project:open'),
  readAutosave: invoke('project:readAutosave'),
  writeAutosave: invoke('project:writeAutosave'),
  clearAutosave: invoke('project:clearAutosave'),
  setDirty: invoke('project:setDirty'),
  pickRelink: invoke('project:pickRelink'),

  openTextFile: invoke('text:open'),
  saveTextFile: invoke('text:save'),
  resolveRelative: invoke('path:resolve'),

  ttsVoices: invoke('tts:voices'),
  ttsGenerate: invoke('tts:generate'),

  exportPickPath: invoke('export:pickPath'),
  exportBegin: invoke('export:begin'),
  exportWriteAsset: invoke('export:writeAsset'),
  exportStart: invoke('export:start'),
  exportCancel: invoke('export:cancel'),
  reveal: invoke('shell:reveal'),

  confirm: invoke('dialog:confirm'),
  onExportProgress: subscribe('export:progress'),
  onProxyProgress: subscribe('proxy:progress'),
  onMenu: subscribe('menu'),
  onOpenPath: subscribe('project:openPath'),
});
