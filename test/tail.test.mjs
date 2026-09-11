import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { session } from './gen.mjs';
import { Tailer, serveLive } from '../src/tail.mjs';
import { sessionFromTranscriptPath, embed } from '../src/cli.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const line = (o) => JSON.stringify(o) + '\n';

function tmpSession() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glassbox-tail-'));
  const file = path.join(dir, 'sess0001-0000.jsonl');
  const s = session({ sessionId: 'sess0001-0000' }); s.user('start'); s.assistant([{ text: 'hi' }]);
  fs.writeFileSync(file, s.text());
  return { dir, file, s: sessionFromTranscriptPath(file) };
}

test('tailer: snapshot then append of complete lines only; partial line is held until its newline', () => {
  const { file, s } = tmpSession();
  const t = new Tailer(s); const evs = []; t.on((e) => evs.push(e));
  const snap = t.snapshot();
  assert.equal(snap.length, 1); assert.equal(snap[0].name, 'sess0001-0000.jsonl');
  assert.equal(t.tick().length, 0, 'nothing new');
  const rec = { type: 'user', message: { role: 'user', content: 'more' }, timestamp: new Date().toISOString() };
  const full = line(rec);
  fs.appendFileSync(file, full.slice(0, 20));
  assert.equal(t.tick().length, 0, 'half a line is not an event');
  fs.appendFileSync(file, full.slice(20));
  const ev = t.tick();
  assert.equal(ev.length, 1); assert.equal(ev[0].type, 'append'); assert.equal(ev[0].text, full);
  assert.equal(t.tick().length, 0);
});

test('tailer: file shrink → replace with the whole new content; new subagent file is discovered', () => {
  const { dir, file, s } = tmpSession();
  const t = new Tailer(s); t.snapshot();
  const small = line({ type: 'user', message: { role: 'user', content: 'rewritten' } });
  fs.writeFileSync(file, small);
  let ev = t.tick();
  assert.equal(ev.length, 1); assert.equal(ev[0].type, 'replace'); assert.equal(ev[0].text, small);
  const sub = path.join(dir, 'sess0001-0000', 'subagents'); fs.mkdirSync(sub, { recursive: true });
  const subLine = line({ type: 'user', agentId: 'ag1', isSidechain: true, message: { role: 'user', content: 'sub' } });
  fs.writeFileSync(path.join(sub, 'agent-ag1.jsonl'), subLine);
  ev = t.tick();
  assert.equal(ev.length, 1); assert.equal(ev[0].name, 'sess0001-0000/subagents/agent-ag1.jsonl'); assert.equal(ev[0].text, subLine);
});

test('tailer: multi-byte UTF-8 split across two appends survives', () => {
  const { file, s } = tmpSession();
  const t = new Tailer(s); t.snapshot();
  const full = line({ type: 'user', message: { role: 'user', content: 'héllo wörld — ✓' } });
  const buf = Buffer.from(full, 'utf8');
  const i = buf.indexOf(Buffer.from('ö', 'utf8')) + 1; // cut inside the 2-byte ö
  fs.appendFileSync(file, buf.subarray(0, i)); t.tick();
  fs.appendFileSync(file, buf.subarray(i));
  const ev = t.tick();
  assert.equal(ev.length, 1);
  assert.equal(ev[0].text, full, 'reassembled line is byte-identical');
});

function sse(url) {
  // Minimal SSE client: resolves with {events: [...], close}
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      const events = []; const waiters = [];
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n\n')) >= 0) { const block = buf.slice(0, i); buf = buf.slice(i + 2); const ev = {}; for (const l of block.split('\n')) { if (l.startsWith('event: ')) ev.type = l.slice(7); else if (l.startsWith('data: ')) ev.data = JSON.parse(l.slice(6)); } if (ev.type) { events.push(ev); for (const w of waiters.splice(0)) w(); } } });
      resolve({ events, close: () => req.destroy(), next: (type, ms = 3000) => new Promise((r, j) => { const t0 = Date.now(); const check = () => { const e = events.find((x) => x.type === type && !x._taken); if (e) { e._taken = true; return r(e); } if (Date.now() - t0 > ms) return j(new Error('timeout waiting for ' + type)); waiters.push(check); }; check(); }) });
    });
    req.on('error', reject);
  });
}

test('serveLive: serves the viewer with LIVE config, streams hello then append events, health reports clients', { skip: !fs.existsSync(path.join(ROOT, 'dist/glassbox.html')) }, async () => {
  const { file, s } = tmpSession();
  const live = await serveLive(s, { port: 0, pollMs: 50, embed: (files) => embed(files) });
  try {
    assert.match(live.url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
    const html = await (await fetch(live.url)).text();
    assert.ok(html.includes('"url":"/events"'), 'LIVE config injected');
    assert.ok(html.includes('sess0001-0000.jsonl'), 'current transcript embedded');
    const c = await sse(live.url + 'events');
    const hello = await c.next('hello');
    assert.equal(hello.data.session, 'sess0001-0000');
    const rec = line({ type: 'user', message: { role: 'user', content: 'live line' }, timestamp: new Date().toISOString() });
    fs.appendFileSync(file, rec);
    const ap = await c.next('append');
    assert.equal(ap.data.text, rec, 'exactly the new line arrives');
    const health = await (await fetch(live.url + 'health')).json();
    assert.equal(health.ok, true); assert.equal(health.clients, 1);
    const nf = await fetch(live.url + 'nope'); assert.equal(nf.status, 404);
    c.close();
  } finally { await live.close(); }
});
