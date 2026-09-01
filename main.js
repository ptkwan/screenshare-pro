const { app, BrowserWindow, desktopCapturer, ipcMain } = require('electron');
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

ipcMain.handle('GET_SOURCES', async () => {
    const sources = await desktopCapturer.getSources({ types: ['window', 'screen'] });
    return sources.map(s => ({ id: s.id, name: s.name, thumbnail: s.thumbnail.toDataURL() }));
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
