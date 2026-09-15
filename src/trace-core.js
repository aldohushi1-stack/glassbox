/*
 * Glassbox trace core — parse, diagnose, cost, redact.
 * Pure JS, no DOM, no dependencies. Runs in Node (tests) and inlined in the viewer.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.TraceCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const VERSION = '0.7.0';

  // ---------------------------------------------------------------------------
  // Rate card (USD per million tokens). Prefix-matched against model ids so dated
  // ids like claude-sonnet-4-5-20250929 resolve. Longest prefix wins.
  // Source: platform.claude.com/docs/en/about-claude/pricing, fetched 2026-09-05.
  // ---------------------------------------------------------------------------
  const RATES = {
    'claude-fable-5-1':   { in: 10,  out: 50, w5m: 12.5,  w1h: 20,  read: 0.25 },
    'claude-mythos-5-1':  { in: 10,  out: 50, w5m: 12.5,  w1h: 20,  read: 0.25 },
    'claude-fable-5':     { in: 10,  out: 50, w5m: 12.5,  w1h: 20,  read: 1.0 },
    'claude-mythos-5':    { in: 10,  out: 50, w5m: 12.5,  w1h: 20,  read: 1.0 },
    'claude-opus-5':      { in: 5,   out: 25, w5m: 6.25,  w1h: 10,  read: 0.5 },
    'claude-opus-4-8':    { in: 5,   out: 25, w5m: 6.25,  w1h: 10,  read: 0.5 },
    'claude-opus-4-7':    { in: 5,   out: 25, w5m: 6.25,  w1h: 10,  read: 0.5 },
    'claude-opus-4-6':    { in: 5,   out: 25, w5m: 6.25,  w1h: 10,  read: 0.5 },
    'claude-opus-4-5':    { in: 5,   out: 25, w5m: 6.25,  w1h: 10,  read: 0.5 },
    'claude-opus-4-1':    { in: 15,  out: 75, w5m: 18.75, w1h: 30,  read: 1.5 },
    'claude-opus-4-2025': { in: 15,  out: 75, w5m: 18.75, w1h: 30,  read: 1.5 },
    'claude-sonnet-5':    { in: 2,   out: 10, w5m: 2.5,   w1h: 4,   read: 0.2 },
    'claude-sonnet-4':    { in: 3,   out: 15, w5m: 3.75,  w1h: 6,   read: 0.3 },
    'claude-haiku-4-5':   { in: 1,   out: 5,  w5m: 1.25,  w1h: 2,   read: 0.1 },
    'claude-3-5-haiku':   { in: 0.8, out: 4,  w5m: 1.0,   w1h: 1.6, read: 0.08 },
  };

  const DEFAULTS = {
    retryLoopMin: 3,
    explorationRunInfo: 8,
    explorationRunWarn: 15,
    oversizedResultWarn: 20000,
    oversizedResultError: 60000,
    imageHeavyInfoBytes: 512 * 1024,
    imageHeavyWarnBytes: 2 * 1048576,
    contextBloatWarn: 120000,
    contextBloatError: 170000,
    cacheChurnMin: 20000,
    lowCacheHitRatio: 0.5,
    lowCacheHitMinRequests: 5,
    slowToolInfoMs: 60000,
    slowToolWarnMs: 300000,
    slowModelMs: 60000,
    slowModelMaxOutput: 1500,
    thinkingHeavyShare: 0.6,
    thinkingHeavyMinOutput: 10000,
    subagentShare: 0.5,
    longTurnTools: 30,
    failedToolRate: 0.5,
    failedToolMinCalls: 3,
    failedToolWarnMinErrors: 2,
    failedToolWarnRate: 0.2,
    cacheMissMinShare: 0.05,
    longGenerationMaxTokPerSec: 15,
    duplicateReadAgents: 3,
    duplicateReadWarnChars: 100000,
    groupRepeatsMin: 3, // slow-tool / oversized-result: this many from one tool become one finding
  };

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------
  const READ_TOOLS = new Set(['Read', 'Glob', 'Grep', 'LS', 'WebFetch', 'WebSearch', 'ToolSearch', 'TaskGet', 'TaskList', 'ListSkills', 'ReadNotifications']);
  const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
  const EXEC_TOOLS = new Set(['Bash', 'BashOutput', 'KillShell']);
  const AGENT_TOOLS = new Set(['Agent', 'Task', 'Workflow']);
  const USER_TOOLS = new Set(['AskUserQuestion', 'SendUserMessage', 'SendUserFile', 'ExitPlanMode', 'EnterPlanMode']);
  // Cowork: Artifact publishes a page (a write), Skill loads instructions (a read); Task* are bookkeeping (other).
  const COWORK_READ = new Set(['Skill', 'ListSkills', 'SearchSkills', 'TaskList', 'TaskGet']);
  const COWORK_WRITE = new Set(['Artifact']);
  // Blocking reads of a background task's output: the duration is the task's run time, and re-issuing the
  // same call after a "still running" timeout is polling, not a retry.
  const WAIT_TOOLS = new Set(['TaskOutput', 'AgentOutputTool']);
  const isWait = (c) => WAIT_TOOLS.has(c.name) && !(c.input && c.input.block === false);
  const waitTarget = (c) => { const i = c.input || {}; return String(i.task_id || i.agentId || i.bash_id || ''); };
  const hasRange = (c) => !!(c.input && (c.input.limit != null || c.input.offset != null || c.input.head_limit != null));
  // MCP leaf names are verb_noun or noun_verb ("memory_read", "device_list_dir", "send_message"): match the verb as a word.
  const MCP_READ = /(^|_)(get|list|search|read|find|fetch|query|describe|show|stage|screenshot|context|status|info|check)(_|$)/i;
  const MCP_WRITE = /(^|_)(write|set|put|create|update|delete|remove|commit|send|reply|forward|upload|str_replace|append|label|move|rename|save)(_|$)/i;

  function toolCategory(name) {
    if (!name) return 'other';
    if (READ_TOOLS.has(name) || COWORK_READ.has(name)) return 'read';
    if (WRITE_TOOLS.has(name) || COWORK_WRITE.has(name)) return 'write';
    if (EXEC_TOOLS.has(name) || /device_bash$/.test(name)) return 'exec';
    if (AGENT_TOOLS.has(name)) return 'agent';
    if (USER_TOOLS.has(name)) return 'user';
    if (name.startsWith('mcp__')) {
      const leaf = name.split('__').pop() || '';
      if (MCP_READ.test(leaf)) return 'read';
      if (MCP_WRITE.test(leaf)) return 'write';
      return 'mcp';
    }
    return 'other';
  }

  function ts(rec) {
    if (!rec) return null;
    const t = rec.timestamp;
    if (t == null) return null;
    if (typeof t === 'number') return t > 1e12 ? t : t * 1000;
    const ms = Date.parse(t);
    return Number.isFinite(ms) ? ms : null;
  }

  function textOf(content) {
    if (content == null) return '';
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return content.map((b) => {
        if (typeof b === 'string') return b;
        if (!b || typeof b !== 'object') return '';
        if (b.type === 'text') return b.text || '';
        if (b.type === 'tool_result') return textOf(b.content);
        if (b.type === 'thinking') return '';
        return '';
      }).join('');
    }
    if (typeof content === 'object') return JSON.stringify(content);
    return String(content);
  }

  function stableStringify(v) {
    if (v === null || typeof v !== 'object') return JSON.stringify(v);
    if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
    return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}';
  }

  function emptyUsage() {
    return { input: 0, cacheRead: 0, cacheWrite: 0, cacheWrite5m: 0, cacheWrite1h: 0, output: 0, thinking: 0 };
  }

  function addUsage(a, b) {
    for (const k of Object.keys(a)) a[k] += b[k] || 0;
    return a;
  }

  function usageFrom(u) {
    const out = emptyUsage();
    if (!u || typeof u !== 'object') return out;
    out.input = u.input_tokens || 0;
    out.cacheRead = u.cache_read_input_tokens || 0;
    out.cacheWrite = u.cache_creation_input_tokens || 0;
    const cc = u.cache_creation || {};
    out.cacheWrite5m = cc.ephemeral_5m_input_tokens || 0;
    out.cacheWrite1h = cc.ephemeral_1h_input_tokens || 0;
    if (!out.cacheWrite5m && !out.cacheWrite1h) out.cacheWrite5m = out.cacheWrite; // default to 5m when unsplit
    out.output = u.output_tokens || 0;
    out.thinking = (u.output_tokens_details && u.output_tokens_details.thinking_tokens) || 0;
    return out;
  }

  function isEmptyUsage(u) {
    return !u.input && !u.cacheRead && !u.cacheWrite && !u.output;
  }

  // A tool call that never ran because the human or a permission rule stopped it. Claude Code
  // records toolDenialKind (user-rejected, permission-rule, automode-blocked, interrupted); older
  // transcripts only have the result text. A shell's own "Permission denied" is a real failure.
  function denialKind(rec, text) {
    if (rec && rec.toolDenialKind) return String(rec.toolDenialKind);
    const t = String(text || '').trim();
    if (/^\[Request interrupted by user/.test(t)) return 'interrupted';
    if (/^The user doesn't want to proceed with this tool use|^User rejected tool use|^Denied by voice/.test(t)) return 'user-rejected';
    if (/^Permission (for this action was|to use \S+ has been) denied/.test(t)) return 'permission-rule';
    return null;
  }

  // One API response is written as several records (one per content block). Subagent transcripts
  // rewrite output_tokens as the stream progresses, so the first record can be far below the final
  // count; the other fields repeat. Keep the largest value seen for each field.
  function maxUsage(a, b) {
    for (const k of Object.keys(a)) if ((b[k] || 0) > a[k]) a[k] = b[k];
    return a;
  }

  // ---------------------------------------------------------------------------
  // Line parsing
  // ---------------------------------------------------------------------------
  function parseLines(text, fileName) {
    const records = [];
    const problems = [];
    if (typeof text !== 'string') return { records, problems: [{ file: fileName, line: 0, reason: 'not text' }] };
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    const trimmed = text.trim();
    // A whole-file JSON array (Messages API dump or SDK output captured as JSON)
    if (trimmed.startsWith('[')) {
      try {
        const arr = JSON.parse(trimmed);
        if (Array.isArray(arr)) {
          arr.forEach((r, i) => records.push(normaliseLoose(r, i, fileName)));
          return { records, problems };
        }
      } catch (e) { /* fall through to line mode */ }
    }
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      try {
        const r = JSON.parse(line);
        if (r && typeof r === 'object') records.push(normaliseLoose(r, i + 1, fileName));
        else problems.push({ file: fileName, line: i + 1, reason: 'not an object' });
      } catch (e) {
        problems.push({ file: fileName, line: i + 1, reason: 'bad JSON: ' + String(e.message).slice(0, 80) });
      }
    }
    return { records, problems };
  }

  // Accept Messages-API {role, content} objects as user/assistant records.
  function normaliseLoose(r, line, fileName) {
    if (r && !r.type && r.role && r.content !== undefined) {
      return { type: r.role, message: { role: r.role, content: r.content, usage: r.usage, model: r.model }, _loose: true, _line: line, _file: fileName };
    }
    r._line = line;
    r._file = fileName;
    return r;
  }

  // ---------------------------------------------------------------------------
  // Trace building
  // ---------------------------------------------------------------------------
  function parseTrace(files, opts) {
    opts = opts || {};
    if (!Array.isArray(files)) files = [files];
    const allRecords = [];
    const problems = [];
    const fileMeta = [];
    const subagentMeta = {}; // agentId -> meta.json content

    for (const f of files) {
      const name = f.name || 'transcript.jsonl';
      if (/\.meta\.json$/.test(name)) {
        try {
          const m = JSON.parse(f.text);
          const id = (name.match(/agent-([^/\\]+)\.meta\.json$/) || [])[1];
          if (id) subagentMeta[id] = m;
        } catch (e) { problems.push({ file: name, line: 0, reason: 'bad meta.json' }); }
        continue;
      }
      const { records, problems: p } = parseLines(f.text, name);
      problems.push(...p);
      fileMeta.push({ name, records: records.length, bytes: f.text ? f.text.length : 0 });
      allRecords.push(...records);
    }

    // Stable sort by timestamp where available; keep file order otherwise.
    // Records without a timestamp (last-prompt, atis-latch, summary…) inherit the previous
    // record's time in their file so the sort key is total and files interleave correctly.
    allRecords.forEach((r, i) => { r._seq = i; });
    const hasTimestamps = allRecords.some((r) => ts(r) != null);
    if (hasTimestamps) {
      let last = null, lastFile = null;
      for (const r of allRecords) {
        if (r._file !== lastFile) { lastFile = r._file; last = null; }
        const t = ts(r);
        if (t != null) last = t; else r._t = last;
      }
      const key = (r) => { const t = ts(r); return t != null ? t : (r._t != null ? r._t : -Infinity); };
      allRecords.sort((a, b) => (key(a) - key(b)) || (a._seq - b._seq));
    }

    const meta = {
      sessionId: null, version: null, cwd: null, gitBranch: null, entrypoint: null, title: null,
      models: [], start: null, end: null, hasTimestamps, files: fileMeta, format: 'claude-code',
      reportedCost: null, reportedUsage: null, reportedTurns: null, reportedDurationMs: null, recordCounts: {},
    };

    const agents = new Map(); // id -> agent
    function agentFor(rec) {
      const id = rec.agentId || (rec.isSidechain ? 'sidechain' : 'main');
      if (!agents.has(id)) {
        agents.set(id, {
          id, type: id === 'main' ? 'main' : 'subagent', description: null, parentToolUseId: null,
          start: null, end: null, usage: emptyUsage(), requestCount: 0, toolCount: 0, model: null,
          workflowRun: (String(rec._file || '').match(/workflows[\\/](wf_[^\\/]+)[\\/]/) || [])[1] || null,
        });
      }
      const a = agents.get(id);
      const t = ts(rec);
      if (t != null) { if (a.start == null || t < a.start) a.start = t; if (a.end == null || t > a.end) a.end = t; }
      return a;
    }
    agentFor({ agentId: null }); // ensure main exists first

    const requests = [];
    const requestByKey = new Map();
    const toolCalls = [];
    const toolCallById = new Map();
    const turns = [];
    const events = [];
    const attachments = { count: 0, chars: 0 };
    let lastAssistantEnd = null; // timestamp of last assistant record (main agent)
    let lastAssistantEndTurn = null;
    let lastToolResultAt = null;

    function currentTurn(agentId) {
      for (let i = turns.length - 1; i >= 0; i--) if (turns[i].agent === agentId) return turns[i];
      return null;
    }
    function ensureTurn(rec, kind, promptText) {
      const a = agentFor(rec);
      const t = ts(rec);
      const prev = currentTurn(a.id);
      if (prev && prev.end == null && t != null) prev.end = t;
      const turn = {
        index: turns.length, agent: a.id, promptText: promptText || '', promptKind: kind, start: t, end: null,
        requestIds: [], toolCallIds: [], usage: emptyUsage(), idleBeforeMs: 0, recordUuid: rec.uuid || null,
      };
      if (a.id === 'main' && kind === 'human' && lastAssistantEndTurn != null && t != null) {
        turn.idleBeforeMs = Math.max(0, t - lastAssistantEndTurn);
      }
      turns.push(turn);
      return turn;
    }

    for (const rec of allRecords) {
      const type = rec.type;
      meta.recordCounts[type] = (meta.recordCounts[type] || 0) + 1;
      if (!meta.sessionId && rec.sessionId) meta.sessionId = rec.sessionId;
      if (!meta.sessionId && rec.session_id) meta.sessionId = rec.session_id;
      if (!meta.version && rec.version) meta.version = rec.version;
      if (!meta.cwd && rec.cwd) meta.cwd = rec.cwd;
      if (!meta.gitBranch && rec.gitBranch) meta.gitBranch = rec.gitBranch;
      if (!meta.entrypoint && rec.entrypoint) meta.entrypoint = rec.entrypoint;
      const t = ts(rec);
      // Only conversation records bound the session: bookkeeping records (frame-link, file-history…)
      // can be written days later and would stretch the wall clock.
      if (t != null && (type === 'user' || type === 'assistant' || type === 'system')) { if (meta.start == null || t < meta.start) meta.start = t; if (meta.end == null || t > meta.end) meta.end = t; }

      if (type === 'summary') { if (rec.summary && !meta.title) meta.title = rec.summary; events.push({ kind: 'summary', at: t, detail: rec.summary }); continue; }
      if (type === 'attachment') { attachments.count++; attachments.chars += JSON.stringify(rec.attachment || '').length; continue; }
      if (type === 'result') {
        meta.format = 'stream-json';
        if (typeof rec.total_cost_usd === 'number') meta.reportedCost = rec.total_cost_usd;
        if (typeof rec.num_turns === 'number') meta.reportedTurns = rec.num_turns;
        if (typeof rec.duration_ms === 'number') meta.reportedDurationMs = rec.duration_ms;
        if (rec.usage) meta.reportedUsage = usageFrom(rec.usage);
        if (rec.is_error) events.push({ kind: 'api_error', at: t, detail: textOf(rec.result) || 'result is_error' });
        continue;
      }
      if (type === 'system') {
        if (rec.subtype === 'init') { meta.format = 'stream-json'; if (rec.model) pushModel(meta, rec.model); continue; }
        if (rec.subtype === 'compact_boundary') {
          const cm = rec.compactMetadata || {};
          events.push({ kind: 'compact', at: t, detail: (cm.trigger || 'compaction') + (cm.preTokens ? ' at ' + cm.preTokens + ' tokens' : ''), preTokens: cm.preTokens || null, agent: agentFor(rec).id });
          continue;
        }
        if (rec.subtype === 'stop_hook_summary') {
          if (Array.isArray(rec.hookErrors) && rec.hookErrors.length) events.push({ kind: 'hook_error', at: t, detail: rec.hookErrors.map(String).join('; ') });
          continue;
        }
        if (rec.subtype === 'api_error' || rec.level === 'error') {
          events.push({ kind: 'api_error', at: t, detail: textOf(rec.content) || rec.subtype || 'system error' });
        }
        continue;
      }
      if (type === 'user') {
        const a = agentFor(rec);
        const msg = rec.message || {};
        const content = msg.content;
        const blocks = Array.isArray(content) ? content : null;
        const toolResults = blocks ? blocks.filter((b) => b && b.type === 'tool_result') : [];
        if (toolResults.length) {
          for (const tr of toolResults) {
            const call = toolCallById.get(tr.tool_use_id);
            const text = textOf(tr.content);
            const structured = rec.toolUseResult;
            if (call) {
              call.end = t;
              call.durationMs = (t != null && call.start != null) ? Math.max(0, t - call.start) : null;
              call.status = tr.is_error ? 'error' : 'ok';
              call.isError = !!tr.is_error;
              call.resultText = text;
              call.resultChars = text.length;
              call.resultStructured = structured != null ? structured : null;
              const imgs = Array.isArray(tr.content) ? tr.content.filter((b) => b && b.type === 'image') : [];
              call.resultImages = imgs.length;
              call.imageBytes = imgs.reduce((s, b) => s + Math.round(((b.source && b.source.data) || '').length * 0.75), 0);
              if (structured && typeof structured === 'object' && !text && !imgs.length) call.resultChars = JSON.stringify(structured).length;
              // stream-json puts is_error only in block; Claude Code also stores toolUseResult as an Error string
              if (!tr.is_error && typeof structured === 'string' && /^Error/i.test(structured)) { call.status = 'error'; call.isError = true; }
              if (call.isError) call.denial = denialKind(rec, text);
            } else {
              toolCalls.push(mkOrphanResult(tr, rec, a.id, text, turns.length ? turns[turns.length - 1].index : null));
            }
          }
          lastToolResultAt = t;
          continue;
        }
        // Human / meta prompt
        const text = textOf(content);
        let kind = 'human';
        if (rec.isCompactSummary) kind = 'compact';
        else if (rec.isMeta) kind = 'meta';
        else if (/^\[Request interrupted by user/.test(text.trim())) kind = 'interrupt';
        else if (/^<(system-reminder|local-command|command-name|bash-input|bash-stdout)/.test(text.trim())) kind = 'meta';
        ensureTurn(rec, kind, text);
        continue;
      }
      if (type === 'assistant') {
        const a = agentFor(rec);
        const msg = rec.message || {};
        const key = rec.requestId || msg.id || rec.uuid || ('seq' + rec._seq);
        let req = requestByKey.get(key);
        if (!req) {
          let turn = currentTurn(a.id);
          if (!turn) turn = ensureTurn(rec, 'implicit', '');
          req = {
            id: key, agent: a.id, model: msg.model || null, stopReason: null, start: t, end: t,
            usage: emptyUsage(), blocks: [], turnIndex: turn.index, contextTokens: 0, records: 0,
            isApiError: !!rec.isApiErrorMessage, uuid: rec.uuid || null,
          };
          requestByKey.set(key, req);
          requests.push(req);
          turn.requestIds.push(req.id);
          a.requestCount++;
          if (msg.model) { pushModel(meta, msg.model); if (!a.model) a.model = msg.model; }
        } else {
          if (t != null) { if (req.start == null || t < req.start) req.start = t; if (req.end == null || t > req.end) req.end = t; }
        }
        maxUsage(req.usage, usageFrom(msg.usage)); // turn and agent totals are summed once, after the loop
        req.records++;
        if (msg.stop_reason) req.stopReason = msg.stop_reason;
        if (rec.isApiErrorMessage) req.isApiError = true;
        const content = Array.isArray(msg.content) ? msg.content : (msg.content != null ? [{ type: 'text', text: String(msg.content) }] : []);
        const blockIndex = typeof rec.apiBlockIndex === 'number' ? rec.apiBlockIndex : req.blocks.length;
        for (const b of content) {
          if (!b || typeof b !== 'object') continue;
          if (b.type === 'tool_use') {
            const call = {
              id: b.id || (key + ':' + blockIndex), agent: a.id, requestId: req.id, name: b.name || 'unknown', input: b.input || {},
              start: t, end: null, durationMs: null, status: 'orphan', isError: false, resultText: '', resultChars: 0,
              resultStructured: null, category: toolCategory(b.name), turnIndex: req.turnIndex, subagentId: null,
              inputChars: JSON.stringify(b.input || {}).length, resultImages: 0, imageBytes: 0, denial: null,
            };
            toolCalls.push(call);
            toolCallById.set(call.id, call);
            turns[req.turnIndex].toolCallIds.push(call.id);
            a.toolCount++;
            req.blocks.push({ type: 'tool_use', name: call.name, id: call.id, index: blockIndex });
          } else if (b.type === 'text') {
            req.blocks.push({ type: 'text', text: b.text || '', index: blockIndex });
          } else if (b.type === 'thinking' || b.type === 'redacted_thinking') {
            req.blocks.push({ type: 'thinking', text: b.thinking || '', index: blockIndex });
          } else {
            req.blocks.push({ type: b.type || 'unknown', index: blockIndex });
          }
        }
        if (a.id === 'main' && t != null) { lastAssistantEnd = t; if (msg.stop_reason === 'end_turn') lastAssistantEndTurn = t; }
        continue;
      }
      // ignored: queue-operation, last-prompt, atis-latch, file-history-snapshot, progress, etc.
    }

    // Finalise
    for (const req of requests) {
      req.blocks.sort((x, y) => x.index - y.index);
      req.contextTokens = req.usage.input + req.usage.cacheRead + req.usage.cacheWrite;
      addUsage(turns[req.turnIndex].usage, req.usage);
      addUsage(agents.get(req.agent).usage, req.usage);
    }
    for (const turn of turns) if (turn.end == null) turn.end = meta.end;
    // Response timing. Assistant record timestamps are written when a block finishes streaming,
    // so a request's "start" is really its first completed block. We measure from the moment the
    // model had everything it needed (previous tool result in this turn, else the prompt) to the
    // last block: responseMs. tokensPerSec = output / responseMs.
    const callsByTurnIdx = new Map();
    for (const c of toolCalls) { if (!callsByTurnIdx.has(c.turnIndex)) callsByTurnIdx.set(c.turnIndex, []); callsByTurnIdx.get(c.turnIndex).push(c); }
    for (const req of requests) {
      req.blocksSummary = req.blocks.map((b) => b.type === 'tool_use' ? b.name : b.type).join(',');
      req.responseFrom = null; req.responseMs = null; req.tokensPerSec = null;
      if (req.start == null || req.end == null) continue;
      const turn = turns[req.turnIndex];
      let from = turn && turn.start != null ? turn.start : req.start;
      for (const c of (callsByTurnIdx.get(req.turnIndex) || [])) if (c.end != null && c.end <= req.start && c.end > from) from = c.end;
      for (const other of requests) if (other !== req && other.agent === req.agent && other.turnIndex === req.turnIndex && other.end != null && other.end <= req.start && other.end > from) from = other.end;
      req.responseFrom = from;
      req.responseMs = Math.max(0, req.end - from);
      req.tokensPerSec = req.responseMs > 0 ? req.usage.output / (req.responseMs / 1000) : null;
    }
    for (const ag of agents.values()) ag.modelTimeMs = requests.filter((r) => r.agent === ag.id).reduce((s, r) => s + (r.responseMs || 0), 0);

    // Link subagents
    const agentList = Array.from(agents.values());
    for (const ag of agentList) {
      if (ag.id === 'main') continue;
      const m = subagentMeta[ag.id];
      if (m) { ag.parentToolUseId = m.toolUseId || null; ag.description = m.description || null; ag.agentType = m.agentType || null; }
      if (!ag.parentToolUseId) {
        const parent = toolCalls.find((c) => c.category === 'agent' && c.agent === 'main' && ((c.resultText && c.resultText.includes(ag.id)) || (c.resultStructured && JSON.stringify(c.resultStructured).includes(ag.id))));
        if (parent) ag.parentToolUseId = parent.id;
      }
      // Workflow agents live in subagents/workflows/<runId>/; the Workflow call's result names that runId.
      if (!ag.parentToolUseId && ag.workflowRun) {
        const parent = toolCalls.find((c) => c.name === 'Workflow' && ((c.resultStructured && c.resultStructured.runId === ag.workflowRun) || (c.resultText && c.resultText.includes(ag.workflowRun))));
        if (parent) ag.parentToolUseId = parent.id;
      }
      if (ag.parentToolUseId) {
        const parent = toolCallById.get(ag.parentToolUseId);
        if (parent) { if (!parent.subagentId) parent.subagentId = ag.id; (parent.subagentIds || (parent.subagentIds = [])).push(ag.id); if (!ag.description && parent.input && parent.input.description) ag.description = parent.input.description; if (!ag.agentType && parent.input && parent.input.subagent_type) ag.agentType = parent.input.subagent_type; }
      }
    }

    // Totals
    const usage = emptyUsage();
    for (const r of requests) addUsage(usage, r.usage);
    const humanIdleMs = turns.reduce((s, tn) => s + (tn.idleBeforeMs || 0), 0);
    // stream-json runs carry no per-record timestamps and no human prompt record, but the result
    // record reports duration_ms and num_turns; use those rather than showing "—" and 0.
    const wallMs = (meta.start != null && meta.end != null) ? meta.end - meta.start : (meta.reportedDurationMs != null ? meta.reportedDurationMs : null);
    const humanTurns = turns.filter((tn) => tn.promptKind === 'human' && tn.agent === 'main').length;
    const totals = {
      usage, wallMs, humanIdleMs, activeMs: wallMs != null ? Math.max(0, wallMs - humanIdleMs) : null,
      requests: requests.length, toolCalls: toolCalls.length, toolErrors: toolCalls.filter((c) => c.isError).length,
      orphans: toolCalls.filter((c) => c.status === 'orphan').length,
      turns: humanTurns || (meta.reportedTurns != null ? meta.reportedTurns : 0),
      toolTimeMs: toolCalls.filter((c) => c.agent === 'main').reduce((s, c) => s + (c.durationMs || 0), 0),
      modelTimeMs: agents.get('main').modelTimeMs || 0,
      cacheHitRatio: (usage.cacheRead + usage.cacheWrite + usage.input) ? usage.cacheRead / (usage.cacheRead + usage.cacheWrite + usage.input) : null,
      attachments,
    };

    return { version: VERSION, meta, requests, toolCalls, turns, agents: agentList, events, problems, totals };
  }

  function pushModel(meta, m) { if (m && !meta.models.includes(m)) meta.models.push(m); }

  function mkOrphanResult(tr, rec, agentId, text, turnIndex) {
    return {
      id: tr.tool_use_id || ('result:' + rec._seq), agent: agentId, requestId: null, name: '(unmatched result)', input: {},
      start: ts(rec), end: ts(rec), durationMs: 0, status: tr.is_error ? 'error' : 'ok', isError: !!tr.is_error, resultText: text,
      resultChars: text.length, resultStructured: null, category: 'other', turnIndex, subagentId: null, inputChars: 0, unmatched: true,
    };
  }

  // ---------------------------------------------------------------------------
  // Diagnostics
  // ---------------------------------------------------------------------------
  function diagnose(trace, userOpts) {
    const o = Object.assign({}, DEFAULTS, userOpts || {});
    const findings = [];
    const push = (f) => { findings.push(Object.assign({ evidence: {} }, f)); };
    const calls = trace.toolCalls;
    const reqs = trace.requests;

    // retry-loop: same tool + identical input within a turn
    const byTurnSig = new Map();
    for (const c of calls) {
      if (c.unmatched) continue;
      const sig = c.turnIndex + '|' + c.agent + '|' + c.name + '|' + stableStringify(c.input);
      if (!byTurnSig.has(sig)) byTurnSig.set(sig, []);
      byTurnSig.get(sig).push(c);
    }
    const callIndex = new Map(calls.map((c, i) => [c, i]));
    for (const group of byTurnSig.values()) {
      if (group.length >= o.retryLoopMin) {
        const errs = group.filter((c) => c.isError).length;
        if (isWait(group[0]) && errs < 2) continue; // polling a running task; failing polls still count
        if (errs < 2) {
          // Re-running a test or taking another screenshot after something changed is observing, not
          // looping: only flag successful repeats that returned the same thing with nothing in between.
          const inGroup = new Set(group);
          const between = calls.slice(callIndex.get(group[0]) + 1, callIndex.get(group[group.length - 1]));
          const changed = between.some((c) => c.agent === group[0].agent && !inGroup.has(c) && c.category !== 'read');
          const same = group.every((c) => c.resultText === group[0].resultText && c.imageBytes === group[0].imageBytes);
          if (changed || !same) continue;
        }
        push({
          id: 'retry-loop', severity: errs >= 2 ? 'error' : 'warn',
          title: `${group[0].name} called ${group.length}× with identical input`,
          detail: errs ? `${errs} of them failed — the agent kept retrying the same call.` : 'Same call repeated in one turn; the result was probably already in context.',
          evidence: { toolCallIds: group.map((c) => c.id), turnIndex: group[0].turnIndex }, metric: group.length,
        });
      }
    }

    // failed-tool: per tool error rate. Calls the human or a permission rule stopped are not the
    // tool's failure (see permission-denied); one stray error in a long session is not a pattern.
    const byTool = new Map();
    for (const c of calls) { if (c.unmatched || c.denial) continue; if (!byTool.has(c.name)) byTool.set(c.name, []); byTool.get(c.name).push(c); }
    for (const [name, list] of byTool) {
      const errs = list.filter((c) => c.isError);
      if (!errs.length) continue;
      const rate = errs.length / list.length;
      const bad = list.length >= o.failedToolMinCalls && rate >= o.failedToolRate;
      if (!bad && (errs.length < o.failedToolWarnMinErrors || rate < o.failedToolWarnRate)) continue;
      push({
        id: 'failed-tool', severity: bad ? 'error' : 'warn',
        title: `${name} failed ${errs.length} of ${list.length} calls (${Math.round(rate * 100)}%)`,
        detail: firstLine(errs[0].resultText) || 'Tool returned is_error.',
        evidence: { toolCallIds: errs.map((c) => c.id) }, metric: rate,
      });
    }

    // permission-denied: calls that never ran because the human rejected them, a permission rule or
    // the auto-mode classifier blocked them, or the human interrupted.
    const denied = calls.filter((c) => c.denial);
    if (denied.length) {
      const kinds = {}; for (const c of denied) kinds[c.denial] = (kinds[c.denial] || 0) + 1;
      push({
        id: 'permission-denied', severity: 'info', title: `${denied.length} tool call${denied.length > 1 ? 's' : ''} denied or interrupted`,
        detail: Object.entries(kinds).map(([k, n]) => `${k} ×${n}`).join(', ') + ' — ' + summariseNames(denied),
        evidence: { toolCallIds: denied.map((c) => c.id) }, metric: denied.length,
      });
    }

    // orphan-tool
    const orphans = calls.filter((c) => c.status === 'orphan');
    if (orphans.length) push({
      id: 'orphan-tool', severity: 'warn', title: `${orphans.length} tool call${orphans.length > 1 ? 's' : ''} never got a result`,
      detail: 'Session aborted, crashed, or was still running when the transcript was captured: ' + orphans.map((c) => c.name).slice(0, 5).join(', '),
      evidence: { toolCallIds: orphans.map((c) => c.id) }, metric: orphans.length,
    });

    // exploration-run: consecutive read-category calls per agent
    for (const ag of trace.agents) {
      let run = [];
      const flush = () => {
        if (run.length >= o.explorationRunInfo) {
          push({
            id: 'exploration-run', severity: run.length >= o.explorationRunWarn ? 'warn' : 'info',
            title: `${run.length} read-only calls in a row${ag.id !== 'main' ? ' (subagent)' : ''}`,
            detail: 'Long exploration without writing or executing anything: ' + summariseNames(run),
            evidence: { toolCallIds: run.map((c) => c.id), turnIndex: run[0].turnIndex }, metric: run.length,
          });
        }
        run = [];
      };
      for (const c of calls) {
        if (c.agent !== ag.id || c.unmatched) continue;
        // MCP calls that aren't reads are actions (browser navigate/click, device commands) and end a run;
        // agent and user calls don't.
        if (c.category === 'read') run.push(c); else if (c.category === 'write' || c.category === 'exec' || c.category === 'mcp') flush();
      }
      flush();
    }

    // duplicate-subagent-read: the same file read by several agents, each paying for it in its own context
    const sharedReads = new Set(); // reported here, so oversized-result below skips them
    const readsByFile = new Map();
    for (const c of calls) {
      if (c.name !== 'Read' || c.isError || !c.input || !c.input.file_path) continue;
      const k = String(c.input.file_path).replace(/\\/g, '/').toLowerCase();
      if (!readsByFile.has(k)) readsByFile.set(k, []);
      readsByFile.get(k).push(c);
    }
    for (const list of readsByFile.values()) {
      const agentIds = new Set(list.map((c) => c.agent));
      if (agentIds.size < o.duplicateReadAgents) continue;
      const chars = list.reduce((s, c) => s + c.resultChars, 0);
      for (const c of list) sharedReads.add(c);
      const largest = Math.max(...list.map((c) => c.resultChars));
      push({
        id: 'duplicate-subagent-read', severity: largest >= o.oversizedResultError ? 'error' : chars >= o.duplicateReadWarnChars ? 'warn' : 'info',
        title: `Same file read by ${agentIds.size} agents (${fmtInt(chars)} chars)`, // path only in detail, which --redact blanks
        detail: `${list.length} reads of ${list[0].input.file_path} across ${agentIds.size} agents; each copy is billed in that agent's context on every later request.`,
        evidence: { toolCallIds: list.map((c) => c.id) }, metric: chars,
      });
    }

    // oversized-result: one line per call, or one per tool when a tool does it repeatedly
    const bigByTool = new Map();
    for (const c of calls) if (c.resultChars >= o.oversizedResultWarn && !sharedReads.has(c)) { if (!bigByTool.has(c.name)) bigByTool.set(c.name, []); bigByTool.get(c.name).push(c); }
    for (const [name, list] of bigByTool) {
      const largest = Math.max(...list.map((c) => c.resultChars)), total = list.reduce((s, c) => s + c.resultChars, 0);
      const ranged = list.every(hasRange);
      const detail = 'Large tool results stay in context for the rest of the session. ' + (ranged ? 'The call already set a range; long lines or a wide window still cost, so narrow it or grep first.' : 'Consider head/limit, grep, or a subagent.');
      if (list.length >= o.groupRepeatsMin) push({
        id: 'oversized-result', severity: largest >= o.oversizedResultError ? 'error' : 'warn',
        title: `${name} returned over ${fmtInt(o.oversizedResultWarn)} chars ${list.length} times (largest ${fmtInt(largest)}, ${fmtInt(total)} in all)`,
        detail, evidence: { toolCallIds: list.map((c) => c.id) }, metric: largest,
      });
      else for (const c of list) push({
        id: 'oversized-result', severity: c.resultChars >= o.oversizedResultError ? 'error' : 'warn',
        title: `${c.name} returned ${fmtInt(c.resultChars)} chars`,
        detail, evidence: { toolCallIds: [c.id], turnIndex: c.turnIndex }, metric: c.resultChars,
      });
    }

    // image-heavy: screenshots and image reads stay in context as tokens for the rest of the session
    const imgCalls = calls.filter((c) => c.imageBytes > 0);
    const imgBytes = imgCalls.reduce((s, c) => s + c.imageBytes, 0);
    if (imgBytes >= o.imageHeavyInfoBytes) push({
      id: 'image-heavy', severity: imgBytes >= o.imageHeavyWarnBytes ? 'warn' : 'info',
      title: `${imgCalls.reduce((s, c) => s + c.resultImages, 0)} image${imgCalls.length > 1 ? 's' : ''} (${(imgBytes / 1048576).toFixed(1)} MB) returned by tools`,
      detail: 'Screenshots and image reads are billed as tokens on every later request. Crop, downscale, or read fewer of them: ' + summariseNames(imgCalls),
      evidence: { toolCallIds: imgCalls.map((c) => c.id) }, metric: imgBytes,
    });

    // context-bloat
    let crossed = null; let peak = null;
    for (const r of reqs) {
      if (r.contextTokens >= o.contextBloatWarn && !crossed) crossed = r;
      if (!peak || r.contextTokens > peak.contextTokens) peak = r;
    }
    if (crossed) {
      // What the large context cost: every request (any agent) sent with more than the threshold.
      let above = 0, all = 0, n = 0;
      for (const r of reqs) { const c = requestCost(r.usage, rateFor(r.model, o.rates)); if (c == null) continue; all += c; if (r.contextTokens >= o.contextBloatWarn) { above += c; n++; } }
      const spend = all > 0 ? ` · ${usd(above)} (${Math.round(above / all * 100)}% of cost) spent above ${fmtInt(o.contextBloatWarn)}` : '';
      push({
        id: 'context-bloat', severity: peak.contextTokens >= o.contextBloatError ? 'error' : 'warn',
        title: `Context reached ${fmtInt(peak.contextTokens)} tokens${spend}`,
        detail: `First crossed ${fmtInt(o.contextBloatWarn)} at request #${reqs.indexOf(crossed) + 1} (turn ${crossed.turnIndex + 1}); ${n} request${n === 1 ? '' : 's'} ran above it. Every one of them re-reads that prefix.`,
        evidence: { requestIds: [crossed.id, peak.id], turnIndex: crossed.turnIndex }, metric: peak.contextTokens, cost: all > 0 ? above : null,
      });
    }

    // cache-churn / idle-cache-expiry: a request that re-wrote prefix the previous request of the same
    // agent had already cached. A big cache write on its own is usually just a new tool result being
    // cached, which is expected. After a gap longer than the cache lifetime the miss is expiry, not
    // invalidation; right after a compaction it is an expected rebuild.
    const prevByAgent = new Map(); const ttlByAgent = new Map();
    for (const r of reqs) {
      const prev = prevByAgent.get(r.agent); prevByAgent.set(r.agent, r);
      if (r.usage.cacheWrite1h > 0) ttlByAgent.set(r.agent, 3600e3); else if (r.usage.cacheWrite5m > 0 && !ttlByAgent.has(r.agent)) ttlByAgent.set(r.agent, 300e3);
      if (!prev) continue;
      const cached = prev.usage.cacheRead + prev.usage.cacheWrite;
      const missed = cached - r.usage.cacheRead;
      if (missed < o.cacheChurnMin || missed < cached * o.cacheMissMinShare) continue;
      const sent = r.responseFrom != null ? r.responseFrom : r.start;
      if (prev.end != null && sent != null && trace.events.some((e) => e.kind === 'compact' && e.at != null && e.at >= prev.end && e.at <= sent)) continue;
      const idle = prev.end != null && sent != null ? sent - prev.end : null;
      const ttl = ttlByAgent.get(r.agent) || 300e3;
      const n = reqs.indexOf(r) + 1;
      if (idle != null && idle > ttl) push({
        id: 'idle-cache-expiry', severity: 'info', title: `${fmtInt(missed)} tokens re-cached after ${fmtDur(idle)} idle`,
        detail: `Request #${n}${r.agent !== 'main' ? ' (subagent)' : ''}: the gap was longer than the ${ttl >= 3600e3 ? '1-hour' : '5-minute'} cache lifetime, so the whole prefix was written again.`,
        evidence: { requestIds: [prev.id, r.id], turnIndex: r.turnIndex }, metric: missed,
      });
      else push({
        id: 'cache-churn', severity: 'info', title: `${fmtInt(missed)} cached tokens re-written at request #${n}`,
        detail: `The previous request had ${fmtInt(cached)} tokens cached; this one read only ${fmtInt(r.usage.cacheRead)} back${idle != null ? ` ${fmtDur(idle)} later` : ''}. Something early in the prompt changed (system prompt, tool list, early messages).`,
        evidence: { requestIds: [prev.id, r.id], turnIndex: r.turnIndex }, metric: missed,
      });
    }

    // low-cache-hit
    if (reqs.length >= o.lowCacheHitMinRequests && trace.totals.cacheHitRatio != null && trace.totals.cacheHitRatio < o.lowCacheHitRatio) push({
      id: 'low-cache-hit', severity: 'info', title: `Cache hit ratio ${Math.round(trace.totals.cacheHitRatio * 100)}%`,
      detail: 'Less than half of input tokens were served from cache. Cached reads cost ~10% of uncached input.',
      evidence: {}, metric: trace.totals.cacheHitRatio,
    });

    // slow-tool: blocking waits roll up per background task, other slow calls per tool when repeated
    const waits = new Map(), slowByTool = new Map();
    for (const c of calls) {
      if (isWait(c)) { const k = c.agent + '|' + c.name + '|' + waitTarget(c); if (!waits.has(k)) waits.set(k, []); waits.get(k).push(c); continue; }
      // Time spent on a question to the human, or on a permission prompt that ended in a denial, is the human's.
      if (c.category === 'user' || c.denial) continue;
      if (c.durationMs != null && c.durationMs >= o.slowToolInfoMs) { if (!slowByTool.has(c.name)) slowByTool.set(c.name, []); slowByTool.get(c.name).push(c); }
    }
    for (const [name, list] of slowByTool) {
      const longest = Math.max(...list.map((c) => c.durationMs)), total = list.reduce((s, c) => s + c.durationMs, 0);
      const detail = list[0].category === 'agent' ? 'Subagent run time.' : 'Long-running tool call.';
      if (list.length >= o.groupRepeatsMin) push({
        id: 'slow-tool', severity: longest >= o.slowToolWarnMs ? 'warn' : 'info',
        title: `${name} took over ${fmtDur(o.slowToolInfoMs)} ${list.length} times (longest ${fmtDur(longest)}, ${fmtDur(total)} in all)`,
        detail, evidence: { toolCallIds: list.map((c) => c.id) }, metric: total,
      });
      else for (const c of list) push({
        id: 'slow-tool', severity: c.durationMs >= o.slowToolWarnMs ? 'warn' : 'info',
        title: `${c.name} took ${fmtDur(c.durationMs)}`, detail,
        evidence: { toolCallIds: [c.id], turnIndex: c.turnIndex }, metric: c.durationMs,
      });
    }
    // One finding per waited-on task, always info: the time belongs to the background job.
    for (const group of waits.values()) {
      const ms = group.reduce((s, c) => s + (c.durationMs || 0), 0);
      if (ms < o.slowToolInfoMs) continue;
      const target = waitTarget(group[0]);
      push({
        id: 'slow-tool', severity: 'info',
        title: `${group[0].name} waited ${fmtDur(ms)} on ${target ? 'task ' + target : 'a background task'}${group.length > 1 ? ` (${group.length} polls)` : ''}`,
        detail: 'Blocking wait on background work: the time is the task\'s run time, not a slow tool.',
        evidence: { toolCallIds: group.map((c) => c.id), turnIndex: group[0].turnIndex }, metric: ms,
      });
    }

    // slow-model: a long response that produced little — API latency, rate limiting or a stall,
    // as opposed to a long response that was simply writing a lot (reported separately as info).
    if (trace.meta.hasTimestamps) {
      for (const r of reqs) {
        if (r.responseMs == null || r.responseMs < o.slowModelMs) continue;
        const n = reqs.indexOf(r) + 1;
        if (r.usage.output < o.slowModelMaxOutput) push({
          id: 'slow-model', severity: 'warn', title: `${fmtDur(r.responseMs)} for a ${fmtInt(r.usage.output)}-token response`,
          detail: `Request #${n} (${r.tokensPerSec != null ? r.tokensPerSec.toFixed(1) : '?'} tok/s): API latency, rate limiting or a stalled stream.`,
          evidence: { requestIds: [r.id], turnIndex: r.turnIndex }, metric: r.responseMs,
        });
        // A long response that wrote a lot at a normal rate is just a big output. Only a slow rate is worth a line.
        else if (r.tokensPerSec != null && r.tokensPerSec < o.longGenerationMaxTokPerSec) push({
          id: 'long-generation', severity: 'info', title: `${fmtDur(r.responseMs)} writing ${fmtInt(r.usage.output)} tokens (${r.tokensPerSec.toFixed(1)} tok/s)`,
          detail: `Request #${n} (${r.blocksSummary}) streamed well below the usual rate: a partial stall or a slow API period.`,
          evidence: { requestIds: [r.id], turnIndex: r.turnIndex }, metric: r.responseMs,
        });
      }
    }

    // max-tokens / api-error
    for (const r of reqs) {
      if (r.stopReason === 'max_tokens') push({ id: 'max-tokens', severity: 'warn', title: `Response truncated at request #${reqs.indexOf(r) + 1}`, detail: 'stop_reason was max_tokens; output was cut off.', evidence: { requestIds: [r.id], turnIndex: r.turnIndex }, metric: r.usage.output });
      if (r.isApiError) push({ id: 'api-error', severity: 'error', title: `API error at request #${reqs.indexOf(r) + 1}`, detail: firstLine(r.blocks.filter((b) => b.type === 'text').map((b) => b.text).join(' ')) || 'Assistant record flagged isApiErrorMessage.', evidence: { requestIds: [r.id], turnIndex: r.turnIndex } });
    }
    for (const e of trace.events) {
      if (e.kind === 'api_error') push({ id: 'api-error', severity: 'error', title: 'API error', detail: firstLine(e.detail), evidence: { at: e.at } });
      if (e.kind === 'hook_error') push({ id: 'hook-error', severity: 'warn', title: 'Hook reported errors', detail: firstLine(e.detail), evidence: { at: e.at } });
      if (e.kind === 'compact') push({ id: 'compaction', severity: 'info', title: 'Context was compacted', detail: e.detail, evidence: { at: e.at } });
    }

    // thinking-heavy
    const u = trace.totals.usage;
    if (u.output >= o.thinkingHeavyMinOutput && u.thinking / u.output > o.thinkingHeavyShare) push({
      id: 'thinking-heavy', severity: 'info', title: `${Math.round(u.thinking / u.output * 100)}% of output tokens were thinking`,
      detail: 'Fine for hard problems; for routine tool loops a lower effort setting would be cheaper.', evidence: {}, metric: u.thinking / u.output,
    });

    // subagent-share
    const subTokens = trace.agents.filter((a) => a.id !== 'main').reduce((s, a) => s + a.usage.output + a.usage.input + a.usage.cacheRead + a.usage.cacheWrite, 0);
    const allTokens = u.output + u.input + u.cacheRead + u.cacheWrite;
    if (allTokens && subTokens / allTokens >= o.subagentShare) push({
      id: 'subagent-share', severity: 'info', title: `Subagents used ${Math.round(subTokens / allTokens * 100)}% of all tokens`,
      detail: 'Most of the spend happened in delegated work.', evidence: {}, metric: subTokens / allTokens,
    });

    // long-turn: main conversation only (a subagent's whole run is one turn by design), numbered like
    // the viewer's T1, T2… (human prompts).
    // Meta turns (injected reminders, interrupts) between two prompts belong to the stretch before them.
    const stretches = [];
    for (const tn of trace.turns) {
      if (tn.agent !== 'main') continue;
      if (tn.promptKind === 'human' || !stretches.length) stretches.push({ first: tn, no: stretches.length + 1, ids: [] });
      stretches[stretches.length - 1].ids.push(...tn.toolCallIds);
    }
    for (const st of stretches) if (st.ids.length >= o.longTurnTools) push({
      id: 'long-turn', severity: 'info', title: `Turn ${st.no} made ${st.ids.length} tool calls`,
      detail: 'A very long autonomous stretch. Worth a skim for wasted work.', evidence: { turnIndex: st.first.index, toolCallIds: st.ids }, metric: st.ids.length,
    });

    const order = { error: 0, warn: 1, info: 2 };
    findings.sort((a, b) => order[a.severity] - order[b.severity] || (b.metric || 0) - (a.metric || 0));
    return findings;
  }

  function summariseNames(list) {
    const counts = {};
    for (const c of list) counts[c.name] = (counts[c.name] || 0) + 1;
    return Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([n, k]) => `${n}×${k}`).join(', ');
  }
  function firstLine(s) { if (!s) return ''; const l = String(s).split('\n').find((x) => x.trim()); return l ? l.trim().slice(0, 200) : ''; }
  function fmtInt(n) { return (n == null || !Number.isFinite(n)) ? '—' : Math.round(n).toLocaleString('en-US'); }
  function fmtDur(ms) {
    if (ms == null || !Number.isFinite(ms)) return '—';
    if (ms < 1000) return Math.round(ms) + ' ms';
    const s = ms / 1000;
    if (s < 60) return (s < 10 ? s.toFixed(1) : Math.round(s)) + ' s';
    const m = Math.floor(s / 60), r = Math.round(s % 60);
    if (m < 60) return m + 'm ' + (r < 10 ? '0' : '') + r + 's';
    const h = Math.floor(m / 60);
    return h + 'h ' + (m % 60) + 'm';
  }

  // ---------------------------------------------------------------------------
  // Cost
  // ---------------------------------------------------------------------------
  function rateFor(model, rates) {
    rates = rates || RATES;
    if (!model) return null;
    if (rates[model]) return rates[model];
    let best = null;
    for (const k of Object.keys(rates)) if (model.startsWith(k) && (!best || k.length > best.length)) best = k;
    return best ? rates[best] : null;
  }
  function requestCost(u, rate) {
    if (!rate) return null;
    const w5 = u.cacheWrite5m || 0, w1 = u.cacheWrite1h || 0;
    const write = (w5 || w1) ? (w5 * rate.w5m + w1 * rate.w1h) : (u.cacheWrite * rate.w5m);
    return (u.input * rate.in + u.cacheRead * rate.read + write + u.output * rate.out) / 1e6;
  }
  function estimateCost(trace, rates) {
    rates = rates || RATES;
    let total = 0; let known = 0;
    const byRequest = []; const byModel = {}; const byAgent = {}; const unknownModels = new Set();
    for (const r of trace.requests) {
      const rate = rateFor(r.model, rates);
      const c = requestCost(r.usage, rate);
      byRequest.push(c);
      if (c == null) { if (r.model) unknownModels.add(r.model); continue; }
      total += c; known++;
      byModel[r.model] = (byModel[r.model] || 0) + c;
      byAgent[r.agent] = (byAgent[r.agent] || 0) + c;
    }
    const complete = known === trace.requests.length;
    return {
      total: known ? total : null, complete, byRequest, byModel, byAgent, unknownModels: Array.from(unknownModels),
      reported: trace.meta.reportedCost, source: trace.meta.reportedCost != null ? 'reported' : (known ? 'estimated' : 'unknown'),
    };
  }

  // ---------------------------------------------------------------------------
  // Advice — one sentence per rule on what to do differently. Mechanical, like the rules.
  // ---------------------------------------------------------------------------
  const ADVICE = {
    'retry-loop': 'When a call fails, change something before calling again: read the error, fix the input or the environment, or ask the user — never repeat an identical call.',
    'failed-tool': 'Check the first error message of the failing tool before retrying; if the tool itself is broken, switch tools or tell the user instead of pushing on.',
    'orphan-tool': 'A call with no result means the session ended mid-call; if you resume, re-run it or confirm its side effects before building on it.',
    'exploration-run': 'Batch exploration: use one Grep or Glob with a wider pattern, or delegate a broad search to a subagent, then commit to an edit or command sooner.',
    'oversized-result': 'Ask tools for less: head/limit/offset on reads, a tighter grep pattern, a file listing instead of a dump, or a subagent that returns a summary.',
    'image-heavy': 'Take fewer screenshots and crop or downscale them; read text with a page-text tool where one exists, since every image is re-billed on each later request.',
    'context-bloat': 'Keep the prompt small: summarise long results into notes, avoid re-reading files already in context, and hand large investigations to subagents.',
    'cache-churn': 'Avoid changing anything at the top of the prompt mid-session (system prompt, tool list, early messages), because it invalidates the cached prefix and re-bills it.',
    'low-cache-hit': 'Long stable prefixes cache well; frequent tool-list or system-prompt changes and many tiny sessions do not.',
    'slow-tool': 'For calls that take minutes, run them in the background, tighten the command, or set a timeout, instead of blocking the whole turn.',
    'slow-model': 'A slow, small response is usually API latency or a stall; nothing to fix in the session itself, but note it when reporting session time.',
    'long-generation': 'Large single outputs are normal for file writes; split very large files into parts if a stall (low tok/s) shows up.',
    'max-tokens': 'The output was truncated: write large files in sections and keep single responses under the output limit.',
    'api-error': 'An API error interrupted the session; check what was lost and re-run the affected step rather than assuming it completed.',
    'hook-error': 'A hook failed; read the hook error, fix the hook command or its permissions, then re-run the step it guarded.',
    'compaction': 'Context was compacted; state that matters later (decisions, file paths, test status) should be written to a file or note before it is summarised away.',
    'thinking-heavy': 'Most output tokens were thinking; fine for hard problems, but for routine tool loops a lower effort setting is cheaper and just as good.',
    'subagent-share': 'Most spend was in subagents; give them narrower briefs and ask for short structured returns so the parent pays for less.',
    'long-turn': 'A very long autonomous turn; check in with a short progress summary at natural checkpoints so wasted work is caught earlier.',
    'permission-denied': 'Before a call the user may not want (installs, network, deleting, publishing), say what it will do and ask; for calls they always allow, suggest a permissions allow rule so the prompt goes away.',
    'duplicate-subagent-read': 'When several subagents need the same file, put the relevant excerpt in their briefs or have one agent summarise it once, instead of every agent reading it into its own context.',
    'idle-cache-expiry': 'The cache expired while the session sat idle; resume sooner, use the 1-hour cache lifetime where available, or start a fresh session with a summary instead of re-sending the whole history.',
  };

  // Advice for a concrete finding: the rule's line, except where the evidence says otherwise.
  function adviceFor(f, trace) {
    if (f.id === 'slow-tool') {
      const ids = (f.evidence && f.evidence.toolCallIds) || [];
      const c = trace.toolCalls.find((x) => x.id === ids[0]);
      if (c && c.category === 'user') return null; // waiting on the human is not the agent's time
      if (c && c.category === 'agent') return 'Subagent run time: give it a narrower brief and ask for a short structured return so the parent is not blocked for as long.';
      if (c && isWait(c)) return 'Waiting on a long background task: keep doing independent work while it runs, or tell the user it is still going, instead of blocking the turn on it.';
    }
    if (f.id === 'oversized-result') {
      const c = trace.toolCalls.find((x) => x.id === ((f.evidence && f.evidence.toolCallIds) || [])[0]);
      if (c && hasRange(c)) return 'The read already had a range and still returned a lot: grep for the part you need first, or read a narrower window.';
    }
    return ADVICE[f.id] || null;
  }

  function inputSummary(c) {
    const i = (c && c.input) || {};
    if (i.command) return String(i.command);
    if (i.file_path) return String(i.file_path) + (i.pattern ? ' ' + i.pattern : '');
    if (i.pattern) return String(i.pattern);
    if (i.query) return String(i.query);
    if (i.description) return String(i.description);
    if (i.url) return String(i.url);
    if (i.prompt) return String(i.prompt);
    if (i.path) return String(i.path);
    const s = JSON.stringify(i);
    return s === '{}' ? '' : s;
  }

  // ---------------------------------------------------------------------------
  // Markdown report — written to be handed back to the agent as well as read by a human.
  // opts: { redact, advice=true, instruction=true, maxEvidence=6, title }
  // ---------------------------------------------------------------------------
  function usd(v) { return v == null ? '—' : v < 0.01 ? '$' + v.toFixed(4) : v < 1 ? '$' + v.toFixed(3) : '$' + v.toFixed(2); }
  function pctStr(x) { return x == null ? '—' : Math.round(x * 100) + '%'; }
  function oneLine(s, n) { s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; }
  function blank(s) { return '«' + String(s == null ? '' : s).length + ' chars»'; }

  function toolTable(trace) {
    const rows = new Map();
    for (const c of trace.toolCalls) { if (c.unmatched) continue; if (!rows.has(c.name)) rows.set(c.name, { name: c.name, calls: 0, errors: 0, time: 0 }); const r = rows.get(c.name); r.calls++; if (c.isError) r.errors++; r.time += c.durationMs || 0; }
    return Array.from(rows.values()).sort((a, b) => b.time - a.time || b.calls - a.calls);
  }

  // Rules whose detail quotes tool output or model text (everything else is names and numbers).
  const CONTENT_DETAIL = new Set(['failed-tool', 'api-error', 'hook-error', 'duplicate-subagent-read']);
  function redactDetail(f) { return CONTENT_DETAIL.has(f.id) ? blank(f.detail) : f.detail; }

  // ---------------------------------------------------------------------------
  // Per-file use: how often each file was read or written, by how many agents, and how often
  // those calls failed. Paths are normalised (backslashes, case) but otherwise kept; the CLI's
  // legend replaces them with keys when sharing.
  // ---------------------------------------------------------------------------
  const FILE_READ = new Set(['Read']);
  const FILE_WRITE = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
  function filePathOf(c) { const i = c && c.input; if (!i) return null; const p = i.file_path || i.notebook_path; return typeof p === 'string' && p ? p : null; }
  function normalisePath(p) { return String(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase(); }
  function fileStats(trace, opts) {
    const minCalls = (opts && opts.minCalls) || 3, minAgents = (opts && opts.minAgents) || 2;
    const rows = new Map();
    for (const c of trace.toolCalls) {
      if (c.unmatched) continue;
      const isRead = FILE_READ.has(c.name), isWrite = FILE_WRITE.has(c.name);
      if (!isRead && !isWrite) continue;
      const p = filePathOf(c); if (!p) continue;
      const k = normalisePath(p);
      if (!rows.has(k)) rows.set(k, { path: p, reads: 0, writes: 0, errors: 0, chars: 0, agentSet: new Set(), tools: {} });
      const r = rows.get(k);
      if (isRead) { r.reads++; r.chars += c.resultChars || 0; } else r.writes++;
      if (c.isError) r.errors++;
      r.agentSet.add(c.agent);
      r.tools[c.name] = (r.tools[c.name] || 0) + 1;
    }
    const out = [];
    for (const r of rows.values()) {
      const calls = r.reads + r.writes;
      if (calls < minCalls && !r.errors && r.agentSet.size < minAgents) continue;
      out.push({ path: r.path, reads: r.reads, writes: r.writes, errors: r.errors, agents: r.agentSet.size, chars: r.chars, tools: r.tools });
    }
    out.sort((a, b) => (b.reads + b.writes) - (a.reads + a.writes) || b.errors - a.errors || a.path.localeCompare(b.path));
    return out;
  }

  function reportMarkdown(trace, findings, cost, opts) {
    opts = opts || {};
    const redact = !!opts.redact, maxEv = opts.maxEvidence || 6;
    const T = trace.totals, m = trace.meta, u = T.usage;
    const R = (s) => redact ? blank(s) : s;
    const total = cost ? (cost.reported != null ? cost.reported : cost.total) : null;
    const turnNo = (idx) => idx != null ? idx + 1 : null; // same numbering as the finding details and the viewer drawer
    const advised = new Set();
    const out = [];
    out.push(`# Glassbox report — ${oneLine(R(m.title || opts.title || 'session'), 90)}`, '');
    out.push(`- session: ${m.sessionId || '—'} · model: ${m.models.join(', ') || '—'}${m.start ? ' · started: ' + new Date(m.start).toISOString() : ''}`);
    out.push(`- wall ${fmtDur(T.wallMs)} (active ${fmtDur(T.activeMs)}) · ${T.turns} turn${T.turns === 1 ? '' : 's'} · ${T.requests} requests · ${T.toolCalls} tool calls (${T.toolErrors} failed${T.orphans ? ', ' + T.orphans + ' unanswered' : ''})`);
    out.push(`- tokens: ${fmtInt(u.input + u.cacheRead + u.cacheWrite)} context served (${pctStr(T.cacheHitRatio)} cached) · peak prompt ${fmtInt(Math.max(0, ...trace.requests.map((r) => r.contextTokens)))} · ${fmtInt(u.output)} output (${fmtInt(u.thinking)} thinking) · est. cost ${usd(total)}${cost && cost.source === 'reported' ? ' (reported)' : ''}`, '');
    if (!findings.length) out.push('## Findings', '', 'Nothing flagged — a clean session, or a very short one.', '');
    else {
      out.push(`## Findings (${findings.length})`, '');
      findings.forEach((f, i) => {
        out.push(`### ${i + 1}. ${f.severity.toUpperCase()} \`${f.id}\` — ${f.title}`, '', redact ? redactDetail(f) : f.detail, '');
        const ev = f.evidence || {};
        const lines = [];
        for (const id of ev.toolCallIds || []) { const c = trace.toolCalls.find((x) => x.id === id); if (!c) continue; const tn = turnNo(c.turnIndex); lines.push(`- ${c.name}${c.isError ? ' (error)' : ''}${c.durationMs != null ? ' · ' + fmtDur(c.durationMs) : ''}${tn != null ? ' · turn ' + tn : ''}${c.agent !== 'main' ? ' · subagent' : ''}: \`${oneLine(R(inputSummary(c)), 100).replace(/`/g, "'") || '(no input)'}\``); }
        for (const id of ev.requestIds || []) { const r = trace.requests.find((x) => x.id === id); if (!r) continue; const n = trace.requests.indexOf(r) + 1; const tn = turnNo(r.turnIndex); lines.push(`- request #${n}${tn != null ? ' · turn ' + tn : ''}: context ${fmtInt(r.contextTokens)} · output ${fmtInt(r.usage.output)}${r.responseMs != null ? ' · ' + fmtDur(r.responseMs) : ''}`); }
        if (lines.length) { out.push('Evidence:', ''); out.push(...lines.slice(0, maxEv)); if (lines.length > maxEv) out.push(`- … ${lines.length - maxEv} more`); out.push(''); }
        const adv = opts.advice !== false && !advised.has(f.id) ? adviceFor(f, trace) : null;
        if (adv) { advised.add(f.id); out.push(`Next time: ${adv}`, ''); }
      });
    }
    const tools = toolTable(trace);
    if (tools.length) { out.push('## Tools', '', '| tool | calls | errors | total time |', '|---|---|---|---|'); for (const r of tools) out.push(`| ${r.name} | ${r.calls} | ${r.errors} | ${fmtDur(r.time)} |`); out.push(''); }
    if (opts.instruction !== false) out.push('## What to do with this', '', 'This is a mechanical review of the session transcript, generated by Glassbox (no AI involved). If you are the agent that ran this session: acknowledge the findings that apply, say in one or two sentences what you will do differently next session, and do not redo any work. If you are a human: the evidence lines are permalinks into the Glassbox viewer for this session.', '');
    out.push('_Generated by Glassbox ' + VERSION + '._', '');
    return out.join('\n');
  }

  // ---------------------------------------------------------------------------
  // Compare two analysed sessions ({trace, findings, cost}).
  // ---------------------------------------------------------------------------
  const METRICS = [
    { key: 'wallMs', label: 'Wall time', fmt: 'dur', dir: 'low', get: (s) => s.trace.totals.wallMs },
    { key: 'activeMs', label: 'Active time', fmt: 'dur', dir: 'low', get: (s) => s.trace.totals.activeMs },
    { key: 'turns', label: 'Turns', fmt: 'int', dir: null, get: (s) => s.trace.totals.turns },
    { key: 'requests', label: 'API requests', fmt: 'int', dir: 'low', get: (s) => s.trace.totals.requests },
    { key: 'toolCalls', label: 'Tool calls', fmt: 'int', dir: 'low', get: (s) => s.trace.totals.toolCalls },
    { key: 'toolErrors', label: 'Tool errors', fmt: 'int', dir: 'low', get: (s) => s.trace.totals.toolErrors },
    { key: 'toolTimeMs', label: 'Time in tools', fmt: 'dur', dir: 'low', get: (s) => s.trace.meta.hasTimestamps ? s.trace.totals.toolTimeMs : null },
    { key: 'modelTimeMs', label: 'Time generating', fmt: 'dur', dir: 'low', get: (s) => s.trace.meta.hasTimestamps ? s.trace.totals.modelTimeMs : null },
    { key: 'contextServed', label: 'Context served', fmt: 'tok', dir: 'low', get: (s) => { const u = s.trace.totals.usage; const v = u.input + u.cacheRead + u.cacheWrite; return v || (s.trace.requests.length ? 0 : null); } },
    { key: 'peakContext', label: 'Peak prompt', fmt: 'tok', dir: 'low', get: (s) => s.trace.requests.length ? Math.max(0, ...s.trace.requests.map((r) => r.contextTokens)) : null },
    { key: 'cacheHitRatio', label: 'Cache hit', fmt: 'pct', dir: 'high', get: (s) => s.trace.totals.cacheHitRatio },
    { key: 'output', label: 'Output tokens', fmt: 'tok', dir: 'low', get: (s) => s.trace.requests.length ? s.trace.totals.usage.output : null },
    { key: 'thinkingShare', label: 'Thinking share', fmt: 'pct', dir: null, get: (s) => { const u = s.trace.totals.usage; return u.output ? u.thinking / u.output : null; } },
    { key: 'cost', label: 'Est. cost', fmt: 'usd', dir: 'low', get: (s) => s.cost ? (s.cost.reported != null ? s.cost.reported : s.cost.total) : null },
    { key: 'findings', label: 'Findings', fmt: 'int', dir: 'low', get: (s) => s.findings.length },
    { key: 'errorFindings', label: 'Error-level findings', fmt: 'int', dir: 'low', get: (s) => s.findings.filter((f) => f.severity === 'error').length },
  ];
  function fmtMetric(v, fmt) {
    if (v == null) return '—';
    if (fmt === 'dur') return fmtDur(v);
    if (fmt === 'pct') return pctStr(v);
    if (fmt === 'usd') return usd(v);
    return fmtInt(v);
  }
  // "×2.4" when B is bigger, "÷2.4" when smaller; never "×0.00".
  function fmtRatio(r) {
    if (r == null || !Number.isFinite(r)) return '—';
    if (r === 1) return '×1.00';
    const v = r >= 1 ? r : 1 / r; const t = v >= 100 ? Math.round(v).toString() : v >= 10 ? v.toFixed(1) : v.toFixed(2);
    return (r >= 1 ? '×' : '÷') + t;
  }
  // Change of B relative to A: a signed percentage where that reads well, ×N for big increases,
  // the absolute delta when A is 0 (no ratio) or B is 0 (no "÷∞").
  function fmtChange(m) {
    if (m.delta == null) return '—';
    const r = m.ratio;
    if (r == null || !m.a || !m.b) return (m.delta > 0 ? '+' : m.delta < 0 ? '−' : '') + fmtMetric(Math.abs(m.delta), m.fmt);
    if (r === 1) return '0%';
    if (r < 1) { const p = (1 - r) * 100; return '−' + (p < 10 || p > 99 ? p.toFixed(1) : Math.round(p)) + '%'; }
    if (r < 10) { const p = (r - 1) * 100; return '+' + (p < 10 ? p.toFixed(1) : Math.round(p)) + '%'; }
    return fmtRatio(r);
  }
  function compare(A, B) {
    const metrics = METRICS.map((d) => {
      const a = d.get(A), b = d.get(B);
      const ok = a != null && b != null && Number.isFinite(a) && Number.isFinite(b);
      const delta = ok ? b - a : null;
      const ratio = ok && a ? b / a : (ok && !a && !b ? 1 : null);
      let better = null;
      if (ok && d.dir && a !== b) better = (d.dir === 'low') === (a < b) ? 'a' : 'b';
      return { key: d.key, label: d.label, fmt: d.fmt, dir: d.dir, a, b, delta, ratio, better, aText: fmtMetric(a, d.fmt), bText: fmtMetric(b, d.fmt) };
    });
    const ta = toolTable(A.trace), tb = toolTable(B.trace);
    const names = new Set([...ta.map((t) => t.name), ...tb.map((t) => t.name)]);
    const zero = { calls: 0, errors: 0, time: 0 };
    const tools = Array.from(names).map((name) => { const a = ta.find((t) => t.name === name) || zero, b = tb.find((t) => t.name === name) || zero; return { name, a: { calls: a.calls, errors: a.errors, time: a.time }, b: { calls: b.calls, errors: b.errors, time: b.time }, deltaCalls: b.calls - a.calls, deltaTime: b.time - a.time }; });
    tools.sort((x, y) => Math.abs(y.deltaCalls) - Math.abs(x.deltaCalls) || (y.a.calls + y.b.calls) - (x.a.calls + x.b.calls) || x.name.localeCompare(y.name));
    const byId = (fs) => { const m = new Map(); for (const f of fs) { if (!m.has(f.id)) m.set(f.id, []); m.get(f.id).push(f); } return m; };
    const fa = byId(A.findings), fb = byId(B.findings);
    const slim = (f) => ({ id: f.id, severity: f.severity, title: f.title });
    const onlyA = [], onlyB = [], both = [];
    for (const [id, list] of fa) { if (fb.has(id)) both.push({ id, a: list.map(slim), b: fb.get(id).map(slim) }); else onlyA.push(...list.map(slim)); }
    for (const [id, list] of fb) if (!fa.has(id)) onlyB.push(...list.map(slim));
    const pick = (key) => { const m = metrics.find((x) => x.key === key); return m ? m.better : null; };
    const cleaner = (() => { const ea = A.findings.filter((f) => f.severity === 'error').length, eb = B.findings.filter((f) => f.severity === 'error').length; if (ea !== eb) return ea < eb ? 'a' : 'b'; const wa = A.findings.length, wb = B.findings.length; return wa === wb ? null : (wa < wb ? 'a' : 'b'); })();
    const verdict = { cheaper: pick('cost'), faster: pick('wallMs') || pick('activeMs'), cleaner };
    return { metrics, tools, findings: { onlyA, onlyB, both }, verdict, a: { sessionId: A.trace.meta.sessionId, title: A.trace.meta.title, models: A.trace.meta.models }, b: { sessionId: B.trace.meta.sessionId, title: B.trace.meta.title, models: B.trace.meta.models } };
  }
  function compareMarkdown(c, opts) {
    opts = opts || {};
    const la = opts.labelA || 'A', lb = opts.labelB || 'B';
    const out = [`# Glassbox compare — ${la} vs ${lb}`, ''];
    out.push(`- ${la}: ${c.a.sessionId || '—'}${c.a.title ? ' · ' + oneLine(c.a.title, 70) : ''}${c.a.models.length ? ' · ' + c.a.models.join(', ') : ''}`);
    out.push(`- ${lb}: ${c.b.sessionId || '—'}${c.b.title ? ' · ' + oneLine(c.b.title, 70) : ''}${c.b.models.length ? ' · ' + c.b.models.join(', ') : ''}`, '');
    const v = c.verdict; const who = (x) => x === 'a' ? la : x === 'b' ? lb : 'tie';
    out.push(`**Verdict** — cheaper: ${who(v.cheaper)} · faster: ${who(v.faster)} · cleaner: ${who(v.cleaner)}`, '');
    out.push(`| metric | ${la} | ${lb} | change |`, '|---|---|---|---|');
    for (const m of c.metrics) { const ch = fmtChange(m); out.push(`| ${m.label} | ${m.aText} | ${m.bText} | ${ch}${m.better ? ' (' + who(m.better) + ' better)' : ''} |`); }
    out.push('');
    if (c.tools.length) { out.push('## Tools', '', `| tool | ${la} calls (errors) | ${lb} calls (errors) | Δ calls |`, '|---|---|---|---|'); for (const t of c.tools) out.push(`| ${t.name} | ${t.a.calls} (${t.a.errors}) | ${t.b.calls} (${t.b.errors}) | ${t.deltaCalls > 0 ? '+' : ''}${t.deltaCalls} |`); out.push(''); }
    out.push('## Findings', '');
    if (!c.findings.onlyA.length && !c.findings.onlyB.length && !c.findings.both.length) out.push('Neither session was flagged.', '');
    if (c.findings.onlyA.length) { out.push(`Only in ${la}:`, ''); for (const f of c.findings.onlyA) out.push(`- **${f.severity.toUpperCase()}** \`${f.id}\` — ${f.title}`); out.push(''); }
    if (c.findings.onlyB.length) { out.push(`Only in ${lb}:`, ''); for (const f of c.findings.onlyB) out.push(`- **${f.severity.toUpperCase()}** \`${f.id}\` — ${f.title}`); out.push(''); }
    if (c.findings.both.length) { out.push('In both:', ''); for (const f of c.findings.both) out.push(`- \`${f.id}\` — ${la}: ${f.a.length}, ${lb}: ${f.b.length}`); out.push(''); }
    out.push('_Generated by Glassbox ' + VERSION + '._', '');
    return out.join('\n');
  }

  // ---------------------------------------------------------------------------
  // Redaction — keep structure, timestamps, usage, tool names; blank every string.
  // ---------------------------------------------------------------------------
  const KEEP_KEYS = new Set(['type', 'subtype', 'role', 'name', 'id', 'tool_use_id', 'uuid', 'parentUuid', 'requestId', 'sessionId', 'session_id', 'agentId', 'timestamp', 'model', 'stop_reason', 'version', 'entrypoint', 'operation', 'trigger', 'status', 'level', 'userType', 'apiBlockIndex', 'isSidechain', 'isMeta', 'isCompactSummary', 'isApiErrorMessage', 'is_error', 'effort', 'permissionMode', 'promptSource', 'sourceToolAssistantUUID', 'promptId', 'leafUuid', 'toolUseID', 'agentType', 'toolUseId', 'spawnDepth']);
  // Inside tool inputs and structured tool results every field is free-form, whatever it is called:
  // {"name": "Project Falcon"} is content, not structure. Only generated ids that link records survive there.
  const FREE_FORM_KEYS = new Set(['input', 'tool_input', 'toolUseResult']);
  const FREE_FORM_KEEP = new Set(['agentId', 'task_id', 'bash_id', 'tool_use_id', 'runId']);
  function redactValue(v, key, depth, freeForm) {
    if (v == null) return v;
    if (typeof v === 'string') {
      if ((freeForm ? FREE_FORM_KEEP : KEEP_KEYS).has(key)) return v;
      return '«' + v.length + ' chars»';
    }
    if (typeof v !== 'object') return v; // numbers, booleans (usage stays)
    if (Array.isArray(v)) return v.map((x) => redactValue(x, key, depth + 1, freeForm));
    const out = {};
    for (const k of Object.keys(v)) out[k] = redactValue(v[k], k, depth + 1, freeForm || FREE_FORM_KEYS.has(k));
    return out;
  }
  function redact(records) {
    return records.map((r) => {
      const c = redactValue(r, undefined, 0);
      delete c._line; delete c._file; delete c._seq;
      return c;
    });
  }
  function toJsonl(records) { return records.map((r) => JSON.stringify(r)).join('\n') + '\n'; }

  return { VERSION, RATES, DEFAULTS, ADVICE, METRICS, parseLines, parseTrace, diagnose, estimateCost, rateFor, redact, toJsonl, toolCategory, textOf, fmtDur, fmtInt, fmtMetric, fmtRatio, fmtChange, stableStringify, inputSummary, adviceFor, redactDetail, reportMarkdown, compare, compareMarkdown, toolTable, fileStats, filePathOf, normalisePath };
});
