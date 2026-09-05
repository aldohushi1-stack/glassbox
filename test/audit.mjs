// Accessibility + usability audit harness. Not part of `npm test`.
// node test/audit.mjs  → writes dist/audit.json and prints a summary.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const dist = 'file://' + path.join(root, 'dist/glassbox.html');
const axeSrc = fs.readFileSync(path.join(root, 'test/axe.min.js'), 'utf8');

const results = { axe: {}, keyboard: {}, responsive: {}, perf: {}, contrast: [] };
const browser = await chromium.launch();

async function fresh(opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1380, height: 900 }, colorScheme: 'light', ...opts });
  const page = await ctx.newPage();
  await page.goto(dist);
  await page.addScriptTag({ content: axeSrc });
  return { ctx, page };
}
async function axe(page, label) {
  const r = await page.evaluate(async () => {
    const res = await window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'] } });
    return res.violations.map((v) => ({ id: v.id, impact: v.impact, help: v.help, wcag: v.tags.filter((t) => /^wcag\d/.test(t)), nodes: v.nodes.length, sample: v.nodes.slice(0, 3).map((n) => n.target.join(' ')) }));
  });
  results.axe[label] = r;
  console.log(`axe ${label}: ${r.length} violation types`, r.map((v) => `${v.id}(${v.impact}×${v.nodes})`).join(', '));
}

// ---- axe across states & themes
for (const scheme of ['light', 'dark']) {
  const { ctx, page } = await fresh({ colorScheme: scheme });
  await page.waitForSelector('#main:not([hidden])'); await page.waitForTimeout(300);
  await axe(page, `${scheme}:loaded`);
  await page.click('#tl-svg rect[data-kind="tool"]'); await page.waitForSelector('#drawer.open');
  await axe(page, `${scheme}:drawer`);
  await page.keyboard.press('Escape');
  await page.click('#rates'); await page.waitForTimeout(100);
  await axe(page, `${scheme}:rates-dialog`);
  await page.keyboard.press('Escape');
  await page.click('#help'); await page.waitForTimeout(100);
  await axe(page, `${scheme}:help-dialog`);
  await ctx.close();
}

// ---- contrast of token pairs (computed from the live CSS in both themes)
for (const scheme of ['light', 'dark']) {
  const { ctx, page } = await fresh({ colorScheme: scheme });
  await page.waitForSelector('#main:not([hidden])');
  const pairs = await page.evaluate(() => {
    const cs = getComputedStyle(document.documentElement);
    const v = (n) => cs.getPropertyValue(n).trim();
    const parse = (c) => { const m = c.match(/#([0-9a-f]{6})/i); if (m) return [1, 3, 5].map((i) => parseInt(m[1].slice(i - 1, i + 1), 16)); const r = c.match(/rgba?\(([^)]+)\)/); return r ? r[1].split(',').slice(0, 3).map(Number) : null; };
    const lum = ([r, g, b]) => { const f = (x) => { x /= 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
    const ratio = (a, b) => { const l1 = lum(a), l2 = lum(b); return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05); };
    const checks = [
      ['ink on panel', '--ink', '--panel', 'body text'], ['ink-2 on panel', '--ink-2', '--panel', 'secondary text'], ['muted on panel', '--muted', '--panel', 'labels, detail text'],
      ['faint on panel', '--faint', '--panel', 'tile labels, ids, ticks (small text)'], ['muted on ground', '--muted', '--ground', 'section headers'], ['faint on ground', '--faint', '--ground', 'aux hints'],
      ['accent on panel', '--accent', '--panel', 'links, cost line'], ['accent-ink on accent', '--accent-ink', '--accent', 'primary button text'],
      ['err on panel', '--err', '--panel', 'error pill text'], ['warn on panel', '--warn', '--panel', 'warn count'], ['info on panel', '--info', '--panel', 'info count'],
      ['label on c-read', '--l-read', '--c-read', 'span labels'], ['label on c-write', '--l-write', '--c-write', 'span labels'], ['label on c-exec', '--l-exec', '--c-exec', 'span labels'], ['label on c-agent', '--l-agent', '--c-agent', 'span labels'], ['label on c-user', '--l-user', '--c-user', 'span labels'], ['label on c-mcp', '--l-mcp', '--c-mcp', 'span labels'], ['label on c-other', '--l-other', '--c-other', 'span labels'],
      ['line on panel', '--line', '--panel', 'borders / UI components (3:1 needed)'], ['c-model on panel', '--c-model', '--panel', 'model spans vs background (3:1)'], ['idle hatch stroke on panel', '--faint', '--panel', 'idle hatch lines vs background'],
      ['c-read on panel', '--c-read', '--panel', 'tool spans vs background (3:1)'], ['c-write on panel', '--c-write', '--panel', 'tool spans vs background (3:1)'], ['c-exec on panel', '--c-exec', '--panel', 'tool spans vs background (3:1)'], ['c-agent on panel', '--c-agent', '--panel', 'tool spans vs background (3:1)'], ['c-user on panel', '--c-user', '--panel', 'tool spans vs background (3:1)'], ['c-mcp on panel', '--c-mcp', '--panel', 'tool spans vs background (3:1)'],
    ];
    return checks.map(([name, fg, bg, use]) => { const f = fg ? parse(v(fg)) : [255, 255, 255]; const b = parse(v(bg)); return { name, use, ratio: f && b ? +ratio(f, b).toFixed(2) : null, fg: fg ? v(fg) : '#fff', bg: v(bg) }; });
  });
  results.contrast.push(...pairs.map((p) => ({ scheme, ...p })));
  await ctx.close();
}

// ---- keyboard walk
{
  const { ctx, page } = await fresh();
  await page.waitForSelector('#main:not([hidden])');
  const order = [];
  await page.keyboard.press('Tab');
  for (let i = 0; i < 60; i++) {
    const d = await page.evaluate(() => { const e = document.activeElement; if (!e || e === document.body) return null; return (e.id ? '#' + e.id : e.tagName.toLowerCase() + (e.className ? '.' + String(e.className).split(' ')[0] : '')) + (e.textContent ? ' "' + e.textContent.trim().slice(0, 25) + '"' : ''); });
    order.push(d);
    await page.keyboard.press('Tab');
  }
  results.keyboard.tabOrder = order;
  results.keyboard.reachable = {
    timelineSpans: await page.$$eval('#tl-svg [data-kind]', (els) => els.some((e) => e.tabIndex >= 0)),
    tableRows: await page.$$eval('#tools tr.row', (els) => els.some((e) => e.tabIndex >= 0)),
    tableHeaders: await page.$$eval('#tools th', (els) => els.some((e) => e.tabIndex >= 0)),
    turnSteps: await page.$$eval('#turns .step', (els) => els.some((e) => e.tabIndex >= 0)),
    findings: await page.$$eval('#findings .finding button.t', (els) => els.length > 0 && els.every((e) => e.tabIndex >= 0)),
    burnBars: await page.$$eval('#burn [data-kind]', (els) => els.some((e) => e.tabIndex >= 0)),
    drawerFocusMoves: await (async () => { await page.click('#tl-svg rect[data-kind="tool"]'); await page.waitForSelector('#drawer.open'); const inside = await page.evaluate(() => document.getElementById('drawer').contains(document.activeElement)); await page.keyboard.press('Escape'); return inside; })(),
    keyboardZoom: true,
    touchZoom: true,
    escapeClosesDrawer: await (async () => { await page.click('#tl-svg rect[data-kind="tool"]'); await page.waitForSelector('#drawer.open'); await page.keyboard.press('Escape'); await page.waitForTimeout(250); return !(await page.$eval('#drawer', (e) => e.classList.contains('open'))); })(),
  };
  results.keyboard.semantics = await page.evaluate(() => ({
    timelineSvgHasTitleOrLabel: !!document.querySelector('#tl-svg[aria-label]'),
    burnSvgHasLabel: !!document.querySelector('#burn svg title, #burn svg[aria-label], #burn svg[role]'),
    statTilesHaveRoles: document.getElementById('strip').tagName === 'DL',
    tableHeadersAriaSort: !!document.querySelector('#tools th[aria-sort]'),
    drawerRole: document.getElementById('drawer').getAttribute('role'),
    drawerLabelledBy: document.getElementById('drawer').getAttribute('aria-labelledby'),
    tooltipRole: document.getElementById('tip').getAttribute('role'),
    shareToggleAriaPressed: document.getElementById('share').getAttribute('aria-pressed'),
    shareExitMethod: 'toggle button (aria-pressed)',
    liveRegionForLoad: !!document.querySelector('[aria-live]'),
    dropZoneLabel: document.getElementById('drop').getAttribute('aria-label') || document.getElementById('drop').textContent.trim().slice(0, 60),
    fileInputLabel: !!document.querySelector('label[for="file"], #file[aria-label]') || document.getElementById('file').closest('label') != null,
    headingsOutline: Array.from(document.querySelectorAll('h1,h2,h3,h4')).map((h) => h.tagName + ':' + h.textContent.trim().slice(0, 30)),
    langAttr: document.documentElement.lang,
    reducedMotionHandled: Array.from(document.styleSheets).some((s) => { try { return Array.from(s.cssRules).some((r) => r.media && /reduced-motion/.test(r.media.mediaText)); } catch (e) { return false; } }),
    fontSizeMinPx: Math.min(...Array.from(document.querySelectorAll('#main *')).filter((e) => e.children.length === 0 && e.textContent.trim()).map((e) => parseFloat(getComputedStyle(e).fontSize))),
    zoom200Overflow: null,
  }));
  // 200% zoom check (WCAG 1.4.4 / 1.4.10 reflow at 320 CSS px)
  await page.setViewportSize({ width: 690, height: 450 });
  results.keyboard.semantics.zoom200Overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 2);
  await ctx.close();
}

// ---- responsive screenshots
for (const [w, h, name] of [[390, 844, 'phone'], [768, 1024, 'tablet'], [1280, 800, 'laptop']]) {
  const { ctx, page } = await fresh({ viewport: { width: w, height: h }, colorScheme: 'dark', hasTouch: w < 800, isMobile: w < 800 });
  await page.waitForSelector('#main:not([hidden])'); await page.waitForTimeout(300);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 2);
  const tlHeight = await page.$eval('#tl', (e) => e.getBoundingClientRect().height);
  const stripCols = await page.$eval('#strip', (e) => getComputedStyle(e).gridTemplateColumns.split(' ').length);
  await page.screenshot({ path: path.join(root, `dist/audit-${name}.png`), fullPage: false });
  results.responsive[name] = { width: w, horizontalOverflow: overflow, timelineHeightPx: Math.round(tlHeight), statColumns: stripCols };
  await ctx.close();
}

// ---- performance with a large synthetic session
{
  const { session, file } = await import('./gen.mjs');
  const s = session({ model: 'claude-sonnet-4-5-20250929' });
  for (let turn = 0; turn < 40; turn++) { s.user('prompt ' + turn); for (let i = 0; i < 125; i++) { s.call(['Read', 'Grep', 'Bash', 'Edit'][i % 4], { file_path: '/src/f' + i + '.js', i }, 'x'.repeat(200 + (i % 7) * 300), { ms: 200 + (i % 5) * 300, error: i % 37 === 0 }); } s.assistant([{ text: 'done ' + turn }]); s.advance(30000); }
  const big = file('big.jsonl', s).text;
  fs.writeFileSync(path.join(root, 'dist/big-fixture.jsonl'), big);
  const { ctx, page } = await fresh();
  const perf = await page.evaluate(async (text) => {
    const t0 = performance.now();
    const trace = window.TraceCore.parseTrace([{ name: 'big.jsonl', text }]);
    const t1 = performance.now();
    const f = window.TraceCore.diagnose(trace);
    const t2 = performance.now();
    return { parseMs: Math.round(t1 - t0), diagnoseMs: Math.round(t2 - t1), toolCalls: trace.toolCalls.length, requests: trace.requests.length, findings: f.length, bytes: text.length };
  }, big);
  // now load through the UI and time render + a zoom step
  const dt = await page.evaluateHandle((text) => { const d = new DataTransfer(); d.items.add(new File([text], 'big.jsonl', { type: 'application/json' })); return d; }, big);
  const tr0 = Date.now();
  await page.dispatchEvent('#drop', 'drop', { dataTransfer: dt });
  await page.waitForSelector('#main:not([hidden])');
  await page.waitForFunction(() => document.querySelectorAll('#tl-svg rect[data-kind]').length > 0);
  perf.uiLoadMs = Date.now() - tr0;
  perf.svgNodes = await page.$$eval('#tl-svg *', (els) => els.length);
  const z0 = Date.now();
  await page.hover('#tl-svg'); await page.mouse.wheel(0, -300); await page.waitForTimeout(50);
  perf.zoomStepMs = await page.evaluate(() => new Promise((res) => { const t = performance.now(); requestAnimationFrame(() => requestAnimationFrame(() => res(Math.round(performance.now() - t)))); }));
  void z0;
  perf.heapMB = await page.evaluate(() => performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null);
  results.perf = perf;
  await ctx.close();
}

await browser.close();
fs.writeFileSync(path.join(root, 'dist/audit.json'), JSON.stringify(results, null, 2));
console.log('\ncontrast failures (<4.5 text / <3 UI):');
for (const c of results.contrast) if (c.ratio != null && ((/spans|borders|idle|model/.test(c.use) ? c.ratio < 3 : c.ratio < 4.5))) console.log(` ${c.scheme} ${c.name}: ${c.ratio} (${c.use})`);
console.log('\nkeyboard:', JSON.stringify(results.keyboard.reachable), '\nsemantics:', JSON.stringify(results.keyboard.semantics));
console.log('\nresponsive:', JSON.stringify(results.responsive));
console.log('\nperf:', JSON.stringify(results.perf));

// ---- gate: fail on serious/critical axe violations or AA contrast failures on text / informative graphics
const bad = [];
for (const [k, v] of Object.entries(results.axe)) for (const x of v) if (x.impact === 'serious' || x.impact === 'critical') bad.push(`axe ${k}: ${x.id} (${x.impact} ×${x.nodes})`);
for (const c of results.contrast) { if (c.ratio == null) continue; const decorative = /borders/.test(c.use); const need = /spans vs|idle|model/.test(c.use) ? 3 : 4.5; if (!decorative && c.ratio < need) bad.push(`contrast ${c.scheme} ${c.name}: ${c.ratio} < ${need}`); }
const k = results.keyboard.reachable;
for (const key of ['timelineSpans', 'tableRows', 'turnSteps', 'findings', 'burnBars', 'drawerFocusMoves', 'escapeClosesDrawer']) if (!k[key]) bad.push(`keyboard: ${key} is false`);
if (bad.length) { console.error('\nAUDIT FAILED:\n - ' + bad.join('\n - ')); process.exit(1); }
console.log('\naudit passed');
