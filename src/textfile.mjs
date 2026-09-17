// Text files a person may have saved on Windows. PowerShell 5.1's `>` writes UTF-16LE with a byte-order
// mark; `Set-Content -Encoding UTF8` and older Notepad write a UTF-8 BOM. Read all of them as the same text,
// so a report, rate card or legend works however it was saved. Transcripts go through parseLines, which
// already drops a UTF-8 BOM; everything a user hands to the CLI goes through here.
import fs from 'node:fs';

export function decodeText(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le');
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) { const le = Buffer.from(buf.subarray(2)); le.swap16(); return le.toString('utf16le'); }
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.subarray(3).toString('utf8');
  return buf.toString('utf8');
}

export function readTextFile(file) {
  return decodeText(fs.readFileSync(file));
}
