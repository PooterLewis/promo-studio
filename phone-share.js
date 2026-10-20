'use strict';
// "Send to phone": serves one video over the home Wi-Fi so a phone can scan a QR
// code and save it. Each link has a random token and stops working after 30 minutes.
// It's HTTPS (with a self-signed certificate made on first use) because phones only
// allow the share sheet, and so "Save Video" to Photos, on secure pages.
const https = require('https');
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const QRCode = require('qrcode');
const selfsigned = require('selfsigned');

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
  const type = /\.mp4$/i.test(name) ? 'video/mp4' : 'video/webm';
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(name)}</title><style>
body{margin:0;font:16px system-ui,-apple-system,sans-serif;background:#0e131a;color:#e8edf3;padding:16px}
video{width:100%;max-height:55vh;background:#000;border-radius:10px}
.b{display:block;width:100%;box-sizing:border-box;text-align:center;background:#f5a524;color:#1a1200;font:700 17px system-ui,-apple-system,sans-serif;padding:15px;border:0;border-radius:10px;text-decoration:none;margin:14px 0}
.b:disabled{opacity:.55}.alt{background:#253141;color:#e8edf3;font-weight:600}
p{color:#9aa7b5;line-height:1.45;font-size:14px}h1{font-size:17px;word-break:break-word}
</style></head><body><h1>${esc(name)}</h1>
<video id="v" controls playsinline preload="none"></video>
<button class="b" id="save" disabled>Getting the video ready…</button>
<a class="b alt" id="dl" href="${src}?dl=1" download="${esc(name)}" hidden>Download video (${(size / 1048576).toFixed(0)} MB)</a>
<p id="msg">Keep Promo Studio open on your PC until this finishes.</p>
<script>
const src=${JSON.stringify(src)}, name=${JSON.stringify(name)}, type=${JSON.stringify(type)}, size=${size};
const save=document.getElementById('save'), dl=document.getElementById('dl'), msg=document.getElementById('msg'), v=document.getElementById('v');
let file=null;
function fallback(why){ save.hidden=true; dl.hidden=false; v.src=src; msg.textContent=why; }
async function load(){
  // The share sheet only opens straight from a tap, so the video is fetched first.
  if(!navigator.canShare||size>800*1048576) return fallback('Tap Download, then in the Files app tap the video, tap Share and choose Save Video.');
  try{
    const r=await fetch(src); if(!r.ok) throw new Error(r.status);
    const rd=r.body.getReader(), parts=[]; let got=0;
    for(;;){ const {done,value}=await rd.read(); if(done) break; parts.push(value); got+=value.length; save.textContent='Getting the video ready… '+Math.floor(got*100/size)+'%'; }
    const blob=new Blob(parts,{type}); file=new File([blob],name,{type});
    if(!navigator.canShare({files:[file]})) return fallback('This browser can\\'t save straight to your gallery. Tap Download instead.');
    v.src=URL.createObjectURL(blob);
    save.disabled=false; save.textContent='Save to Photos';
    msg.textContent='Tap Save to Photos, then choose Save Video.';
  }catch(e){ fallback('Couldn\\'t get the video ('+e.message+'). Tap Download instead.'); }
}
save.onclick=async()=>{
  try{ await navigator.share({files:[file]}); msg.textContent='Done. If you chose Save Video, it\\'s in your Photos.'; }
  catch(e){ if(e.name!=='AbortError') msg.textContent='Couldn\\'t open the share menu: '+e.message; }
};
load();
</script></body></html>`;
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

// One certificate per install, kept with the app's settings so the phone sees the same one each time.
function certificate(dir) {
  const file = path.join(dir, 'phone-share-cert.json');
  try { const c = JSON.parse(fs.readFileSync(file, 'utf8')); if (c.key && c.cert) return c; } catch {}
  const p = selfsigned.generate([{ name: 'commonName', value: 'Promo Studio' }], { days: 3650, keySize: 2048, algorithm: 'sha256' });
  const c = { key: p.private, cert: p.cert };
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(c), { mode: 0o600 });
  return c;
}

function ensureServer(dir) {
  if (server) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const srv = https.createServer(certificate(dir), handle);
    // Same port each time when free, so Windows only asks about the firewall once.
    const tryListen = p => srv.listen(p, '0.0.0.0', () => { server = srv; port = srv.address().port; resolve(); });
    srv.once('error', e => {
      if (e.code !== 'EADDRINUSE') return reject(e);
      srv.once('error', reject); tryListen(0);
    });
    tryListen(47616);
  });
}

async function share(file, dataDir) {
  const ip = lanAddress();
  if (!ip) return { error: 'no-network' };
  await ensureServer(dataDir);
  for (const [t, s] of shares) if (s.expires < Date.now()) shares.delete(t);
  const token = crypto.randomBytes(16).toString('hex');
  shares.set(token, { file, expires: Date.now() + TTL });
  const url = `https://${ip}:${port}/t/${token}`;
  const qr = await QRCode.toDataURL(url, { margin: 1, width: 320, errorCorrectionLevel: 'M' });
  return { url, qr, ip };
}

function stop() { if (server) { server.close(); server = null; } shares.clear(); }

module.exports = { share, stop };
