'use strict';
// Records the screen with ffmpeg instead of Chromium. On Windows it grabs frames
// with Desktop Duplication (ddagrab) and encodes on the graphics card (NVENC, AMF,
// Quick Sync or Media Foundation), which holds 60 fps while a game is running.
const { app, screen } = require('electron');
const { spawn, execFile } = require('child_process');
const path = require('path');
const fs = require('fs');

const WIN = process.platform === 'win32';
const ENCODERS = WIN ? ['h264_nvenc', 'h264_amf', 'h264_qsv', 'h264_mf', 'libx264'] : ['libx264'];
const running = new Map();
let failed = new Set();
let probe = null;

function ffmpegPath() {
  const bundled = app.isPackaged
    ? path.join(process.resourcesPath, 'ffmpeg', WIN ? 'ffmpeg.exe' : 'ffmpeg')
    : path.join(__dirname, 'vendor', WIN ? 'ffmpeg.exe' : 'ffmpeg');
  if (fs.existsSync(bundled)) return bundled;
  return WIN ? null : 'ffmpeg';
}

function run(args, timeout = 15000) {
  return new Promise(res => {
    const bin = ffmpegPath(); if (!bin) return res(false);
    execFile(bin, args, { timeout, windowsHide: true }, err => res(!err));
  });
}

// Finds the first encoder that actually works on this PC (a listed encoder can
// still fail when the matching graphics card isn't present).
function detect() {
  if (!probe) probe = (async () => {
    if (!ffmpegPath()) return { available: false };
    for (const enc of ENCODERS) {
      const ok = await run(['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=1280x720:r=60',
        '-frames:v', '12', '-pix_fmt', enc === 'h264_mf' || enc === 'h264_qsv' ? 'nv12' : 'yuv420p', '-c:v', enc, '-f', 'null', '-']);
      if (ok) return { available: true, encoders: ENCODERS.slice(ENCODERS.indexOf(enc)), best: enc };
    }
    return { available: false };
  })();
  return probe;
}

function displayFor(displayId) {
  const all = screen.getAllDisplays();
  let idx = all.findIndex(d => String(d.id) === String(displayId));
  if (idx < 0) idx = all.findIndex(d => d.id === screen.getPrimaryDisplay().id);
  const d = all[Math.max(0, idx)];
  return { idx: Math.max(0, idx), bounds: d.bounds, scale: d.scaleFactor };
}

function encoderArgs(enc, fps) {
  const sys = WIN ? ['-vf', 'hwdownload,format=bgra'] : [];
  switch (enc) {
    case 'h264_nvenc': return ['-c:v', 'h264_nvenc', '-preset', 'p4', '-tune', 'hq', '-rc', 'vbr', '-cq', '21', '-b:v', '0', '-maxrate', '60M', '-bufsize', '120M', '-bf', '0'];
    case 'h264_amf': return ['-c:v', 'h264_amf', '-usage', 'transcoding', '-quality', 'balanced', '-rc', 'cqp', '-qp_i', '20', '-qp_p', '22'];
    case 'h264_qsv': return ['-vf', 'hwmap=derive_device=qsv,format=qsv', '-c:v', 'h264_qsv', '-preset', 'faster', '-global_quality', '22'];
    case 'h264_mf': return [...sys, '-pix_fmt', 'nv12', '-c:v', 'h264_mf', '-hw_encoding', '1', '-rate_control', 'quality', '-quality', '70', '-b:v', '30M'];
    default: return [...sys, '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-crf', '20'];
  }
}

function inputArgs(disp, fps) {
  if (WIN) return ['-f', 'lavfi', '-i', `ddagrab=output_idx=${disp.idx}:framerate=${fps}:draw_mouse=1`];
  const w = Math.round(disp.bounds.width * disp.scale), h = Math.round(disp.bounds.height * disp.scale);
  return ['-f', 'x11grab', '-framerate', String(fps), '-video_size', `${w - (w % 2)}x${h - (h % 2)}`, '-i', `${process.env.DISPLAY || ':0'}+${disp.bounds.x},${disp.bounds.y}`];
}

// Starts ffmpeg and resolves once it is capturing. Falls through to the next
// encoder if one fails to start.
async function start({ displayId, fps, tempFile }) {
  const info = await detect();
  if (!info.available) throw new Error('Native capture unavailable');
  const disp = displayFor(displayId);
  for (const enc of info.encoders) {
    if (failed.has(enc)) continue;
    const args = ['-hide_banner', '-y', '-thread_queue_size', '512', ...inputArgs(disp, fps), ...encoderArgs(enc, fps),
      '-g', String(fps * 2), '-an', '-movflags', '+frag_keyframe+empty_moov+default_base_moof', '-f', 'mp4', tempFile];
    const proc = spawn(ffmpegPath(), args, { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] });
    let log = '';
    const startedAt = await new Promise(res => {
      const t = setTimeout(() => res(null), 8000);
      proc.stderr.on('data', d => {
        log = (log + d.toString()).slice(-8000);
        if (/frame=\s*\d+/.test(log) || /Press \[q\]/.test(log)) { clearTimeout(t); res(Date.now()); }
      });
      proc.on('exit', () => { clearTimeout(t); res(null); });
      proc.on('error', () => { clearTimeout(t); res(null); });
    });
    if (startedAt && proc.exitCode === null) {
      const id = Math.random().toString(36).slice(2);
      const done = new Promise(res => proc.on('exit', code => res(code)));
      running.set(id, { proc, tempFile, done, enc, log: () => log });
      return { id, startedAt, encoder: enc };
    }
    try { proc.kill(); } catch (e) {}
    console.error(`[capture] ${enc} failed:`, log.slice(-1500));
    failed.add(enc);
    try { fs.unlinkSync(tempFile); } catch (e) {}
  }
  throw new Error('No encoder could start');
}

// Stops ffmpeg cleanly, then rewrites the file as a normal MP4 that seeks fast in
// any player. The fragmented recording is kept if the rewrite fails.
async function stop(id, finalFile) {
  const r = running.get(id); if (!r) return null;
  running.delete(id);
  try { r.proc.stdin.write('q'); r.proc.stdin.end(); } catch (e) {}
  const killer = setTimeout(() => { try { r.proc.kill(); } catch (e) {} }, 10000);
  await r.done; clearTimeout(killer);
  if (!fs.existsSync(r.tempFile)) return null;
  const ok = await run(['-hide_banner', '-loglevel', 'error', '-y', '-i', r.tempFile, '-c', 'copy', '-movflags', '+faststart', finalFile], 10 * 60 * 1000);
  if (ok && fs.existsSync(finalFile) && fs.statSync(finalFile).size > 0) { try { fs.unlinkSync(r.tempFile); } catch (e) {} return finalFile; }
  try { fs.renameSync(r.tempFile, finalFile); return finalFile; } catch (e) { return r.tempFile; }
}

// Exports come out of Chromium with Opus sound, which iPhones and some social sites
// reject. This swaps it for AAC (the picture is copied untouched).
async function toAac(file) {
  if (!ffmpegPath()) return false;
  const tmp = file.replace(/\.mp4$/i, '') + '.aac-tmp.mp4';
  const ok = await run(['-hide_banner', '-loglevel', 'error', '-y', '-i', file, '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', tmp], 10 * 60 * 1000);
  if (ok && fs.existsSync(tmp) && fs.statSync(tmp).size > 0) { fs.renameSync(tmp, file); return true; }
  try { fs.unlinkSync(tmp); } catch (e) {}
  return false;
}

function stopAll() { for (const r of running.values()) { try { r.proc.stdin.write('q'); } catch (e) {} } }

module.exports = { detect, start, stop, stopAll, toAac };
