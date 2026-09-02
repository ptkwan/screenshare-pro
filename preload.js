const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    closeApp: () => ipcRenderer.send('close-app'),
    getSources: () => ipcRenderer.invoke('GET_SOURCES'),
    // Nova função para receber o IP do servidor
    onServerFound: (callback) => ipcRenderer.on('server-found', (event, url) => callback(url)),

    // Áudio por aplicativo (captura só o processo da janela compartilhada)
    resolveWindowPid: (sourceId) => ipcRenderer.invoke('resolve-window-pid', sourceId),
    startAppAudioCapture: (pid) => ipcRenderer.invoke('start-app-audio-capture', pid),
    // Áudio do sistema inteiro (nativo, usado quando a fonte é "Tela Cheia")
    startSystemAudioCapture: () => ipcRenderer.invoke('start-system-audio-capture'),
    stopAppAudioCapture: () => ipcRenderer.send('stop-app-audio-capture'),
    onAppAudioChunk: (callback) => {
        const listener = (event, chunk) => callback(chunk);
        ipcRenderer.on('app-audio-chunk', listener);
        return () => ipcRenderer.removeListener('app-audio-chunk', listener);
    }
});
