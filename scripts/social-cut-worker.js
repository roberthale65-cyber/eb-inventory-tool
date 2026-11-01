// Makes the 15-second social cuts the server is waiting for. Runs in the "Social video cuts"
// GitHub Action, started by the server when a cut is wanted, with a 30-minute schedule as backup
// (.github/workflows/social-cuts.yml): asks the server which
// listing videos need a cut, makes each one with lib/social-cut.js, and sends it back. The server
// saves it to Drive and posts it. A video Claude finds no good footage in is reported back, so the
// post goes out with the listing video as it is.
// Needs SOCIAL_CUT_KEY (shared with the server) and ANTHROPIC_API_KEY.
// Logs stay to EB numbers and stages: this repository's Action logs are public.
const fs = require('fs'), path = require('path'), os = require('os');
const { makeCut } = require('../lib/social-cut');

const SERVER = (process.env.SERVER_URL || 'https://eb-shopify-server.onrender.com').replace(/\/$/, '');
const KEY = process.env.SOCIAL_CUT_KEY, API_KEY = process.env.ANTHROPIC_API_KEY;
const BUDGET_MS = 75 * 60 * 1000; // start no new cut after this, so a run ends well within its timeout

// The server may be asleep on Render's free tier: the first call can take a minute.
async function server(pathname, opts = {}) {
  for (let attempt = 1; ; attempt++) {
    try {
      const r = await fetch(SERVER + pathname, { ...opts, headers: { 'x-cut-key': KEY, ...(opts.headers || {}) }, signal: AbortSignal.timeout(120000) });
      if (r.status === 502 || r.status === 503) throw new Error('server is starting');
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw Object.assign(new Error(data.error || `HTTP ${r.status}`), { final: r.status < 500 });
      return data;
    } catch (e) {
      if (e.final || attempt >= 4) throw e;
      await new Promise(res => setTimeout(res, 30000));
    }
  }
}

(async () => {
  if (!KEY) throw new Error('SOCIAL_CUT_KEY is not set');
  const started = Date.now();
  const { jobs } = await server('/marketing/cut-jobs');
  console.log(`${jobs.length} cut(s) wanted`);
  for (const job of jobs) {
    if (Date.now() - started > BUDGET_MS) { console.log('Time is up; the rest wait for the next run.'); break; }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cut-'));
    const t0 = Date.now();
    try {
      const cut = await makeCut(job.src, dir, { apiKey: API_KEY, onStage: s => console.log(`${job.eb}: ${s}`) });
      await server(`/marketing/cut-upload/${job.name}`, { method: 'POST', headers: { 'content-type': 'video/mp4' }, body: fs.readFileSync(cut.file) });
      console.log(`${job.eb}: done, ${cut.length.toFixed(1)} s, made in ${Math.round((Date.now() - t0) / 1000)} s (moments ${cut.moments.map(m => `${m.start}-${m.end}`).join(', ')})`);
    } catch (e) {
      console.log(`${job.eb}: failed — ${e.message}`);
      // Claude's verdict on the footage is final; anything else (a network blip) is tried again
      // next run, and the server gives up after a few tries.
      const final = /no footage good enough|is only \d+ s long|did not pick|too short|overlap|the cut would be|not readable/.test(e.message);
      await server(`/marketing/cut-failed/${job.name}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ error: e.message, retry: !final }) }).catch(() => {});
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
})().catch(e => { console.error(e.message); process.exit(1); });
