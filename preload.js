'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// The only bridge between the portal page and Electron. Deliberately tiny:
// the page can learn that an update is ready and ask to restart, nothing more.
contextBridge.exposeInMainWorld('portalUpdates', {
  onUpdateReady: (callback)=>{
    ipcRenderer.on('update:ready', (_event, info)=> callback(info));
  },
  restartToUpdate: ()=> ipcRenderer.invoke('update:restart')
});
