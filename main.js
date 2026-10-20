'use strict';
const { app, BrowserWindow, desktopCapturer, session, ipcMain, globalShortcut, shell, nativeTheme, protocol, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const { Readable } = require('stream');
const native = require('./native-capture');
const phone = require('./phone-share');

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

// After an update, put the desktop shortcut back if the installer removed it.
function restoreShortcut() {
  if (!app.isPackaged || process.platform !== 'win32') return;
  const marker = path.join(app.getPath('userData'), 'last-version');
  let last = ''; try { last = fs.readFileSync(marker, 'utf8').trim(); } catch (e) {}
  if (last === app.getVersion()) return;
  try { fs.writeFileSync(marker, app.getVersion()); } catch (e) {}
  const link = path.join(app.getPath('desktop'), 'Promo Studio.lnk');
  if (fs.existsSync(link)) return;
  try { shell.writeShortcutLink(link, 'create', { target: process.execPath, appUserModelId: 'com.pooterlewis.promostudio', description: 'Promo Studio' }); }
  catch (e) { console.error('shortcut', e); }
}

// Tell the Library when files appear or change in the videos folder (new takes,
// exports, or edits Claude drops in), so it updates without pressing Refresh.
function watchLibrary() {
  let t = null;
  try {
    fs.watch(outDir(), () => { clearTimeout(t); t = setTimeout(() => send('library:changed'), 1500); });
  } catch (e) { console.error('watch', e); }
}

function setupUpdates() {
  if (!app.isPackaged) { ipcMain.handle('update:check', () => send('update', { state: 'dev' })); return; }
  let autoUpdater;
  try { ({ autoUpdater } = require('electron-updater')); } catch (e) { return; }
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('update-available', info => send('update', { state: 'downloading', version: info.version }));
  autoUpdater.on('download-progress', p => send('update', { state: 'downloading', percent: Math.round(p.percent) }));
  autoUpdater.on('update-downloaded', info => send('update', { state: 'ready', version: info.version }));
  autoUpdater.on('update-not-available', () => send('update', { state: 'none', version: app.getVersion() }));
  autoUpdater.on('error', e => { console.error('update error', e && e.message); send('update', { state: 'error' }); });
  // Silent install, then reopen the app on the new version.
  // Stop ffmpeg and the phone server first: a running ffmpeg.exe locks the install
  // folder, which can make the installer give up halfway (and lose the shortcut).
  ipcMain.handle('update:install', async () => {
    native.stopAll(); phone.stop();
    await new Promise(r => setTimeout(r, 800));
    autoUpdater.quitAndInstall(true, true);
  });
  ipcMain.handle('update:check', () => { send('update', { state: 'checking' }); return check(); });
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
ipcMain.handle('native:start', async (e, { sourceId, fps, small }) => {
  const sources = await desktopCapturer.getSources({ types: ['screen'] });
  const src = sources.find(s => s.id === sourceId);
  if (!src) throw new Error('Only whole screens use the fast recorder');
  const tempFile = uniquePath(`recording-${Date.now()}.part.mp4`);
  return native.start({ displayId: src.display_id, fps, tempFile, small: !!small });
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
ipcMain.handle('file:save', async (e, name, buf) => {
  const file = uniquePath(name); await fs.promises.writeFile(file, Buffer.from(buf));
  if (/\.mp4$/i.test(file)) await native.toAac(file);
  return file;
});

// ---- Library: every take and export in the videos folder.
// Extra facts about each take (sync offset, whether the camera file has video) live
// in the app's own data folder so the videos folder only holds videos.
const metaFile = () => path.join(app.getPath('userData'), 'takes.json');
const readMeta = () => { try { return JSON.parse(fs.readFileSync(metaFile(), 'utf8')); } catch (e) { return {}; } };
ipcMain.handle('library:meta', (e, base, info) => { const all = readMeta(); all[base] = { ...all[base], ...info }; fs.writeFileSync(metaFile(), JSON.stringify(all)); return true; });
ipcMain.handle('library:list', async () => {
  const dir = outDir(), meta = readMeta(), takes = new Map(), exports = [];
  for (const name of await fs.promises.readdir(dir)) {
    if (!/\.(mp4|webm)$/i.test(name) || /\.part\.mp4$|\.aac-tmp\.mp4$|\.shrink-tmp\.mp4$/i.test(name)) continue;
    const file = path.join(dir, name); let st; try { st = fs.statSync(file); } catch (e) { continue; }
    if (!st.isFile()) continue;
    const item = { name, file, size: st.size, mtime: st.mtimeMs };
    const m = /^(Take .+?) - (screen|camera|game sound)(?: \(\d+\))?\.(mp4|webm)$/.exec(name);
    if (!m) { exports.push(item); continue; }
    if (!takes.has(m[1])) takes.set(m[1], { base: m[1], parts: {}, size: 0, mtime: 0, meta: meta[m[1]] || {} });
    const t = takes.get(m[1]); const kind = { screen: 'screen', camera: 'cam', 'game sound': 'game' }[m[2]];
    t.parts[kind] = file; t.size += st.size; t.mtime = Math.max(t.mtime, st.mtimeMs);
  }
  return { dir, takes: [...takes.values()].filter(t => t.parts.screen).sort((a, b) => b.mtime - a.mtime), exports: exports.sort((a, b) => b.mtime - a.mtime) };
});
// Deleting moves files to the Recycle Bin, so a mistake can be undone there.
// Free space on the drive that holds the videos folder.
ipcMain.handle('storage:info', async () => {
  try { const st = await fs.promises.statfs(outDir()); return { free: st.bavail * st.bsize, total: st.blocks * st.bsize }; }
  catch (e) { return null; }
});
// Auto-cleanup removes old raw takes for good (not the Recycle Bin), so the space
// actually comes back. Only the renderer decides which takes qualify.
ipcMain.handle('library:purge', async (e, files) => {
  const dir = path.resolve(outDir()) + path.sep; let freed = 0;
  for (const f of files) {
    if (!path.resolve(f).startsWith(dir) || !fs.existsSync(f)) continue;
    try { freed += fs.statSync(f).size; await fs.promises.unlink(f); } catch (err) {}
  }
  return freed;
});
// Shrink: re-encode a take's screen and camera files smaller, then replace them.
ipcMain.handle('library:shrink', async (e, files) => {
  const dir = path.resolve(outDir()) + path.sep; let before = 0, after = 0; const out = {};
  for (const f of files) {
    if (!path.resolve(f).startsWith(dir) || !fs.existsSync(f) || !/ - (screen|camera)(?: \(\d+\))?\.(mp4|webm)$/i.test(f)) continue;
    const isCam = / - camera/i.test(f);
    const tmp = f.replace(/\.(mp4|webm)$/i, '.shrink-tmp.mp4');
    const size = fs.statSync(f).size;
    if (!(await native.shrink(f, tmp, { maxHeight: isCam ? 720 : 1080 }))) continue;
    const newSize = fs.statSync(tmp).size;
    if (newSize >= size * 0.9) { fs.unlinkSync(tmp); continue; } // already small, keep the original
    const final = f.replace(/\.(mp4|webm)$/i, '.mp4');
    await fs.promises.unlink(f); fs.renameSync(tmp, final);
    before += size; after += newSize; out[f] = final;
  }
  return { before, after, renamed: out };
});
ipcMain.handle('library:trash', async (e, files) => {
  const dir = path.resolve(outDir()) + path.sep;
  for (const f of files) if (path.resolve(f).startsWith(dir) && fs.existsSync(f)) await shell.trashItem(f);
  return true;
});
// "Send to Claude": saves the request next to the videos (so Claude, which can see
// this folder, has the details) and puts a ready-to-paste message on the clipboard.
ipcMain.handle('claude:request', async (e, req) => {
  const dir = path.join(outDir(), 'Claude requests'); fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toLocaleString('sv-SE').replace(/:/g, '.');
  const file = path.join(dir, `Request ${stamp}.json`);
  fs.writeFileSync(file, JSON.stringify({ ...req, createdAt: new Date().toISOString() }, null, 2));
  clipboard.writeText(req.message);
  return { file };
});
ipcMain.handle('claude:open', () => shell.openExternal('https://claude.ai/'));
ipcMain.handle('phone:share', (e, file) => {
  if (!path.resolve(file).startsWith(path.resolve(outDir()) + path.sep)) return { error: 'outside' };
  return phone.share(file, app.getPath('userData'));
});
ipcMain.handle('file:reveal', (e, file) => { if (file && fs.existsSync(file)) shell.showItemInFolder(file); else shell.openPath(outDir()); });
ipcMain.handle('folder:open', () => shell.openPath(outDir()));
ipcMain.handle('file:exists', (e, file) => !!file && fs.existsSync(file));
// Keeps the Windows title bar in step with the app's theme.
ipcMain.on('theme:set', (e, t) => { nativeTheme.themeSource = ['dark', 'light', 'system'].includes(t) ? t : 'system'; });
// A red taskbar button shows recording is running while you're in the game.
ipcMain.on('rec:state', (e, on) => { if (win) win.setProgressBar(on ? 1 : -1, { mode: on ? 'error' : 'none' }); });

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
  if (process.platform === 'win32') app.setAppUserModelId('com.pooterlewis.promostudio');
  app.whenReady().then(() => { protocol.handle('media', serveMedia); setupCapture(); native.detect(); createWindow(); setupHotkeys(); setupUpdates(); restoreShortcut(); watchLibrary(); });
  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    for (const w of writers.values()) w.stream.end();
    native.stopAll();
    phone.stop();
  });
  app.on('window-all-closed', () => app.quit());
}
