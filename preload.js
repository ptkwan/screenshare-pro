const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    closeApp: () => ipcRenderer.send('close-app'),
    getAppVersion: () => ipcRenderer.invoke('get-app-version'),
    getSources: () => ipcRenderer.invoke('GET_SOURCES'),
    // Bot de música: busca/baixa o áudio do YouTube (yt-dlp no processo principal)
    musicIsReady: () => ipcRenderer.invoke('music-is-ready'),
    musicResolve: (query) => ipcRenderer.invoke('music-resolve', query),
    // Janelas minimizadas (o Chromium não lista) e restaurar uma pra compartilhar
    getMinimizedWindows: () => ipcRenderer.invoke('get-minimized-windows'),
    restoreMinimizedWindow: (hwnd) => ipcRenderer.invoke('restore-minimized-window', hwnd),

    // Configurações do app (aceleração de hardware / método de captura) e
    // diagnóstico pra tela preta
    getAppSettings: () => ipcRenderer.invoke('get-app-settings'),
    setAppSetting: (key, value) => ipcRenderer.invoke('set-app-setting', key, value),
    restartApp: () => ipcRenderer.send('restart-app'),
    getDiagnostics: () => ipcRenderer.invoke('get-diagnostics'),
    // Método de captura alternativo: avisa qual fonte entregar pro getDisplayMedia
    prepareDisplayMedia: (sourceId, audio) => ipcRenderer.invoke('prepare-display-media', { sourceId, audio }),
    // Nova função para receber o IP do servidor
    onServerFound: (callback) => ipcRenderer.on('server-found', (event, url) => callback(url)),

    // Notificação nativa de nova mensagem no chat -- o Main Process decide se
    // mostra (só quando a janela NÃO está em foco); o preload só repassa o
    // aviso, sem lógica nenhuma aqui.
    notifyNewMessage: (payload) => ipcRenderer.send('chat-message-received', payload),

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
