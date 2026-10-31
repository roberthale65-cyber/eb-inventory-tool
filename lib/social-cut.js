// The 15-second social cut of a listing video, built to the rules Patti approved over four
// review rounds (social-video-cut-rules.md, 2026-10-31): three moments (the whole piece, a close
// look at the flowers and berries, the whole piece again), the footage slowed to 70% with motion
// smoothing, 1-second dissolves, a light zoom on the whole-piece shots, and the white logo nearly
// full width at the bottom for the whole video. No captions, no sound.
// Claude picks the three moments from frames of the listing video.
// Used by scripts/social-cut-worker.js in a GitHub Action: the smoothing needs far more memory
// and CPU than the Render instance has (making cuts there restarted it, 2026-10-31). The server
// only uses cutName() to know which cut belongs to which video.
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const { spawn } = require('child_process');

const VERSION = 1; // bump when the recipe changes so old cuts are remade
const SPEED = 0.7, DISSOLVE = 1, W = 1080, H = 1920;
const LOGO_W = 1000, LOGO_BOTTOM = 170; // px in the 1080×1920 frame (Patti, round 3)
const LOGO = path.join(__dirname, '..', 'assets', 'logo-white.png');
const STEP_TIMEOUT_MS = 40 * 60 * 1000;

const cutName = src => crypto.createHash('sha256').update(`${VERSION}|cut|${src}`).digest('hex').slice(0, 32) + '.mp4';

function ffmpeg(args, { allowFail = false, timeoutMs = STEP_TIMEOUT_MS } = {}) {
  const bin = require('@ffmpeg-installer/ffmpeg').path;
  return new Promise((resolve, reject) => {
    const p = spawn(bin, ['-hide_banner', '-y', ...args]);
    let log = '';
    p.stderr.on('data', c => { log += c; if (log.length > 40000) log = log.slice(-20000); });
    const timer = setTimeout(() => p.kill('SIGKILL'), timeoutMs);
    p.on('error', e => { clearTimeout(timer); reject(e); });
    p.on('close', code => {
      clearTimeout(timer);
      if (code === 0 || allowFail) return resolve(log);
      reject(new Error('ffmpeg failed: ' + log.trim().split('\n').slice(-2).join(' ').slice(0, 300)));
    });
  });
}

async function probe(file) {
  const log = await ffmpeg(['-i', file], { allowFail: true });
  const size = log.match(/Video:.*?\b(\d{2,5})x(\d{2,5})\b/), dur = log.match(/Duration: (\d+):(\d+):([\d.]+)/);
  if (!size || !dur) throw new Error('could not read the video');
  let w = +size[1], h = +size[2];
  if (/rotate\s*:\s*-?(90|270)/.test(log)) [w, h] = [h, w]; // iPhone MOVs; ffmpeg auto-rotates
  return { w, h, duration: +dur[1] * 3600 + +dur[2] * 60 + +dur[3] };
}

// Claude looks at a frame every second or two and picks the three moments.
async function pickMoments(file, info, dir, apiKey) {
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set');
  const step = info.duration > 60 ? 2 : 1, frames = path.join(dir, 'frames');
  fs.mkdirSync(frames, { recursive: true });
  await ffmpeg(['-i', file, '-vf', `fps=1/${step},scale=200:-2`, '-q:v', '5', path.join(frames, 'f%03d.jpg')]);
  const names = fs.readdirSync(frames).filter(n => n.endsWith('.jpg')).sort().slice(0, 90);
  const content = [];
  names.forEach((n, i) => {
    content.push({ type: 'text', text: `t=${(i * step).toFixed(0)}s` });
    content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: fs.readFileSync(path.join(frames, n)).toString('base64') } });
  });
  content.push({ type: 'text', text: `These are frames from a ${info.duration.toFixed(1)}-second listing video of one handmade faux floral piece (wreath, swag, centerpiece or arrangement), one frame every ${step} s. Pick three moments of the source video for a 15-second social cut. Each moment is played at 70% speed, so the source moments must add up to 11.0–11.9 s.

1. "open": the WHOLE piece, sharp and steady, about 3.2–3.6 s, usually near the start.
2. "detail": a close look at what makes the piece beautiful: the main flowers with the berries and best textures, about 3.0 s. Never a stretch that dwells on ribbon loops, bare branches, twigs, stems or plain greenery.
3. "close": the WHOLE piece again with a little room around it, about 4.6–5.2 s, usually near the end.

Rules: the moments are in time order and don't overlap. Only steady footage: no blur, focus hunting, fast camera moves, hands or people, and skip the first and last half second. The whole piece must be complete, not cut off, in "open" and "close". Prefer moments where the camera is still or moving slowly, since the joins are dissolves.
Each moment also gets a zoom and an anchor for the vertical 9:16 frame: zoom 1.1–1.2 on the whole-piece moments to trim empty wall (use 1.0 when zooming would cut off the ends of a wide piece), 1.0 on the detail; anchor 0–1 is where the crop sits vertically (0.5 centered, 0.55–0.6 when there is empty wall above the piece).
If the video has no stretch good enough for one of the moments, say so instead.
Answer with JSON only: {"ok":true,"moments":[{"start":0.0,"end":3.4,"zoom":1.1,"anchor":0.5},{...},{...}]} or {"ok":false,"reason":"..."}` });
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'claude-sonnet-4-5', max_tokens: 400, messages: [{ role: 'user', content }] })
  });
  const data = await r.json();
  if (!r.ok) throw new Error((data.error && data.error.message) || 'Anthropic API error');
  const text = (data.content && data.content[0] && data.content[0].text) || '';
  const json = JSON.parse((text.match(/\{[\s\S]*\}/) || ['{}'])[0]);
  if (!json.ok) throw new Error('no footage good enough for a social cut' + (json.reason ? ': ' + json.reason : ''));
  return checkMoments(json.moments, info.duration);
}
function checkMoments(moments, duration) {
  if (!Array.isArray(moments) || moments.length !== 3) throw new Error('Claude did not pick three moments');
  const out = moments.map(m => ({
    start: Math.max(0.3, +m.start || 0), end: Math.min(duration - 0.3, +m.end || 0),
    zoom: Math.min(1.25, Math.max(1, +m.zoom || 1)), anchor: Math.min(1, Math.max(0, m.anchor == null ? 0.5 : +m.anchor))
  }));
  out.forEach((m, i) => {
    if (m.end - m.start < 2.5) throw new Error(`moment ${i + 1} is too short`);
    if (i && m.start < out[i - 1].end - 0.05) throw new Error('the moments overlap');
  });
  const total = cutLength(out);
  if (total < 12 || total > 16.5) throw new Error(`the cut would be ${total.toFixed(1)} s`);
  return out;
}
const cutLength = ms => ms.reduce((s, m) => s + (m.end - m.start) / SPEED, 0) - DISSOLVE * (ms.length - 1);

// One moment: cropped to 9:16 and zoomed, slowed with motion smoothing, scaled to 1080×1920.
async function renderMoment(file, info, m, out) {
  const even = v => Math.max(2, Math.floor(v / 2) * 2);
  const baseW = Math.min(info.w, info.h * 9 / 16), baseH = baseW * 16 / 9;
  const cw = even(baseW / m.zoom), ch = even(baseH / m.zoom);
  const x = Math.round((info.w - cw) / 2), y = Math.round((info.h - ch) * m.anchor);
  await ffmpeg(['-ss', m.start.toFixed(2), '-t', (m.end - m.start).toFixed(2), '-i', file,
    '-vf', `setpts=(PTS-STARTPTS)/${SPEED},crop=${cw}:${ch}:${x}:${y},minterpolate=fps=30:mi_mode=mci:mc_mode=aobmc:me_mode=bidir:vsbmc=1,scale=${W}:${H},setsar=1`,
    '-an', '-c:v', 'libx264', '-crf', '16', '-preset', 'fast', out]);
}

// The moments joined with dissolves (this ffmpeg has no xfade, so each one fades in over the
// last on a black base), with the logo on top for the whole video.
async function assemble(parts, moments, out) {
  const b = fs.readFileSync(LOGO), logo = { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
  const lens = moments.map(m => (m.end - m.start) / SPEED), total = cutLength(moments);
  const lh = Math.round(LOGO_W * logo.h / logo.w / 2) * 2;
  const chain = [`color=black:s=${W}x${H}:r=30:d=${total.toFixed(2)}[base]`];
  let off = 0, last = 'base';
  parts.forEach((_, i) => {
    chain.push(`[${i}:v]setpts=PTS-STARTPTS,format=yuva420p${i ? `,fade=in:st=0:d=${DISSOLVE}:alpha=1` : ''},setpts=PTS+${off.toFixed(3)}/TB[s${i}]`);
    chain.push(`[${last}][s${i}]overlay=eof_action=pass[v${i}]`);
    last = `v${i}`; off += lens[i] - DISSOLVE;
  });
  chain.push(`[${parts.length}:v]scale=${LOGO_W}:${lh},format=rgba,fade=in:st=0:d=0.5:alpha=1[lg]`);
  chain.push(`[${last}][lg]overlay=x=(W-w)/2:y=H-h-${LOGO_BOTTOM}:eof_action=pass,format=yuv420p[out]`);
  await ffmpeg([...parts.flatMap(p => ['-i', p]), '-loop', '1', '-t', total.toFixed(2), '-i', LOGO,
    '-filter_complex', chain.join(';'), '-map', '[out]', '-t', total.toFixed(2),
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '21', '-maxrate', '7M', '-bufsize', '14M', '-pix_fmt', 'yuv420p', '-an', '-movflags', '+faststart', out]);
}

// Makes the cut of the video at `src` (a URL or a local file) inside `dir`; resolves with the
// path of the finished MP4 and the moments used. The three moments are smoothed side by side.
// `pick` replaces Claude's choice (for tests).
async function makeCut(src, dir, { apiKey, onStage = () => {}, pick } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const input = path.join(dir, 'listing.mp4'), out = path.join(dir, 'cut.mp4');
  onStage('downloading the listing video');
  if (/^https?:/.test(src)) {
    const r = await fetch(src);
    if (!r.ok) throw new Error(`video download failed (${r.status})`);
    fs.writeFileSync(input, Buffer.from(await r.arrayBuffer()));
  } else fs.copyFileSync(src, input);
  const info = await probe(input);
  if (info.duration < 12) throw new Error(`the listing video is only ${info.duration.toFixed(0)} s long`);
  onStage('choosing the best moments');
  const moments = pick ? checkMoments(await pick(info), info.duration) : await pickMoments(input, info, dir, apiKey);
  onStage('smoothing the three moments');
  const parts = moments.map((_, i) => path.join(dir, `part-${i}.mp4`));
  await Promise.all(moments.map((m, i) => renderMoment(input, info, m, parts[i])));
  onStage('adding the logo');
  await assemble(parts, moments, out);
  return { file: out, moments, length: cutLength(moments) };
}

module.exports = { VERSION, cutName, makeCut };
