const { app, BrowserWindow, desktopCapturer, ipcMain, Notification } = require('electron');
const path = require('path');
const { execFile } = require('child_process');
const { autoUpdater } = require('electron-updater');

process.on('uncaughtException', (error) => console.error('Erro Crítico:', error));
process.on('unhandledRejection', (reason) => console.error('Promessa Rejeitada:', reason));

let mainWindow;
let activeCapture = null; // instância do LoopbackCapture em uso no momento (só uma por vez)

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1280,
        height: 720,
        backgroundColor: '#313338', // evita o "flash" branco antes da página carregar
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            // Quem compartilha tela normalmente está jogando com o app em segundo
            // plano/coberto -- sem isso o Chromium reduz a taxa de timers/render da
            // janela e o vídeo enviado engasga.
            backgroundThrottling: false
        }
    });

    mainWindow.setMenu(null);
    mainWindow.loadFile('index.html');
}

// ==========================================
// ATUALIZAÇÃO AO ABRIR (igual ao Discord)
// ==========================================
// Antes: checkForUpdatesAndNotify() baixava em segundo plano, mostrava uma
// notificação do Windows e só instalava ao fechar o app -- pelo instalador
// com assistente, que aparecia pedindo pra atualizar. Agora: uma janelinha
// (splash) procura atualização ANTES de abrir o app; se tiver, baixa, instala
// em silêncio e reabre já na versão nova. Se não tiver (ou der erro / demorar
// demais pra responder), abre o app normalmente.
const UPDATE_CHECK_TIMEOUT_MS = 15_000; // sem resposta nesse tempo = abre o app mesmo assim
const BACKGROUND_CHECK_INTERVAL_MS = 60 * 60 * 1000; // com o app aberto, procura de novo a cada hora

let splashWindow = null;
let splashStatus = { text: 'Iniciando...', progress: null };
let mainOpened = false;

function createSplashWindow() {
    splashWindow = new BrowserWindow({
        width: 300,
        height: 340,
        frame: false,
        resizable: false,
        maximizable: false,
        center: true,
        show: false,
        backgroundColor: '#2b2d31',
        webPreferences: { contextIsolation: true, nodeIntegration: false }
    });
    splashWindow.loadFile('splash.html');
    splashWindow.once('ready-to-show', () => splashWindow.show());
    // Reaplica o último status quando a página termina de carregar (o
    // updater pode mandar status antes disso)
    splashWindow.webContents.on('did-finish-load', () => setSplashStatus(splashStatus.text, splashStatus.progress));
}

function setSplashStatus(text, progress = null) {
    splashStatus = { text, progress };
    if (!splashWindow || splashWindow.isDestroyed()) return;
    const progressArg = typeof progress === 'number' ? progress.toFixed(1) : 'null';
    splashWindow.webContents
        .executeJavaScript(`window.setStatus && window.setStatus(${JSON.stringify(text)}, ${progressArg})`)
        .catch(() => { /* página ainda carregando -- did-finish-load reaplica */ });
}

function openMainAndCloseSplash() {
    if (mainOpened) return;
    mainOpened = true;
    // Abre a principal ANTES de fechar o splash -- senão, sem nenhuma janela
    // aberta, o 'window-all-closed' encerraria o app.
    createWindow();
    mainWindow.once('ready-to-show', () => {
        if (splashWindow && !splashWindow.isDestroyed()) splashWindow.close();
        splashWindow = null;
    });
    setInterval(() => autoUpdater.checkForUpdates().catch(() => {}), BACKGROUND_CHECK_INTERVAL_MS);
}

function startUpdateCheck() {
    autoUpdater.autoDownload = true;
    // Atualização achada com o app já aberto (checagem de hora em hora, ou a
    // primeira que demorou mais que o timeout) não derruba ninguém no meio de
    // uma chamada: instala em silêncio quando o app for fechado.
    autoUpdater.autoInstallOnAppQuit = true;

    let downloading = false;
    const timeout = setTimeout(() => { if (!downloading) openMainAndCloseSplash(); }, UPDATE_CHECK_TIMEOUT_MS);

    autoUpdater.on('checking-for-update', () => { if (!mainOpened) setSplashStatus('Procurando atualizações...'); });
    autoUpdater.on('update-available', (info) => {
        if (mainOpened) return;
        downloading = true;
        clearTimeout(timeout);
        setSplashStatus(`Baixando atualização ${info.version}...`, 0);
    });
    autoUpdater.on('download-progress', (p) => { if (!mainOpened) setSplashStatus('Baixando atualização...', p.percent); });
    autoUpdater.on('update-not-available', () => {
        clearTimeout(timeout);
        setSplashStatus('Iniciando...');
        openMainAndCloseSplash();
    });
    autoUpdater.on('update-downloaded', () => {
        if (mainOpened) {
            console.log('Atualização baixada com o app aberto -- instala em silêncio ao fechar.');
            return;
        }
        setSplashStatus('Instalando...');
        // isSilent=true: sem o assistente do instalador; isForceRunAfter=true: reabre o app sozinho
        setImmediate(() => autoUpdater.quitAndInstall(true, true));
    });
    autoUpdater.on('error', (error) => {
        console.error('Erro no auto-update:', error);
        clearTimeout(timeout);
        openMainAndCloseSplash();
    });

    autoUpdater.checkForUpdates().catch(() => { /* já tratado no 'error' */ });
}

app.whenReady().then(() => {
    // Em modo dev (npm start) não tem o que atualizar -- abre direto
    if (!app.isPackaged) {
        createWindow();
        return;
    }
    createSplashWindow();
    startUpdateCheck();
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
