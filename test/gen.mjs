// Synthetic Claude Code transcript builder for tests.
// Produces the real on-disk shape: assistant messages split one record per block,
// usage repeated on each record, tool results as user records.
let counter = 0;
const uid = (p) => `${p}_${(++counter).toString(36).padStart(6, '0')}`;

export function session(opts = {}) {
  const sessionId = opts.sessionId || uid('sess');
  const agentId = opts.agentId || null;
  let t = opts.start || Date.parse('2026-09-05T10:00:00.000Z');
  const model = opts.model || 'claude-sonnet-4-5-20250929';
  const records = [];
  let parent = null;
  let context = opts.context || 20000;

  const base = (extra) => {
    const r = Object.assign({ parentUuid: parent, isSidechain: !!agentId, userType: 'external', cwd: opts.cwd || '/work', sessionId, version: '2.1.261', gitBranch: 'main', uuid: uid('u'), timestamp: new Date(t).toISOString() }, extra);
    if (agentId) r.agentId = agentId;
    parent = r.uuid;
    records.push(r);
    return r;
  };

  const api = {
    records, sessionId,
    at(ms) { t = ms; return api; },
    advance(ms) { t += ms; return api; },
    user(text, extra = {}) { base(Object.assign({ type: 'user', message: { role: 'user', content: text } }, extra)); return api; },
    meta(text) { return api.user(text, { isMeta: true }); },
    compactSummary(text) { return api.user(text, { isCompactSummary: true }); },
    compactBoundary(preTokens) { base({ type: 'system', subtype: 'compact_boundary', compactMetadata: { trigger: 'auto', preTokens }, content: 'Conversation compacted', level: 'info' }); context = 15000; return api; },
    hookErrors(errs) { base({ type: 'system', subtype: 'stop_hook_summary', hookErrors: errs, hookCount: 1, level: 'suggestion' }); return api; },
    summary(s) { records.push({ type: 'summary', summary: s, leafUuid: parent }); return api; },
    raw(extra) { records.push(Object.assign({ timestamp: new Date(t).toISOString(), sessionId }, extra)); return api; },
    junk() { records.push({ type: 'queue-operation', operation: 'enqueue', timestamp: new Date(t).toISOString(), sessionId, content: 'x' }); records.push({ type: 'attachment', attachment: { type: 'total_tokens_reminder', text: '<total_tokens>1</total_tokens>' }, timestamp: new Date(t).toISOString(), uuid: uid('u'), parentUuid: parent }); return api; },
    // blocks: [{thinking}|{text}|{tool:'Bash', input:{...}, id?}], returns tool ids
    assistant(blocks, u = {}) {
      const requestId = uid('req');
      const msgId = uid('msg');
      const output = u.output != null ? u.output : 200;
      const usage = {
        input_tokens: u.input != null ? u.input : 3,
        cache_creation_input_tokens: u.cacheWrite != null ? u.cacheWrite : 500,
        cache_read_input_tokens: u.cacheRead != null ? u.cacheRead : context,
        output_tokens: output,
        output_tokens_details: { thinking_tokens: u.thinking || 0 },
        cache_creation: { ephemeral_5m_input_tokens: u.w5m != null ? u.w5m : 0, ephemeral_1h_input_tokens: u.w1h != null ? u.w1h : (u.cacheWrite != null ? u.cacheWrite : 500) },
      };
      context = usage.input_tokens + usage.cache_creation_input_tokens + usage.cache_read_input_tokens + output;
      const stop = u.stopReason || (blocks.some((b) => b.tool) ? 'tool_use' : 'end_turn');
      const ids = [];
      blocks.forEach((b, i) => {
        let block;
        if (b.thinking !== undefined) block = { type: 'thinking', thinking: b.thinking, signature: 'sig' };
        else if (b.text !== undefined) block = { type: 'text', text: b.text };
        else { const id = b.id || uid('toolu'); ids.push(id); block = { type: 'tool_use', id, name: b.tool, input: b.input || {} }; }
        // u.outputs: per-block output_tokens, as subagent transcripts write them while the response streams
        const blockUsage = u.outputs ? Object.assign({}, usage, { output_tokens: u.outputs[i] }) : usage;
        base({ type: 'assistant', requestId, apiBlockIndex: i, isApiErrorMessage: !!u.apiError, message: { id: msgId, model: u.model || model, role: 'assistant', type: 'message', stop_reason: stop, usage: blockUsage, content: [block] } });
        t += b.ms != null ? b.ms : 400;
      });
      return ids;
    },
    result(toolId, content, extra = {}) {
      const isErr = !!extra.error;
      base({ type: 'user', message: { role: 'user', content: [{ tool_use_id: toolId, type: 'tool_result', content: typeof content === 'string' ? content : JSON.stringify(content), is_error: isErr || undefined }] }, toolUseResult: extra.structured !== undefined ? extra.structured : (isErr ? 'Error: ' + content : { stdout: content }) });
      return api;
    },
    // convenience: one tool call + result, advancing time
    call(tool, input, out = 'ok', o = {}) {
      const [id] = api.assistant([{ tool, input, ms: 300 }], o.usage);
      api.advance(o.ms != null ? o.ms : 500);
      api.result(id, out, { error: o.error });
      return id;
    },
    text() { return records.map((r) => JSON.stringify(r)).join('\n') + '\n'; },
  };
  return api;
}

export function file(name, s) { return { name, text: s.text ? s.text() : s }; }
