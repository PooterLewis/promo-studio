'use strict';
// "Send to phone": serves one video over the home Wi-Fi so a phone can scan a QR
// code and download it. Each link has a random token and stops working after 30 minutes.
const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const QRCode = require('qrcode');

const shares = new Map(); // token -> { file, expires }
const TTL = 30 * 60 * 1000;
let server = null, port = 0;

function lanAddress() {
  const all = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) all.push({ name, address: a.address });
  }
  // Home networks first; skip virtual adapters (WSL, Hyper-V, VirtualBox, VPNs) where possible.
  const virtual = /vEthernet|VirtualBox|VMware|WSL|Hyper-V|Loopback|Tailscale|ZeroTier|Hamachi/i;
  const home = a => /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a.address);
  return (all.find(a => home(a) && !virtual.test(a.name)) || all.find(home) || all[0] || {}).address || null;
}

const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function page(token, name, size) {
  const src = `/f/${token}/${encodeURIComponent(name)}`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(name)}</title><style>
body{margin:0;font:16px system-ui,-apple-system,sans-serif;background:#0e131a;color:#e8edf3;padding:16px}
video{width:100%;max-height:60vh;background:#000;border-radius:10px}
a.b{display:block;text-align:center;background:#f5a524;color:#1a1200;font-weight:700;padding:14px;border-radius:10px;text-decoration:none;margin:14px 0}
p{color:#9aa7b5;line-height:1.45;font-size:14px}h1{font-size:17px;word-break:break-word}
</style></head><body><h1>${esc(name)}</h1>
<video src="${src}" controls playsinline preload="metadata"></video>
<a class="b" href="${src}?dl=1" download="${esc(name)}">Download video (${(size / 1048576).toFixed(0)} MB)</a>
<p><b>iPhone:</b> tap Download, then open the Files app (Downloads), tap the video, tap Share and choose <b>Save Video</b> to put it in Photos.</p>
<p><b>Android:</b> tap Download. The video appears in your Downloads and Gallery.</p>
<p>Keep Promo Studio open on your PC until the download finishes.</p></body></html>`;
}

function handle(req, res) {
  const m = /^\/(t|f)\/([a-f0-9]{32})(?:\/[^?]*)?(\?.*)?$/.exec(req.url);
  const s = m && shares.get(m[2]);
  if (!s || s.expires < Date.now() || !fs.existsSync(s.file)) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('This link has expired. Click Send to phone again on your PC.'); }
  const name = path.basename(s.file), size = fs.statSync(s.file).size;
  if (m[1] === 't') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); return res.end(page(m[2], name, size)); }
  const type = /\.mp4$/i.test(name) ? 'video/mp4' : 'video/webm';
  const headers = { 'Content-Type': type, 'Accept-Ranges': 'bytes' };
  if (/[?&]dl=1/.test(m[3] || '')) headers['Content-Disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(name)}`;
  const r = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
  if (!r) { res.writeHead(200, { ...headers, 'Content-Length': size }); return fs.createReadStream(s.file).pipe(res); }
  let start = r[1] ? +r[1] : size - +r[2], end = r[1] && r[2] ? +r[2] : size - 1;
  start = Math.max(0, start); end = Math.min(size - 1, end);
  if (start > end) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }); return res.end(); }
  res.writeHead(206, { ...headers, 'Content-Length': end - start + 1, 'Content-Range': `bytes ${start}-${end}/${size}` });
  fs.createReadStream(s.file, { start, end }).pipe(res);
}

function ensureServer() {
  if (server) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const srv = http.createServer(handle);
    // Same port each time when free, so Windows only asks about the firewall once.
    const tryListen = p => srv.listen(p, '0.0.0.0', () => { server = srv; port = srv.address().port; resolve(); });
    srv.once('error', e => {
      if (e.code !== 'EADDRINUSE') return reject(e);
      srv.once('error', reject); tryListen(0);
    });
    tryListen(47615);
  });
}

async function share(file) {
  const ip = lanAddress();
  if (!ip) return { error: 'no-network' };
  await ensureServer();
  for (const [t, s] of shares) if (s.expires < Date.now()) shares.delete(t);
  const token = crypto.randomBytes(16).toString('hex');
  shares.set(token, { file, expires: Date.now() + TTL });
  const url = `http://${ip}:${port}/t/${token}`;
  const qr = await QRCode.toDataURL(url, { margin: 1, width: 320, errorCorrectionLevel: 'M' });
  return { url, qr, ip };
}

function stop() { if (server) { server.close(); server = null; } shares.clear(); }

module.exports = { share, stop };
