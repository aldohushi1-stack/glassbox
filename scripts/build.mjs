#!/usr/bin/env node
// Build dist/glassbox.html (standalone, full document) and dist/glassbox.artifact.html (fragment for hosted publishing).
import fs from 'node:fs';
import path from 'node:path';
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const core = read('src/trace-core.js');
let page = read('src/viewer.html');
const demoFiles = [
  ['test/fixtures/real-main.jsonl', 'session.jsonl'],
  ['test/fixtures/real-subagent.jsonl', 'session/subagents/agent-a898d892224cdc5a8.jsonl'],
  ['test/fixtures/real-subagent.meta.json', 'session/subagents/agent-a898d892224cdc5a8.meta.json'],
].filter(([p]) => fs.existsSync(path.join(root, p))).map(([p, name]) => ({ name, text: read(p) }));

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
