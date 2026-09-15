// The viewer must work with the network cable out: no external stylesheet, script, image or font.
// "Nothing leaves your machine" is a claim IT departments check — this test is what backs it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const FONTS = [
  ['IBM Plex Sans', 400], ['IBM Plex Sans', 500], ['IBM Plex Sans', 600],
  ['IBM Plex Sans Condensed', 500], ['IBM Plex Sans Condensed', 600],
  ['IBM Plex Mono', 400], ['IBM Plex Mono', 500],
];

for (const file of ['dist/glassbox.html', 'dist/glassbox.artifact.html']) {
  test(`${file} references nothing on the network`, () => {
    const html = fs.readFileSync(path.join(root, file), 'utf8');
    // Markup that would make the browser fetch something: <link href>, <script src>, <img src>, <iframe src>, CSS url(), @import.
    const fetches = [];
    for (const m of html.matchAll(/<(link|script|img|iframe|source|video|audio)\b[^>]*\b(?:href|src)\s*=\s*["']([^"']+)["']/gi)) fetches.push(m[2]);
    // CSS url() and @import only count inside <style> (JavaScript has its own URL(...) calls)
    for (const style of html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)) {
      for (const m of style[1].matchAll(/\burl\(\s*["']?([^"')]+)["']?\s*\)/gi)) fetches.push(m[1]);
      for (const m of style[1].matchAll(/@import\s+(?:url\()?["']?([^"')\s;]+)/gi)) fetches.push(m[1]);
    }
    const external = fetches.filter((u) => !/^(data:|#|blob:)/i.test(u));
    assert.deepEqual(external, [], `external references in ${file}`);
    assert.doesNotMatch(html, /fonts\.googleapis\.com|fonts\.gstatic\.com/, 'no Google Fonts');
  });

  test(`${file} carries the IBM Plex faces it uses, inline`, () => {
    const html = fs.readFileSync(path.join(root, file), 'utf8');
    for (const [family, weight] of FONTS) {
      const re = new RegExp(`@font-face\\s*\\{[^}]*font-family:\\s*["']${family}["'][^}]*font-weight:\\s*${weight}\\b[^}]*url\\(data:font/woff2;base64,`, 'i');
      assert.match(html, re, `${family} ${weight} inline`);
    }
  });
}

test('src/viewer.html has no font link left for the build to miss', () => {
  const src = fs.readFileSync(path.join(root, 'src/viewer.html'), 'utf8');
  assert.doesNotMatch(src, /<link[^>]*stylesheet/i);
  assert.match(src, /\/\*__FONTS__\*\//, 'font marker present for the build');
});
