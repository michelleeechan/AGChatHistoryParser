/* ============================================================
 * AGChatHistoryParser · UI 主邏輯
 * 依賴：parser.js, marked, DOMPurify, highlight.js, lucide
 * ============================================================ */
(function () {
  'use strict';

  /* ---------- 全域狀態 ---------- */
  const state = {
    entries: [],
    files: [],          // [{fileName, format, entries:N, errors:M, truncatedLines, warnings}]
    duplicates: 0,
    fileNameLabel: '',
    filter: 'all',      // all | user | ai
    query: '',
    loaded: false,
    isDark: false
  };

  const $ = function (sel) { return document.querySelector(sel); };
  const $$ = function (sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); };

  const els = {};

  /* ---------- Markdown 渲染管線 ---------- */
  function markdownToHtml(text) {
    try {
      const raw = marked.parse(text || '');
      return DOMPurify.sanitize(raw, { ADD_ATTR: ['target'] });
    } catch (e) {
      const div = document.createElement('div');
      div.textContent = text || '';
      return '<p>' + div.innerHTML + '</p>';
    }
  }

  function enhanceCodeBlocks(container) {
    container.querySelectorAll('pre > code').forEach(function (code) {
      if (code.dataset.enhanced) return;
      code.dataset.enhanced = '1';
      const pre = code.parentElement;
      const wrapper = document.createElement('div');
      wrapper.className = 'code-block';
      const bar = document.createElement('div');
      bar.className = 'code-bar';
      const langMatch = (code.className || '').match(/language-([\w+-]+)/);
      const lang = document.createElement('span');
      lang.className = 'code-lang';
      lang.textContent = langMatch ? langMatch[1] : 'text';
      const btn = document.createElement('button');
      btn.className = 'copy-btn';
      btn.type = 'button';
      btn.innerHTML = '<i data-lucide="copy"></i><span>複製</span>';
      btn.addEventListener('click', function () {
        navigator.clipboard.writeText(code.textContent).then(function () {
          btn.innerHTML = '<i data-lucide="check"></i><span>已複製</span>';
          lucide.createIcons();
          setTimeout(function () {
            btn.innerHTML = '<i data-lucide="copy"></i><span>複製</span>';
            lucide.createIcons();
          }, 1600);
        });
      });
      bar.appendChild(lang);
      bar.appendChild(btn);
      pre.replaceWith(wrapper);
      wrapper.appendChild(bar);
      wrapper.appendChild(pre);
      if (window.hljs) { try { hljs.highlightElement(code); } catch (e) { /* 忽略 */ } }
    });
    // 連結另開新視窗
    container.querySelectorAll('.msg-body a').forEach(function (a) {
      a.setAttribute('target', '_blank');
      a.setAttribute('rel', 'noopener noreferrer');
    });
  }

  /* ---------- 訊息建構 ---------- */
  function metaLine(e) {
    const bits = [];
    if (e.kind === 'user') bits.push('User');
    else if (e.kind === 'ai') bits.push('Antigravity Agent');
    else if (e.kind === 'doc') bits.push('文件');
    else bits.push(e.type || 'Tool');
    if (e.step != null) bits.push('Step #' + e.step);
    const t = AGParser.formatTimestamp(e.time);
    if (t) bits.push(t);
    if (e.sourceFile) bits.push(e.sourceFile);
    return bits;
  }

  function buildMeta(e) {
    const wrap = document.createElement('div');
    wrap.className = 'msg-meta';
    const frags = metaLine(e);
    frags.forEach(function (f, i) {
      const span = document.createElement('span');
      span.textContent = f;
      span.className = i === 0 ? 'msg-who' : 'msg-sub';
      wrap.appendChild(span);
    });
    return wrap;
  }

  function buildToolAccordions(toolCalls) {
    const frag = document.createDocumentFragment();
    const details = document.createElement('details');
    details.className = 'tool-acc';
    const summary = document.createElement('summary');
    summary.innerHTML = '<i data-lucide="wrench"></i><span>工具執行紀錄（' + toolCalls.length + '）</span><i data-lucide="chevron-down" class="chev"></i>';
    details.appendChild(summary);
    const body = document.createElement('div');
    body.className = 'tool-acc-body';
    toolCalls.forEach(function (tc, i) {
      const item = document.createElement('div');
      item.className = 'tool-item';
      const head = document.createElement('div');
      head.className = 'tool-item-head';
      const badge = document.createElement('span');
      badge.className = 'tool-badge';
      badge.textContent = (i + 1) + '. ' + tc.name;
      head.appendChild(badge);
      item.appendChild(head);
      if (tc.args != null && !(typeof tc.args === 'object' && tc.args !== null && Object.keys(tc.args).length === 0)) {
        const pre = document.createElement('pre');
        pre.className = 'tool-args';
        const code = document.createElement('code');
        code.textContent = typeof tc.args === 'string' ? tc.args : JSON.stringify(tc.args, null, 2);
        if (window.hljs) { try { hljs.highlightElement(code); } catch (err) { /* 忽略 */ } }
        pre.appendChild(code);
        item.appendChild(pre);
      }
      if (tc.result != null && String(tc.result).trim() !== '') {
        const rlabel = document.createElement('div');
        rlabel.className = 'tool-result-label';
        rlabel.textContent = '執行結果';
        const rpre = document.createElement('pre');
        rpre.className = 'tool-result';
        const rcode = document.createElement('code');
        rcode.textContent = String(typeof tc.result === 'string' ? tc.result : JSON.stringify(tc.result, null, 2)).slice(0, 3000);
        rpre.appendChild(rcode);
        item.appendChild(rlabel);
        item.appendChild(rpre);
      }
      body.appendChild(item);
    });
    details.appendChild(body);
    frag.appendChild(details);
    return frag;
  }

  function buildEntry(e) {
    const msg = document.createElement('article');
    msg.className = 'msg msg-' + e.kind;
    msg.dataset.kind = e.kind;

    if (e.kind === 'tool') {
      // 獨立工具卡片（左對齊窄欄）
      msg.classList.add('msg-tool-card');
      const meta = buildMeta(e);
      msg.appendChild(meta);
      if (e.text) {
        const cap = document.createElement('div');
        cap.className = 'tool-caption';
        cap.textContent = e.text;
        msg.appendChild(cap);
      }
      msg.appendChild(buildToolAccordions(e.toolCalls));
      return msg;
    }

    const row = document.createElement('div');
    row.className = e.kind === 'user' ? 'bubble-row row-user' : 'bubble-row row-ai';

    const avatar = document.createElement('div');
    avatar.className = e.kind === 'user' ? 'avatar avatar-user' : 'avatar avatar-ai';
    avatar.textContent = e.kind === 'user' ? '👤' : '🤖';

    const bubble = document.createElement('div');
    bubble.className = e.kind === 'user' ? 'bubble bubble-user' : 'bubble bubble-ai';
    bubble.appendChild(buildMeta(e));

    const body = document.createElement('div');
    body.className = 'msg-body';
    if (e.kind === 'user') {
      body.classList.add('plain-text');
      body.textContent = e.text || '';
    } else if (e.kind === 'doc') {
      body.classList.add('plain-text', 'doc-text');
      body.textContent = e.text || '';
    } else {
      body.classList.add('md-body', 'prose', 'prose-sm', 'dark:prose-invert', 'max-w-none');
      body.innerHTML = markdownToHtml(e.text || '');
    }
    bubble.appendChild(body);

    if (e.toolCalls && e.toolCalls.length) {
      bubble.appendChild(buildToolAccordions(e.toolCalls));
    }

    row.appendChild(avatar);
    row.appendChild(bubble);
    msg.appendChild(row);
    return msg;
  }

  /* ---------- 主渲染 ---------- */
  function renderAll() {
    renderStats();
    renderConversation();
  }

  function renderStats() {
    if (!state.loaded) { els.dashboard.classList.add('hidden'); return; }
    els.dashboard.classList.remove('hidden');
    els.hero.classList.add('hidden');

    const userCount = state.entries.filter(function (e) { return e.kind === 'user'; }).length;
    const aiCount = state.entries.filter(function (e) { return e.kind === 'ai'; }).length;
    const toolCount = state.entries.reduce(function (s, e) { return s + (e.toolCalls ? e.toolCalls.length : 0); }, 0);

    els.statTotal.textContent = state.entries.length;
    els.statUser.textContent = userCount;
    els.statAi.textContent = aiCount;
    els.statTool.textContent = toolCount;

    // 檔案標籤
    els.fileChips.innerHTML = '';
    state.files.forEach(function (f) {
      const chip = document.createElement('span');
      chip.className = 'file-chip';
      const icon = f.format === 'jsonl' ? '{ }' : 'TXT';
      chip.innerHTML = '<b class="chip-fmt">' + icon + '</b>';
      const name = document.createElement('span');
      name.textContent = f.fileName;
      const cnt = document.createElement('span');
      cnt.className = 'chip-cnt';
      cnt.textContent = f.entries.length + ' 條';
      chip.appendChild(name);
      chip.appendChild(cnt);
      if (f.errors.length) {
        const err = document.createElement('span');
        err.className = 'chip-err';
        err.textContent = f.errors.length + ' 錯誤';
        chip.appendChild(err);
      }
      els.fileChips.appendChild(chip);
    });
    if (state.duplicates > 0) {
      const dup = document.createElement('span');
      dup.className = 'file-chip chip-dup';
      dup.textContent = '已去除重複 ' + state.duplicates + ' 條';
      els.fileChips.appendChild(dup);
    }

    // 警示橫幅
    const totalErrors = state.files.reduce(function (s, f) { return s + f.errors.length; }, 0);
    const truncated = state.files.reduce(function (s, f) { return s + (f.truncatedLines || 0); }, 0);
    const warnings = state.files.reduce(function (s, f) { return s.concat(f.warnings || []); }, []);
    if (totalErrors || truncated || warnings.length) {
      els.warnBox.classList.remove('hidden');
      els.warnList.innerHTML = '';
      if (totalErrors) {
        const li = document.createElement('li');
        li.textContent = '已略過 ' + totalErrors + ' 行無法解析的內容（格式損壞或非 JSON 物件）。';
        els.warnList.appendChild(li);
      }
      if (truncated) {
        const li = document.createElement('li');
        li.textContent = '已略過 ' + truncated + ' 行含 <truncated> 標記的不完整內容。';
        els.warnList.appendChild(li);
      }
      warnings.forEach(function (w) {
        const li = document.createElement('li');
        li.textContent = w;
        els.warnList.appendChild(li);
      });
    } else {
      els.warnBox.classList.add('hidden');
    }

    els.exportBtn.disabled = false;
    els.exportBtn.classList.remove('opacity-40', 'pointer-events-none');
  }

  function renderConversation() {
    els.conversation.innerHTML = '';
    state.entries.forEach(function (e, idx) {
      const node = buildEntry(e);
      node.dataset.idx = idx;
      // 快取原始 body HTML 供搜尋還原
      const body = node.querySelector('.msg-body');
      if (body) node._origHtml = body.innerHTML;
      const accBody = node.querySelectorAll('.tool-acc-body pre code');
      els.conversation.appendChild(node);
    });
    lucide.createIcons();
    els.noResult.classList.add('hidden');
    applyFilterAndSearch();
  }

  /* ---------- 過濾 + 搜尋 ---------- */
  function clearHighlights(msg) {
    const body = msg.querySelector('.msg-body');
    if (body && msg._origHtml !== undefined) body.innerHTML = msg._origHtml;
    // 只清除「本則訊息」範圍內的高亮，避免把同輪其他訊息剛標上的 mark 移除
    msg.querySelectorAll('mark.hl-hit').forEach(function (m) {
      const parent = m.parentNode;
      if (!parent) return;
      parent.replaceChild(document.createTextNode(m.textContent), m);
      parent.normalize();
    });
  }

  function highlightTextNodes(root, query) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: function (n) {
        if (!n.nodeValue || !n.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
        if (n.parentElement && n.parentElement.closest('script,style,mark')) return NodeFilter.FILTER_REJECT;
        return n.nodeValue.toLowerCase().indexOf(query) !== -1 ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
      }
    });
    const targets = [];
    while (walker.nextNode()) targets.push(walker.currentNode);
    targets.forEach(function (node) {
      const text = node.nodeValue;
      const lower = text.toLowerCase();
      const frag = document.createDocumentFragment();
      let i = 0;
      for (;;) {
        const idx = lower.indexOf(query, i);
        if (idx === -1) {
          if (i < text.length) frag.appendChild(document.createTextNode(text.slice(i)));
          break;
        }
        if (idx > i) frag.appendChild(document.createTextNode(text.slice(i, idx)));
        const mark = document.createElement('mark');
        mark.className = 'hl-hit';
        mark.textContent = text.slice(idx, idx + query.length);
        frag.appendChild(mark);
        i = idx + query.length;
      }
      node.parentNode.replaceChild(frag, node);
    });
  }

  function applyFilterAndSearch() {
    const q = state.query.trim().toLowerCase();
    let visible = 0;

    $$('#conversation .msg').forEach(function (msg) {
      const kind = msg.dataset.kind;
      const passFilter =
        state.filter === 'all' ||
        (state.filter === 'user' && kind === 'user') ||
        (state.filter === 'ai' && (kind === 'ai' || kind === 'tool' || kind === 'doc'));
      if (!passFilter) { msg.classList.add('msg-hidden'); return; }

      if (!q) {
        msg.classList.remove('msg-hidden');
        clearHighlights(msg);
        visible++;
        return;
      }
      const hay = msg.textContent.toLowerCase();
      if (hay.indexOf(q) === -1) { msg.classList.add('msg-hidden'); return; }
      msg.classList.remove('msg-hidden');
      clearHighlights(msg);
      const body = msg.querySelector('.msg-body');
      if (body) { if (msg._origHtml !== undefined) body.innerHTML = msg._origHtml; highlightTextNodes(body, q); }
      msg.querySelectorAll('.tool-acc-body, .tool-caption').forEach(function (zone) { highlightTextNodes(zone, q); });
      visible++;
    });

    els.matchInfo.textContent = q
      ? '搜尋「' + state.query.trim() + '」：符合 ' + visible + ' 條訊息'
      : (state.loaded ? '共顯示 ' + visible + ' 條訊息' : '');
    els.noResult.classList.toggle('hidden', visible !== 0 || !state.loaded);
  }

  /* ---------- 載入內容 ---------- */
  function readFile(file) {
    return new Promise(function (resolve, reject) {
      const reader = new FileReader();
      reader.onload = function () { resolve({ name: file.name, content: String(reader.result) }); };
      reader.onerror = function () { reject(new Error('無法讀取檔案：' + file.name)); };
      reader.readAsText(file, 'utf-8');
    });
  }

  function loadFromFiles(fileList) {
    const files = Array.prototype.slice.call(fileList);
    if (!files.length) return;
    Promise.all(files.map(readFile)).then(function (items) {
      loadFromTexts(items);
    }).catch(function (err) { toast(err.message, 'error'); });
  }

  function loadFromTexts(items) {
    try {
      const result = AGParser.parseFiles(items);
      if (!result.entries.length) {
        toast('沒有解析到任何對話內容，請確認檔案格式。', 'error');
        return;
      }
      // 累加模式：新檔案與既有檔案合併，重新依 step_index 排序去重
      state.files = result.files.map(function (f) {
        return { fileName: f.fileName, format: f.format, entries: f.entries, errors: f.errors, truncatedLines: f.truncatedLines, warnings: f.warnings };
      }).concat(state.files);

      const allResults = state.files.map(function (f) {
        return { fileName: f.fileName, entries: f.entries };
      });
      const re = AGParser.mergeResults(allResults);
      state.entries = re.entries;
      state.duplicates = re.duplicates;
      state.loaded = true;
      state.fileNameLabel = state.files.map(function (f) { return f.fileName; }).join('、');
      els.clearBtn.classList.remove('hidden');
      renderAll();
      toast('已載入 ' + state.files.length + ' 個檔案，共 ' + state.entries.length + ' 條訊息', 'success');
    } catch (err) {
      toast('解析失敗：' + err.message, 'error');
    }
  }

  function loadFromPaste(text) {
    loadFromTexts([{ name: '貼上內容.jsonl', content: text }]);
  }

  function loadSample() {
    Promise.all([
      fetch('sample/transcript.sample.jsonl').then(function (r) { return r.text(); }),
      fetch('sample/overview.sample.txt').then(function (r) { return r.text(); })
    ]).then(function (texts) {
      loadFromTexts([
        { name: 'transcript.jsonl（範例）', content: texts[0] },
        { name: 'overview.txt（範例）', content: texts[1] }
      ]);
    }).catch(function () { toast('範例載入失敗，請確認由 HTTP 伺服器開啟頁面。', 'error'); });
  }

  function clearAll() {
    state.entries = [];
    state.files = [];
    state.duplicates = 0;
    state.loaded = false;
    state.query = '';
    els.searchInputs.forEach(function (i) { i.value = ''; });
    els.fileInput.value = '';
    els.clearBtn.classList.add('hidden');
    els.dashboard.classList.add('hidden');
    els.hero.classList.remove('hidden');
    els.conversation.innerHTML = '';
    els.matchInfo.textContent = '';
    els.exportBtn.disabled = true;
    els.exportBtn.classList.add('opacity-40', 'pointer-events-none');
    toast('已清除所有對話');
  }

  /* ---------- 匯出 ---------- */
  function exportMarkdown() {
    if (!state.entries.length) return;
    const md = AGParser.exportMarkdown(state.entries, { fileNames: state.files.map(function (f) { return f.fileName; }) });
    const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'conversation.md';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
    toast('已匯出 conversation.md', 'success');
  }

  /* ---------- 佈景 ---------- */
  function applyTheme(dark) {
    state.isDark = dark;
    document.documentElement.classList.toggle('dark', dark);
    localStorage.setItem('ag-theme', dark ? 'dark' : 'light');
    const light = $('#hljs-light'), darkLink = $('#hljs-dark');
    if (light && darkLink) { light.disabled = dark; darkLink.disabled = !dark; }
    const icon = dark ? 'sun' : 'moon';
    els.themeBtn.innerHTML = '<i data-lucide="' + icon + '"></i>';
    lucide.createIcons();
  }

  /* ---------- Toast ---------- */
  let toastTimer = null;
  function toast(msg, type) {
    els.toast.textContent = msg;
    els.toast.className = 'toast show' + (type === 'error' ? ' toast-error' : type === 'success' ? ' toast-success' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { els.toast.className = 'toast'; }, 2600);
  }

  /* ---------- 初始化 ---------- */
  function cacheEls() {
    els.searchInputs = $$('.search-input');
    els.dropzone = $('#dropzone');
    els.matchInfo = $('#match-info');
    els.fileInput = $('#file-input');
    els.uploadBtn = $('#upload-btn');
    els.pasteBtn = $('#paste-btn');
    els.pasteModal = $('#paste-modal');
    els.pasteTextarea = $('#paste-textarea');
    els.pasteConfirm = $('#paste-confirm');
    els.pasteCancel = $('#paste-cancel');
    els.sampleBtn = $('#sample-btn');
    els.exportBtn = $('#export-btn');
    els.clearBtn = $('#clear-btn');
    els.themeBtn = $('#theme-btn');
    els.dashboard = $('#dashboard');
    els.hero = $('#hero');
    els.statTotal = $('#stat-total');
    els.statUser = $('#stat-user');
    els.statAi = $('#stat-ai');
    els.statTool = $('#stat-tool');
    els.conversation = $('#conversation');
    els.noResult = $('#no-result');
    els.fileChips = $('#file-chips');
    els.warnBox = $('#warn-box');
    els.warnList = $('#warn-list');
    els.toast = $('#toast');
    els.dropOverlay = $('#drop-overlay');
    els.backTop = $('#back-top');
    els.copyPathBtns = $$('.copy-path');
  }

  function bindEvents() {
    // 上傳
    els.uploadBtn.addEventListener('click', function () { els.fileInput.click(); });
    els.fileInput.addEventListener('change', function () { loadFromFiles(els.fileInput.files); });

    // 拖放
    let dragDepth = 0;
    document.addEventListener('dragenter', function (e) { e.preventDefault(); dragDepth++; els.dropOverlay.classList.remove('hidden'); });
    document.addEventListener('dragleave', function (e) { e.preventDefault(); dragDepth--; if (dragDepth <= 0) { dragDepth = 0; els.dropOverlay.classList.add('hidden'); } });
    document.addEventListener('dragover', function (e) { e.preventDefault(); });
    document.addEventListener('drop', function (e) {
      e.preventDefault();
      dragDepth = 0;
      els.dropOverlay.classList.add('hidden');
      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) loadFromFiles(e.dataTransfer.files);
    });

    // 貼上
    els.pasteBtn.addEventListener('click', function () { els.pasteModal.classList.remove('hidden'); els.pasteTextarea.focus(); });
    els.pasteCancel.addEventListener('click', function () { els.pasteModal.classList.add('hidden'); });
    els.pasteModal.addEventListener('click', function (e) { if (e.target === els.pasteModal) els.pasteModal.classList.add('hidden'); });
    els.pasteConfirm.addEventListener('click', function () {
      const text = els.pasteTextarea.value;
      if (!text.trim()) { toast('請先貼上 JSONL 或 TXT 內容', 'error'); return; }
      els.pasteModal.classList.add('hidden');
      els.pasteTextarea.value = '';
      loadFromPaste(text);
    });

    els.sampleBtn.addEventListener('click', loadSample);
    els.exportBtn.addEventListener('click', exportMarkdown);
    els.clearBtn.addEventListener('click', clearAll);

    // 搜尋（防抖；雙輸入框同步）
    let searchTimer = null;
    els.searchInputs.forEach(function (input) {
      input.addEventListener('input', function () {
        const v = input.value;
        els.searchInputs.forEach(function (other) { if (other !== input) other.value = v; });
        clearTimeout(searchTimer);
        searchTimer = setTimeout(function () {
          state.query = v;
          applyFilterAndSearch();
        }, 180);
      });
    });

    // 點擊上傳區開檔（避開內部按鈕）
    els.dropzone.addEventListener('click', function (e) {
      if (e.target.closest('button')) return;
      els.fileInput.click();
    });

    // 說話者過濾
    $$('.filter-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        state.filter = btn.dataset.filter;
        $$('.filter-btn').forEach(function (b) { b.classList.toggle('filter-active', b === btn); });
        applyFilterAndSearch();
      });
    });

    // 佈景
    els.themeBtn.addEventListener('click', function () { applyTheme(!state.isDark); });

    // 複製路徑
    els.copyPathBtns.forEach(function (btn) {
      btn.addEventListener('click', function () {
        const path = btn.dataset.path;
        navigator.clipboard.writeText(path).then(function () {
          toast('已複製路徑', 'success');
        });
      });
    });

    // 快捷鍵
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { els.pasteModal.classList.add('hidden'); }
      if (e.key === '/' && !e.target.closest('input, textarea')) {
        e.preventDefault();
        els.searchInputs[0].focus();
      }
    });

    // 回到頂部
    window.addEventListener('scroll', function () {
      els.backTop.classList.toggle('show', window.scrollY > 480);
    });
    els.backTop.addEventListener('click', function () { window.scrollTo({ top: 0, behavior: 'smooth' }); });
  }

  function init() {
    cacheEls();
    bindEvents();
    applyTheme(localStorage.getItem('ag-theme') === 'dark' ||
      (localStorage.getItem('ag-theme') === null && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches));
    lucide.createIcons();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
