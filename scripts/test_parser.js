/* AGChatHistoryParser 解析引擎測試（Node.js） */
const fs = require('fs');
const path = require('path');

require(path.join(__dirname, '..', 'assets', 'parser.js'));
const AG = globalThis.AGParser;

let pass = 0, fail = 0;
function test(name, cond, extra) {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (extra ? '\n     → ' + extra : '')); }
}

console.log('== 1. USER_REQUEST 擷取與雜訊過濾 ==');
const content1 = '<USER_REQUEST>\n幫我寫個腳本\n</USER_REQUEST>\n\n<ADDITIONAL_METADATA>\nos: linux\n</ADDITIONAL_METADATA>';
test('擷取 USER_REQUEST 純文字', AG.extractUserText(content1) === '幫我寫個腳本', JSON.stringify(AG.extractUserText(content1)));
const content2 = '<ADDITIONAL_METADATA>x</ADDITIONAL_METADATA>\n直接裸文字提問';
test('無標籤時過濾雜訊保留原文', AG.extractUserText(content2) === '直接裸文字提問', JSON.stringify(AG.extractUserText(content2)));
test('純文字原樣保留', AG.extractUserText('hello world') === 'hello world');

console.log('== 2. JSONL 容錯解析 ==');
const jsonl = [
  '{"step_index":1,"source":"USER_EXPLICIT","type":"USER_INPUT","created_at":"2026-05-01T16:26:26Z","content":"<USER_REQUEST>hi</USER_REQUEST>"}',
  '',
  '{"step_index":2,"source":"MODEL","type":"PLANNER_RESPONSE","created_at":"2026-05-01T16:26:30Z","content":"**hello**"}',
  'not a json line',
  '{"step_index":3,"source":"MODEL","type":"PLANN',
  '<truncated 4096 bytes>',
  '{"step_index":4,"source":"MODEL","type":"CODE_ACTION","content":"","tool_calls":[{"name":"run_command","arguments":"{\\"command\\":\\"ls\\"}"}]}',
  '[1,2,3]'
].join('\n');
const r = AG.parseJSONL(jsonl);
test('解析出 3 條有效訊息', r.entries.length === 3, 'got ' + r.entries.length);
test('錯誤行數 = 3（壞 JSON + 陣列行）', r.errors.length === 3, 'got ' + r.errors.length);
test('truncated 行數 = 1', r.truncatedLines === 1, 'got ' + r.truncatedLines);
test('tool args 字串自動轉物件', r.entries[2].toolCalls[0].args && r.entries[2].toolCalls[0].args.command === 'ls');
test('tool 類型歸類', r.entries[2].kind === 'tool');
test('user 類型歸類', r.entries[0].kind === 'user');

console.log('== 3. 時間格式化 ==');
const ts = AG.formatTimestamp('2026-05-01T16:26:26Z');
test('ISO → YYYY-MM-DD HH:mm:ss（本機）', /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(ts), ts);
test('無效時間回傳原字串', AG.formatTimestamp('not-a-time') === 'not-a-time');
test('空值回傳空字串', AG.formatTimestamp(null) === '');

console.log('== 4. TXT 結構化解析 ==');
const txt1 = fs.readFileSync(path.join(__dirname, '..', 'sample', 'overview.sample.txt'), 'utf-8');
const t1 = AG.parseTXT(txt1);
test('結構化模式', t1.mode === 'structured', t1.mode);
test('解析出 7 條（含前導文件卡）', t1.entries.length === 7, 'got ' + t1.entries.length);
test('前導說明 → doc 卡', t1.entries[0].kind === 'doc');
const step13 = t1.entries.find(e => e.step === 13);
test('Step 13 為 User', step13 && step13.kind === 'user');
test('Step 13 時間擷取', step13 && step13.time === '2026-05-01 16:35:02', step13 && step13.time);
const step14 = t1.entries.find(e => e.step === 14);
test('Step 14 為 AI', step14 && step14.kind === 'ai');
test('多行區塊合併', step14 && step14.text.includes('PyInstaller'));

console.log('== 5. TXT 文件模式後備 ==');
const t2 = AG.parseTXT('這是一份\n沒有任何說話者標記的\n純文字文件');
test('文件模式', t2.mode === 'document');
test('整份成為單一 doc', t2.entries.length === 1 && t2.entries[0].kind === 'doc');
test('產生警告', t2.warnings.length === 1);

console.log('== 6. 格式嗅探 ==');
test('JSONL 嗅探', AG.parseInput('a.jsonl', jsonl).format === 'jsonl');
test('TXT 嗅探', AG.parseInput('b.txt', txt1).format === 'txt');
test('副檔名誤標仍可嗅探為 jsonl', AG.parseInput('wrong.txt', jsonl).format === 'jsonl');

console.log('== 7. 多檔案合併與排序（sample 實測） ==');
const sj = fs.readFileSync(path.join(__dirname, '..', 'sample', 'transcript.sample.jsonl'), 'utf-8');
const pf = AG.parseFiles([{ name: 'transcript.jsonl', content: sj }, { name: 'overview.txt', content: txt1 }]);
test('合併後共 18 條', pf.entries.length === 18, 'got ' + pf.entries.length);
test('JSONL 檔解析 11 條', pf.files[0].entries.length === 11, 'got ' + pf.files[0].entries.length);
test('TXT 檔解析 7 條', pf.files[1].entries.length === 7, 'got ' + pf.files[1].entries.length);
test('壞行錯誤計數 = 1', pf.files[0].errors.length === 1);
test('truncated 計數 = 1', pf.files[0].truncatedLines === 1);
const steps = pf.entries.map(e => e.step).filter(s => s != null);
test('step 嚴格遞增排序', steps.every((s, i) => i === 0 || s > steps[i - 1]), steps.join(','));
test('step 範圍 1-18', steps[0] === 1 && steps[steps.length - 1] === 18);
test('來源檔名標記', pf.entries.every(e => e.sourceFile));

console.log('== 8. 重複上傳去重 ==');
const pf2 = AG.parseFiles([{ name: 'transcript.jsonl', content: sj }, { name: 'overview.txt', content: txt1 }, { name: 'transcript(副本).jsonl', content: sj }, { name: 'overview(副本).txt', content: txt1 }]);
test('重複檔案全部去重，總數仍 18', pf2.entries.length === 18, 'got ' + pf2.entries.length);
test('去重統計 = 18', pf2.duplicates === 18, 'got ' + pf2.duplicates);

console.log('== 9. Markdown 匯出 ==');
const md = AG.exportMarkdown(pf.entries, { fileNames: ['transcript.jsonl', 'overview.txt'] });
test('標題存在', md.startsWith('# Antigravity 對話逐字稿'));
test('含 User 段落', md.includes('## 👤 User · Step #1'));
test('含 AI 段落', md.includes('## 🤖 Antigravity Agent · Step #2'));
test('含工具調用區塊', md.includes('#### 1. `write_to_file`'));
test('含 JSON 參數', md.includes('```json'));
test('含來源檔案標記', md.includes('> 來源：`overview.txt`'));
test('含時間範圍', md.includes('時間範圍'));
test('保持 Markdown 原文（表格）', md.includes('| 測試案例 | 指令 | 結果 |'));

console.log('\n========================================');
console.log('結果：' + pass + ' 通過 / ' + fail + ' 失敗');
process.exit(fail ? 1 : 0);
