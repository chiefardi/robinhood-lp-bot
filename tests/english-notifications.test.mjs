import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

// Isolate these renderers from RPC, Telegram, persisted data and real credentials.
function loadModule(file, dependencies, globals = {}) {
  const source = readFileSync(new URL(`../src/telegram/${file}`, import.meta.url), 'utf8');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  });
  const exports = {};
  vm.runInNewContext(outputText, {
    exports,
    require(name) {
      assert.ok(Object.hasOwn(dependencies, name), `Unexpected dependency: ${name}`);
      return dependencies[name];
    },
    ...globals,
  }, { filename: file });
  return exports;
}

const esc = (s) => String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const format = { esc, pre: (s) => `<pre>${esc(s)}</pre>`, padR: (s, n) => s.padEnd(n), tokenEmoji: () => '🐱' };
const indonesian = /\b(gagal|harga|nembus|posisi|berhenti|makan|dibuka|ditutup|cek|beli|jual|belum|ketangkep|lolos|rame|saran|besok|skrg|naikin|turunin|kumpulin|harian|analisa|kosong)\b/i;

test('all notification types use English while retaining metadata and callback IDs', async () => {
  const messages = [];
  const api = loadModule('notify.ts', {
    './tg.js': { send: async (text, options) => messages.push({ text, options }), explorerTx: (h) => `https://example.invalid/${h}` },
    './format.js': format,
    '../util/format.js': { fmtMcap: (n) => `$${n}` },
  });
  const token = '0x123';
  await api.notifySpike({ symbol: 'KUCING', addr: token, prevVol5m: 10, vol5m: 20, vol1h: 30, liq: 100, fdv: 1000, chg5m: 1, chg1h: -2, safe: { reason: 'passed', backPct: 99 }, url: 'https://example.invalid/chart' });
  await api.notifyNewToken({ symbol: 'KUCING', token, kind: 'mint', fee: 30000, wethSeed: 1, safeReason: 'passed', backPct: 99 });
  await api.notifyCandidate({ token: { symbol: 'KUCING', address: token, liquidity: 100, volume: 200, marketCap: 1000 }, kind: 'meme', community: 'clear', score: 80, fomo: 40, flags: [], verdict: 'ape' }, { quote: 'eth', fee: 30000, volUsd: 200, liqUsd: 100 });
  await api.notifyAutoLp({ opened: true, symbol: 'KUCING', sizeEth: 0.1, result: { tokenId: 123, mode: 'inrange', tickLower: 0, tickUpper: 100, txHash: '0xabc' } });
  await api.notifyAutoClose({ sym: 'KUCING', tokenId: 123, reason: 'FVLOW', version: 'v4', pnlPct: 1, pnlEth: 0.01 });
  await api.notifyRebalance({ sym: 'KUCING', oldTokenId: 123, newTokenId: 124 });
  await api.notifyCompound({ sym: 'KUCING', tokenId: 124, feeUsd: 2 });
  for (const side of ['atas', 'bawah']) {
    await api.notifyOutOfRange({ symbol: 'KUCING', tokenId: 123, side, tick: 101, tickLower: 0, tickUpper: 100, autoClosed: false, closeError: 'RPC unavailable' });
    assert.match(messages.at(-1).text, new RegExp(side === 'atas' ? 'above' : 'below'));
    assert.equal(messages.at(-1).options.reply_markup.inline_keyboard[0][0].callback_data, 'close:123');
  }
  assert.equal(messages.length, 9);
  for (const { text } of messages) {
    assert.match(text, /KUCING/);
    assert.doesNotMatch(text, indonesian);
  }
  for (const { options } of messages.slice(0, 3)) {
    assert.equal(options.reply_markup.inline_keyboard[0][0].callback_data, `ca:${token}`);
  }
});

function briefingDependencies(entries, briefKey = '') {
  return {
    '../chain/ledger.js': { readLedger: () => entries, ledgerSummary: () => ({ count: entries.length, winRate: 50, pnlUsd: 1, feeEth: 0.01 }) },
    '../chain/positions.js': { listPositions: async () => [] },
    '../chain/v4/list.js': { listV4Positions: async () => [{ valueUsd: 100, depEth: 0.01, inRange: true, pair: 'KUCING/WETH' }] },
    '../chain/price.js': { ethUsd: async () => 2000 },
    '../config.js': { cfg: { autoLp: { tpPct: 8, slPct: 15, oorAction: 'close', maxOpen: 5, dailyCapEth: 1 }, scan: { minSpikeX: 2, minScore: 60 } }, env: { briefKey, briefModel: 'test', briefUrl: 'https://example.invalid/brief' } },
    '../util/files.js': { dataPath: (s) => s, readJson: () => ({}), writeJson: () => assert.fail('Unexpected disk write') },
    './tg.js': { send: () => assert.fail('Unexpected Telegram send') },
    './format.js': format,
    '../util/log.js': { logger: () => ({ info() {}, warn() {} }) },
    '../radar/cash-report.js': {buildCashReport:()=>assert.fail('Legacy test must not render the pilot report')},
  };
}

test('legacy manual briefing uses English and English duration units for every close reason', async () => {
  const entries = ['TP', 'SL', 'OOR', 'VFADE', 'FVLOW', 'manual'].map((reason, i) => ({
    source: 'bot', closedAt: Date.now(), pnlEth: 0.01, pnlUsd: 1, pnlPct: 2, feeEth: 0.001,
    reason, sym: 'KUCING', pair: 'KUCING/WETH', heldMs: (i ? 25 : 2) * 3600000, mode: 'inrange',
  }));
  const { buildLegacyBriefing } = loadModule('briefing.ts', briefingDependencies(entries));
  const text = await buildLegacyBriefing();
  assert.match(text, /DAILY BRIEFING/);
  assert.match(text, /OPEN POSITIONS/);
  assert.match(text, /KUCING/);
  assert.match(text, /2\.0h/);
  assert.match(text, /1\.0d/);
  assert.match(text, /Suggestion for tomorrow/);
  assert.doesNotMatch(text, indonesian);
});

test('legacy LLM briefing requests explicitly require English and unchanged token names', async () => {
  let request;
  const { buildLegacyBriefing } = loadModule('briefing.ts', briefingDependencies([], 'test-only'), {
    AbortSignal,
    fetch: async (url, options) => {
      assert.equal(url, 'https://example.invalid/brief');
      request = JSON.parse(options.body);
      return { ok: true, json: async () => ({ choices: [{ message: { content: '**💚 PROFIT** — No closes yet.' } }] }) };
    },
  });
  const text = await buildLegacyBriefing();
  assert.match(request.messages[0].content, /English only/);
  assert.match(request.messages[0].content, /Preserve token names and symbols exactly/);
  assert.match(request.messages[1].content, /KUCING/);
  assert.doesNotMatch(request.messages[0].content, indonesian);
  assert.match(text, /No closes yet/);
});

test('scheduled briefing reads real cash report even when legacy ledger is empty',async()=>{
 const {summarizeCash,renderCashReport}=await import('../src/radar/cash-report.ts');
 const now=Date.now();
 const state={version:1,history:[],session:{id:'cash',startedAt:now-2000,paused:false,pauseReason:'',lossTriggered:false,
  entries:[{id:'1',token:'0xabc',tokenId:'123',status:'closed',sizeUsd:29,sizeEth:.01,at:now-2000,closedAt:now-1000,basisUsd:29,realizedNetUsd:32,armed:false,closeReason:'MAX_HOLD'}]}};
 const deps=briefingDependencies([]);
 deps['../radar/cash-report.js']={buildCashReport:kind=>renderCashReport(summarizeCash(state,now),kind)};
 deps['../chain/ledger.js']={readLedger:()=>assert.fail('Must not use legacy accounting'),ledgerSummary:()=>assert.fail('Must not use legacy accounting')};
 const text=await loadModule('briefing.ts',deps).buildBriefing();
 assert.match(text,/Realized 24h:<\/b> \+\$3\.00/);assert.match(text,/1 closed/);assert.match(text,/#123/);
 assert.match(text,/Fee breakdown: unavailable/);assert.doesNotMatch(text,indonesian);
});
