#!/usr/bin/env node
// Markdown -> the print page used for docs/Glassbox-for-IT.html and docs/Glassbox-pilot.html.
//   node scripts/mdpage.mjs <in.md> <existing-or-out.html> <title> <foot> [out.html]
// Mimics the Python-Markdown (tables + fenced_code) output those pages were first made with, for the
// constructs the two docs use. The head and CSS are copied verbatim from the existing page. Relative
// links (../SECURITY.md) point at the file on GitHub, so they still work in the PDF.
//
//   node scripts/mdpage.mjs docs/IT.md docs/Glassbox-for-IT.html "Glassbox for IT — glassbox-trace 0.9.1" \
//     "glassbox-trace 0.9.1 · github.com/aldohushi1-stack/glassbox/blob/main/docs/IT.md · pilot plan: docs/PILOT.md"
//   node scripts/mdpage.mjs docs/PILOT.md docs/Glassbox-pilot.html "A two-week Glassbox pilot" \
//     "glassbox-trace 0.9.1 · github.com/aldohushi1-stack/glassbox/blob/main/docs/PILOT.md · IT inventory: docs/IT.md"
//
// Then print the PDF with Chrome (Windows paths shown):
//   chrome.exe --headless=new --disable-gpu --no-first-run --no-pdf-header-footer
//     --user-data-dir=<temp dir> --print-to-pdf=docs\Glassbox-for-IT.pdf file:///C:/…/docs/Glassbox-for-IT.html
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BLOB = 'https://github.com/aldohushi1-stack/glassbox/blob/main/';

const [, , mdPath, htmlPath, title, foot, outPath] = process.argv;
if (!foot) { console.error('usage: node scripts/mdpage.mjs <in.md> <existing-or-out.html> <title> <foot> [out.html]'); process.exit(2); }
const md = fs.readFileSync(mdPath, 'utf8').replace(/\r\n/g, '\n');
const old = fs.readFileSync(htmlPath, 'utf8').replace(/\r\n/g, '\n'); // a CRLF checkout still gives an all-LF page
const headEnd = old.indexOf('</style></head><body>');
if (headEnd < 0) throw new Error('no head in ' + htmlPath);
const head = old.slice(0, headEnd).replace(/<title>[^<]*<\/title>/, `<title>${title}</title>`) + '</style></head><body>';

const mdDir = path.relative(root, path.dirname(path.resolve(mdPath))).split(path.sep).join('/');
const href = (h) => (/^[a-z][a-z0-9+.-]*:|^#/i.test(h) ? h : BLOB + path.posix.normalize(path.posix.join(mdDir, h)));

const MARK = String.fromCharCode(0);
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function inline(s) {
  const codes = [];
  // Code spans are set aside behind NUL-delimited placeholders so the emphasis rules can't touch them.
  s = s.replace(/`([^`]+)`/g, (m, c) => { codes.push(`<code>${esc(c)}</code>`); return MARK + (codes.length - 1) + MARK; });
  s = esc(s);
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, text, h) => `<a href="${href(h)}">${text}</a>`);
  s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^\w])_(\S(?:.*?\S)?)_(?![\w])/g, '$1<em>$2</em>');
  s = s.replace(/(^|[^\w*])\*(\S(?:.*?\S)?)\*(?![\w*])/g, '$1<em>$2</em>');
  return s.split(MARK).map((part, k) => (k % 2 ? codes[+part] : part)).join('');
}
const cells = (row) => row.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());

const lines = md.split('\n');
const out = [];
let i = 0;
while (i < lines.length) {
  const line = lines[i];
  if (!line.trim()) { i++; continue; }
  let m;
  if (/^```/.test(line)) {
    const body = []; i++;
    while (i < lines.length && !/^```/.test(lines[i])) body.push(lines[i++]);
    i++;
    out.push(`<pre><code>${esc(body.join('\n')).replace(/"/g, '&quot;')}\n</code></pre>`);
  } else if ((m = line.match(/^(#{1,6})\s+(.*)$/))) {
    out.push(`<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`); i++;
  } else if (/^\|/.test(line) && i + 1 < lines.length && /^\|[\s:|-]+\|?\s*$/.test(lines[i + 1])) {
    const hdr = cells(line); i += 2;
    const rows = [];
    while (i < lines.length && /^\|/.test(lines[i])) rows.push(cells(lines[i++]));
    out.push('<table>', '<thead>', '<tr>', ...hdr.map((c) => `<th>${inline(c)}</th>`), '</tr>', '</thead>', '<tbody>');
    for (const r of rows) out.push('<tr>', ...r.map((c) => `<td>${inline(c)}</td>`), '</tr>');
    out.push('</tbody>', '</table>');
  } else if (/^(?:[-*+]|\d+\.)\s+/.test(line)) {
    // A list runs until a non-item, non-blank line; an item next to a blank line is "loose" (<p>-wrapped).
    const ordered = /^\d+\./.test(line);
    const itemRe = ordered ? /^\d+\.\s+(.*)$/ : /^[-*+]\s+(.*)$/;
    const items = [];
    let blankBefore = false;
    while (i < lines.length) {
      if (!lines[i].trim()) {
        const next = lines.slice(i).find((l) => l.trim());
        if (next && itemRe.test(next)) { if (items.length) items[items.length - 1].loose = true; blankBefore = true; i++; continue; }
        break;
      }
      const im = lines[i].match(itemRe);
      if (im) { items.push({ text: im[1], loose: blankBefore }); blankBefore = false; i++; continue; }
      if (/^\s+\S/.test(lines[i]) && items.length) { items[items.length - 1].text += '\n' + lines[i].trim(); i++; continue; }
      break;
    }
    out.push(ordered ? '<ol>' : '<ul>');
    for (const it of items) out.push(it.loose ? `<li>\n<p>${inline(it.text)}</p>\n</li>` : `<li>${inline(it.text)}</li>`);
    out.push(ordered ? '</ol>' : '</ul>');
  } else {
    const para = [];
    while (i < lines.length && lines[i].trim() && !/^(```|#{1,6}\s|\||(?:[-*+]|\d+\.)\s)/.test(lines[i])) para.push(lines[i++]);
    out.push(`<p>${inline(para.join('\n'))}</p>`);
  }
}
const html = head + out.join('\n') + `<p class="foot">${foot}</p></body></html>`;
fs.writeFileSync(outPath || htmlPath, html);
console.log(`${outPath || htmlPath}: ${html.length} bytes`);
