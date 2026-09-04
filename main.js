const { app, BrowserWindow, desktopCapturer, ipcMain, Notification } = require('electron');
const path = require('path');
const { execFile } = require('child_process');
const { autoUpdater } = require('electron-updater');

process.on('uncaughtException', (error) => console.error('Erro Crítico:', error));
process.on('unhandledRejection', (reason) => console.error('Promessa Rejeitada:', reason));

autoUpdater.on('error', (error) => console.error('Erro no auto-update:', error));
autoUpdater.on('update-downloaded', () => console.log('Atualização baixada, será instalada ao fechar o app.'));

let mainWindow;
let activeCapture = null; // instância do LoopbackCapture em uso no momento (só uma por vez)

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1280,
        height: 720,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false
        }
    });

    mainWindow.setMenu(null);
    mainWindow.loadFile('index.html');
}

app.whenReady().then(() => {
    createWindow();
    autoUpdater.checkForUpdatesAndNotify();
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});

ipcMain.on('close-app', () => app.quit());

ipcMain.handle('get-app-version', () => app.getVersion());

// ==========================================
// NOTIFICAÇÃO NATIVA DE NOVA MENSAGEM NO CHAT
// ==========================================
// Fica no Main Process de propósito: quem decide se a janela está "em foco"
// é o próprio SO via BrowserWindow.isFocused(), não o renderer. O renderer
// não é confiável pra essa decisão (poderia ter sido adulterado via devtools,
// ou só estar com `document.hasFocus()` inconsistente entre plataformas) --
// então ele só avisa "chegou mensagem" (+ se já tá olhando esse canal), e
// quem decide se mostra a notificação é sempre o Main.
// Usa `ipcRenderer.send` (fire-and-forget) em vez de `invoke`: não precisa de
// resposta, e isso evita a Promise/round-trip de um `invoke` numa mensagem de
// chat (que pode chegar em rajada) -- mais barato, sem trade-off nenhum aqui,
// já que quem manda o texto pro toast/notificação é sempre string simples,
// não HTML (Notification nativa não faz parsing de markup, então não tem
// risco de injeção mesmo sem escapar o texto).
const MAX_NOTIFICATION_BODY_LENGTH = 200;

ipcMain.on('chat-message-received', (event, payload) => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    // Só pula a notificação quando a pessoa realmente não precisa dela: janela
    // em foco E o canal daquela mensagem já aberto na tela (ela literalmente
    // acabou de ver o texto aparecer). Em foco mas olhando outro canal (ou a
    // área de voz) ainda notifica -- só porque o app tá aberto não quer dizer
    // que ela viu a mensagem.
    const isViewingChannel = payload?.isViewingChannel === true;
    if (mainWindow.isFocused() && isViewingChannel) return;
    if (!Notification.isSupported()) return;

    const channelName = typeof payload?.channelName === 'string' ? payload.channelName : '';
    const userName = typeof payload?.userName === 'string' && payload.userName ? payload.userName : 'Alguém';
    const text = typeof payload?.text === 'string' ? payload.text.slice(0, MAX_NOTIFICATION_BODY_LENGTH) : '';
    if (!text) return;

    const notification = new Notification({
        title: channelName ? `${userName} em #${channelName}` : userName,
        body: text,
        silent: false,
    });
    notification.on('click', () => {
        if (!mainWindow || mainWindow.isDestroyed()) return;
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.show();
        mainWindow.focus();
    });
    notification.show();
});

ipcMain.handle('GET_SOURCES', async () => {
    const sources = await desktopCapturer.getSources({ types: ['window', 'screen'] });
    // Nunca deixa listar a própria janela do app como fonte pra compartilhar --
    // além de não fazer sentido pra ninguém, se a pessoa escolher "Áudio do
    // Sistema" nessa janela, a captura nativa por processo pega justamente o
    // <audio> do chat de voz tocando localmente e manda de volta pra sala,
    // causando eco pra quem está do outro lado (quem fala ouve a própria voz
    // repetida com atraso).
    const ownSourceId = mainWindow && !mainWindow.isDestroyed() ? mainWindow.getMediaSourceId() : null;
    return sources
        .filter(s => s.id !== ownSourceId)
        .map(s => ({ id: s.id, name: s.name, thumbnail: s.thumbnail.toDataURL() }));
});

// ==========================================
// ÁUDIO POR APLICATIVO (captura só o processo da janela escolhida,
// pra compartilhar o som de um jogo/app específico sem vazar o chat de
// voz do próprio programa — igual o Discord faz)
// ==========================================

// Extrai o HWND do id que o Electron usa pra fontes de janela (ex: "window:7341886:0")
function extractHwndFromSourceId(sourceId) {
    const match = /^window:(\d+):/.exec(sourceId || '');
    return match ? Number(match[1]) : null;
}

// Resolve o HWND pra um PID de processo real, via PowerShell (GetWindowThreadProcessId)
function resolvePidFromHwnd(hwnd) {
    return new Promise((resolve) => {
        // O PowerShell é um processo externo e não entende o sistema de arquivos
        // virtual do asar -- precisa do caminho real do arquivo desempacotado.
        const scriptPath = app.isPackaged
            ? path.join(process.resourcesPath, 'app.asar.unpacked', 'native', 'resolve-window-pid.ps1')
            : path.join(__dirname, 'native', 'resolve-window-pid.ps1');
        execFile(
            'powershell.exe',
            ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, '-Hwnd', String(hwnd)],
            { timeout: 5000 },
            (err, stdout) => {
                if (err) { resolve(null); return; }
                const pid = parseInt(stdout.trim(), 10);
                resolve(Number.isFinite(pid) && pid > 0 ? pid : null);
            }
        );
    });
}

ipcMain.handle('resolve-window-pid', async (event, sourceId) => {
    if (process.platform !== 'win32') return null;
    const hwnd = extractHwndFromSourceId(sourceId);
    if (hwnd === null) return null; // não é uma fonte de janela (ex: "Tela Cheia")
    return resolvePidFromHwnd(hwnd);
});

ipcMain.handle('start-app-audio-capture', (event, pid) => {
    if (process.platform !== 'win32') return false;
    try {
        stopAppAudioCaptureInternal();
        const loopback = require('loopback-capture');
        activeCapture = new loopback.LoopbackCapture();
        activeCapture.start(pid, true, (chunk) => {
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('app-audio-chunk', chunk);
            }
        });
        return true;
    } catch (e) {
        console.error('Falha ao iniciar captura de áudio por app:', e);
        activeCapture = null;
        return false;
    }
});

function stopAppAudioCaptureInternal() {
    if (activeCapture) {
        try { activeCapture.stop(); } catch (e) { /* ignora */ }
        activeCapture = null;
    }
}

ipcMain.on('stop-app-audio-capture', () => {
    stopAppAudioCaptureInternal();
});

// Captura de áudio do sistema inteiro (WASAPI loopback clássico, sem PID) —
// usada quando a fonte compartilhada é "Tela Cheia" e não uma janela
// específica, então não tem um processo único pra filtrar. É o mesmo
// caminho nativo que resolve a instabilidade da API antiga do Chromium
// (chromeMediaSource: 'desktop' pra áudio), só que sem filtro de processo.
ipcMain.handle('start-system-audio-capture', () => {
    if (process.platform !== 'win32') return false;
    try {
        stopAppAudioCaptureInternal();
        const loopback = require('loopback-capture');
        activeCapture = new loopback.LoopbackCapture();
        activeCapture.startSystemAudio((chunk) => {
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('app-audio-chunk', chunk);
            }
        });
        return true;
    } catch (e) {
        console.error('Falha ao iniciar captura de áudio do sistema:', e);
        activeCapture = null;
        return false;
    }
});
