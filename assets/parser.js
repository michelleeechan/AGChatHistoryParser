/* ============================================================
 * AGChatHistoryParser · 核心解析引擎（純前端、零依賴）
 * 支援格式：
 *   1. transcript.jsonl  — JSON Lines，逐行 JSON 物件
 *   2. overview.txt      — 純文字對話記錄（啟發式解析）
 * 能力：多檔案合併、依 step_index 排序、自動去重、容錯解析
 * ============================================================ */
(function (global) {
  'use strict';

  /* ---------- 常數 ---------- */
  const TRUNCATED_RE = /<truncated\s+\d+\s+bytes\s*>/i;

  // 環境雜訊區塊（使用者訊息中要完全過濾的內容）
  const NOISE_BLOCK_RES = [
    /<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/gi,
    /<USER_SETTINGS_CHANGE>[\s\S]*?<\/USER_SETTINGS_CHANGE>/gi,
    /<ENVIRONMENT_CONTEXT>[\s\S]*?<\/ENVIRONMENT_CONTEXT>/gi,
    /<ENVIRONMENT_DETAILS>[\s\S]*?<\/ENVIRONMENT_DETAILS>/gi,
    /<SYSTEM_CONTEXT>[\s\S]*?<\/SYSTEM_CONTEXT>/gi,
    /<GEMINI_SYSTEM_PROMPT>[\s\S]*?<\/GEMINI_SYSTEM_PROMPT>/gi,
    /<available_skills>[\s\S]*?<\/available_skills>/gi
  ];

  /* ============================================================
   * 一、使用者文字清洗
   * ============================================================ */
  function extractUserText(content) {
    if (content == null) return '';
    const text = String(content);

    // 規則 1：優先擷取 <USER_REQUEST>...</USER_REQUEST> 內容
    const m = text.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/i);
    if (m) return m[1].trim();

    // 規則 2：找不到標籤 → 剔除已知雜訊區塊後保留其餘原文
    let cleaned = text;
    for (const re of NOISE_BLOCK_RES) cleaned = cleaned.replace(re, '');
    cleaned = cleaned.trim();
    return cleaned || text.trim();
  }

  /* ============================================================
   * 二、JSONL 解析
   * ============================================================ */
  function normalizeToolCalls(list) {
    if (!Array.isArray(list)) return [];
    return list.map(function (tc, idx) {
      tc = (tc && typeof tc === 'object') ? tc : { name: 'unknown_tool' };
      const name = tc.name || tc.tool || tc.tool_name ||
        (tc.function && tc.function.name) || tc.action || ('tool_' + (idx + 1));
      let args = tc.arguments;
      if (args === undefined) args = tc.args;
      if (args === undefined) args = tc.input;
      if (args === undefined) args = tc.parameters;
      if (args === undefined && tc.function) args = tc.function.arguments;
      if (args === undefined) args = tc.params;
      if (typeof args === 'string') {
        try { args = JSON.parse(args); } catch (e) { /* 保留字串 */ }
      }
      let result = tc.result;
      if (result === undefined) result = tc.response;
      if (result === undefined) result = tc.output;
      if (result === undefined) result = tc.status;
      return { name: String(name), args: (args === undefined ? null : args), result: (result === undefined ? null : result) };
    });
  }

  function normalizeEntry(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const source = String(raw.source || '');
    const type = String(raw.type || '');
    const stepNum = parseInt(raw.step_index, 10);
    const step = Number.isNaN(stepNum) ? null : stepNum;
    const createdAt = raw.created_at || raw.timestamp || raw.time || null;
    const toolCalls = normalizeToolCalls(raw.tool_calls);
    const content = typeof raw.content === 'string' ? raw.content : '';

    // 使用者發言
    if (source === 'USER_EXPLICIT' && type === 'USER_INPUT') {
      const text = extractUserText(content);
      if (!text && toolCalls.length === 0) return null;
      return { kind: 'user', step: step, time: createdAt, text: text, toolCalls: toolCalls, type: type, source: source };
    }

    // AI 回覆（Planner）
    if (source === 'MODEL' && type === 'PLANNER_RESPONSE') {
      if (!content.trim() && toolCalls.length === 0) return null;
      return { kind: 'ai', step: step, time: createdAt, text: content, toolCalls: toolCalls, type: type, source: source };
    }

    // 其他類型（VIEW_FILE / CODE_ACTION / RUN_COMMAND 等）→ 工具卡片
    if (toolCalls.length > 0) {
      return { kind: 'tool', step: step, time: createdAt, text: content.trim(), toolCalls: toolCalls, type: type, source: source };
    }

    // MODEL 其他類型但有實質內容 → 仍視為 AI 訊息
    if (source === 'MODEL' && content.trim()) {
      return { kind: 'ai', step: step, time: createdAt, text: content, toolCalls: [], type: type, source: source };
    }

    return null; // 無可顯示內容
  }

  function parseJSONL(text) {
    const lines = String(text).split(/\r?\n/);
    const entries = [];
    const errors = [];
    let truncatedLines = 0;

    for (let i = 0; i < lines.length; i++) {
      const lineNo = i + 1;
      const line = lines[i].trim();
      if (!line) continue;

      // 含 <truncated N bytes> 的行 → 溫和跳過
      if (TRUNCATED_RE.test(line)) { truncatedLines++; continue; }

      let obj;
      try {
        obj = JSON.parse(line);
      } catch (e) {
        errors.push({ line: lineNo, reason: 'JSON 解析失敗', excerpt: line.slice(0, 100) });
        continue;
      }
      if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
        errors.push({ line: lineNo, reason: '不是 JSON 物件', excerpt: line.slice(0, 100) });
        continue;
      }
      const entry = normalizeEntry(obj);
      if (entry) entries.push(entry);
    }
    return { entries: entries, errors: errors, truncatedLines: truncatedLines };
  }

  /* ============================================================
   * 三、TXT 啟發式解析（overview.txt）
   * ============================================================ */
  const TXT_USER_RE = /^\s*(?:\[\s*(?:Step\s*)?(\d+)\s*\]\s*)?(?:\*\*)?(User|使用者|用戶|You)(?:\*\*)?(?:\s*\([^)]{0,60}\))?\s*[:：]\s*/i;
  const TXT_AI_RE = /^\s*(?:\[\s*(?:Step\s*)?(\d+)\s*\]\s*)?(?:\*\*)?(Antigravity(?:\s*Agent)?|Agent|Assistant|Model|AI|Gemini)(?:\*\*)?(?:\s*\([^)]{0,60}\))?\s*[:：]\s*/i;
  const TXT_STEP_RE = /^\s*(?:\[\s*(?:Step\s*)?(\d+)\s*\]|Step\s*(\d+)\s*[:：]|\[(\d+)\])\s*/i;
  const TXT_TIME_RE = /(\d{4}-\d{1,2}-\d{1,2}[T ]\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?\s*(?:Z|UTC|[+-]\d{2}:?\d{2})?)/;

  function extractTxtTime(line) {
    const m = String(line).match(TXT_TIME_RE);
    return m ? m[1] : null;
  }

  function parseTXT(text) {
    const lines = String(text).split(/\r?\n/);
    const entries = [];
    const warnings = [];
    let current = null;   // { kind, step, time, lines: [] }
    let speakerFound = 0;
    let pendingStep = null;
    const preamble = [];

    function flush() {
      if (!current) return;
      const text = current.lines.join('\n').trim();
      if (text) {
        entries.push({
          kind: current.kind, step: current.step, time: current.time,
          text: text, toolCalls: [], type: 'TXT_' + current.kind.toUpperCase(), source: 'TXT'
        });
      }
      current = null;
    }

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      const um = line.match(TXT_USER_RE);
      const am = line.match(TXT_AI_RE);

      if (um) {
        flush();
        speakerFound++;
        current = { kind: 'user', step: um[1] ? parseInt(um[1], 10) : pendingStep, time: extractTxtTime(line), lines: [] };
        pendingStep = null;
        current.lines.push(line.slice(um[0].length));
        continue;
      }
      if (am) {
        flush();
        speakerFound++;
        current = { kind: 'ai', step: am[1] ? parseInt(am[1], 10) : pendingStep, time: extractTxtTime(line), lines: [] };
        pendingStep = null;
        current.lines.push(line.slice(am[0].length));
        continue;
      }

      if (!current) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        // 獨立 Step 標記行 → 記住編號，套用到下一則訊息
        const sm = line.match(TXT_STEP_RE);
        if (sm) {
          const n = parseInt(sm[1] || sm[2] || sm[3], 10);
          if (!Number.isNaN(n)) { pendingStep = n; continue; }
        }
        // 第一位說話者出現前的內容 → 視為文件前導說明
        if (speakerFound === 0) { preamble.push(trimmed); }
        // 其餘孤行（分隔線等）靜默略過
        continue;
      }

      // 區塊延續行
      current.lines.push(line);
    }
    flush();

    // 前導說明 → 文件卡（置頂）
    if (entries.length > 0 && preamble.length) {
      entries.unshift({
        kind: 'doc', step: null, time: null,
        text: preamble.join('\n'),
        toolCalls: [], type: 'TXT_PREAMBLE', source: 'TXT'
      });
    }

    // 完全沒有可辨識結構 → 整份文件視為單一文件卡
    if (entries.length === 0 && text.trim()) {
      warnings.push('未偵測到「說話者：」格式，已以純文字文件模式顯示整份檔案。');
      entries.push({
        kind: 'doc', step: null, time: null,
        text: text.replace(/\n{3,}/g, '\n\n').trim(),
        toolCalls: [], type: 'TXT_DOCUMENT', source: 'TXT'
      });
    }
    return { entries: entries, warnings: warnings, mode: speakerFound > 0 ? 'structured' : 'document' };
  }

  /* ============================================================
   * 四、格式嗅探 + 多檔案合併
   * ============================================================ */
  function looksLikeJSONL(text) {
    const lines = String(text).split(/\r?\n/);
    let checked = 0, weak = 0, strong = 0;
    for (const line of lines) {
      const t = line.trim();
      if (!t) continue;
      checked++;
      try {
        const o = JSON.parse(t);
        if (o && typeof o === 'object' && !Array.isArray(o)) {
          weak++;
          // 具備 Antigravity 欄位特徵 → 強訊號
          if (o.source || o.type || o.step_index != null || o.tool_calls) strong++;
        }
      } catch (e) { /* 忽略 */ }
      if (checked >= 5) break;
    }
    if (checked === 0) return false;
    if (strong > 0) return true;
    return weak / checked >= 0.5;
  }

  function parseInput(fileName, content) {
    const isJsonl = looksLikeJSONL(content) || /\.jsonl$/i.test(fileName);
    if (isJsonl) {
      const r = parseJSONL(content);
      // JSONL 完全解析失敗 → 退回 TXT 模式
      if (r.entries.length === 0 && content.trim()) {
        const t = parseTXT(content);
        if (t.entries.length > 0) {
          return { format: 'txt', entries: t.entries, errors: r.errors, truncatedLines: r.truncatedLines, warnings: t.warnings };
        }
        return { format: 'jsonl', entries: [], errors: r.errors, truncatedLines: r.truncatedLines, warnings: ['此檔案沒有可顯示的對話內容。'] };
      }
      return { format: 'jsonl', entries: r.entries, errors: r.errors, truncatedLines: r.truncatedLines, warnings: [] };
    }
    const t = parseTXT(content);
    return { format: 'txt', entries: t.entries, errors: [], truncatedLines: 0, warnings: t.warnings };
  }

  function dedupeKey(entry) {
    const base = (entry.text || '').replace(/\s+/g, ' ').trim().slice(0, 120);
    const tools = (entry.toolCalls || []).map(function (tc) {
      let args = '';
      try { args = JSON.stringify(tc.args || {}); } catch (e) { args = ''; }
      return tc.name + args.slice(0, 80);
    }).join('|');
    return (entry.step == null ? '-' : entry.step) + '|' + entry.kind + '|' + base + '|' + tools;
  }

  /**
   * 合併多個檔案的解析結果：
   * 1. 串接所有 entries（保留來源檔名）
   * 2. 去除重複（相同 step + 類型 + 內容前綴）
   * 3. 依 step_index 排序；無 step 者以內插位置保持相對順序
   */
  function mergeResults(results) {
    const merged = [];
    const seen = new Map();
    let duplicates = 0;
    let lastStep = 0;
    let gapOffset = 0;

    for (const res of results) {
      for (const entry of res.entries) {
        entry.sourceFile = res.fileName;
        const key = dedupeKey(entry);
        if ((entry.text && entry.text.trim()) || (entry.toolCalls && entry.toolCalls.length)) {
          if (seen.has(key)) { duplicates++; continue; }
          seen.set(key, true);
        }
        // 計算排序鍵
        if (entry.step != null) {
          entry._sortKey = entry.step;
          lastStep = entry.step;
          gapOffset = 0;
        } else {
          gapOffset++;
          entry._sortKey = lastStep + 0.5 + gapOffset * 0.001;
        }
        merged.push(entry);
      }
    }
    merged.sort(function (a, b) { return a._sortKey - b._sortKey; });
    return { entries: merged, duplicates: duplicates };
  }

  function parseFiles(fileItems) {
    // fileItems: [{ name, content }]
    const results = [];
    for (const item of fileItems) {
      const r = parseInput(item.name, item.content);
      r.fileName = item.name;
      results.push(r);
    }
    const merged = mergeResults(results);
    return { files: results, entries: merged.entries, duplicates: merged.duplicates };
  }

  /* ============================================================
   * 五、時間格式化
   * ============================================================ */
  function formatTimestamp(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso);
    const p = function (n) { return String(n).padStart(2, '0'); };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
      ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }

  /* ============================================================
   * 六、Markdown 匯出
   * ============================================================ */
  function exportMarkdown(entries, meta) {
    meta = meta || {};
    const out = [];
    const userCount = entries.filter(function (e) { return e.kind === 'user'; }).length;
    const aiCount = entries.filter(function (e) { return e.kind === 'ai'; }).length;
    const toolCount = entries.reduce(function (s, e) { return s + (e.toolCalls ? e.toolCalls.length : 0); }, 0);
    const docCount = entries.filter(function (e) { return e.kind === 'doc'; }).length;

    out.push('# Antigravity 對話逐字稿');
    out.push('');
    out.push('> **來源檔案：** ' + (meta.fileNames && meta.fileNames.length ? meta.fileNames.join('、') : 'transcript.jsonl'));
    out.push('> **匯出時間：** ' + formatTimestamp(new Date().toISOString()));
    out.push('> **訊息統計：** 共 ' + entries.length + ' 條（👤 User ' + userCount + ' 則 · 🤖 Antigravity ' + aiCount + ' 則 · 🔧 工具調用 ' + toolCount + ' 次' + (docCount ? ' · 📄 文件 ' + docCount + ' 份' : '') + '）');

    const times = entries.map(function (e) { return e.time ? new Date(e.time).getTime() : NaN; }).filter(function (t) { return !isNaN(t); });
    if (times.length >= 2) {
      out.push('> **時間範圍：** ' + formatTimestamp(new Date(Math.min.apply(null, times)).toISOString()) + ' ～ ' + formatTimestamp(new Date(Math.max.apply(null, times)).toISOString()));
    }
    out.push('');
    out.push('---');

    for (const e of entries) {
      const label = e.kind === 'user' ? '👤 User' : e.kind === 'ai' ? '🤖 Antigravity Agent' : e.kind === 'doc' ? '📄 附加文件' : '🔧 工具執行';
      const stepTxt = e.step != null ? ' · Step #' + e.step : '';
      out.push('');
      out.push('## ' + label + stepTxt);
      if (e.time) { out.push(''); out.push('**時間：** ' + formatTimestamp(e.time)); }
      if (e.sourceFile) { out.push(''); out.push('> 來源：`' + e.sourceFile + '`'); }
      if (e.text) {
        out.push('');
        out.push(e.kind === 'user' ? e.text : e.text.trim());
      }
      if (e.toolCalls && e.toolCalls.length) {
        out.push('');
        out.push('### 🔧 工具調用（' + e.toolCalls.length + '）');
        e.toolCalls.forEach(function (tc, i) {
          out.push('');
          out.push('#### ' + (i + 1) + '. `' + tc.name + '`');
          if (tc.args != null) {
            const argsStr = typeof tc.args === 'string' ? tc.args : JSON.stringify(tc.args, null, 2);
            out.push('');
            out.push('```json');
            out.push(argsStr);
            out.push('```');
          }
          if (tc.result != null) {
            const resStr = typeof tc.result === 'string' ? tc.result : JSON.stringify(tc.result, null, 2);
            out.push('');
            out.push('**執行結果：**');
            out.push('');
            out.push('```');
            out.push(resStr.length > 2000 ? resStr.slice(0, 2000) + '\n...（內容過長已截斷）' : resStr);
            out.push('```');
          }
        });
      }
      out.push('');
      out.push('---');
    }
    return out.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\n---\n\n---/g, '\n---') + '\n';
  }

  /* ---------- 匯出 API ---------- */
  global.AGParser = {
    extractUserText: extractUserText,
    parseJSONL: parseJSONL,
    parseTXT: parseTXT,
    parseInput: parseInput,
    parseFiles: parseFiles,
    mergeResults: mergeResults,
    normalizeEntry: normalizeEntry,
    formatTimestamp: formatTimestamp,
    exportMarkdown: exportMarkdown
  };
})(typeof window !== 'undefined' ? window : globalThis);
