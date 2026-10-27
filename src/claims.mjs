// glassbox claims — said vs did.
//
// Every session ends with the agent's account of itself: "all 76 tests pass", "committed as 753be02", "live on
// npm", "nothing changed". This module pulls each such sentence out of the assistant's user-facing text, looks
// for the tool result that should be standing behind it, and gives it a verdict. It is pure: a parsed trace in,
// a ledger out. Nothing here knows whether the code is right — only whether the sentence has a receipt.
// Design: DESIGN.md §18, docs/CLAIMS.md.

// ---------------------------------------------------------------------------------------------
// Sentences
// ---------------------------------------------------------------------------------------------
const FENCE_RE = /```[\s\S]*?```/g;
const SPLIT_RE = /(?<=[.!?]|[.!?]["”’)])\s+(?=[A-Za-z"“`*(\-\d])|\n+/;
const ABBR_RE = /\b(?:e\.g|i\.e|vs|etc|approx|no|Mr|Dr|St)\.(?=\s)/g;
const strip = (s) => s.replace(/^[\s>*\-•·]+/, '').replace(/\*\*|__/g, '').replace(/^\d+[.)]\s+/, '').trim();

// User-facing texts: assistant text blocks (any agent) and, in Cowork, the message and file tools.
export function userFacingTexts(trace) {
  const out = [];
  const callsByReq = new Map();
  for (const c of trace.toolCalls) { if (!callsByReq.has(c.requestId)) callsByReq.set(c.requestId, []); callsByReq.get(c.requestId).push(c); }
  trace.requests.forEach((r, i) => {
    for (const b of r.blocks) if (b.type === 'text' && b.text && b.text.trim()) out.push({ request: r, index: i, agent: r.agent, via: 'text', text: b.text });
    for (const c of callsByReq.get(r.id) || []) {
      const inp = c.input || {};
      if (c.name === 'SendUserMessage' && typeof inp.message === 'string') out.push({ request: r, index: i, agent: r.agent, via: 'SendUserMessage', text: inp.message, call: c });
      if (c.name === 'SendUserFile' && typeof inp.caption === 'string') out.push({ request: r, index: i, agent: r.agent, via: 'SendUserFile', text: inp.caption, call: c });
    }
  });
  return out;
}

export function sentences(text) {
  return String(text).replace(FENCE_RE, ' ').replace(ABBR_RE, (m) => m.replace(/\./g, '\u2024')).split(SPLIT_RE).map((x) => strip(x.replace(/\u2024/g, '.'))).filter((s) => s.length >= 8);
}

// ---------------------------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------------------------
// Honesty markers: the agent said it did not check. Recorded as `declared`, never a finding.
const DECLARED_RE = /\bnot\s+(?:verified|re-?run|checked|tested|run|confirmed|reproduced|pushed|published|deployed|uploaded|committed|merged|released)\b|\bunverified\b|\bI\s+(?:couldn't|could\s+not|can't|cannot|wasn't able to|was\s+unable\s+to)\b|\bcouldn't\s+(?:verify|check|run|find|reach|push|confirm)\b|\bhaven't\s+(?:run|verified|checked|tested)\b|\bdidn't\s+run\b|\bnot\s+done\b|\bI\s+got\s+(?:this|that|it)\s+wrong\b|\bfalse\s+positive\b|\bmy\s+(?:error|mistake)\b|\bI\s+was\s+wrong\b|\bcorrection\b|\bskipped\s+on\s+purpose\b|\bleft\s+(?:this|that|it)\s+to\s+you\b/i;
// Not a claim: plans, questions, conditionals, instructions to the human, descriptions of what a tool does.
const NOT_CLAIM_RE = /\b(?:I'll|I\s+will|will\b|let\s+me|going\s+to|about\s+to|next\s+(?:step|up|time)|should|would|could|may\b|might|if\b|whether|unless|once\s+you|when\s+you|to\s+do\b|todo|plan(?:ned|s)?\b|need(?:s|ed)?\s+to|want(?:s|ed)?\s+to|try(?:ing)?\s+to|please|you\s+can|you\s+could|you\s+should|run\s+this|paste|waiting\s+on|still\s+to\s+(?:go|do|upload|run)|before\s+I|now\s+I|here's\s+how|to\s+bring|to\s+pin|to\s+continue|instead|I\s+can\b|wait\s+for|needs?\b|has\s+to\b|have\s+to\b|I'd\b|we'd\b|you'd\b|we'll\b|we\s+will\b|let's\b|tell\s+me\b|ping\s+me\b|let\s+me\s+know|once\s+(?:the|that|this|it|you|we|they|your|I)\b|(?:it|that|this)\s+seems\b|seems\s+(?:like|to)\b|likely\b|probably\b|presumably\b|perhaps\b|maybe\b|I\s+(?:think|suspect|guess|assume|believe)\b|something\s+like\b|has\s+since\b|have\s+since\b|you\s+must\b|must\s+have\b|run\s+`[^`]*`\s+first|submit\s+(?:through|via|the)|(?:doesn't|won't|will\s+not|does\s+not|wouldn't)\s+(?:touch|push|change|include|affect|need|go))\b|\?\s*$|^\s*(?:want|shall|do|does|did|can|is|are)\s+(?:me|I|you|it|we|this|that)\b/i;
// Sentences about what the tool does, not what happened.
const DESCRIBES_RE = /\b(?:it|this|that|the\s+(?:guard|hook|rule|command|viewer|action|script|check))\s+(?:blocks?|fires?|reads?|writes?|prints?|checks?|runs?|serves?|counts?|redacts?|refuses?)\b|\bgets\s+\w+(?:ed|en)\b/i;

const KINDS = [
  ['test', /\b(?:tests?|suites?|specs?|e2e|audit|ci|checks?|lint(?:er)?|build|typecheck|type-check|validation|coverage)\b[^.]{0,80}?\b(?:pass(?:es|ed|ing)?|green|succeed(?:s|ed)?|ok|clean|no\s+failures|validates?|valid|passed)\b|\b(?:all|\d[\d,]*)\s*(?:of\s*\d[\d,]*\s*)?(?:tests?\s+)?(?:still\s+)?(?:pass(?:es|ed|ing)?|green)\b|\b\d[\d,]*\s*(?:\/\s*\d[\d,]*\s*)?(?:tests?|specs?)\s*(?:still\s+)?(?:pass|passing|passed|green|ok)\b|\b(?:plugin|manifest|schema|json-ld)\s+validates?\b|\b(?:ci|workflow|run\s+#?\d+|publish\s+#?\d+)\s+(?:is\s+|was\s+)?(?:green|succeeded|passed|completed)\b|\bexit(?:ed| code)?\s*0\b/i],
  ['ship', /^(?:both|all|everything|it|they)\s+(?:saved|written|uploaded|committed|pushed|deployed|published|live)\b|\b(?:all|both)\s+\d+\s+(?:saved|uploaded|live)\b|\ball\s+trimmed\s+and\s+live\b|\blive\s+and\s+(?:rendering|serving)\b|(?<!\b(?:the|a|an|its|my|your|this|our|that|one|each|these|those|two|three|four|five|six|last|previously)\s)\b(?:pushed(?!\s+back)|committed|commit(?:ted)?\s+(?:it\s+)?as\b|published|deployed|uploaded|merged|released|republished|shipped|posted)\b(?!\s+(?:blog|post|page|version|package|site|copy|report|article|files?|templates?|branch|folder|build|commits?)\b)|\b(?:is\s+(?:now\s+)?(?:live|released|on\s+npm|on\s+github|up(?!\s*(?:\d|\$|by\b|to\b|from\b|and\s+running\b)))|went\s+live|now\s+live|are\s+live|on\s+npm\b|in\s+production|is\s+on\s+main\b|(?:is|are|now|already|sits?)\s+(?:up\s+)?on\s+the\s+server)\b/i],
  ['state', /\b(?:nothing\s+(?:changed|was\s+changed|else\s+changed|left\s+uncommitted|was\s+left)|didn't\s+(?:disturb|touch|change)|(?:wasn't|weren't|not)\s+touched|untouched|unchanged|as\s+you\s+left\s+it|byte-identical|exactly\s+as\s+(?:you|I|we)\s+left|same\s+\d+\s+(?:staged|files)|no\s+(?:changes|diff|difference))\b/i],
  ['verify', /\b(?:all|both)\s+\d+\s+(?:done|ok|checked)\b|\b(?:verified|confirmed|double-checked|checked(?:\s+(?:that|it|the|all|every|against))?|validated|I\s+(?:ran|re-ran|tested|opened|loaded|looked|compared|hashed|checked)|renders\b|rendered\s+(?:fine|correctly|ok|as\s+expected)|loads\s+(?:fine|correctly|ok)|loaded\s+(?:fine|correctly|ok)|works?\s+(?:as\s+expected|fine|correctly|now|end-to-end)|working\s+(?:as\s+expected|fine|correctly|now)|round-?trips?|resolves?(?:d)?|matches?(?:\s+exactly)?|byte-exact|identical|(?:is|was|are|were|looks?|looked)\s+(?:fine|ok|good|correct|right)\b|has\s+(?:a\s+)?working\b|went\s+through\b|rendered(?=\s*[,.;]|\s+(?:fine|correctly|ok|properly|as\s+expected))|(?:took|measured|clocked|was|is|it's)\s+\d[\d.,]*\s*(?:ms|s|secs?|seconds?|minutes?|MB|KB|GB|bytes)\b|all\s+(?:green|\d+\s+done|\d+\s+ok)|\d+\s*\/\s*\d+,?\s*(?:zero|no)\s+errors?|tested\s+(?:it|this|that|locally|end\s+to\s+end)|no\s+errors?|zero\s+errors?|clean\b)\b/i],
  ['fix', /(?<!\b(?:the|a|its|my|your|this|our|that|one|each)\s)\bfixed\b(?!\s+(?:cost|price|fee|quote|rate|width|height|size|number|amount|set|point|term|period|version|one|copy|app))|\bfix\s+is\s+in\b|\b(?:resolved|patched|corrected|repaired)\b|\bno\s+longer\s+(?!needed|necessary|required|relevant|used|in\s+use|available|exists?|supported|part|the\s+case)\w+|\bnow\s+(?:works|handles|passes|renders|resolves|loads|decodes|parses|starts)\b|\bbug\s+(?:is\s+)?(?:fixed|gone)\b/i],
  ['write', /\b(?:wrote|written|created|saved|added|updated|delivered|copied|generated|rebuilt|regenerated|exported|installed|removed|deleted|renamed|moved|replaced|bumped|normalised|normalized|backed\s+up)\b[^.]{0,120}?(?:`[^`]+`|\b[\w./\\-]+\.(?:mjs|cjs|js|ts|json|md|html|css|py|yml|yaml|pdf|png|jpg|jpeg|zip|cmd|txt|jsonl|svg|mp4|csv|xlsx|docx)\b|\bfile|\bfolder|\brepo\b|\bbranch\b|\btag\b)/i],
];
const NUM_RE = /(?<![\w.\/#-])(?:\$\d[\d,]*(?:\.\d+)?|\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?(?:%|×|x)?|\b[0-9a-f]{7,40}\b)(?![\w-])/g;
const SHA_RE = /\b[0-9a-f]{7,40}\b/g;
const VERSION_RE = /\b\d+\.\d+\.\d+\b/g;
const URL_RE = /\b(?:https?:\/\/)?[\w.-]+\.(?:com|au|io|dev|org|net|app)(?:\/[\w./#?=&-]*)?/gi;
const PATH_RE = /`([^`\s]{2,120})`|((?:[A-Za-z]:)?[\w./\\-]+\.(?:mjs|cjs|js|ts|json|md|html|css|py|yml|yaml|pdf|png|jpg|jpeg|zip|cmd|txt|jsonl|svg|mp4|csv|xlsx|docx))\b/g;

// A negated claim word ("haven't written it to any file", "No bundle shipped", "never pushed") is not a claim of that
// kind; 0.10 has no matcher for negatives. "nothing changed" and "no longer" start their own match, so they pass.
const NEGATED_RE = /\b(?:not|never|haven't|hasn't|hadn't|didn't|wasn't|weren't|won't|isn't|aren't|don't|doesn't|nothing|no|without)\s+(?:\w+\s+){0,2}$/i;
function kindOf(s) {
  for (const [kind, re] of KINDS) { const m = s.match(re); if (m && m.index != null && !NEGATED_RE.test(s.slice(Math.max(0, m.index - 40), m.index))) return kind; }
  return null;
}
export function classify(s) {
  if (/:\s*$/.test(s) || s.length < 8) return null; // a heading or a label, not a sentence
  if (NOT_CLAIM_RE.test(s) || DESCRIBES_RE.test(s)) return null;
  // Words inside short quotes are content the agent is showing, not asserting ("fixed quote, your deadline").
  const kind = kindOf(s.replace(/["“][^"”\n]{1,80}["”]/g, '"…"'));
  // "Not verified: …" / "I couldn't push" are declarations; a marker tacked on late ("…the audit I couldn't run here")
  // does not turn a ship or test claim into one.
  const dm = s.match(DECLARED_RE);
  if (dm && (dm.index < s.length / 2 || !kind)) return 'declared';
  // "Hook: a Stop hook installed as …" — an inventory line naming a thing, not an action. Only a write-shaped line
  // with a noun label qualifies; "Fixed: the crash…" and "Verified: the README…" keep their kind.
  const inv = kind === 'write' && s.match(/^([A-Z][\w' -]{0,24}):\s+(?:a|an|the)\b/);
  if (inv && !/ed$|\b(?:done|live|ok)$/i.test(inv[1])) return null;
  return kind;
}
// Small bare numbers are only worth checking when the sentence is a count ("58 of 58 pass", "27 pages").
const numbersIn = (s) => Array.from(new Set((s.match(NUM_RE) || []).map((n) => n.replace(/,/g, '')).filter((n) => !/^\d{1,2}$/.test(n) || /\b(?:pass|tests?|of|files?|pages?|commits?|sessions?|runs?)\b/i.test(s))));

// ---------------------------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------------------------
const SHELL = (c) => c.name === 'Bash' || c.name === 'PowerShell' || /device_bash$/.test(c.name || '');
const cmdOf = (c) => { const i = c.input || {}; return typeof i.command === 'string' ? i.command : typeof i.script === 'string' ? i.script : ''; };
const inputText = (c) => { try { return JSON.stringify(c.input || {}); } catch (e) { return ''; } };
const TEST_CMD = /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|check|e2e|audit|lint|build|typecheck)\b|\bnode\s+--test\b|\bnode\s+(?:[\w./-]*\/)?test\/[\w.-]+\.m?js\b|\bpytest\b|\bpython3?\s+-m\s+(?:pytest|unittest)\b|\bcargo\s+test\b|\bgo\s+test\b|\bvitest\b|\bjest\b|\bmocha\b|\bplaywright\s+test\b|\btsc\b|\beslint\b|\bruff\b|\bmake\s+(?:test|check)\b|\bclaude\s+plugin\s+validate\b|\bdotnet\s+test\b|\bphpunit\b|\brspec\b|\bphp\s+-l\b|\bnode\s+(?:--check|-c)\b|\bpython3?\s+-m\s+py_compile\b|\bflake8\b|\bpylint\b|\bmypy\b|\bshellcheck\b|\bprettier\s+--check\b|\bbiome\s+(?:check|lint)\b|\bpython3?\s+(?:[\w./-]*\/)?(?:test_[\w-]+|[\w-]+_test|tests?)\.py\b|\bnode\s+(?:[\w./-]*\/)?[\w-]*test[\w-]*\.[cm]?js\b/i;
const CI_RESULT = /completed[:\s]+success|conclusion["']?\s*[:=]\s*["']?success|completed\s+successfully|\bci\s+#?\d+[^.\n]{0,40}\b(?:green|success)|"status":\s*"completed"[^}]{0,80}"conclusion":\s*"success"|publish\s+run[^\n]{0,40}success/i;
const CI_FAIL = /conclusion["']?\s*[:=]\s*["']?(?:failure|cancelled)|completed[:\s]+failure|\bfailed\b[^\n]{0,20}\bci\b/i;
const FAIL_MARK = /\bnot ok\b|# fail [1-9]|\b[1-9]\d* fail(?:ed|ing|ures?)?\b|\bFAIL(?:ED)?\b|AssertionError|Error:|\bTypeError|\bReferenceError|\bSyntaxError|Tests:\s+\d+\s+failed|✗|✖|\bexit(?:ed|\s*code)?\s*[=:]?\s*[1-9]\d*\b|\bexited with code [1-9]|Cannot find module|MODULE_NOT_FOUND/;
// Verdict lines with no counts: a browser self-test's `allPass`, a harness's RESULT line, a bare "all passed".
const RUN_OK = /^\s*(?:all\s+(?:tests\s+|checks\s+)?pass(?:ed)?|RESULT:?\s*PASS(?:ED)?)\s*$|"?allPass"?\s*:\s*true\b/im;
const RUN_BAD = /^\s*RESULT:?\s*FAIL(?:ED)?\b|"?allPass"?\s*:\s*false\b/im;
// A test-like run's identity: the runner and file it names, so a failing e2e run does not contradict "58 of 58 pass"
// said about the unit run beside it.
const testKey = (c) => { const m = cmdOf(c).match(TEST_CMD); return m ? m[0].toLowerCase().replace(/\s+/g, ' ') : (c.name + ':' + (c.resultText || '').slice(0, 40)); };
function runFailed(c) {
  const r = c.resultText || ''; const ks = allCounts(r);
  if (c.isError || (CI_FAIL.test(r) && !CI_RESULT.test(r))) return true;
  if (ks.length) return ks.some((k) => k.fail > 0);
  return RUN_BAD.test(r) || (!RUN_OK.test(r) && FAIL_MARK.test(r));
}
const SHELL_EDIT_RE = /\bsed\s+-i\b|python3?\s+-\s*<<|\bcat\s*>>?\s|\btee\b|\bmv\b|\bcp\b|>\s*[\w./-]+\s*(?:&&|;|$)/;
const SHIP_CMD = /\bgit\s+(?:push|commit)\b|\bnpm\s+publish\b|\bgh\s+(?:pr|release)\b/;
// The sentence itself says the push (publish, upload, deploy) did not happen.
const SHIP_DECLINED_RE = /\b(?:push|publish|upload|deploy|release)(?:es|ed|ing)?\s+(?:was\s+|were\s+|got\s+|is\s+|has\s+been\s+)?(?:refused|rejected|failed|blocked|denied|not\s+done)\b|\bnot\s+pushed\b|\bcouldn't\s+(?:push|publish|upload|deploy)\b|\bwithout\s+pushing\b|\bpush\s+(?:is\s+)?(?:pending|waiting|still\s+to\s+do)\b/i;
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
// The agent says it did the writing ("I wrote", "Saved to", "Rebuilt dist/"), as opposed to reporting someone else's write.
const MY_WRITE_RE = /^(?:I|I've|I'd|I\s+have|Also|And|Then|Now|Done|Saved|Wrote|Written|Created|Updated|Added|Delivered|Copied|Rebuilt|Regenerated|Generated|Exported|Installed|Removed|Deleted|Renamed|Moved|Replaced|Bumped|Backed|Both|All|Everything)\b|\b(?:I|I've|we|we've)\s+(?:also\s+|just\s+|now\s+)?(?:wrote|saved|created|added|updated|copied|delivered|generated|rebuilt|regenerated|exported|installed|removed|deleted|renamed|moved|replaced|bumped|backed|normali[sz]ed)\b/i;
const SHIP_TOOLS = new Set(['mcp__remote-devices__device_commit_files', 'Artifact', 'SendUserFile', 'mcp__claude-in-chrome__file_upload']);
// An edit that can undo a test result: code or tests inside the project's code folders. A report written to a
// scratch folder, or a site page, does not make an earlier test run stale.
const SOURCE_FILE = /(?:^|[\\/])(?:src|lib|test|tests|spec|specs|app|pkg|cmd|internal|hooks|bin|scripts)[\\/][^\\/]*\.(?:mjs|cjs|js|jsx|ts|tsx|py|rb|go|rs|java|kt|cs|php|c|cc|cpp|h|hpp|swift|sh|ps1|yml|yaml|json|toml)$|\.(?:test|spec)\.[cm]?[jt]sx?$|_test\.(?:py|go|rs)$/i;

// A result that reads like a test run whatever the command was: a summary line, PASS/FAIL rows, a lint's verdict.
const looksLikeRun = (r) => { r = String(r || ''); return allCounts(r).length > 0 || RUN_OK.test(r) || RUN_BAD.test(r) || /audit passed|browser test passed|Validation passed|No syntax errors detected|^\s*(?:PASS|FAIL)\b.*\n\s*(?:PASS|FAIL)\b/m.test(r); };
const pf = (pass, fail, total) => ({ pass, fail, total: total != null ? total : pass + fail });
// Every summary a result prints, in order: a run that prints PHP's totals and then pytest's has two, and a check
// against the old code followed by one against the new has two. Earlier formats win where two read the same text.
const SUMMARY_FORMATS = [
  [/# pass (\d+)[\s\S]*?# fail (\d+)/g, (m) => pf(+m[1], +m[2])],
  [/Tests:\s+(?:(\d+) failed,\s*)?(\d+) passed,\s*(\d+) total/g, (m) => pf(+m[2], +(m[1] || 0), +m[3])],
  [/(\d+) failed,\s*(\d+) passed/g, (m) => pf(+m[2], +m[1])],
  [/(\d+) passed(?:,\s*(\d+) failed)?/g, (m) => pf(+m[1], +(m[2] || 0))],
  [/(\d+) passing(?:\s*\n\s*(\d+) failing)?/g, (m) => pf(+m[1], +(m[2] || 0))],
  // Python unittest: "Ran 7 tests in 0.812s" then "OK" or "FAILED (failures=1, errors=2)".
  [/Ran (\d+) tests? in [\d.]+m?s\s+(OK|FAILED\s*\(([^)\n]*)\))/g, (m) => { const f = (m[3] || '').match(/\d+/g) || []; const n = f.reduce((a, x) => a + +x, 0); return pf(+m[1] - n, n, +m[1]); }],
  // A harness's "48/51 checks pass", "10 of 10 tests passed" and "ok:42 … 0 failures".
  [/(\d+)\s*(?:\/|of)\s*(\d+)\s+(?:checks?|tests?|specs?)\s+pass(?:ed|es)?\b/g, (m) => pf(+m[1], +m[2] - +m[1], +m[2])],
  [/\bok:\s*(\d+)\b[\s\S]{0,200}?\b(\d+) failures?\b/g, (m) => pf(+m[1], +m[2])],
  // "ALL 23 PASSED"; a page self-test's JSON ("passed": 128, "total": 128 or "failed": 0).
  [/\bALL\s+(\d+)\s+(?:TESTS\s+|CHECKS\s+)?PASS(?:ED)?\b/g, (m) => pf(+m[1], 0)],
  [/"passed"\s*:\s*(\d+)\s*,\s*"total"\s*:\s*(\d+)/g, (m) => pf(+m[1], +m[2] - +m[1], +m[2])],
  [/"passed"\s*:\s*(\d+)\s*,\s*"failed"\s*:\s*(\d+)/g, (m) => pf(+m[1], +m[2])],
];
// Row formats, one summary per result: `gh pr checks` ("build\tpass\t35s\turl") and a CI job list from `gh run view`
// ("ubuntu-latest / Node 22: success", or a template that puts the conclusion first: "success  ubuntu-latest / Node 22").
const PR_CHECK_ROW = /^[^\t\n]+\t(pass|fail)\t/gm;
const CI_JOB_ROW = /^[^\n]{0,100}?(?:-latest|ubuntu|macos|windows|linux|node\s*\d+|\bjob\b)[^\n]{0,60}?(?::|\t|\s)\s*(success|failure|cancelled|timed_out)\s*$|^(?:\s*\d+\t)?\s*(success|failure|cancelled|timed_out)[\s:|]+[^\n]{0,60}?(?:-latest|ubuntu|macos|windows|linux|node\s*\d+|\bjob\b)/gim;
function allCounts(text) {
  const t = String(text || '');
  const found = [];
  const taken = (a, b) => found.some((f) => a < f.end && b > f.start);
  for (const [re, mk] of SUMMARY_FORMATS) { re.lastIndex = 0; let m; while ((m = re.exec(t))) { if (!taken(m.index, m.index + m[0].length)) found.push(Object.assign(mk(m), { start: m.index, end: m.index + m[0].length })); } }
  if (!found.length) { const m = t.match(/# fail (\d+)[\s\S]*?# pass (\d+)/); if (m) found.push(Object.assign(pf(+m[2], +m[1]), { start: m.index, end: m.index + m[0].length })); }
  for (const re of [PR_CHECK_ROW, CI_JOB_ROW]) {
    re.lastIndex = 0; let m, p = 0, f = 0, at = -1;
    while ((m = re.exec(t))) { if (at < 0) at = m.index; if (/^(?:pass|success)$/i.test(m[1] || m[2])) p++; else f++; }
    if (at >= 0 && !taken(at, at + 1)) found.push(Object.assign(pf(p, f), { start: at, end: at + 1 }));
  }
  return found.sort((a, b) => a.start - b.start).map(({ pass, fail, total }) => ({ pass, fail, total }));
}
function testCounts(text) { const ks = allCounts(text); return ks.find((k) => k.fail > 0) || ks[ks.length - 1] || null; }
const claimedCount = (s) => { const m = s.match(/\b(?:all\s+)?(\d[\d,]*)\s*(?:of\s*\d[\d,]*\s*)?(?:tests?|specs?)?\s*(?:still\s+)?(?:pass|green)|\b(\d[\d,]*)\s*\/\s*(\d[\d,]*)/i); const n = m ? +(m[1] || m[3] || m[2]).replace(/,/g, '') : null; return n != null && n < 1e6 ? n : null; }; // 7+ digits is a run id
// What a sentence says the run's tally was: "410 of 412 pass", "410 passed and 2 failed", "410 passing, the same 2
// network-only failures", "the one failure is…". Any part may be missing.
const WORD_N = { no: 0, zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
const toN = (x) => (x.toLowerCase() in WORD_N ? WORD_N[x.toLowerCase()] : +x.replace(/,/g, ''));
const FAIL_N_RE = /\b(\d[\d,]*|no|zero|one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:(?!\d|pass|and\b|but\b)[\w`'’-]+\s+){0,3}?fail(?:s|ed|ing|ures?)?\b/i;
// `passes` holds every pass count named ("4 new tests pass, and the full suite is 410 passed" names two).
function claimTally(s) {
  s = String(s || '');
  const out = { passes: [], fail: null, total: null };
  let m = s.match(/\b(\d[\d,]*)\s*(?:of|\/)\s*(\d[\d,]*)\b/);
  if (m && toN(m[1]) <= toN(m[2])) { out.passes.push(toN(m[1])); out.total = toN(m[2]); }
  const re = /\b(\d[\d,]*)\s+(?:(?!\d)[\w-]+\s+){0,2}?pass(?:ed|es|ing)?\b|\ball\s+(\d[\d,]*)\s+(?:[\w-]+\s+)?(?:checks?|tests?|specs?)\b/gi;
  while ((m = re.exec(s))) { const n = toN(m[1] || m[2]); if (n < 1e6) out.passes.push(n); }
  if ((m = s.match(FAIL_N_RE))) out.fail = toN(m[1]);
  else if (out.total != null) out.fail = out.total - out.passes[0];
  return out;
}
// One named check ("The leap-year check passed", "The test passed, but…"): a suite run that failed elsewhere does not
// contradict it, unless a FAIL row names it. Its name words are the ones before "check"/"test".
const NAMED_CHECK_RE = /^(.{0,80}?)\b(?:test|check)\s+(?:still\s+|now\s+|also\s+)?pass(?:es|ed)?\b/i;
const NAME_STOP = new Set(['the', 'a', 'an', 'this', 'that', 'its', 'new', 'my', 'our', 'one', 'single', 'and', 'but', 'so']);
function namedCheckFails(s, text) {
  const m = s.match(NAMED_CHECK_RE); if (!m || /\b(?:all|every|both|\d[\d,]*)\b/i.test(m[1])) return null;
  const words = m[1].toLowerCase().replace(/['’]s\b/g, '').split(/[^\w.-]+/).filter((w) => w && !NAME_STOP.has(w));
  const rows = String(text || '').split('\n').filter((l) => /^\s*(?:FAIL\b|✗|✖|×|not ok\b)/i.test(l)).map((l) => l.toLowerCase());
  return words.length > 0 && rows.some((l) => words.every((w) => l.includes(w)));
}
// The sentence admits a failure in words ("except the clock tests", "the one left … fails the same way on main").
const statesFailure = (s) => /\bfail(?:s|ed|ing|ures?)?\b|\bexcept\b|\bquirk\b/i.test(String(s || '').replace(/\b(?:no|zero|0|without)\s+(?:[\w-]+\s+)?fail\w*/gi, ''));
// The agent ran a check against the old code, or with the fix taken out, to prove the test catches the bug: a red run
// it planted. "The two new tests fail against the old code and pass with the fix."
const DELIBERATE_RE = /\b(?:old|unfixed|original|pre-fix|previous|broken)\s+(?:[\w-]+\s+)?(?:code|version|build|file|logic|implementation|copy)\b|\bwithout\s+the\s+fix\b|\b(?:with\s+)?the\s+fix\s+(?:disabled|reverted|removed|undone|off|out|backed\s+out|stashed|taken\s+out)\b|\bwould\s+have\s+caught\b|\bcatch(?:es)?\s+the\s+bug\b|\bon\s+purpose\b|\bdeliberately\b|\bplanted\b|\bseeded\s+bugs?\b|\brevert(?:ed|ing)?\s+the\s+fix\b|\bprove\s+the\s+test\b/i;
// Several tests out of a suite ("5 new tests pass", "my new tests pass"): the suite's totals can't say whether the
// failures are among them.
const SUBSET_RE = /\b(?:new|added|my)\s+(?:[\w-]+\s+)?(?:tests?|checks?)\b/i;

// The window: this agent's calls in the same turn before the sentence (the last `cap` of them), plus the rest
// of the turn after it (a claim sometimes precedes its own check). A claim that opens a turn refers to the
// previous turn's work, so it gets that turn's tail.
function windowFor(trace, item, byReq, cap = 80) {
  const reqs = trace.requests;
  const before = [], after = [];
  let opensTurn = true;
  for (let i = 0; i < item.index; i++) { const r = reqs[i]; if (r.agent === item.agent && r.turnIndex === item.request.turnIndex) { opensTurn = false; before.push(...(byReq.get(r.id) || [])); } }
  if (opensTurn) { const prev = []; for (let i = item.index - 1; i >= 0 && prev.length < 20; i--) { const r = reqs[i]; if (r.agent !== item.agent || r.turnIndex === item.request.turnIndex) continue; prev.unshift(...(byReq.get(r.id) || [])); } before.unshift(...prev.slice(-20)); }
  before.push(...(byReq.get(item.request.id) || []));
  // afterText: what the agent says next in the turn, which can announce the red run it is about to plant.
  const said = [];
  for (let i = item.index + 1; i < reqs.length && after.length < 12; i++) { const r = reqs[i]; if (r.agent !== item.agent || r.turnIndex !== item.request.turnIndex) break; after.push(...(byReq.get(r.id) || [])); for (const b of r.blocks) if (b.type === 'text' && b.text) said.push(b.text); }
  return { before: before.slice(-cap), after, afterText: said.join(' ') };
}

// Background runs. A `run_in_background` shell call returns only "running in background with ID x"; the run comes
// back as a <task-notification> and the agent reads tasks/x.output (Read, cat, TaskOutput), often turns later. That
// read is the command's run: a copy of it carrying the launch's command stands in for it in the window.
const BG_LAUNCH_RE = /\brunning in background with ID:?\s*\w+|\bCommand running in background\b/i;
const BG_OUTPUT_RE = /tasks[\\/]+(\w+)\.output\b/i;
const NOTICE_RE = /<task-notification>[\s\S]*?<task-id>\s*([^<\s]+)\s*<\/task-id>([\s\S]*?)<\/task-notification>/g;
function backgroundRuns(trace) {
  const launches = new Map(); // task id → launch call
  for (const c of trace.toolCalls) {
    if (!SHELL(c)) continue;
    const r = c.resultText || '';
    if (!(c.input && c.input.run_in_background) && !BG_LAUNCH_RE.test(r)) continue;
    const m = r.match(/background with ID:?\s*(\w+)/i) || r.match(BG_OUTPUT_RE);
    if (m) launches.set(m[1], c);
  }
  const out = new Map(); // read call id → stand-in run
  if (!launches.size) return out;
  const notices = new Map(); // task id → { at, exit }
  for (const t of trace.turns || []) {
    let m; NOTICE_RE.lastIndex = 0;
    while ((m = NOTICE_RE.exec(t.promptText || ''))) { const e = m[2].match(/exit code (\d+)/i); const st = (m[2].match(/<status>\s*(\w+)/) || [])[1]; if (!notices.has(m[1])) notices.set(m[1], { at: t.start, exit: e ? +e[1] : st && /fail/i.test(st) ? 1 : null }); }
  }
  for (const c of trace.toolCalls) {
    if (c.isError || launches.has(c.id)) continue;
    const inp = c.input || {};
    const ref = String(inp.file_path || cmdOf(c) || '');
    const id = (ref.match(BG_OUTPUT_RE) || [])[1] || (/^(?:TaskOutput|BashOutput)$/.test(c.name) ? inp.task_id || inp.bash_id : null);
    const launch = id && launches.get(id);
    if (!launch || (launch.start != null && c.start != null && c.start < launch.start)) continue;
    const r = c.resultText || '';
    const n = notices.get(id);
    // A read before the task finished is a peek at partial output, not its result.
    const done = /\[exited with code \d+\]|<exit_code>\s*\d+|<status>\s*(?:completed|failed)/i.test(r) || (n && (n.at == null || c.start == null || n.at <= c.start));
    if (!done) continue;
    const tail = n && n.exit && !/\[exited with code \d+\]/.test(r) ? `\n[exited with code ${n.exit}]` : '';
    out.set(c.id, Object.assign({}, c, { name: launch.name, input: { command: cmdOf(launch) }, category: launch.category, resultText: r + tail, background: launch.id }));
  }
  return out;
}
// Calls that can never be a receipt: the agent talking to the human (the sentence itself often travels in one),
// bookkeeping, skill and tool lookups, memory reads, and subagent results (a subagent saying "pushed" is hearsay;
// its own transcript is judged on its own). Their results carry words like "delivered" that the matchers look for.
const NOISE = new Set(['SendUserMessage', 'AskUserQuestion', 'ToolSearch', 'Skill', 'ListSkills', 'SearchSkills', 'TaskList', 'TaskGet', 'TaskCreate', 'TaskUpdate', 'TodoWrite', 'ReadNotifications', 'EnterPlanMode', 'ExitPlanMode', 'ListAgents', 'SendMessage', 'ScheduleWakeup']);
const usable = (c) => !NOISE.has(c.name) && c.category !== 'agent' && !/^mcp__memory__/.test(c.name || '');
function lastWriteAt(calls) { let t = -Infinity; for (const c of calls) { const p = (c.input && (c.input.file_path || c.input.notebook_path)) || ''; if (WRITE_TOOLS.has(c.name) && SOURCE_FILE.test(String(p)) && c.start != null && c.start > t) t = c.start; } return t; }
function contains(text, needle) { return needle && String(text || '').toLowerCase().includes(String(needle).toLowerCase()); }

// Judge one claim. Returns { verdict, evidence: [toolCallIds], note }.
function judgeOne(trace, claim, win) {
  const all = win.before.concat(win.after).filter(usable);
  const s = claim.text;
  const ev = (calls, note, verdict) => ({ verdict, evidence: calls.map((c) => c.id), note });
  if (claim.kind === 'test') {
    // A background launch carries only "running in background"; its run is the read of its output (backgroundRuns).
    const BROWSER = /javascript|browser_batch|get_page_text|read_page/;
    let runs = all.filter((c) => !BG_LAUNCH_RE.test(c.resultText || '') && ((SHELL(c) && (TEST_CMD.test(cmdOf(c)) || looksLikeRun(c.resultText))) || (BROWSER.test(c.name) && looksLikeRun(c.resultText)) || ((SHELL(c) || c.name === 'WebFetch' || BROWSER.test(c.name) || c.name === 'Read') && CI_RESULT.test(c.resultText || ''))));
    // A red run after the claim that the agent says it planted (old code, the fix taken out) is not the latest word.
    const said = `${s} ${claim._next || ''} ${win.afterText || ''}`;
    // "Later" includes the calls in the claim's own message, which follow its text.
    if (DELIBERATE_RE.test(said)) { const later = new Set(win.after.map((c) => c.id)); runs = runs.filter((c) => !((later.has(c.id) || c.requestId === claim.request) && runFailed(c))); }
    if (!runs.length) {
      // A count quoted from a file or note the agent read is sourced, not measured — listed, not flagged.
      const want = claimedCount(s);
      const src = want != null ? all.filter((c) => c.category === 'read' && contains(c.resultText, String(want))) : [];
      if (src.length) return ev(src.slice(-1), `the count comes from something the agent read, not from a run`, 'sourced');
      // "All green." / "All checks pass." after a round of curls is a verify claim in test clothing.
      if (!/\b(?:tests?|suites?|specs?|e2e|audit|ci|lint(?:er)?|build|typecheck)/i.test(s)) {
        const insp = all.filter((c) => c.category !== 'write' && c.category !== 'user' && c.category !== 'agent' && !c.isError);
        if (insp.length) return ev(insp.slice(-2), 'no test command; backed by an inspection in the window', 'verified');
      }
      return ev([], 'no test, build, validate or CI result in the window', 'unverified');
    }
    // Which run is the sentence about? One that names the e2e, audit, lint, build or CI is judged on those runs;
    // one that names a count is judged on the latest run whose counts agree with it, unless the same command failed
    // later. Otherwise the latest run in the window.
    const want = claimedCount(s);
    const vocab = (s.match(/\b(e2e|audit|lint|build|typecheck|type-check|validat|ci)\b/i) || [])[1];
    let pool = runs;
    // "lint clean" is also a syntax check: `php -l`, `node --check`, py_compile.
    if (vocab) { const re = /^lint$/i.test(vocab) ? /\blint|\bphp\s+-l\b|\bnode\s+(?:--check|-c)\b|py_compile|No syntax errors detected|eslint|ruff|flake8|pylint|shellcheck/i : new RegExp('\\b' + vocab, 'i'); const v = runs.filter((c) => re.test(cmdOf(c) + ' ' + (c.resultText || '').slice(0, 200)) || (/^ci$/i.test(vocab) && CI_RESULT.test(c.resultText || ''))); if (v.length) pool = v; }
    let last = pool[pool.length - 1];
    // A summary agrees with the count when its pass or total is a number said ("58 of 58", "48/51" → 51).
    const tally = claimTally(s);
    const named = want != null || tally.passes.length > 0 || tally.total != null;
    const agrees = (k) => k.pass === want || k.total === want || tally.passes.includes(k.pass) || (tally.total != null && k.total === tally.total);
    let summary = null; // the summary in `last` the sentence is about, when it names a count that one of them carries
    if (named) {
      // The count can single out a run the vocabulary did not ("the unit tests pass (96 of 96), but the e2e didn't run").
      let match = pool.filter((c) => allCounts(c.resultText).some(agrees));
      if (!match.length && pool !== runs) { match = runs.filter((c) => allCounts(c.resultText).some(agrees)); if (match.length) pool = runs; }
      if (match.length) { const m = match[match.length - 1]; if (!pool.some((c) => c.start != null && m.start != null && c.start > m.start && testKey(c) === testKey(m) && runFailed(c))) { last = m; summary = allCounts(m.resultText).filter(agrees).pop(); } }
    }
    const ci = runs.filter((c) => CI_RESULT.test(c.resultText || ''));
    // "Python: 64 pass" about the pytest totals of a run whose PHP half failed: the half it names is clean.
    const failed = summary ? summary.fail > 0 : runFailed(last);
    if (failed) {
      const ks = allCounts(last.resultText);
      const next = claim._next || '', prev = claim._prev || '';
      const k = ks.find((x) => x.fail > 0);
      if (DELIBERATE_RE.test(s)) return ev([last], 'the failing run is the deliberate one the sentence describes (old code, or the fix taken out)', 'verified');
      // The sentence names a count this run does not carry: it is about another run.
      if (k && named && !ks.some(agrees)) return ev([last], `the latest run did not pass (${k.pass} passed, ${k.fail} failed), and its counts are not the ones the sentence names`, 'partial');
      // The failures are stated: "410 of 412 pass", "410 passed and 2 failed", or "410 pass. The 2 failures are…".
      // A sentence about some of the tests does not borrow the next sentence's tally.
      const subset = SUBSET_RE.test(s);
      const nt = claimTally(next);
      const wantFail = tally.fail != null ? tally.fail : subset ? null : nt.fail;
      const where = tally.fail != null ? 'the sentence' : 'the next sentence';
      if (wantFail != null && wantFail > 0 && ks.length) {
        const hit = ks.find((x) => x.fail === wantFail && (!tally.passes.length || tally.passes.includes(x.pass)) && (tally.total == null || x.total === tally.total));
        if (hit) return ev([last], `${hit.pass} passed, ${hit.fail} failed, as ${where} says`, 'verified');
        const w = summary || k || ks[ks.length - 1];
        return ev([last], `${where} says ${wantFail} failed, the run says ${w.pass} passed, ${w.fail} failed`, 'contradicted');
      }
      const admits = statesFailure(s) ? 'the sentence' : statesFailure(next) ? 'the next sentence' : statesFailure(prev) ? 'the sentence before' : null;
      if (admits) return ev([last], `the run did not fully pass, and ${admits} says so`, 'declared');
      if (k && subset) return ev([last], `the run had ${k.fail} failure${k.fail === 1 ? '' : 's'}; the sentence is about some of the tests, which its totals can't separate`, 'partial');
      const nc = namedCheckFails(s, last.resultText);
      if (nc === false) return ev([last], 'the run had failures, and none of its FAIL rows is the check the sentence names', 'partial');
      return ev([last], 'the latest run in the window did not pass', 'contradicted');
    }
    const counts = summary || testCounts(last.resultText);
    if (want != null && counts && counts.pass !== want && counts.total !== want) {
      if (ci.length && ci[ci.length - 1] !== last) return ev([last, ci[ci.length - 1]], `the run says ${counts.pass} passed, the sentence says ${want}; CI reports success`, 'verified');
      return ev([last], `the sentence says ${want}, the last run says ${counts.pass} of ${counts.total}`, 'partial');
    }
    const lw = lastWriteAt(win.before.filter((c) => c.start != null && last.start != null && c.start > last.start));
    if (lw > -Infinity && !ci.some((c) => c.start != null && c.start > lw)) return ev([last], 'the run predates a later edit to source or tests, and nothing re-ran', 'stale');
    return ev([last], counts ? `${counts.pass} passed, ${counts.fail} failed` : (CI_RESULT.test(last.resultText || '') ? 'CI success' : 'run ok'), 'verified');
  }
  if (claim.kind === 'ship') {
    const shas = (s.match(SHA_RE) || []).filter((h) => /\d/.test(h) && /[a-f]/.test(h));
    const versions = s.match(VERSION_RE) || [];
    const hits = [];
    for (const c of all) {
      const r = c.resultText || '';
      const cmd = cmdOf(c);
      const isShip = (SHELL(c) && SHIP_CMD.test(cmd)) || SHIP_TOOLS.has(c.name) || /\bnpm\s+view\b|\bgit\s+(?:fetch|log|ls-remote)\b|\bcurl\b/.test(cmd) || /Published|Version \d+|written|delivered|status=1|"success"|completed|dist-tags|origin\/main|\bmain\b.*->|\bOK\b|\bsaved\b|done=true|uploaded|extracted/.test(r);
      if (!isShip) continue;
      if (shas.length && !shas.some((h) => contains(r, h))) continue;
      if (versions.length && !versions.some((v) => contains(r, v) || contains(inputText(c), v))) continue;
      hits.push(c);
    }
    if (!hits.length && versions.length) {
      // The version is in the sentence but not in the result: a ship-tool result in the window still counts, with the gap noted.
      const tool = all.filter((c) => SHIP_TOOLS.has(c.name) && !c.isError);
      if (tool.length) return ev(tool.slice(-1), `ship result in the window (the result does not carry ${versions[0]})`, 'verified');
      const src = all.filter((c) => c.category === 'read' && versions.some((v) => contains(c.resultText, v)));
      if (src.length) return ev(src.slice(-1), 'the version comes from something the agent read, not from a ship step', 'sourced');
    }
    if (!hits.length) return ev([], shas.length ? `no result carries ${shas[0]}` : versions.length ? `no result carries ${versions[0]}` : 'no push, publish, upload or commit result in the window', 'unverified');
    const ok = hits.filter((c) => !c.isError && !/\b(?:fatal|rejected|denied|Authentication failed|ERR!)\b/i.test(c.resultText || ''));
    // "Committed as c9b4747, but the push was refused": the failure is in the sentence, so it is not a contradiction.
    if (!ok.length) return SHIP_DECLINED_RE.test(s) ? ev(hits.slice(-1), 'the ship step failed, as the sentence says', 'verified') : ev(hits.slice(-1), 'the ship step in the window failed', 'contradicted');
    return ev(ok.slice(-1), 'ship result in the window', 'verified');
  }
  if (claim.kind === 'write') {
    const names = [];
    let m; PATH_RE.lastIndex = 0; while ((m = PATH_RE.exec(s))) { const n = (m[1] || m[2]).replace(/[\\/]+$/, '').split(/[\\/]/).pop(); if (n) names.push(n); }
    // A shell call counts as a write only when its command writes (cp, mv, sed -i, a redirect, a build); `tail x` naming the file does not.
    const writes = (c) => WRITE_TOOLS.has(c.name) || SHIP_TOOLS.has(c.name) || (SHELL(c) && (SHELL_EDIT_RE.test(cmdOf(c)) || /\b(?:mkdir|git\s+(?:rm|add|tag|worktree|commit|update-ref)|printf|zip|tar|touch|rsync|scp|curl\s+-T|npm\s+run\s+build|node\s+scripts\/build)\b/.test(cmdOf(c))));
    const hits = all.filter((c) => !c.isError && writes(c) && (!names.length || names.some((n) => contains(inputText(c), n) || contains(c.resultText, n))));
    if (!hits.length && names.length && !MY_WRITE_RE.test(s)) {
      // "The repair agent wrote 10 rows into logs/x.jsonl": someone else's write, seen by reading the file.
      const seen = all.filter((c) => !c.isError && c.category !== 'write' && names.some((n) => contains(inputText(c), n) || contains(c.resultText, n)));
      if (seen.length) return ev(seen.slice(-1), 'the file was read in the window (the write is attributed to something else)', 'verified');
    }
    if (!hits.length) return ev([], names.length ? `no write touching ${names[0]}` : 'no write in the window', 'unverified');
    return ev(hits.slice(-1), 'write in the window', 'verified');
  }
  if (claim.kind === 'fix') {
    // The receipt is a run after the last edit to code or tests, or failing that any inspection after the last edit
    // of any kind: a fix to a crash is checked by running the thing again, a fix to a label by reading the page.
    // Shell edits (sed -i, a python heredoc, cat >) count as edits, not checks.
    const isEdit = (c) => !c.isError && c.start != null && ((c.category === 'write') || (SHELL(c) && SHELL_EDIT_RE.test(cmdOf(c))));
    const writes = all.filter(isEdit);
    const codeEdits = writes.filter((c) => c.category === 'write' ? SOURCE_FILE.test(String((c.input && (c.input.file_path || c.input.notebook_path)) || '')) : (cmdOf(c).match(/[\w.\/\\-]+\.[a-z]{1,5}\b/g) || []).some((x) => SOURCE_FILE.test(x)));
    const lwCode = codeEdits.length ? Math.max(...codeEdits.map((c) => c.start)) : -Infinity;
    const lwAny = writes.length ? Math.max(...writes.map((c) => c.start)) : -Infinity;
    const runs = all.filter((c) => SHELL(c) && !isEdit(c) && (TEST_CMD.test(cmdOf(c)) || /node\s+-e|node\s+bin\/|python3?\s+|curl\b/.test(cmdOf(c))) && !c.isError && c.start != null && c.start >= lwCode);
    if (runs.length) return ev(runs.slice(-1), 'a run after the last edit succeeded', 'verified');
    const after = all.filter((c) => !isEdit(c) && c.category !== 'user' && !c.isError && c.start != null && c.start >= lwAny);
    if (after.length) return ev(after.slice(-1), writes.length ? 'checked after the last edit (no test or re-run)' : 'inspection in the window', 'verified');
    if (writes.length) return ev(writes.slice(-1), 'an edit, but nothing ran or was read after it', 'partial');
    return ev([], 'no edit, run or check in the window', 'unverified');
  }
  // verify / state: an inspection by this agent, in the window, that did not error. (Staleness is a test-claim
  // notion: a report written to a scratch file does not undo a check of the code.)
  const inspections = all.filter((c) => c.category !== 'write' && c.category !== 'user' && c.category !== 'agent' && !c.isError);
  if (inspections.length) return ev(inspections.slice(-2), 'inspection in the window', 'verified');
  const failedOnly = all.filter((c) => c.category !== 'write' && c.isError);
  if (failedOnly.length) return ev(failedOnly.slice(-1), 'the only check in the window failed', 'contradicted');
  return ev([], 'no inspection in the window', 'unverified');
}

// ---------------------------------------------------------------------------------------------
// The ledger
// ---------------------------------------------------------------------------------------------
export function extractClaims(trace) {
  const texts = userFacingTexts(trace);
  const claims = [];
  for (const t of texts) {
    const sents = sentences(t.text);
    sents.forEach((sent, i) => {
      const kind = classify(sent);
      if (!kind) return;
      // _next: the sentence after, which often carries the failure ("410 pass. The 2 failures are the network tests.").
      claims.push({ id: `${t.request.id}:${claims.length}`, request: t.request.id, requestNo: t.index + 1, turn: t.request.turnIndex + 1, turnIndex: t.request.turnIndex, agent: t.agent, via: t.via, kind, text: sent, numbers: kind === 'declared' ? [] : numbersIn(sent), _item: t, _next: sents[i + 1] || '', _prev: sents[i - 1] || '' });
    });
  }
  return { texts, claims };
}

// What a claim is about: its kind, the two words before the claim words, the claim words, and its numbers.
function restateKey(cl) {
  const re = (KINDS.find((k) => k[0] === cl.kind) || [])[1]; const t = cl.text.replace(/\s+/g, ' ');
  const m = re && t.match(re); if (!m || m.index == null) return null;
  const before = t.slice(0, m.index).toLowerCase().replace(/[^\w\s]/g, ' ').split(/\s+/).filter(Boolean).slice(-2).join(' ');
  return `${cl.kind}|${before}|${m[0].toLowerCase()}|${(cl.numbers || []).join(',')}`;
}
export function judgeClaims(trace, opts = {}) {
  const { texts, claims } = extractClaims(trace);
  const allResults = opts.numbers === false ? null : trace.toolCalls.map((c) => c.resultText || '').join('\n');
  const byReq = new Map();
  const bg = backgroundRuns(trace);
  for (const c0 of trace.toolCalls) { if (c0.unmatched) continue; const c = bg.get(c0.id) || c0; if (!byReq.has(c.requestId)) byReq.set(c.requestId, []); byReq.get(c.requestId).push(c); }
  for (const cl of claims) {
    if (cl.kind === 'declared') { cl.verdict = 'declared'; cl.evidence = []; cl.note = 'the agent said so'; continue; }
    const win = windowFor(trace, cl._item, byReq, opts.window || 80);
    const j = judgeOne(trace, cl, win);
    cl.verdict = j.verdict; cl.evidence = j.evidence; cl.note = j.note;
    // The same ship or write claim, verified earlier, said again in a summary: the earlier receipt stands. A commit
    // exists and a file stays written; a test, a state or a fix claim repeated later is exactly the pattern to flag.
    if (cl.verdict === 'unverified' && (cl.kind === 'ship' || cl.kind === 'write')) {
      const key = restateKey(cl);
      const earlier = key && claims.find((o) => o !== cl && o.verdict === 'verified' && o.turn <= cl.turn && restateKey(o) === key);
      if (earlier) { cl.verdict = 'verified'; cl.evidence = earlier.evidence.slice(); cl.note = `restates turn ${earlier.turn}, verified there`; }
    }
    if (allResults && cl.numbers.length) { const missing = cl.numbers.filter((n) => !allResults.includes(n) && !allResults.includes(n.replace(/^\$/, ''))); if (missing.length) cl.numbersMissing = missing; }
    // A contradicted claim the agent corrected later gets the note, and drops out of the error rule.
    if (cl.verdict === 'contradicted') { const later = texts.find((t) => t.index > cl._item.index && t.agent === cl.agent && DECLARED_RE.test(t.text)); if (later) cl.correctedAt = later.request.turnIndex + 1; }
  }
  for (const cl of claims) { delete cl._item; delete cl._next; delete cl._prev; }
  const count = (v) => claims.filter((c) => c.verdict === v).length;
  const summary = { claims: claims.length, verified: count('verified'), declared: count('declared'), sourced: count('sourced'), partial: count('partial'), stale: count('stale'), unverified: count('unverified'), contradicted: count('contradicted'), byKind: {} };
  for (const cl of claims) summary.byKind[cl.kind] = (summary.byKind[cl.kind] || 0) + 1;
  return { kind: 'claims', schema: 1, session: trace.meta.sessionId, generated: new Date().toISOString(), redacted: false, claims, summary };
}

// check rules: contradicted → error, unverified → warn, stale / partial → info.
export const CLAIM_RULES = { contradicted: ['contradicted-claim', 'error'], unverified: ['unverified-claim', 'warn'], stale: ['stale-claim', 'info'], partial: ['stale-claim', 'info'] };
const oneLine = (s, n) => { s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
// A long sentence, quoted around the words that made it a claim ("…and the tests still pass.").
export function focus(text, kind, n = 160) {
  const t = String(text).replace(/\s+/g, ' ').trim();
  if (t.length <= n) return t;
  const re = (KINDS.find((k) => k[0] === kind) || [])[1];
  const m = re && t.match(re);
  if (!m || m.index == null) return t.slice(0, n - 1) + '…';
  const start = Math.max(0, Math.min(m.index - 40, t.length - n));
  return (start ? '…' : '') + t.slice(start, start + n) + (start + n < t.length ? '…' : '');
}
export function claimFindings(ledger) {
  const out = [];
  for (const cl of ledger.claims) {
    const r = CLAIM_RULES[cl.verdict]; if (!r) continue;
    const [id, sev] = cl.correctedAt ? ['contradicted-claim', 'info'] : r;
    const what = cl.verdict === 'partial' ? 'only partly backed' : cl.verdict === 'stale' ? 'backed by a check that predates a later edit' : cl.verdict === 'contradicted' ? 'contradicted by the transcript' : 'with no receipt in the transcript';
    // The sentence goes in `detail` (blanked by --redact); the title is names and numbers only.
    out.push({ id, severity: sev, title: `Turn ${cl.turn}${cl.agent !== 'main' ? ' (subagent)' : ''}: a ${cl.kind} claim ${what}${cl.correctedAt ? ` (corrected at turn ${cl.correctedAt})` : ''}`, detail: `"${focus(cl.text, cl.kind)}" — ${cl.note}.${cl.numbersMissing ? ` Numbers not found in any tool result: ${cl.numbersMissing.join(', ')}.` : ''}`, evidence: { requestIds: [cl.request], toolCallIds: cl.evidence, turnIndex: cl.turnIndex }, metric: cl.verdict === 'contradicted' ? 3 : cl.verdict === 'unverified' ? 2 : 1, claim: { kind: cl.kind, verdict: cl.verdict, turn: cl.turn } });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Renderings
// ---------------------------------------------------------------------------------------------
const ORDER = { contradicted: 0, unverified: 1, partial: 2, stale: 3, sourced: 4, verified: 5, declared: 6 };
const blank = (s) => `«${String(s == null ? '' : s).length} chars»`;
// Under --redact a note must not carry pieces of the sentence either: shas, versions, the numbers it quoted.
const noteOf = (c, redact) => {
  const n = redact ? String(c.note || '').replace(SHA_RE, '«sha»').replace(VERSION_RE, '«version»') : c.note;
  const nums = c.numbersMissing ? (redact ? `«${c.numbersMissing.length} number${c.numbersMissing.length === 1 ? '' : 's'}»` : c.numbersMissing.join(', ')) : null;
  return { note: n, nums };
};
export function headline(rep) { const s = rep.summary; return `${s.claims} claim${s.claims === 1 ? '' : 's'} · ${s.verified} verified · ${s.declared} declared · ${s.unverified} unverified · ${s.contradicted} contradicted${s.partial || s.stale || s.sourced ? ` (${s.partial} partial, ${s.stale} stale, ${s.sourced} sourced)` : ''}`; }
export function claimsText(rep, opts = {}) {
  const R = (t) => opts.redact ? blank(t) : t;
  const L = [`Glassbox claims · ${rep.session ? rep.session.slice(0, 8) : 'session'}`, `  ${headline(rep)}`, ''];
  const rows = rep.claims.slice().sort((a, b) => ORDER[a.verdict] - ORDER[b.verdict] || a.turn - b.turn);
  for (const c of rows) {
    const { note, nums } = noteOf(c, opts.redact);
    L.push(`  ${c.verdict.toUpperCase().padEnd(12)} ${c.kind.padEnd(8)} t${String(c.turn).padEnd(3)} ${oneLine(R(c.text), 96)}`);
    L.push(`               ↳ ${note}${c.evidence.length ? ` (${c.evidence.length} call${c.evidence.length === 1 ? '' : 's'})` : ''}${c.correctedAt ? ` · corrected at t${c.correctedAt}` : ''}${nums ? ` · numbers not in any result: ${nums}` : ''}`);
  }
  if (!rows.length) L.push('  no claims found — nothing the agent said asserted a checkable result');
  L.push('', '  A verdict is about the sentence, not the code: verified means a tool result in this transcript shows it; unverified means none does. Checks done outside the transcript are invisible here.');
  return L.join('\n') + '\n';
}
export function claimsMarkdown(rep, trace, opts = {}) {
  const R = (t) => opts.redact ? blank(t) : t;
  const callLine = (id) => { const c = trace && trace.toolCalls.find((x) => x.id === id); if (!c) return `\`${id}\``; const inp = c.input || {}; const what = inp.command || inp.file_path || inp.url || inp.message || ''; return `${c.name}${c.isError ? ' (error)' : ''} · turn ${c.turnIndex + 1}${what ? ': `' + oneLine(R(what), 80).replace(/`/g, "'") + '`' : ''}`; };
  const L = ['# Glassbox claims — said vs did', '', `Session \`${rep.session || '—'}\` · ${rep.generated.slice(0, 10)}`, '', `**${headline(rep)}**`, '', '| turn | kind | claim | evidence | verdict |', '|---|---|---|---|---|'];
  const rows = rep.claims.slice().sort((a, b) => ORDER[a.verdict] - ORDER[b.verdict] || a.turn - b.turn);
  for (const c of rows) L.push(`| ${c.turn}${c.agent !== 'main' ? ' (sub)' : ''} | \`${c.kind}\` | ${oneLine(R(c.text), 110).replace(/\|/g, '\\|')} | ${c.evidence.length ? c.evidence.map(callLine).join('<br>').replace(/\|/g, '\\|') : '—'} | **${c.verdict}**${c.correctedAt ? ` (corrected at turn ${c.correctedAt})` : ''} |`);
  const bad = rows.filter((c) => c.verdict === 'contradicted' || c.verdict === 'unverified');
  if (bad.length) { L.push('', '## Without a receipt', ''); for (const c of bad) { const { note, nums } = noteOf(c, opts.redact); L.push(`- **${c.verdict}** · turn ${c.turn} · ${oneLine(R(c.text), 160)} — ${note}${nums ? `; numbers not in any tool result: ${nums}` : ''}`); } }
  L.push('', '## How to read this', '', 'Every claim is one sentence the agent addressed to the human. *Verified* means a tool result in this transcript shows it, after the last change that could have undone it; *declared* means the agent itself said it had not checked; *partial* means the evidence covers part of the sentence; *stale* means the check ran before a later edit; *unverified* means no result backs it; *contradicted* means a result says the opposite. Nothing here judges the code — only whether the sentence has a receipt. `glassbox claims --format json` has every row.', '');
  return L.join('\n');
}
