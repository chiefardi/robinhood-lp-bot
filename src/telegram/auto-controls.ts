import { RiskStore, PILOT_LIMITS, validateExitSettings, type ExitSettings } from '../radar/auto-risk.js';
interface AutoSettings extends ExitSettings {enabled:boolean;entryPaused:boolean;sizeUsd:number;compound:boolean;oorAction:string;closeOor:boolean;volFadeX:number;minFeePerHourUsd:number;manageSec:number}
interface Controls {store:RiskStore;persist:()=>void;start:()=>void;stop:()=>void;send:(text:string)=>Promise<unknown>;walletBusy:()=>boolean;checkFunding:()=>Promise<void>}
function ready(a:AutoSettings):void {
  validateExitSettings(a);
  if(a.slPct<=0 || (a.tpPct<=0&&a.trailActivationPct<=0))throw new Error('Configure hard SL and either fixed TP or trailing TP first');
  if(a.compound||a.oorAction==='rebalance'||a.closeOor||a.volFadeX>0||a.minFeePerHourUsd>0)throw new Error('Pilot supports cash TP/SL/trailing only; turn off compound, re-range, OOR and other legacy exits');
  if(!Number.isFinite(a.sizeUsd)||a.sizeUsd<=0||a.sizeUsd>30)throw new Error('Pilot entry size must be at most $30');
}
/** Explicit operator controls; configuring a session never enables entries. */
export async function riskAutoCommand(arg:string,a:AutoSettings,d:Controls):Promise<void> {
  const [command='',first='',second='']=arg.trim().split(/\s+/);
  const cmd=command.toLowerCase();
  try {
    const pauseForSettings=()=>{d.store.pauseEntries('Exit settings changed; review then resume');a.entryPaused=true;};
    if(['trail','tp','sl','session','resume'].includes(cmd)&&d.walletBusy())throw new Error('Wallet operation in progress; wait before changing protection');
    if(cmd==='session'){
      if(a.enabled||d.walletBusy())throw new Error('Stop auto and wait for wallet activity before starting a new session');
      d.store.startSession();a.entryPaused=true;d.persist();
      await d.send('New pilot session created, entries PAUSED. Limits: 3 concurrent positions with reusable settled slots, no hourly entry delay, one wallet workflow at a time, $90 outstanding cost basis, -$15 cumulative session loss circuit. Auto remains OFF.');return;
    }
    if(cmd==='pause'){
      d.store.pauseEntries();a.entryPaused=true;d.persist();
      await d.send(`Entries PAUSED. ${a.enabled?'Exit monitoring remains ON.':'Auto is OFF; exit monitoring is stopped.'}`);return;
    }
    if(cmd==='on'){
      ready(a);if(!d.store.hasSession())throw new Error('Initialize /auto session first');
      // Starting monitors must never implicitly unpause new spending.
      d.store.pauseEntries('Monitoring started; explicit resume required');a.entryPaused=true;a.enabled=true;d.persist();d.start();
      await d.send('Auto exit monitoring ON (REAL transactions). Entries remain PAUSED. Review /auto status, then /auto resume to permit screened entries. /auto pause stops entries only; /auto off also stops exits.');return;
    }
    if(cmd==='resume'){
      ready(a);if(!a.enabled)throw new Error('Start exit monitoring with /auto on first');
      await d.checkFunding();
      if(d.walletBusy())throw new Error('Wallet operation started during funding check');
      ready(a);if(!a.enabled)throw new Error('Monitoring stopped during funding check');
      d.store.resumeEntries();a.entryPaused=false;d.persist();
      await d.send('Entries RESUMED, subject to persistent session caps, mandatory GMGN checks and exact-pool verification. Real funds may be spent.');return;
    }
    if(cmd==='off'){
      d.store.pauseEntries('Auto fully stopped');a.entryPaused=true;a.enabled=false;d.persist();d.stop();
      await d.send('AUTO OFF. Entries AND exit monitoring are stopped. Existing positions are NOT closed; TP/SL/trailing will not protect them while off.');return;
    }
    if(cmd==='trail'){
      if(first==='off'){pauseForSettings();a.trailActivationPct=0;d.persist();await d.send('Trailing TP OFF. Entries paused; stored peaks preserved. Review fixed TP / SL before resuming.');return;}
      const activation=Number(first),giveback=Number(second);
      if(!first||!second||!Number.isFinite(activation)||activation<=0||!Number.isFinite(giveback)||giveback<=0||giveback>=activation)throw new Error('Invalid trailing settings; use /auto trail 10 5 (activation %, giveback percentage points)');
      pauseForSettings();a.trailActivationPct=activation;a.trailGivebackPct=giveback;a.tpPct=0;d.persist();
      await d.send(`Trailing TP: arms at +${activation}%, exits ${giveback} percentage points below peak estimated cash PnL. Fixed TP disabled; hard SL unchanged. Entries paused pending review/resume. Peaks persist across restarts. This is not a guaranteed fill.`);return;
    }
    if(cmd==='tp'||cmd==='sl'){
      const value=Number(first);
      if(!first||!Number.isFinite(value)||value<0||(cmd==='sl'&&value>100))throw new Error('Invalid percent');
      pauseForSettings();if(cmd==='tp'){a.tpPct=value;if(value>0)a.trailActivationPct=0;}else a.slPct=value;
      d.persist();await d.send(`${cmd==='tp'?'Fixed TP':'Hard SL'}: ${value>0?`${cmd==='tp'?'+':'-'}${value}%`:'OFF'}.${cmd==='tp'&&value>0?' Trailing disabled.':''} Based on estimated liquidation versus fixed cash basis; not guaranteed execution.`);return;
    }
    if(cmd==='oor'){throw new Error('OOR auto-close is disabled in the pilot; single-sided parked positions begin out of range');}
    const s=d.store.snapshot();
    const entries=s?.entries??[];
    const occupied=entries.filter(e=>e.status!=='closed'&&e.status!=='aborted');
    const used=occupied.reduce((n,e)=>n+Math.max(e.sizeUsd,e.basisUsd??0),0);
    const block=d.store.entryBlockReason(a.sizeUsd);
    const realized=entries.filter(e=>e.status==='closed').reduce((n,e)=>n+(e.realizedNetUsd??0)-(e.basisUsd??0),0);
    const lines=[
      `Alexandria Auto — ${a.enabled?'monitoring ON':'OFF'}; entries ${a.entryPaused||s?.paused?'PAUSED':block?'BLOCKED':'enabled'}`,
      `Session: ${s?s.id:'not initialized'}`,
      `Size: $${a.sizeUsd}; ${occupied.length}/${PILOT_LIMITS.maxOpen} occupied slots; ${Math.max(0,PILOT_LIMITS.maxOpen-occupied.length)} free; no hourly entry delay; outstanding basis $${used.toFixed(2)}/$90; cumulative loss circuit -$15.`,
      'One wallet workflow at a time; every entry needs fresh screening and confirmed accounting.',
      `History: ${entries.length} attempts retained; settled slots reusable. ${block?'Entry gate: '+block:'Entry gate: ready (screening still required)'}.`,
      `Hard SL: ${a.slPct>0?'-'+a.slPct+'%':'off'}; fixed TP: ${a.tpPct>0?'+'+a.tpPct+'%':'off'}; trailing: ${a.trailActivationPct>0?'+'+a.trailActivationPct+'% / '+a.trailGivebackPct+'pp':'off'}.`,
      `Timed TP: ${(a.timedTpMin??0)>0?'after '+a.timedTpMin+'m at >= +'+a.timedTpPct+'% net':'off'}; maximum hold: ${(a.maxHoldMin??0)>0?a.maxHoldMin+'m':'off'}.`,
      `Realized session cash PnL: $${realized.toFixed(2)}. Immutable cash basis, not LP-versus-HODL.`,
      ...(s?.pauseReason?[`Pause: ${s.pauseReason}`]:[]),
      ...[...occupied,...entries.filter(e=>!occupied.includes(e)).slice(-5)].map(e=>[
        `#${e.tokenId??'pending'} ${e.status}: basis ${e.basisUsd==null?'unknown':'$'+e.basisUsd.toFixed(2)}, peak ${e.peakPct==null?'unknown':e.peakPct.toFixed(2)+'%'}, ${e.closeReason??'no exit latched'}`,
        ...(e.status==='open'?[
          `Trailing ${e.armed&&a.trailActivationPct>0?'ARMED; exit at '+((e.peakPct??0)-a.trailGivebackPct).toFixed(2)+'% net':'not armed'}.`,
          ...((a.timedTpMin??0)>0?[`Timed TP eligible from ${new Date(e.at+a.timedTpMin!*60_000).toISOString()} at >= +${a.timedTpPct}% net.`]:[]),
          ...((a.maxHoldMin??0)>0?[`Maximum hold deadline ${new Date(e.at+a.maxHoldMin!*60_000).toISOString()}.`]:[]),
        ]:[]),
      ].join('\n')),
      'Quotes include uncollected fees, swap haircuts and a gas reserve. Settlement can differ. Polling may miss spikes.',
      '/auto session · /auto trail 10 5 · /auto sl 10 · /auto on · /auto resume · /auto pause · /auto off',
      'Timed exits require fresh quotes; deadlines are not guaranteed fills. No automatic re-range or compounding. Unknown executions require reconciliation.',
    ];
    await d.send(lines.join('\n'));
  }catch(e:any){await d.send(`Auto unchanged or paused: ${String(e?.message??e).replace(/[<>&]/g,'')}`);}
}
