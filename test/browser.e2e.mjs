// End-to-end: load dist/glassbox.html in Chromium, load the demo, compare stat tiles with the Node core, screenshot.
// Run: node test/browser.e2e.mjs   (needs playwright + chromium; skipped by `npm test`)
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
// playwright may be a global install: resolve it via require so both layouts work
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const core = require('../src/trace-core.js');
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const dist = path.join(root, 'dist/glassbox.html');
if (!fs.existsSync(dist)) { console.error('build first: npm run build'); process.exit(1); }

const fixtures = [
  ['test/fixtures/real-main.jsonl', 'session.jsonl'],
  ['test/fixtures/real-subagent.jsonl', 'session/subagents/agent-a898d892224cdc5a8.jsonl'],
  ['test/fixtures/real-subagent.meta.json', 'session/subagents/agent-a898d892224cdc5a8.meta.json'],
].map(([p, name]) => ({ name, text: fs.readFileSync(path.join(root, p), 'utf8') }));
const expected = core.parseTrace(fixtures);
const expectedFindings = core.diagnose(expected);

const browser = await chromium.launch();
const errors = [];
for (const scheme of ['light', 'dark']) {
  const ctx = await browser.newContext({ viewport: { width: 1380, height: 900 }, colorScheme: scheme });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push('console: ' + m.text()); }); // font CDN may be offline in CI
  await page.goto('file://' + dist);
  await page.click('#demo');
  await page.waitForSelector('#main:not(.hidden)');
  const tiles = await page.$$eval('#strip .stat', (els) => els.map((e) => ({ l: e.querySelector('.l').textContent, v: e.querySelector('.v').textContent.trim() })));
  const byLabel = Object.fromEntries(tiles.map((t) => [t.l, t.v]));
  assert.equal(byLabel['Turns'], core.fmtInt(expected.totals.turns), 'turns tile');
  assert.equal(byLabel['Tool calls'], core.fmtInt(expected.totals.toolCalls), 'tool calls tile');
  assert.equal(byLabel['Wall time'], core.fmtDur(expected.totals.wallMs), 'wall time tile');
  assert.equal(byLabel['Subagents'], '1');
  const findingCount = await page.$$eval('#findings .finding', (els) => els.length);
  assert.equal(findingCount, expectedFindings.length, 'findings count');
  const lanes = await page.$$eval('#tl-svg .lane-label', (els) => els.length);
  assert.equal(lanes, expected.agents.length, 'timeline lanes');
  const toolRows = await page.$$eval('#tools tbody tr.row', (els) => els.length);
  assert.ok(toolRows >= 5, 'tools table rows');
  // click first finding → highlight + possibly drawer
  await page.click('#findings .finding');
  await page.waitForTimeout(150);
  const hl = await page.$$eval('#tl-svg .span.hl, #tl-svg .span.sel', (els) => els.length);
  assert.ok(hl >= 1, 'finding highlights evidence on the timeline');
  // click a tool span → drawer opens with its name
  await page.click('#tl-svg rect[data-kind="tool"]');
  await page.waitForSelector('#drawer.open');
  const title = await page.$eval('#d-title', (e) => e.textContent);
  assert.ok(title.length > 0, 'drawer title');
  await page.keyboard.press('Escape');
  // share mode blanks prompt text
  await page.click('#share');
  const promptTxt = await page.$eval('#turns details summary .p', (e) => e.textContent);
  assert.match(promptTxt, /«\d+ chars»|\(no prompt text\)/, 'share mode blanks prompts');
  await page.click('#share', { button: 'right' }); // back to normal
  // screenshot: top of page
  await page.screenshot({ path: path.join(root, `dist/screenshot-${scheme}.png`), fullPage: false });
  await ctx.close();
}
await browser.close();
if (errors.length) { console.error('browser errors:\n' + errors.join('\n')); process.exit(1); }
console.log('browser test passed: light + dark, tiles match core, findings', expectedFindings.length, 'lanes', expected.agents.length);
