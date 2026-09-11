// Glassbox live tail — follow a session transcript (and its subagents) as it grows, and serve
// the viewer with Server-Sent Events on 127.0.0.1. No dependencies. Nothing leaves the machine.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { subagentFiles } from './cli.mjs';

// Follow one session's files by byte offset. Emits:
//   { type: 'snapshot', files: [{name, text}] }     once, at start()
//   { type: 'append',   name, text }                 new complete lines
//   { type: 'replace',  name, text }                 file shrank or was rewritten → whole file again
// A trailing partial line (no newline yet) is held back until it completes.
export class Tailer {
  constructor(session, opts = {}) {
    this.session = session;
    this.pollMs = opts.pollMs || 1000;
    this.files = new Map(); // name -> { path, offset, pending }
    this.listeners = [];
    this.timer = null;
    this.watchers = [];
  }
  on(fn) { this.listeners.push(fn); return this; }
  emit(ev) { for (const fn of this.listeners) fn(ev); }

  // All files that belong to the session right now: main + subagents dir (Workflow agents included;
  // fs.watch below is not recursive, so their folders are picked up by the poll).
  discover() {
    const s = this.session;
    return [{ name: s.id + '.jsonl', path: s.file }, ...subagentFiles(s)];
  }

  // Read everything new. Returns the events it emitted (also emits them).
  tick() {
    const events = [];
    for (const { name, path: p } of this.discover()) {
      let st; try { st = fs.statSync(p); } catch (e) { continue; }
      let f = this.files.get(name);
      if (!f) { f = { path: p, offset: 0, pending: Buffer.alloc(0) }; this.files.set(name, f); }
      if (st.size < f.offset) { // truncated or rewritten
        f.offset = 0; f.pending = Buffer.alloc(0);
        const text = this.readFrom(f, st.size, true);
        events.push({ type: 'replace', name, text });
        continue;
      }
      if (st.size === f.offset) continue;
      const text = this.readFrom(f, st.size, false);
      if (text) events.push({ type: 'append', name, text });
    }
    for (const ev of events) this.emit(ev);
    return events;
  }

  // Read [offset, size) from the file; split at the last newline byte and keep the tail pending
  // as bytes, so a multi-byte UTF-8 character cut across two appends is reassembled intact.
  readFrom(f, size, whole) {
    const len = size - f.offset; if (len <= 0) return '';
    const fd = fs.openSync(f.path, 'r');
    let chunk;
    try { const buf = Buffer.alloc(len); const n = fs.readSync(fd, buf, 0, len, f.offset); chunk = buf.subarray(0, n); } finally { fs.closeSync(fd); }
    f.offset = size;
    const all = f.pending && f.pending.length ? Buffer.concat([f.pending, chunk]) : chunk;
    const cut = all.lastIndexOf(0x0a);
    if (cut < 0) { if (whole) { f.pending = Buffer.alloc(0); return all.toString('utf8'); } f.pending = Buffer.from(all); return ''; }
    f.pending = Buffer.from(all.subarray(cut + 1));
    return all.subarray(0, cut + 1).toString('utf8');
  }

  // Full current content of every file (complete lines only), as the viewer expects them.
  snapshot() {
    const files = [];
    for (const { name, path: p } of this.discover()) {
      let buf; try { buf = fs.readFileSync(p); } catch (e) { continue; }
      const cut = buf.lastIndexOf(0x0a);
      this.files.set(name, { path: p, offset: buf.length, pending: Buffer.from(cut < 0 ? buf : buf.subarray(cut + 1)) });
      files.push({ name, text: cut < 0 ? '' : buf.subarray(0, cut + 1).toString('utf8') });
    }
    return files;
  }

  // Everything emitted so far, per file (complete lines only): [0, offset − pending). Drains first so
  // a page that loads from this and then subscribes to /events cannot miss or duplicate a line.
  current() {
    this.tick();
    const out = [];
    for (const [name, f] of this.files) {
      const len = f.offset - f.pending.length; let text = '';
      if (len > 0) { try { const fd = fs.openSync(f.path, 'r'); try { const buf = Buffer.alloc(len); const n = fs.readSync(fd, buf, 0, len, 0); text = buf.toString('utf8', 0, n); } finally { fs.closeSync(fd); } } catch (e) { } }
      out.push({ name, text });
    }
    return out;
  }

  start() {
    const files = this.snapshot();
    this.emit({ type: 'snapshot', files });
    const kick = () => { try { this.tick(); } catch (e) { /* transient read errors: next tick */ } };
    // fs.watch where it works (fast), plus a poll (fs.watch misses events on some filesystems).
    const dirs = new Set([path.dirname(this.session.file), path.join(this.session.projectDir, this.session.id, 'subagents')]);
    for (const d of dirs) { try { if (fs.existsSync(d)) { const w = fs.watch(d, { persistent: false }, () => setTimeout(kick, 30)); w.on('error', () => { }); this.watchers.push(w); } } catch (e) { /* fall back to polling */ } }
    this.timer = setInterval(kick, this.pollMs); if (this.timer.unref) this.timer.unref();
    return files;
  }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; for (const w of this.watchers) { try { w.close(); } catch (e) { } } this.watchers = []; }
}

// Serve the viewer for one session on loopback and stream tail events to it.
// opts: { port (0 = random), template (dist/glassbox.html path), embed (fn files→html), pollMs }
export function serveLive(session, opts = {}) {
  const tailer = new Tailer(session, { pollMs: opts.pollMs });
  const clients = new Set();
  const send = (res, type, data) => { try { res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`); } catch (e) { clients.delete(res); } };
  tailer.on((ev) => { if (ev.type === 'snapshot') return; for (const res of clients) send(res, ev.type, ev); });
  const server = http.createServer((req, res) => {
    const url = (req.url || '/').split('?')[0];
    if (url === '/' || url === '/index.html') {
      let html = opts.embed(tailer.current());
      html = html.replace('/*__LIVE__*/null', () => JSON.stringify({ url: '/events', session: session.id, file: session.file }));
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(html); return;
    }
    if (url === '/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
      res.write(': glassbox live\n\n');
      clients.add(res);
      send(res, 'hello', { session: session.id, file: session.file, files: tailer.current() });
      req.on('close', () => clients.delete(res));
      return;
    }
    if (url === '/health') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, session: session.id, clients: clients.size, files: Array.from(tailer.files.keys()) })); return; }
    res.writeHead(404); res.end('not found');
  });
  const ping = setInterval(() => { for (const res of clients) send(res, 'ping', { t: Date.now() }); }, 15000); if (ping.unref) ping.unref();
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(opts.port || 0, '127.0.0.1', () => {
      tailer.start();
      const { port } = server.address();
      resolve({ url: `http://127.0.0.1:${port}/`, port, tailer, server, clients, close: () => new Promise((r) => { clearInterval(ping); tailer.stop(); for (const c of clients) { try { c.end(); } catch (e) { } } clients.clear(); server.close(() => r()); }) });
    });
  });
}
