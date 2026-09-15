#!/usr/bin/env node
// Build dist/glassbox.html (standalone, full document) and dist/glassbox.artifact.html (fragment for hosted publishing).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const core = read('src/trace-core.js');
let page = read('src/viewer.html');
const demoFiles = [
  ['test/fixtures/real-main.jsonl', 'session.jsonl'],
  ['test/fixtures/real-subagent.jsonl', 'session/subagents/agent-a898d892224cdc5a8.jsonl'],
  ['test/fixtures/real-subagent.meta.json', 'session/subagents/agent-a898d892224cdc5a8.meta.json'],
].filter(([p]) => fs.existsSync(path.join(root, p))).map(([p, name]) => ({ name, text: read(p) }));

// Fonts travel inside the file (assets/fonts, IBM Plex latin subsets, OFL) so the viewer makes no
// network request at all — test/offline.test.mjs and the e2e request log hold it to that.
const FONTS = [
  ['IBM Plex Sans', 400, 'ibm-plex-sans-latin-400-normal.woff2'],
  ['IBM Plex Sans', 500, 'ibm-plex-sans-latin-500-normal.woff2'],
  ['IBM Plex Sans', 600, 'ibm-plex-sans-latin-600-normal.woff2'],
  ['IBM Plex Sans Condensed', 500, 'ibm-plex-sans-condensed-latin-500-normal.woff2'],
  ['IBM Plex Sans Condensed', 600, 'ibm-plex-sans-condensed-latin-600-normal.woff2'],
  ['IBM Plex Mono', 400, 'ibm-plex-mono-latin-400-normal.woff2'],
  ['IBM Plex Mono', 500, 'ibm-plex-mono-latin-500-normal.woff2'],
];
const LATIN = 'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD';
const fontCss = FONTS.map(([family, weight, file]) => {
  const b64 = fs.readFileSync(path.join(root, 'assets/fonts', file)).toString('base64');
  return `@font-face{font-family:"${family}";font-style:normal;font-weight:${weight};font-display:swap;src:url(data:font/woff2;base64,${b64}) format("woff2");unicode-range:${LATIN}}`;
}).join('\n');
if (!page.includes('/*__FONTS__*/')) throw new Error('src/viewer.html has no /*__FONTS__*/ marker');
page = page.replace('/*__FONTS__*/', () => fontCss);

// Inline safely inside <script>: no "</script" sequences may survive.
const safe = (s) => s.replace(/<\/script/gi, '<\\/script').replace(/<!--/g, '<\\!--');
page = page.replace('/*__TRACE_CORE__*/', () => safe(core));
page = page.replace('/*__DEMO__*/null', () => safe(JSON.stringify(demoFiles)));

fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
fs.writeFileSync(path.join(root, 'dist/glassbox.artifact.html'), page);
const full = `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n${page.replace(/<title>[\s\S]*?<\/title>/, (m) => m)}`;
// Move <title>, <meta>, <link>, <style> into head; the rest into body.
const headParts = []; let body = page;
body = body.replace(/<title>[\s\S]*?<\/title>\s*|<meta [^>]*>\s*|<link [^>]*>\s*|<style>[\s\S]*?<\/style>\s*/g, (m) => { headParts.push(m.trim()); return ''; });
const standalone = `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n${headParts.join('\n')}\n</head>\n<body>\n${body}\n</body>\n</html>\n`;
void full;
fs.writeFileSync(path.join(root, 'dist/glassbox.html'), standalone);
const kb = (p) => Math.round(fs.statSync(path.join(root, p)).size / 1024);
console.log(`dist/glassbox.html ${kb('dist/glassbox.html')} KB · dist/glassbox.artifact.html ${kb('dist/glassbox.artifact.html')} KB · demo files: ${demoFiles.length}`);
