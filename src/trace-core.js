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

  const VERSION = '0.3.0';

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
  };

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------
  const READ_TOOLS = new Set(['Read', 'Glob', 'Grep', 'LS', 'WebFetch', 'WebSearch', 'ToolSearch', 'TaskGet', 'TaskList', 'ListSkills', 'ReadNotifications']);
  const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
  const EXEC_TOOLS = new Set(['Bash', 'BashOutput', 'KillShell']);
  const AGENT_TOOLS = new Set(['Agent', 'Task', 'Workflow']);
  const USER_TOOLS = new Set(['AskUserQuestion']);

  function toolCategory(name) {
    if (!name) return 'other';
    if (READ_TOOLS.has(name)) return 'read';
    if (WRITE_TOOLS.has(name)) return 'write';
    if (EXEC_TOOLS.has(name) || /device_bash$/.test(name)) return 'exec';
    if (AGENT_TOOLS.has(name)) return 'agent';
    if (USER_TOOLS.has(name)) return 'user';
    if (name.startsWith('mcp__')) {
      const leaf = name.split('__').pop() || '';
      if (/^(get|list|search|read|find|fetch|query|describe|show)/i.test(leaf)) return 'read';
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
      reportedCost: null, reportedUsage: null, recordCounts: {},
    };

    const agents = new Map(); // id -> agent
    function agentFor(rec) {
      const id = rec.agentId || (rec.isSidechain ? 'sidechain' : 'main');
      if (!agents.has(id)) {
        agents.set(id, {
          id, type: id === 'main' ? 'main' : 'subagent', description: null, parentToolUseId: null,
          start: null, end: null, usage: emptyUsage(), requestCount: 0, toolCount: 0, model: null,
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
      if (t != null) { if (meta.start == null || t < meta.start) meta.start = t; if (meta.end == null || t > meta.end) meta.end = t; }

      if (type === 'summary') { if (rec.summary && !meta.title) meta.title = rec.summary; events.push({ kind: 'summary', at: t, detail: rec.summary }); continue; }
      if (type === 'attachment') { attachments.count++; attachments.chars += JSON.stringify(rec.attachment || '').length; continue; }
      if (type === 'result') {
        meta.format = 'stream-json';
        if (typeof rec.total_cost_usd === 'number') meta.reportedCost = rec.total_cost_usd;
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
          const u = usageFrom(msg.usage);
          if (!isEmptyUsage(u)) { req.usage = u; req.contextTokens = u.input + u.cacheRead + u.cacheWrite; addUsage(turn.usage, u); addUsage(a.usage, u); }
        } else {
          if (t != null) { if (req.start == null || t < req.start) req.start = t; if (req.end == null || t > req.end) req.end = t; }
          // usage: if the first record lacked it and a later one has it, take it once
          if (isEmptyUsage(req.usage)) {
            const u = usageFrom(msg.usage);
            if (!isEmptyUsage(u)) { req.usage = u; req.contextTokens = u.input + u.cacheRead + u.cacheWrite; const turn = turns[req.turnIndex]; addUsage(turn.usage, u); addUsage(a.usage, u); }
          }
        }
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
              inputChars: JSON.stringify(b.input || {}).length, resultImages: 0, imageBytes: 0,
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
    for (const req of requests) req.blocks.sort((x, y) => x.index - y.index);
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
      if (ag.parentToolUseId) {
        const parent = toolCallById.get(ag.parentToolUseId);
        if (parent) { parent.subagentId = ag.id; if (!ag.description && parent.input && parent.input.description) ag.description = parent.input.description; if (!ag.agentType && parent.input && parent.input.subagent_type) ag.agentType = parent.input.subagent_type; }
      }
    }

    // Totals
    const usage = emptyUsage();
    for (const r of requests) addUsage(usage, r.usage);
    const humanIdleMs = turns.reduce((s, tn) => s + (tn.idleBeforeMs || 0), 0);
    const wallMs = (meta.start != null && meta.end != null) ? meta.end - meta.start : null;
    const totals = {
      usage, wallMs, humanIdleMs, activeMs: wallMs != null ? Math.max(0, wallMs - humanIdleMs) : null,
      requests: requests.length, toolCalls: toolCalls.length, toolErrors: toolCalls.filter((c) => c.isError).length,
      orphans: toolCalls.filter((c) => c.status === 'orphan').length,
      turns: turns.filter((tn) => tn.promptKind === 'human' && tn.agent === 'main').length,
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
    for (const group of byTurnSig.values()) {
      if (group.length >= o.retryLoopMin) {
        const errs = group.filter((c) => c.isError).length;
        push({
          id: 'retry-loop', severity: errs >= 2 ? 'error' : 'warn',
          title: `${group[0].name} called ${group.length}× with identical input`,
          detail: errs ? `${errs} of them failed — the agent kept retrying the same call.` : 'Same call repeated in one turn; the result was probably already in context.',
          evidence: { toolCallIds: group.map((c) => c.id), turnIndex: group[0].turnIndex }, metric: group.length,
        });
      }
    }

    // failed-tool: per tool error rate
    const byTool = new Map();
    for (const c of calls) { if (c.unmatched) continue; if (!byTool.has(c.name)) byTool.set(c.name, []); byTool.get(c.name).push(c); }
    for (const [name, list] of byTool) {
      const errs = list.filter((c) => c.isError);
      if (!errs.length) continue;
      const rate = errs.length / list.length;
      const bad = list.length >= o.failedToolMinCalls && rate >= o.failedToolRate;
      push({
        id: 'failed-tool', severity: bad ? 'error' : 'warn',
        title: `${name} failed ${errs.length} of ${list.length} calls (${Math.round(rate * 100)}%)`,
        detail: firstLine(errs[0].resultText) || 'Tool returned is_error.',
        evidence: { toolCallIds: errs.map((c) => c.id) }, metric: rate,
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
        if (c.category === 'read') run.push(c); else if (c.category === 'write' || c.category === 'exec') flush(); // agent/user/mcp calls don't break a run
      }
      flush();
    }

    // oversized-result
    for (const c of calls) {
      if (c.resultChars >= o.oversizedResultWarn) push({
        id: 'oversized-result', severity: c.resultChars >= o.oversizedResultError ? 'error' : 'warn',
        title: `${c.name} returned ${fmtInt(c.resultChars)} chars`,
        detail: 'Large tool results stay in context for the rest of the session. Consider head/limit, grep, or a subagent.',
        evidence: { toolCallIds: [c.id], turnIndex: c.turnIndex }, metric: c.resultChars,
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
    if (crossed) push({
      id: 'context-bloat', severity: peak.contextTokens >= o.contextBloatError ? 'error' : 'warn',
      title: `Context reached ${fmtInt(peak.contextTokens)} tokens`,
      detail: `First crossed ${fmtInt(o.contextBloatWarn)} at request #${reqs.indexOf(crossed) + 1} (turn ${crossed.turnIndex + 1}). Every later request pays for that prefix.`,
      evidence: { requestIds: [crossed.id, peak.id], turnIndex: crossed.turnIndex }, metric: peak.contextTokens,
    });

    // cache-churn
    const firstReqOfAgent = new Set();
    for (const r of reqs) {
      if (!firstReqOfAgent.has(r.agent)) { firstReqOfAgent.add(r.agent); continue; }
      if (r.usage.cacheWrite >= o.cacheChurnMin) push({
        id: 'cache-churn', severity: 'info', title: `${fmtInt(r.usage.cacheWrite)} tokens re-cached at request #${reqs.indexOf(r) + 1}`,
        detail: 'A large cache write mid-session means the cached prefix was invalidated (system prompt, tool list or early messages changed).',
        evidence: { requestIds: [r.id], turnIndex: r.turnIndex }, metric: r.usage.cacheWrite,
      });
    }

    // low-cache-hit
    if (reqs.length >= o.lowCacheHitMinRequests && trace.totals.cacheHitRatio != null && trace.totals.cacheHitRatio < o.lowCacheHitRatio) push({
      id: 'low-cache-hit', severity: 'info', title: `Cache hit ratio ${Math.round(trace.totals.cacheHitRatio * 100)}%`,
      detail: 'Less than half of input tokens were served from cache. Cached reads cost ~10% of uncached input.',
      evidence: {}, metric: trace.totals.cacheHitRatio,
    });

    // slow-tool
    for (const c of calls) {
      if (c.durationMs != null && c.durationMs >= o.slowToolInfoMs) push({
        id: 'slow-tool', severity: c.durationMs >= o.slowToolWarnMs ? 'warn' : 'info',
        title: `${c.name} took ${fmtDur(c.durationMs)}`, detail: c.category === 'agent' ? 'Subagent run time.' : c.category === 'user' ? 'Waiting on the human.' : 'Long-running tool call.',
        evidence: { toolCallIds: [c.id], turnIndex: c.turnIndex }, metric: c.durationMs,
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
        else push({
          id: 'long-generation', severity: 'info', title: `${fmtDur(r.responseMs)} writing ${fmtInt(r.usage.output)} tokens`,
          detail: `Request #${n} at ${r.tokensPerSec != null ? r.tokensPerSec.toFixed(1) : '?'} tok/s (${r.blocksSummary}). Big single outputs are normal for file writes; a stall would show as low tok/s.`,
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

    // long-turn
    for (const tn of trace.turns) if (tn.toolCallIds.length >= o.longTurnTools) push({
      id: 'long-turn', severity: 'info', title: `Turn ${tn.index + 1} made ${tn.toolCallIds.length} tool calls`,
      detail: 'A very long autonomous stretch. Worth a skim for wasted work.', evidence: { turnIndex: tn.index, toolCallIds: tn.toolCallIds.slice() }, metric: tn.toolCallIds.length,
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
  // Redaction — keep structure, timestamps, usage, tool names; blank every string.
  // ---------------------------------------------------------------------------
  const KEEP_KEYS = new Set(['type', 'subtype', 'role', 'name', 'id', 'tool_use_id', 'uuid', 'parentUuid', 'requestId', 'sessionId', 'session_id', 'agentId', 'timestamp', 'model', 'stop_reason', 'version', 'entrypoint', 'operation', 'trigger', 'status', 'level', 'userType', 'apiBlockIndex', 'isSidechain', 'isMeta', 'isCompactSummary', 'isApiErrorMessage', 'is_error', 'effort', 'permissionMode', 'promptSource', 'sourceToolAssistantUUID', 'promptId', 'leafUuid', 'toolUseID', 'agentType', 'toolUseId', 'spawnDepth']);
  function redactValue(v, key, depth) {
    if (v == null) return v;
    if (typeof v === 'string') {
      if (KEEP_KEYS.has(key)) return v;
      return '«' + v.length + ' chars»';
    }
    if (typeof v !== 'object') return v; // numbers, booleans (usage stays)
    if (Array.isArray(v)) return v.map((x) => redactValue(x, key, depth + 1));
    const out = {};
    for (const k of Object.keys(v)) {
      if (k === 'input' && key === undefined) { out[k] = redactValue(v[k], k, depth + 1); continue; }
      out[k] = redactValue(v[k], k, depth + 1);
    }
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

  return { VERSION, RATES, DEFAULTS, parseLines, parseTrace, diagnose, estimateCost, rateFor, redact, toJsonl, toolCategory, textOf, fmtDur, fmtInt, stableStringify };
});
