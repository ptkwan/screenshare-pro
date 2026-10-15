// ==========================================
// BOT DE MÚSICA -- lado do processo principal
// ==========================================
// Busca/baixa o áudio do YouTube com o yt-dlp (o mesmo que os bots de música
// do Discord usam). O yt-dlp.exe não vai junto no instalador: é baixado do
// GitHub na primeira vez que alguém usa o bot e atualizado sozinho de tempos
// em tempos -- o YouTube muda direto e um yt-dlp velho para de funcionar.
//
// Desde 2025 o yt-dlp precisa de um motor JavaScript pra resolver as
// proteções do YouTube. Usamos o próprio Electron do app como Node
// (ELECTRON_RUN_AS_NODE), então ninguém precisa instalar nada.

const { app, net } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');

const YTDLP_URL = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe';
const UPDATE_EVERY_MS = 3 * 24 * 60 * 60 * 1000; // 3 dias
const RESOLVE_TIMEOUT_MS = 90_000;
const MAX_DURATION_S = 60 * 60; // 1 hora
const MAX_FILESIZE = '80M';

const binDir = () => path.join(app.getPath('userData'), 'bin');
const ytdlpPath = () => path.join(binDir(), 'yt-dlp.exe');
const downloadDir = () => path.join(os.tmpdir(), 'streama-musica');

let ensurePromise = null;
let updatePromise = null;
let queue = Promise.resolve(); // um yt-dlp por vez

function isReady() {
    return fs.existsSync(ytdlpPath());
}

async function downloadYtDlp() {
    fs.mkdirSync(binDir(), { recursive: true });
    const res = await net.fetch(YTDLP_URL);
    if (!res.ok) throw new Error(`download do yt-dlp falhou (HTTP ${res.status})`);
    const tmp = ytdlpPath() + '.download';
    fs.writeFileSync(tmp, Buffer.from(await res.arrayBuffer()));
    fs.renameSync(tmp, ytdlpPath());
}

function ensureYtDlp() {
    if (isReady()) return Promise.resolve();
    if (!ensurePromise) ensurePromise = downloadYtDlp().finally(() => { ensurePromise = null; });
    return ensurePromise;
}

function runYtDlp(args, timeout) {
    return new Promise((resolve) => {
        execFile(ytdlpPath(), args, {
            timeout,
            windowsHide: true,
            maxBuffer: 4 * 1024 * 1024,
            env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', PYTHONIOENCODING: 'utf-8' },
        }, (err, stdout, stderr) => resolve({ err, stdout: stdout || '', stderr: stderr || '' }));
    });
}

// "yt-dlp -U" (troca o próprio .exe pela versão mais nova). Roda em segundo
// plano quando o arquivo está velho, e na hora quando uma busca falha.
function updateYtDlp() {
    if (!updatePromise) {
        updatePromise = runYtDlp(['-U'], 120_000)
            .then(({ stdout }) => { console.log('[musica] yt-dlp -U:', stdout.trim().split('\n').pop()); })
            .finally(() => { updatePromise = null; });
    }
    return updatePromise;
}

function updateIfStale() {
    try {
        if (Date.now() - fs.statSync(ytdlpPath()).mtimeMs > UPDATE_EVERY_MS) updateYtDlp();
    } catch (e) { /* sem yt-dlp ainda */ }
}

// Link do YouTube vira o próprio link; qualquer outra coisa vira busca.
// Nunca repassa um texto qualquer como URL pro yt-dlp (ele baixa de mil sites).
function toTarget(query) {
    try {
        const u = new URL(query);
        const host = u.hostname.replace(/^www\.|^m\./, '');
        if (['youtube.com', 'music.youtube.com', 'youtu.be'].includes(host)) return u.toString();
    } catch (e) { /* não é URL */ }
    return `ytsearch1:${query}`;
}

const FIELDS_SEP = '\u001f';
async function resolveOnce(query) {
    const outDir = downloadDir();
    fs.mkdirSync(outDir, { recursive: true });
    const args = [
        '--no-playlist', '--no-warnings', '--no-progress', '--encoding', 'utf-8',
        '--js-runtimes', `node:${process.execPath}`,
        '-f', 'bestaudio[ext=webm]/bestaudio[ext=m4a]/bestaudio',
        '--match-filter', `!is_live & duration <= ${MAX_DURATION_S}`,
        '--max-filesize', MAX_FILESIZE,
        '-o', path.join(outDir, '%(id)s.%(ext)s'),
        '--no-simulate',
        '--print', `after_move:%(title)s${FIELDS_SEP}%(duration)s${FIELDS_SEP}%(webpage_url)s${FIELDS_SEP}%(filepath)s`,
        '--', toTarget(query),
    ];
    const { err, stdout, stderr } = await runYtDlp(args, RESOLVE_TIMEOUT_MS);
    const line = stdout.split(/\r?\n/).find(l => l.includes(FIELDS_SEP));
    if (!line) {
        const reason = /does not pass filter|skipping/i.test(stdout + stderr) ? 'too-long'
            : err ? 'failed' : 'not-found';
        return { ok: false, reason, detail: (stderr || String(err || '')).trim().split('\n').pop() };
    }
    const [title, duration, url, filepath] = line.split(FIELDS_SEP);
    try {
        const data = fs.readFileSync(filepath);
        const ext = path.extname(filepath).slice(1).toLowerCase();
        return {
            ok: true, title, url, data,
            duration: Number(duration) || 0,
            mime: ext === 'm4a' || ext === 'mp4' ? 'audio/mp4' : 'audio/webm',
        };
    } finally {
        fs.rm(filepath, { force: true }, () => {});
    }
}

async function resolve(query) {
    await ensureYtDlp();
    updateIfStale();
    let result = await resolveOnce(query);
    // Falhou de verdade (não é "não achei"/"longa demais"): costuma ser o
    // YouTube que mudou algo -- atualiza o yt-dlp e tenta mais uma vez.
    if (!result.ok && result.reason === 'failed') {
        await updateYtDlp();
        result = await resolveOnce(query);
    }
    if (!result.ok) console.error('[musica] falha ao buscar', JSON.stringify(query), result.reason, result.detail);
    return result;
}

function register(ipcMain) {
    ipcMain.handle('music-is-ready', () => isReady());
    ipcMain.handle('music-resolve', (event, query) => {
        if (typeof query !== 'string' || !query.trim() || query.length > 300) return { ok: false, reason: 'not-found' };
        const job = queue.then(() => resolve(query.trim()));
        queue = job.catch(() => {});
        return job.catch(e => {
            console.error('[musica] erro:', e);
            return { ok: false, reason: 'failed', detail: String(e.message || e) };
        });
    });
}

module.exports = { register };
