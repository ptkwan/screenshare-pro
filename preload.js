const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    closeApp: () => ipcRenderer.send('close-app'),
    getSources: () => ipcRenderer.invoke('GET_SOURCES'),
    // Nova função para receber o IP do servidor
    onServerFound: (callback) => ipcRenderer.on('server-found', (event, url) => callback(url))
});