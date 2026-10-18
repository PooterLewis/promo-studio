'use strict';
const { app, BrowserWindow, desktopCapturer, session, ipcMain, globalShortcut, shell, nativeTheme, protocol } = require('electron');
const path = require('path');
const fs = require('fs');
const { Readable } = require('stream');
const native = require('./native-capture');

// media:// serves recorded files to the editor with range requests (for seeking)
// and CORS headers, so frames can be drawn and exported like any other video.
protocol.registerSchemesAsPrivileged([{ scheme: 'media', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } }]);

let win = null;
let pick = { id: null, audio: true };
const writers = new Map();
const HOTKEYS = { record: 'F9', pause: 'F10' };
const hotkeyStatus = {};

const outDir = () => {
  const dir = path.join(app.getPath('videos'), 'Promo Studio');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};
// Keep names safe for Windows and never overwrite an existing file.
function uniquePath(name) {
  const clean = String(name).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 150) || 'video';
  const ext = path.extname(clean), base = clean.slice(0, clean.length - ext.length);
  let p = path.join(outDir(), clean), n = 2;
  while (fs.existsSync(p)) p = path.join(outDir(), `${base} (${n++})${ext}`);
  return p;
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440, height: 900, minWidth: 960, minHeight: 640,
    backgroundColor: '#0e131a', title: 'Promo Studio', autoHideMenuBar: true,
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  win.loadFile(path.join(__dirname, 'app', 'index.html'));
  // Links in the app open in the normal browser, never inside the app window.
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.on('closed', () => { win = null; });
}

function send(channel, ...args) { if (win && !win.isDestroyed()) win.webContents.send(channel, ...args); }

function setupCapture() {
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((wc, perm, cb) => cb(['media', 'display-capture', 'fullscreen', 'clipboard-sanitized-write'].includes(perm)));
  ses.setDisplayMediaRequestHandler(async (req, cb) => {
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen', 'window'] });
      const src = sources.find(s => s.id === pick.id) || sources.find(s => s.id.startsWith('screen')) || sources[0];
      // 'loopback' records everything Windows plays: the game, Discord, music.
      const audio = pick.audio && req.audioRequested && process.platform === 'win32' ? 'loopback' : undefined;
      cb(audio ? { video: src, audio } : { video: src });
    } catch (e) {
      console.error(e); cb({});
    }
  });
}

function setupHotkeys() {
  for (const [action, key] of Object.entries(HOTKEYS)) {
    try { hotkeyStatus[action] = globalShortcut.register(key, () => send('hotkey', action)); }
    catch (e) { hotkeyStatus[action] = false; }
  }
}

function setupUpdates() {
  if (!app.isPackaged) return;
  let autoUpdater;
  try { ({ autoUpdater } = require('electron-updater')); } catch (e) { return; }
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('update-available', info => send('update', { state: 'downloading', version: info.version }));
  autoUpdater.on('download-progress', p => send('update', { state: 'downloading', percent: Math.round(p.percent) }));
  autoUpdater.on('update-downloaded', info => send('update', { state: 'ready', version: info.version }));
  autoUpdater.on('error', e => console.error('update error', e && e.message));
  ipcMain.handle('update:install', () => autoUpdater.quitAndInstall());
  const check = () => autoUpdater.checkForUpdates().catch(() => {});
  setTimeout(check, 4000);
  setInterval(check, 4 * 60 * 60 * 1000);
}

ipcMain.handle('app:info', () => ({
  version: app.getVersion(), platform: process.platform, outDir: outDir(),
  hotkeys: HOTKEYS, hotkeyStatus, systemAudio: process.platform === 'win32',
}));
ipcMain.handle('sources:list', async () => {
  const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 320, height: 180 } });
  return sources
    .filter(s => !/^Promo Studio$/.test(s.name))
    .map(s => ({ id: s.id, name: s.name, isScreen: s.id.startsWith('screen'), thumb: s.thumbnail.isEmpty() ? '' : s.thumbnail.toDataURL() }));
});
ipcMain.handle('sources:choose', (e, id, audio) => { pick = { id, audio: !!audio }; return true; });

// Recordings stream to disk while they happen, so a crash never loses a take.
ipcMain.handle('rec:open', (e, name) => {
  const file = uniquePath(name); const id = Math.random().toString(36).slice(2);
  writers.set(id, { file, stream: fs.createWriteStream(file) });
  return { id, file };
});
ipcMain.handle('rec:write', (e, id, buf) => { const w = writers.get(id); if (w) w.stream.write(Buffer.from(buf)); return true; });
ipcMain.handle('rec:close', (e, id) => new Promise(res => {
  const w = writers.get(id); if (!w) return res(null);
  writers.delete(id); w.stream.end(() => res(w.file));
}));
ipcMain.handle('native:info', () => native.detect());
ipcMain.handle('native:start', async (e, { sourceId, fps }) => {
  const sources = await desktopCapturer.getSources({ types: ['screen'] });
  const src = sources.find(s => s.id === sourceId);
  if (!src) throw new Error('Only whole screens use the fast recorder');
  const tempFile = uniquePath(`recording-${Date.now()}.part.mp4`);
  return native.start({ displayId: src.display_id, fps, tempFile });
});
ipcMain.handle('native:stop', (e, id, name) => native.stop(id, uniquePath(name)));

function serveMedia(req) {
  const file = path.resolve(new URL(req.url).searchParams.get('p') || '');
  if (!file.startsWith(path.resolve(outDir()) + path.sep) || !fs.existsSync(file)) return new Response('Not found', { status: 404 });
  const size = fs.statSync(file).size;
  const type = /\.mp4$/i.test(file) ? 'video/mp4' : 'video/webm';
  const base = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Access-Control-Allow-Origin': '*' };
  const m = /bytes=(\d*)-(\d*)/.exec(req.headers.get('range') || '');
  if (!m) return new Response(Readable.toWeb(fs.createReadStream(file)), { status: 200, headers: { ...base, 'Content-Length': String(size) } });
  let start = m[1] ? +m[1] : size - +m[2], end = m[1] && m[2] ? +m[2] : size - 1;
  start = Math.max(0, start); end = Math.min(size - 1, end);
  if (start > end) return new Response(null, { status: 416, headers: { ...base, 'Content-Range': `bytes */${size}` } });
  return new Response(Readable.toWeb(fs.createReadStream(file, { start, end })), {
    status: 206, headers: { ...base, 'Content-Length': String(end - start + 1), 'Content-Range': `bytes ${start}-${end}/${size}` },
  });
}
ipcMain.handle('file:save', async (e, name, buf) => { const file = uniquePath(name); await fs.promises.writeFile(file, Buffer.from(buf)); return file; });
ipcMain.handle('file:reveal', (e, file) => { if (file && fs.existsSync(file)) shell.showItemInFolder(file); else shell.openPath(outDir()); });
ipcMain.handle('folder:open', () => shell.openPath(outDir()));
// Keeps the Windows title bar in step with the app's theme.
ipcMain.on('theme:set', (e, t) => { nativeTheme.themeSource = ['dark', 'light', 'system'].includes(t) ? t : 'system'; });
// A red taskbar button shows recording is running while you're in the game.
ipcMain.on('rec:state', (e, on) => { if (win) win.setProgressBar(on ? 1 : -1, { mode: on ? 'error' : 'none' }); });

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
  if (process.platform === 'win32') app.setAppUserModelId('com.pooterlewis.promostudio');
  app.whenReady().then(() => { protocol.handle('media', serveMedia); setupCapture(); native.detect(); createWindow(); setupHotkeys(); setupUpdates(); });
  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    for (const w of writers.values()) w.stream.end();
    native.stopAll();
  });
  app.on('window-all-closed', () => app.quit());
}
