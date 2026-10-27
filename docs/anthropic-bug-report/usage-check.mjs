// Prints, for every subagent transcript under ~/.claude/projects, any API response whose
// block records disagree on usage.output_tokens. Output is usage numbers and ids only.
import fs from 'node:fs'; import path from 'node:path'; import os from 'node:os';
const root = process.argv[2] || path.join(os.homedir(), '.claude', 'projects');
const files = [];
(function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (/agent-.*\.jsonl$/.test(e.name)) files.push(p); } })(root);
let responses = 0, varying = 0, shown = 0;
for (const f of files) {
  const by = new Map();
  for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
    let r; try { r = JSON.parse(line); } catch { continue; }
    if (r.type !== 'assistant' || !r.message?.usage) continue;
    const k = r.message.id; if (!by.has(k)) by.set(k, []);
    by.get(k).push({ block: r.apiBlockIndex, out: r.message.usage.output_tokens, in: r.message.usage.input_tokens, cacheRead: r.message.usage.cache_read_input_tokens });
  }
  for (const [id, recs] of by) {
    responses++;
    if (new Set(recs.map((x) => x.out)).size > 1) {
      varying++;
      if (shown++ < 5) console.log(path.relative(root, f), id, JSON.stringify(recs));
    }
  }
}
console.log(`${files.length} subagent files, ${responses} responses, ${varying} with differing output_tokens across their records`);
