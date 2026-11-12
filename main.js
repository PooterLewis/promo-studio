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
let cutWin = null;
const planWatch = new Map();
let pick = { id: null, audio: true };
const writers = new Map();
const HOTKEYS = { record: 'F9', pause: 'F10' };
const hotkeyStatus = {};

const starterSounds = path.join(__dirname, 'app', 'sounds');
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

const MEDIA_TYPES = { '.mp4':'video/mp4', '.m4v':'video/mp4', '.mov':'video/mp4', '.webm':'video/webm', '.mp3':'audio/mpeg', '.wav':'audio/wav', '.m4a':'audio/mp4', '.aac':'audio/aac', '.ogg':'audio/ogg', '.flac':'audio/flac', '.json':'application/json', '.jpg':'image/jpeg', '.png':'image/png' };
function serveMedia(req) {
  const file = path.resolve(new URL(req.url).searchParams.get('p') || '');
  const allowed = [outDir(), starterSounds].some(root => file.startsWith(path.resolve(root) + path.sep));
  if (!allowed || !fs.existsSync(file)) return new Response('Not found', { status: 404 });
  const size = fs.statSync(file).size;
  const type = MEDIA_TYPES[path.extname(file).toLowerCase()] || 'video/webm';
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
    if (!/\.(mp4|webm)$/i.test(name) || /\.part\.mp4$|\.aac-tmp\.mp4$|\.shrink-tmp\.mp4$|\.upload-tmp\./i.test(name)) continue;
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

// ---- Cutroom: the AI edit window. It plays a take (picture + game sound in sync),
// asks Claude for an edit plan through the same copy-and-paste hand-off as "Send to
// Claude", loads the plan.json Claude saves, and exports into the Library.
const inOut = f => !!f && path.resolve(f).startsWith(path.resolve(outDir()) + path.sep);
const requestsDir = () => path.join(outDir(), 'Claude requests');
ipcMain.handle('cutroom:open', (e, info) => {
  info = info || {};
  // No take: open Cutroom empty, so a video can be dropped into it.
  if ((info.main && !inOut(info.main)) || (info.game && !inOut(info.game))) return { error: 'outside' };
  const query = { main: info.main || '', game: info.game || '', off: String(Number(info.off) || 0), take: info.take || '', title: info.title || '', style: info.style || '' };
  if (cutWin && !cutWin.isDestroyed()) {
    if (query.main) cutWin.webContents.send('cutroom:load', query);
    if (cutWin.isMinimized()) cutWin.restore(); cutWin.focus(); return { ok: true };
  }
  cutWin = new BrowserWindow({
    width: 1500, height: 940, minWidth: 960, minHeight: 640, backgroundColor: '#0e1013', title: 'Cutroom · Promo Studio', autoHideMenuBar: true,
    icon: path.join(__dirname, 'build', 'icon.png'),
    // backgroundThrottling off: exports record in real time and must keep drawing if the window loses focus.
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  cutWin.loadFile(path.join(__dirname, 'app', 'cutroom.html'), { query });
  cutWin.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  cutWin.on('closed', () => { cutWin = null; for (const t of planWatch.values()) clearInterval(t); planWatch.clear(); });
  return { ok: true };
});
// ---- Sound effects for Cutroom: the starter set in app/sounds (CC0, see CREDITS.md) plus
// anything in Videos\Promo Studio\Sounds, subfolders included, so a whole downloaded library
// (Sonniss, Kenney, your own) can be dropped in as is. Cutroom sorts them by name.
const soundsDir = () => path.join(outDir(), 'Sounds');
const SOUND_EXT = /\.(wav|mp3|ogg|flac|m4a|aac)$/i;
const SOUNDS_README = `Put sound effects here and Cutroom (and Claude) will use them.

Any folder layout works: drop in a whole sound library with its subfolders.
Cutroom sorts each file by its name or folder name into whoosh, impact, boom,
riser, reverse, glitch and click, so names like "Whoosh Heavy 03.wav" or a
folder called "Impacts" are all it needs. Files: wav, mp3, ogg, flac, m4a.

Good free libraries: the Sonniss GDC bundles (royalty-free, sonniss.com/gameaudiogdc)
and the Kenney audio packs (CC0, kenney.nl/assets/category:Audio).
`;
ipcMain.handle('cutroom:sounds', async () => {
  const dir = soundsDir(), out = [];
  try {
    fs.mkdirSync(dir, { recursive: true });
    const readme = path.join(dir, 'Put sound effects here.txt');
    if (!fs.existsSync(readme)) fs.writeFileSync(readme, SOUNDS_README);
  } catch (err) {}
  try {
    for (const n of fs.readdirSync(starterSounds).sort()) {
      if (!SOUND_EXT.test(n)) continue;
      const m = /^(\w+) - (.+)\.\w+$/.exec(n);
      out.push({ name: m ? m[2] : n.replace(/\.[^.]+$/, ''), cat: m ? m[1] : '', file: path.join(starterSounds, n), pack: 'starter' });
    }
  } catch (err) {}
  const walk = async (d, depth) => {
    if (depth > 6 || out.length > 5000) return;
    let ents; try { ents = await fs.promises.readdir(d, { withFileTypes: true }); } catch (err) { return; }
    for (const e of ents.sort((a, b) => a.name.localeCompare(b.name))) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) await walk(f, depth + 1);
      else if (SOUND_EXT.test(e.name)) out.push({ name: e.name.replace(/\.[^.]+$/, ''), rel: path.relative(dir, f), file: f, pack: 'yours' });
    }
  };
  await walk(dir, 0);
  return { dir, sounds: out };
});
ipcMain.handle('cutroom:openSounds', () => { fs.mkdirSync(soundsDir(), { recursive: true }); return shell.openPath(soundsDir()); });
ipcMain.handle('cutroom:music', async () => {
  const dir = path.join(outDir(), 'Music');
  try {
    return (await fs.promises.readdir(dir)).filter(n => /\.(mp3|wav|m4a|aac|ogg|flac)$/i.test(n)).sort()
      .map(n => ({ name: n.replace(/\.[^.]+$/, ''), file: path.join(dir, n) }));
  } catch (err) { return []; }
});
// Writes "Claude requests/Cutroom <time>/" with the full brief (prompt.md), the contact
// sheets and request.json, then copies a short message that points Claude at the folder.
ipcMain.handle('cutroom:request', async (e, { message, prompt, sheets, request }) => {
  const stamp = new Date().toLocaleString('sv-SE').replace(/:/g, '.');
  let dir = path.join(requestsDir(), `Cutroom ${stamp}`), n = 2;
  while (fs.existsSync(dir)) dir = path.join(requestsDir(), `Cutroom ${stamp} (${n++})`);
  fs.mkdirSync(dir, { recursive: true });
  (sheets || []).forEach((buf, i) => fs.writeFileSync(path.join(dir, `sheet-${i + 1}.jpg`), Buffer.from(buf)));
  fs.writeFileSync(path.join(dir, 'prompt.md'), String(prompt || ''));
  fs.writeFileSync(path.join(dir, 'request.json'), JSON.stringify({ kind: 'cutroom', ...request, folder: dir, sheets: (sheets || []).map((_, i) => `sheet-${i + 1}.jpg`), createdAt: new Date().toISOString() }, null, 2));
  const text = `${message}\nFolder: ${dir}\nRead prompt.md and the sheet images there (use the cutroom skill), then save the edit plan as plan.json in that folder. Cutroom in Promo Studio loads it by itself.`;
  clipboard.writeText(text);
  return { dir, text };
});
// Polls the request folder for plan.json and hands every new version to the Cutroom window
// (a half-written file just fails to parse and is read again on the next tick). Each version
// is a review round: Cutroom renders key frames back into the folder (cutroom:review), Claude
// looks at them and may write plan.json again.
const inRequests = dir => !!dir && path.resolve(dir).startsWith(path.resolve(requestsDir()) + path.sep);
ipcMain.handle('cutroom:watch', (e, dir) => {
  if (!inRequests(dir)) return false;
  const sender = e.sender, file = path.join(dir, 'plan.json'), started = Date.now();
  let seen = 0, round = 0;
  const stop = () => { clearInterval(planWatch.get(dir)); planWatch.delete(dir); };
  const tick = () => {
    if (sender.isDestroyed() || Date.now() - started > 6 * 3600e3) return stop();
    let mtime; try { mtime = fs.statSync(file).mtimeMs; } catch (err) { return; }
    if (mtime === seen) return;
    let plan; try { plan = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (err) { return; }
    seen = mtime; sender.send('cutroom:plan', { dir, plan, round: ++round });
  };
  stop(); planWatch.set(dir, setInterval(tick, 1500)); tick();
  return true;
});
// Review frames of the plan as rendered: review.jpg (contact sheet) and review.json (frame
// times, automatic checks). The skill reads them to critique and revise its own edit.
// takes: contact sheets of extra takes a plan just pulled in (take-N.jpg), so Claude can see them.
ipcMain.handle('cutroom:review', async (e, dir, { jpeg, review, takes }) => {
  if (!inRequests(dir) || !fs.existsSync(dir)) return false;
  await fs.promises.writeFile(path.join(dir, 'review.jpg'), Buffer.from(jpeg));
  for (const t of takes || []) if (/^take-\d+\.jpg$/.test(t.name)) await fs.promises.writeFile(path.join(dir, t.name), Buffer.from(t.jpeg));
  await fs.promises.writeFile(path.join(dir, 'review.json'), JSON.stringify({ ...review, sheet: 'review.jpg', renderedAt: new Date().toISOString() }, null, 2));
  return true;
});
ipcMain.handle('phone:share', (e, file) => {
  if (!path.resolve(file).startsWith(path.resolve(outDir()) + path.sep)) return { error: 'outside' };
  return phone.share(file, app.getPath('userData'));
});
ipcMain.handle('phone:receive', () => phone.receiveLink(outDir(), app.getPath('userData'), async (tmp, base, ext) => {
  // .mov is copied into an .mp4 so the Library and editor can open it; if that fails the original is kept.
  if (ext !== 'mp4') {
    const out = uniquePath(base + '.mp4');
    if (await native.remux(tmp, out)) { fs.rmSync(tmp, { force: true }); return out; }
  }
  const out = uniquePath(`${base}.${ext}`);
  fs.renameSync(tmp, out);
  return out;
}));
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
