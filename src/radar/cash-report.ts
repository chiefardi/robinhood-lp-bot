import {RiskStore,riskStore} from './auto-risk.js';
import {esc} from '../telegram/format.js';

type State=ReturnType<RiskStore['reportingSnapshot']>;
type Entry=NonNullable<State['session']>['entries'][number];
const money=(n:number|null)=>n==null?'unavailable':`${n<0?'-':'+'}$${Math.abs(n).toFixed(2)}`;
function totals(entries:Entry[]){
 const closed=entries.filter(e=>e.status==='closed');
 const known=closed.filter(e=>e.basisUsd!=null&&e.realizedNetUsd!=null);
 const pnls=known.map(e=>e.realizedNetUsd!-e.basisUsd!);
 const wins=pnls.filter(n=>n>1e-8).length,losses=pnls.filter(n=>n< -1e-8).length;
 return {count:closed.length,known:known.length,wins,losses,flat:pnls.length-wins-losses,
  pnlUsd:known.length===closed.length?pnls.reduce((n,p)=>n+p,0):null};
}
/** One immutable cash-basis source for reports; never revalue historic costs at today's ETH price. */
export function summarizeCash(state:State,now=Date.now()){
 if(!state.session)throw new Error('Cash ledger unavailable or session not initialized');
 const sessions=[...state.history,...(state.session?[state.session]:[])];
 const entries=sessions.flatMap(s=>s.entries),closed=entries.filter(e=>e.status==='closed');
 const validTime=(e:Entry)=>e.closedAt!=null&&e.closedAt>=e.at&&e.closedAt<=now;
 const undated=closed.filter(e=>!validTime(e)).length;
 const dayEntries=closed.filter(e=>validTime(e)&&e.closedAt!>now-86_400_000);
 const day=totals(dayEntries);if(undated)day.pnlUsd=null;
 const open=entries.filter(e=>e.status!=='closed'&&e.status!=='aborted');
 const fresh=open.filter(e=>e.status==='open'&&e.basisUsd!=null&&e.markUsd!=null&&e.markAt!=null&&e.markAt<=now&&now-e.markAt<=60_000);
 return {now,sessionId:state.session?.id,paused:state.session?.paused,pauseReason:state.session?.pauseReason,
  lifetime:totals(entries),session:totals(state.session?.entries??[]),day,undated,dayEntries,
  recent:[...closed].sort((a,b)=>(b.closedAt??b.at)-(a.closedAt??a.at)).slice(0,10),
  open:{count:open.length,freshCount:fresh.length,valueUsd:fresh.length===open.length?fresh.reduce((n,e)=>n+e.markUsd!,0):null,
   pnlUsd:fresh.length===open.length?fresh.reduce((n,e)=>n+e.markUsd!-e.basisUsd!,0):null},
 };
}
export function renderCashReport(r:ReturnType<typeof summarizeCash>,kind:'pnl'|'briefing'){
 const label=new Date(r.now+7*3_600_000).toISOString().slice(0,16).replace('T',' ')+' WIB';
 const rows=kind==='briefing'?r.dayEntries.slice(-10).reverse():r.recent;
 return [
  `<b>${kind==='briefing'?'DAILY BRIEFING':'AUTO-LP CASH PnL'}</b> — ${label}`,
  'Source: confirmed auto-LP cash settlements; not LP-versus-HODL or wallet deposit flows.',
  `<b>Realized 24h:</b> ${money(r.day.pnlUsd)} · ${r.day.count} dated closes · ${r.day.wins}W/${r.day.losses}L/${r.day.flat} flat`,
  ...(r.undated?[`24h coverage incomplete: ${r.undated} historical close time(s) unverified; not counted as zero.`]:[]),
  `<b>All recorded sessions:</b> ${money(r.lifetime.pnlUsd)} · ${r.lifetime.count} closed · ${r.lifetime.wins}W/${r.lifetime.losses}L/${r.lifetime.flat} flat`,
  `<b>Current session realized:</b> ${money(r.session.pnlUsd)}`,
  `<b>Open/unresolved:</b> ${r.open.count} · estimated net liquidation value ${money(r.open.valueUsd)} · unrealized ${money(r.open.pnlUsd)}`,
  ...(r.open.freshCount<r.open.count?['Open valuation unavailable or stale; not reported as $0.']:[]),
  'Fee breakdown: unavailable separately; collected fees and execution costs are included in net cash settlement.',
  `Entries: ${r.paused?'PAUSED — '+esc(r.pauseReason??'reason unavailable'):'not paused (screening and risk gates still apply)'}`,
  '',`<b>${kind==='briefing'?'CLOSED IN LAST 24 HOURS':'RECENT CLOSED POSITIONS'}</b>`,
  ...(rows.length?rows.map(e=>`#${esc(e.tokenId??'?')} · ${esc(e.token.slice(0,10))}… · ${esc(e.closeReason??'unknown reason')} · ${money(e.basisUsd!=null&&e.realizedNetUsd!=null?e.realizedNetUsd-e.basisUsd:null)}${e.closedAt?' · '+new Date(e.closedAt+7*3_600_000).toISOString().slice(0,16).replace('T',' ')+' WIB':' · close time unverified'}`):[r.undated?'No dated closes available; historical coverage is incomplete.':'None.']),
  ...(kind==='briefing'?[`Rule-based summary: ${r.open.count} open/unresolved; ${r.paused?'new entries paused':'new entries subject to screening'}. No strategy recommendation inferred from this small sample.`]:[]),
  'USD cash basis is fixed at entry and settlement. Unrelated wallet flows/manual LPs are excluded. Quotes are estimates, not guaranteed fills.',
 ].join('\n');
}
export function buildCashReport(kind:'pnl'|'briefing',store:RiskStore=riskStore,now=Date.now()){
 return renderCashReport(summarizeCash(store.reportingSnapshot(),now),kind);
}
