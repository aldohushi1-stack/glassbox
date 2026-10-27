// Reading transcripts of any size. V8 caps a string at buffer.constants.MAX_STRING_LENGTH (536,870,888 characters
// on Node 22), so readFileSync(file, 'utf8') throws ERR_STRING_TOO_LONG on a transcript past ~512 MB before a single
// line is parsed — an outside review found a 1.26 GB session that broke `check` outright. Files at or under
// streamBytes() are read exactly as before; bigger ones line by line, keeping the parsed record and dropping the
// line string at once. Synchronous on purpose: the callers (check, the Stop hook, fence) are synchronous.
// DESIGN.md §21.
import fs from 'node:fs';
import { constants } from 'node:buffer';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const core = require('./trace-core.js');

export const STREAM_BYTES = 64 * 1048576;
export const CHUNK_BYTES = 8 * 1048576;
export function streamBytes() { const n = Number(process.env.GLASSBOX_STREAM_BYTES); return Number.isFinite(n) && n > 0 ? n : STREAM_BYTES; }

// fn(line, n) for every line, 1-based, CRLF and a leading BOM removed — the lines text.split(/\r?\n/) would give.
// A line longer than maxLine bytes is never decoded: fn(null, n, bytes). Lines are cut on the 0x0A byte, which
// never occurs inside a UTF-8 multi-byte sequence, so a character split across two chunks is never split here.
export function forEachLine(file, fn, opts = {}) {
  const chunkBytes = opts.chunkBytes || CHUNK_BYTES;
  const maxLine = opts.maxLine || constants.MAX_STRING_LENGTH;
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.allocUnsafe(chunkBytes);
  let parts = [], partBytes = 0, n = 0, first = true, tooLong = false;
  const emit = (line) => {
    n++;
    if (tooLong || line.length > maxLine) { fn(null, n, tooLong ? partBytes : line.length); return; }
    let s = line.toString('utf8');
    if (first && s.charCodeAt(0) === 0xfeff) s = s.slice(1);
    if (s.charCodeAt(s.length - 1) === 13) s = s.slice(0, -1);
    fn(s, n);
  };
  try {
    for (;;) {
      const got = fs.readSync(fd, buf, 0, chunkBytes, null);
      if (!got) break;
      let at = 0;
      for (;;) {
        const nl = buf.indexOf(10, at);
        if (nl < 0 || nl >= got) {
          if (at < got) { partBytes += got - at; if (partBytes > maxLine) { tooLong = true; parts = []; } else parts.push(Buffer.from(buf.subarray(at, got))); }
          break;
        }
        const piece = buf.subarray(at, nl);
        const line = parts.length ? Buffer.concat([...parts, piece]) : piece;
        if (tooLong) partBytes += piece.length;
        emit(line); first = false;
        parts = []; partBytes = 0; tooLong = false; at = nl + 1;
      }
    }
    // The last line when the file doesn't end in \n. (After a final \n, split() would add an empty line; it is blank,
    // so no caller sees it either way.)
    if (parts.length || tooLong) emit(parts.length ? Buffer.concat(parts) : Buffer.alloc(0));
  } finally { fs.closeSync(fd); }
  return n;
}

// The records of one transcript file, as core.parseLines would give them from its text.
export const SLIM_LINE = 262144;
export function readRecords(file, name, opts = {}) {
  const records = [], problems = [];
  const slim = opts.slim !== false, keep = opts.keep || 32768;
  const bytes = fs.statSync(file).size;
  forEachLine(file, (line, n, len) => {
    if (line == null) { problems.push({ file: name, line: n, reason: `line too long (${len} bytes); skipped` }); return; }
    const t = line.trim(); if (!t) return;
    try {
      const r = JSON.parse(t);
      // A long line's huge strings become head + marker + tail (core.charsOf still gives their size): holding every
      // multi-MB tool result of a 1 GB session at once would run Node out of heap after the string limit was solved.
      // The JSON round trip matters as much as the cut: V8's JSON.parse and slice() can hand back strings that point
      // into the source, so even a uuid kept from a 4 MB line would keep the whole line alive. A copy owns its text.
      if (r && typeof r === 'object') records.push(core.normaliseLoose(slim && t.length > SLIM_LINE ? JSON.parse(JSON.stringify(core.slimRecord(r, keep))) : r, n, name));
      else problems.push({ file: name, line: n, reason: 'not an object' });
    } catch (e) { problems.push({ file: name, line: n, reason: 'bad JSON: ' + String(e.message).slice(0, 80) }); }
  }, opts);
  return { name, records, problems, bytes };
}

// One file for parseTrace: { name, text } as before, or { name, records, problems, bytes } past the threshold.
// A whole-file JSON array or a .meta.json is always text (they can't be read line by line; a JSON array past the
// string limit is reported, not thrown).
export function readTranscript(file, name, opts = {}) {
  const size = fs.statSync(file).size;
  if (size <= (opts.streamBytes || streamBytes()) || /\.meta\.json$/.test(name)) return { name, text: fs.readFileSync(file, 'utf8') };
  // The first non-blank character decides; read until there is one (a JSON array can follow a long run of blanks).
  const fd = fs.openSync(file, 'r'); const head = Buffer.alloc(65536); let first = '';
  try { for (let pos = 0; ;) { const got = fs.readSync(fd, head, 0, head.length, pos); if (!got) break; const t = head.subarray(0, got).toString('latin1').replace(/^\xef\xbb\xbf/, '').replace(/^\s+/, ''); if (t) { first = t[0]; break; } pos += got; } } finally { fs.closeSync(fd); }
  if (first === '[') {
    if (size < constants.MAX_STRING_LENGTH / 2) return { name, text: fs.readFileSync(file, 'utf8') };
    return { name, records: [], problems: [{ file: name, line: 0, reason: `a JSON array of ${size} bytes is too large to read; convert it to JSONL (one record per line)` }], bytes: size };
  }
  return readRecords(file, name, opts);
}

// Does the file contain `needle` (already lowercased)? Line by line, so it works on any size.
export function fileIncludes(file, needle) {
  if (fs.statSync(file).size <= streamBytes()) return fs.readFileSync(file, 'utf8').toLowerCase().includes(needle);
  let hit = false;
  try { forEachLine(file, (line) => { if (!hit && line && line.toLowerCase().includes(needle)) { hit = true; throw STOP; } }); } catch (e) { if (e !== STOP) throw e; }
  return hit;
}
const STOP = Symbol('stop');
