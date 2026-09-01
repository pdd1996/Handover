#!/usr/bin/env node
/**
 * Handover 台账与文档一致性校验（零依赖，Node ≥ 18）
 * 用法：node scripts/check-ledger.mjs
 *
 * 检查项：
 *  1. 台账：规格编号唯一、前缀计数与编号规则表一致、总数与进度速览一致、规格行列数完整
 *  2. 测试用例清单：每个用例编号的规格部分存在于台账、各节实际条数与节标题声明一致、Phase 1 合计一致
 *  3. 任务分解：TK- 编号唯一、数量与 README 声明一致
 *  4. README：全部相对链接目标存在
 *  5. docs/ 文件命名符合 Handover-主题-vX.Y.md
 *
 * 退出码：0 通过 / 1 有失败项。修改任何带编号的文档后必须跑本脚本并通过。
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const docs = join(root, 'docs');
let failures = 0;
const fail = (m) => { failures += 1; console.error(`  ✗ ${m}`); };
const pass = (m) => console.log(`  ✓ ${m}`);
const section = (t) => console.log(`\n${t}`);

const read = (p) => readFileSync(p, 'utf8').split(/\r?\n/);

// 按文件名版本号取最新一版（v1.10 > v1.9 > v1.4）
function latest(prefix) {
  const ver = (f) => (f.match(/v(\d+(?:\.\d+)*)\.md$/) || [])[1]?.split('.').map(Number) || [];
  const files = readdirSync(docs)
    .filter((f) => f.startsWith(prefix) && /-v\d+(\.\d+)*\.md$/.test(f));
  if (!files.length) return null;
  files.sort((a, b) => {
    const va = ver(a), vb = ver(b);
    for (let i = 0; i < Math.max(va.length, vb.length); i++) {
      const d = (vb[i] ?? 0) - (va[i] ?? 0);
      if (d) return d;
    }
    return 0;
  });
  return files[0];
}

const ledgerIds = new Set();

// ── 一、台账 ────────────────────────────────────────────
section('一、台账（规格编号与验收对照表）');
const ledgerFile = latest('Handover-规格编号与验收对照表-v');
if (!ledgerFile) fail('未找到台账文件');
else {
  const lines = read(join(docs, ledgerFile));

  // 编号规则表声明的各前缀条目数：| C | 含义 | 9 |
  const declared = {};
  for (const l of lines) {
    const m = l.match(/^\|\s*([A-Z][A-Z0-9]*)\s*\|\s*[^|]+\|\s*(\d+)\s*\|\s*$/);
    if (m) declared[m[1]] = Number(m[2]);
  }

  // 规格行：| C-01 | ...（C 系列表 4 列，其余规格表 7 列）
  const ids = [];
  const badRows = [];
  for (const l of lines) {
    const m = l.match(/^\|\s*([A-Z][A-Z0-9]*-\d+)\s*\|/);
    if (!m) continue;
    ids.push(m[1]);
    ledgerIds.add(m[1]);
    const cells = l.split('|').slice(1, -1).map((c) => c.trim());
    const expect = /^C-/.test(m[1]) ? 4 : 7;
    if (cells.length !== expect || cells.some((c) => c === '')) badRows.push(m[1]);
  }

  const dup = ids.filter((id, i) => ids.indexOf(id) !== i);
  dup.length
    ? fail(`规格编号重复：${[...new Set(dup)].join('、')}`)
    : pass(`规格编号唯一（${ids.length} 条）`);

  const actual = {};
  for (const id of ids) {
    const p = id.replace(/-\d+$/, '');
    actual[p] = (actual[p] || 0) + 1;
  }
  const mism = Object.keys(declared).filter((k) => declared[k] !== actual[k]);
  mism.length
    ? fail(`前缀计数不符：${mism.map((k) => `${k} 声明 ${declared[k]} 实际 ${actual[k] ?? 0}`).join('；')}`)
    : pass(`前缀计数与编号规则表一致（${Object.keys(declared).length} 个前缀）`);

  const totalRow = lines.find((l) => /^\|\s*规格总数\s*\|/.test(l)) || '';
  const totalDeclared = Number((totalRow.match(/\|\s*(\d+)\s*\|/) || [])[1] || 0);
  totalDeclared === ids.length
    ? pass(`规格总数 ${ids.length} 与进度速览一致`)
    : fail(`规格总数不符：进度速览 ${totalDeclared}，实际 ${ids.length}`);

  badRows.length
    ? fail(`规格行列数/空值异常：${badRows.join('、')}`)
    : pass('全部规格行列数完整、无空单元格');
}

// ── 二、测试用例清单 ────────────────────────────────────
section('二、测试用例清单');
const caseFile = latest('Handover-测试用例清单-v');
if (!caseFile) fail('未找到测试用例清单');
else {
  const lines = read(join(docs, caseFile));
  const caseRowRe = /^\|\s*([A-Z][A-Z0-9]*-\d+)-T\d+\s*\|/;

  const bases = lines.filter((l) => caseRowRe.test(l))
    .map((l) => l.match(caseRowRe)[1]);
  const orphan = [...new Set(bases.filter((b) => !ledgerIds.has(b)))];
  orphan.length
    ? fail(`用例挂钩了不存在的规格：${orphan.join('、')}`)
    : pass(`全部 ${bases.length} 条用例的规格挂钩有效`);

  // 各节实际条数 vs 节标题声明（## 一、F1 …（23 条））
  const secs = [];
  let cur = null;
  for (const l of lines) {
    const h = l.match(/^## [一二三四五六七八九十]+、.*?（(\d+) 条/);
    if (h) { cur = { title: l.replace(/^##\s*/, ''), expect: Number(h[1]), actual: 0 }; secs.push(cur); continue; }
    if (cur && caseRowRe.test(l)) cur.actual += 1;
  }
  const badSec = secs.filter((s) => s.expect !== s.actual);
  badSec.length
    ? fail(`分节条数不符：${badSec.map((s) => `「${s.title.slice(0, 14)}…」声明 ${s.expect} 实际 ${s.actual}`).join('；')}`)
    : pass(`各节条数与标题声明一致（${secs.map((s) => s.actual).join('/')}）`);

  // Phase 1 合计行分项核对：合计行声明各域条数，逐域与对应章节实际比对
  // （不按标题含"Phase 2"识别分节——P1 章节标题可能合法提及 Phase 2，如 F3 节）
  const sumLine = lines.find((l) => /Phase 1 合计：\d+ 条/.test(l)) || '';
  const claimed = Number((sumLine.match(/Phase 1 合计：(\d+) 条/) || [])[1] || 0);
  const breakdown = {};
  for (const m of sumLine.matchAll(/([A-Z][A-Z0-9]*)\s+(\d+)/g)) breakdown[m[1]] = Number(m[2]);
  const bdSum = Object.values(breakdown).reduce((a, b) => a + b, 0);
  if (!claimed || claimed !== bdSum) {
    fail(`合计行自相矛盾：总数 ${claimed}，分项加总 ${bdSum}`);
  } else {
    const problems = [];
    let actualSum = 0;
    for (const [dom, n] of Object.entries(breakdown)) {
      const sec = secs.find((s) => new RegExp(`^[一二三四五六七八九十]+、${dom}\\b`).test(s.title));
      if (!sec) { problems.push(`${dom} 无对应章节`); continue; }
      if (sec.actual !== n) problems.push(`${dom} 声明 ${n} 节内实际 ${sec.actual}`);
      actualSum += sec.actual;
    }
    if (problems.length) fail(`合计分项不符：${problems.join('；')}`);
    else if (actualSum !== claimed) fail(`Phase 1 合计不符：声明 ${claimed}，实际 ${actualSum}`);
    else pass(`Phase 1 合计 ${claimed} 条与分项、各节实际一致`);
  }
}

// ── 三、任务分解 ────────────────────────────────────────
section('三、任务分解');
const taskFile = latest('Handover-任务分解-v');
if (!taskFile) fail('未找到任务分解');
else {
  const tks = read(join(docs, taskFile))
    .map((l) => l.match(/^\|\s*(TK-\d+)\s*\|/)?.[1]).filter(Boolean);
  const dupT = tks.filter((t, i) => tks.indexOf(t) !== i);
  dupT.length
    ? fail(`任务编号重复：${[...new Set(dupT)].join('、')}`)
    : pass(`TK- 编号唯一（${tks.length} 个）`);

  const readmeText = read(join(root, 'README.md')).join('\n');
  const claimT = Number(readmeText.match(/(\d+) 个任务/)?.[1] || 0);
  claimT === tks.length
    ? pass(`README 任务数声明一致（${tks.length}）`)
    : fail(`README 声明 ${claimT} 个任务，任务分解实际 ${tks.length} 个`);
}

// ── 四、README 链接与文件命名 ───────────────────────────
section('四、README 链接与文件命名');
const readmeText = read(join(root, 'README.md')).join('\n');
const links = [...readmeText.matchAll(/\]\(([^)]+)\)/g)]
  .map((m) => m[1]).filter((t) => !/^https?:/.test(t));
const broken = links.filter((t) => !existsSync(join(root, t)));
broken.length
  ? fail(`README 链接目标不存在：${broken.join('、')}`)
  : pass(`README 全部 ${links.length} 个相对链接有效`);

const badlyNamed = readdirSync(docs)
  .filter((f) => f.endsWith('.md') && !/^Handover-.+-v\d+(\.\d+)*\.md$/.test(f));
badlyNamed.length
  ? fail(`docs/ 命名不符合版本规范：${badlyNamed.join('、')}`)
  : pass('docs/ 文件命名全部符合 Handover-主题-vX.Y.md');

// ── 结果 ────────────────────────────────────────────────
console.log(`\n${failures === 0 ? '✅ 全部通过' : `❌ ${failures} 项失败`}`);
process.exit(failures ? 1 : 0);
