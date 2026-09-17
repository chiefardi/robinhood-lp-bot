import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';

process.env.RH_TG_TOKEN = 'local-test-no-real-token';
process.env.RH_TG_CHAT = '123456';
delete process.env.RH_OPENROUTER_KEY;
const messages = [];
let gmgnRows=[];
// Replace only the external CLI boundary; exercise the real adapter, filter and renderer.
childProcess.execFile=(file,args,_options,callback)=>{
  assert.equal(file,'gmgn-cli');
  if(args[0]==='config') {
    assert.deepEqual(args,['config','--check']);
    queueMicrotask(()=>callback(null,''));
  } else {
    assert.equal(args[0],'market');
    assert.equal(args[1],'trending');
    assert.equal(args[args.indexOf('--chain')+1],'robinhood');
    queueMicrotask(()=>callback(null,JSON.stringify({code:0,data:{rank:gmgnRows}})));
  }
};
syncBuiltinESMExports();
globalThis.fetch = async (url, options) => {
  assert.ok(String(url).startsWith('https://api.telegram.org/botlocal-test-no-real-token/'), 'Unexpected external request in UI test');
  const body = JSON.parse(options.body);
  messages.push(body);
  return new Response(JSON.stringify({ok:true,result:{message_id:1,text:body.text}}), {headers:{'content-type':'application/json'}});
};
const {MENU_KEYBOARD, resolveMenu} = await import('../src/telegram/menu.ts');
const {onHelp, onScreen} = await import('../src/telegram/handlers.ts');
const {notifyOutOfRange} = await import('../src/telegram/notify.ts');

test('English reply keyboard labels route to existing commands', () => {
  const labels = MENU_KEYBOARD.keyboard.flat();
  for (const [label,command] of [['📋 Positions','/list'],['📸 Card','/card'],['⚙️ Settings','/settings']]) {
    assert.ok(labels.includes(label), `Missing ${label}`);
    assert.equal(resolveMenu(label),command);
  }
  // Old messages remain clickable after deployment, but are never generated anew.
  assert.equal(resolveMenu('📋 Posisi'),'/list');
  assert.equal(resolveMenu('📸 Kartu'),'/card');
  assert.equal(resolveMenu('/screen fast'),'/screen fast');
});

test('help response and command guidance are English', async () => {
  messages.length=0;
  await onHelp();
  const text=messages.map(m=>m.text||'').join('\n');
  assert.match(text,/POSITIONS/i);
  assert.match(text,/open positions/i);
  assert.doesNotMatch(text,/\b(posisi|terbuka|pilih|jumlah|nggak|ketik|seumur|riwayat)\b/i);
});

test('empty GMGN response returns an English diagnostic, not an empty success', async () => {
  messages.length=0;
  await onScreen('fast');
  const text=messages.at(-1)?.text||'';
  assert.match(text,/GMGN/i);
  assert.match(text,/unavailable|did not return|no trending data/i);
  assert.doesNotMatch(text,/\b(nggak|balikin|belum|coba|lagi)\b/i);
});

test('out-of-range notification preserves token name and uses English action guidance', async () => {
  messages.length=0;
  await notifyOutOfRange({symbol:'KUCING',tokenId:123,tick:110,tickLower:0,tickUpper:100,side:'atas',autoClosed:false});
  const text=messages.at(-1)?.text||'';
  assert.match(text,/KUCING/);
  assert.match(text,/OUT OF RANGE/);
  assert.match(text,/fees/i);
  assert.match(text,/above/i);
  assert.doesNotMatch(text,/\b(harga|nembus|posisi|berhenti|makan|gagal|atas|bawah)\b/i);
});

test('screening result is English while token metadata and LP callback stay intact', async () => {
  messages.length=0;
  gmgnRows=[{
    address:'0x1111111111111111111111111111111111111111',name:'KUCING Protocol',symbol:'KUCING',
    price:0.01,price_change_percent:12,price_change_percent1h:2,volume:2000000,liquidity:100000,
    market_cap:1000000,history_highest_market_cap:1500000,swaps:100,buys:50,sells:50,holder_count:1000,
    top_10_holder_rate:0.2,launchpad:'pons_v2',launchpad_platform:'pons_v2',twitter_username:'fixture',
    website:'https://example.test',telegram:'',twitter_dup:0,telegram_dup:0,website_dup:0,twitter_change_flag:false,
    cto_flag:false,is_og:false,smart_degen_count:5,renowned_count:1,sniper_count:2,bot_degen_count:3,
    visiting_count:50,hot_level:1,rug_ratio:0,bundler_rate:0.01,entrapment_ratio:0,dev_team_hold_rate:0.01,
    top70_sniper_hold_rate:0.01,buy_tax:0,sell_tax:0,is_honeypot:0,is_renounced:1,is_open_source:1,
    lock_percent:1,burn_status:'yes',creation_timestamp:1700000000
  }];
  try {
    await onScreen('fast');
    const result=messages.at(-1);
    assert.match(result.text,/candidate/i);
    assert.match(result.text,/score/i);
    assert.match(result.text,/KUCING/);
    assert.doesNotMatch(result.text,/\b(kandidat|skor|komun|jelas|tipis|buang|lolos)\b/i);
    assert.equal(result.reply_markup.inline_keyboard[0][0].callback_data,'ca:0x1111111111111111111111111111111111111111');
  } finally {gmgnRows=[];}
});
