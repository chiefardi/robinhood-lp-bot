/**
 * Daily briefing — a once-a-day narrative (07:00 WIB / 00:00 UTC) over the last 24h of LP activity.
 *
 * Gathers: positions CLOSED in the last 24h (with WHY each closed — TP/SL/OOR/VFADE/manual),
 * the currently OPEN positions (value + unrealized), and lifetime stats. Then asks the briefing
 * LLM gateway (cc/claude-sonnet-5) to explain what went right/wrong — was the entry placed well? —
 * and suggest the ONE knob to tune so the bot gets smarter each day. A deterministic rule-based
 * analysis is used as fallback whenever the LLM is unavailable, so a briefing always goes out.
 *
 * The gateway key is a SECRET → lives in .env (RH_BRIEF_KEY), never in code. See config.ts env.
 */
import { readLedger, ledgerSummary } from "../chain/ledger.js";
import { listPositions } from "../chain/positions.js";
import { listV4Positions } from "../chain/v4/list.js";
import { ethUsd } from "../chain/price.js";
import { cfg, env } from "../config.js";
import { dataPath, readJson, writeJson } from "../util/files.js";
import { send } from "./tg.js";
import { esc } from "./format.js";
import { logger } from "../util/log.js";
import type { LedgerEntry } from "../types.js";
import {buildCashReport} from '../radar/cash-report.js';

const log = logger("briefing");
const DAY_MS = 24 * 60 * 60 * 1000;
const STATE_FILE = dataPath("briefing.json");

// ── formatting helpers ───────────────────────────────────────────────────────
const usd = (v: number) => (v >= 0 ? "+" : "-") + "$" + Math.abs(v).toFixed(2);
const pctS = (v: number | null) => (v == null ? "?" : (v >= 0 ? "+" : "") + v.toFixed(1) + "%");
const dur = (ms: number | null) => {
  if (!ms || ms <= 0) return "?";
  const h = ms / 3_600_000;
  if (h < 1) return `${Math.round(ms / 60_000)}m`;
  if (h < 24) return `${h.toFixed(1)}h`;
  return `${(h / 24).toFixed(1)}d`;
};
const clip = (s: string, n = 24) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

// Ledger entries closed BEFORE the `reason` field existed default to "manual". Infer a meaningful
// close reason from the realized PnL vs the configured TP/SL bands so historical days still read
// sensibly (going forward, auto-closes carry the real TP/SL/OOR/VFADE reason and this is a no-op).
function effReason(e: LedgerEntry): "TP" | "SL" | "OOR" | "VFADE" | "FVLOW" | "manual" {
  if (e.reason && e.reason !== "manual") return e.reason;
  const p = e.pnlPct;
  if (p == null) return e.reason ?? "manual";
  const tp = cfg.autoLp.tpPct || 8,
    sl = cfg.autoLp.slPct || 15;
  if (p >= tp * 0.8) return "TP";
  if (p <= -sl * 0.8) return "SL";
  if (Math.abs(p) < 1.5) return "OOR"; // near-breakeven exit ≈ range/volume close
  return e.reason ?? "manual";
}
// The analysis renders as a clean MONOSPACE block (<pre>) — reads like a terminal log. The LLM
// answers in Markdown, and bold can't nest inside <pre>, so strip the markers (keep the emoji
// section labels) and escape < > & so the content can't break the HTML parse.
function analysisMono(raw: string): string {
  const s = raw
    .trim()
    .replace(/\*\*(.+?)\*\*/gs, "$1") // drop **bold** markers (no bold inside <pre>)
    .replace(/__(.+?)__/gs, "$1")
    .replace(/`([^`]+)`/g, "$1") // drop `code` backticks
    .replace(/^\s{0,3}#{1,6}\s+/gm, "") // drop "# " headings
    .replace(/\n{3,}/g, "\n\n"); // collapse big gaps
  return "<pre>" + esc(s) + "</pre>";
}

// WIB (UTC+7) calendar date/time — used for the 07:00 trigger + the header stamp.
function wibParts() {
  const w = new Date(Date.now() + 7 * 3_600_000);
  return { date: w.toISOString().slice(0, 10), hour: w.getUTCHours(), label: w.toISOString().slice(0, 16).replace("T", " ") + " WIB" };
}

interface BriefData {
  closes: LedgerEntry[]; // closed by the bot in the last 24h (pnl known)
  openCount: number;
  openValUsd: number;
  openUnrealUsd: number;
  openOor: number;
  openList: { sym: string; inRange: boolean; pnlUsd: number | null; ver: "v3" | "v4" }[];
  life: ReturnType<typeof ledgerSummary>;
  ethPx: number;
  dayPnlUsd: number;
  dayFeeUsd: number;
  wins: number;
  losses: number;
  byReason: Record<string, { n: number; pnlUsd: number }>;
}

// ── data gathering ───────────────────────────────────────────────────────────
async function gather(): Promise<BriefData> {
  const now = Date.now();
  const closes = readLedger()
    .filter((e) => e.source === "bot" && e.closedAt != null && now - e.closedAt < DAY_MS && e.pnlEth != null)
    .sort((a, b) => (b.closedAt ?? 0) - (a.closedAt ?? 0))
    .map((e) => ({ ...e, reason: effReason(e) })); // fill inferred reason for pre-`reason` history

  const ethPx = await ethUsd().catch(() => 0);

  // open positions — best-effort; a slow RPC must never block the briefing
  const [v3, v4] = await Promise.all([
    listPositions().catch((e) => {
      log.warn(`brief listPositions failed: ${(e as Error).message.slice(0, 80)}`);
      return [] as Awaited<ReturnType<typeof listPositions>>;
    }),
    listV4Positions(0).catch((e) => {
      log.warn(`brief listV4Positions failed: ${(e as Error).message.slice(0, 80)}`);
      return [] as Awaited<ReturnType<typeof listV4Positions>>;
    }),
  ]);

  let openValUsd = 0,
    openUnrealUsd = 0,
    openOor = 0;
  const openList: BriefData["openList"] = [];
  for (const r of v4) {
    openValUsd += r.valueUsd || 0;
    const unreal = r.depEth != null && ethPx ? (r.valueUsd || 0) - r.depEth * ethPx : null;
    if (unreal != null) openUnrealUsd += unreal;
    if (!r.inRange) openOor++;
    openList.push({ sym: r.pair || r.sym, inRange: r.inRange, pnlUsd: unreal, ver: "v4" });
  }
  for (const r of v3) {
    if (ethPx) {
      openValUsd += (r.valEth || 0) * ethPx;
      if (r.pnlEth != null) openUnrealUsd += r.pnlEth * ethPx;
    }
    if (!r.inRange) openOor++;
    openList.push({ sym: r.tokenSym, inRange: r.inRange, pnlUsd: r.pnlEth != null && ethPx ? r.pnlEth * ethPx : null, ver: "v3" });
  }

  let dayPnlUsd = 0,
    dayFeeUsd = 0,
    wins = 0,
    losses = 0;
  const byReason: Record<string, { n: number; pnlUsd: number }> = {};
  for (const e of closes) {
    const pu = e.pnlUsd ?? (e.pnlEth != null && ethPx ? e.pnlEth * ethPx : 0);
    dayPnlUsd += pu;
    dayFeeUsd += (e.feeEth || 0) * ethPx;
    if ((e.pnlEth ?? 0) > 0) wins++;
    else losses++;
    const k = e.reason ?? "manual";
    (byReason[k] ??= { n: 0, pnlUsd: 0 }).n++;
    byReason[k].pnlUsd += pu;
  }

  return {
    closes,
    openCount: v3.length + v4.length,
    openValUsd,
    openUnrealUsd,
    openOor,
    openList,
    life: ledgerSummary(),
    ethPx,
    dayPnlUsd,
    dayFeeUsd,
    wins,
    losses,
    byReason,
  };
}

// ── LLM analysis (briefing gateway) ──────────────────────────────────────────
function llmDataBlock(d: BriefData): string {
  const a = cfg.autoLp,
    s = cfg.scan;
  const L: string[] = [];
  L.push(`ETH=$${d.ethPx.toFixed(0)}`);
  L.push(`24h: closed=${d.closes.length} win=${d.wins} loss=${d.losses} realizedPnL=${usd(d.dayPnlUsd)} feesEarned=$${d.dayFeeUsd.toFixed(2)}`);
  L.push(`open=${d.openCount} value=$${d.openValUsd.toFixed(0)} unrealized=${usd(d.openUnrealUsd)} outOfRange=${d.openOor}`);
  L.push(`lifetime: trades=${d.life.count} winRate=${d.life.winRate.toFixed(0)}% totalPnL=${usd(d.life.pnlUsd)} feesTotal=~${(d.life.feeEth * d.ethPx).toFixed(2)}`);
  L.push("");
  L.push("CLOSED_24H  (token | reason | pnl% | pnlUsd | heldTime | mintMode):");
  if (!d.closes.length) L.push("  (nothing closed in the last 24h)");
  for (const e of d.closes.slice(0, 12)) {
    L.push(`  ${clip(e.pair || e.sym, 28)} | ${e.reason || "manual"} | ${pctS(e.pnlPct)} | ${usd(e.pnlUsd ?? 0)} | ${dur(e.heldMs)} | ${e.mode}`);
  }
  L.push("");
  L.push("OPEN_NOW (token | inRange | unrealizedUsd):");
  if (!d.openList.length) L.push("  (none)");
  for (const o of d.openList.slice(0, 20)) L.push(`  ${clip(o.sym, 28)} | ${o.inRange ? "in" : "OUT"} | ${o.pnlUsd == null ? "?" : usd(o.pnlUsd)}`);
  L.push("");
  L.push("STRATEGY_CONFIG (the knobs you can suggest tuning):");
  L.push(`  autoClose: tp=${a.tpPct}% sl=${a.slPct}% closeOor=${a.closeOor} oorGraceMin=${a.oorGraceMin} oorAction=${a.oorAction} volFadeX=${a.volFadeX} compound=${a.compound}`);
  L.push(`  hunt: minScore=${s.minScore} mcap=$${s.screenMinMcap}-${s.screenMaxMcap || "∞"} minVol=$${s.minVolUsd} minPoolFees=$${s.minPoolFeesUsd} minPoolLiq=$${s.minPoolLiqUsd} minSpikeX=${s.minSpikeX} cooldownMin=${s.cooldownMin} maxOpen=${a.maxOpen} dailyCapEth=${a.dailyCapEth}`);
  return L.join("\n");
}

async function briefLlm(dataBlock: string): Promise<string | null> {
  if (!env.briefKey) {
    log.info("brief LLM skip — RH_BRIEF_KEY is empty (using deterministic fallback)");
    return null;
  }
  const system =
    "You are a quantitative analyst for a liquidity-provider (LP) bot on Uniswap v4 DEX (Robinhood chain). " +
    "The bot automatically hunts tokens, opens LP positions in high-fee pools (3-5%), and automatically closes at take-profit (TP), stop-loss (SL), " +
    "out-of-range (OOR), or volume-fade (VFADE). You receive a summary of the last 24 hours of activity and the strategy configuration. " +
    "Write SHORT, SHARP analysis in English only, in a direct, conversational operator style. Preserve token names and symbols exactly.\n" +
    "Use EXACTLY 3 sections, each one short paragraph, STARTING with a label enclosed in **...**:\n" +
    "**💚 PROFIT** — why profitable positions made money, and whether the entry and range were well placed.\n" +
    "**🩸 LOSS** — why losing positions lost money: did we position them poorly? (late entry after peak volume? range too narrow, causing a quick OOR? poor-quality token or rug?). Be honest, not artificially positive.\n" +
    "**🔧 FIX** — ONE configuration change with the biggest impact for tomorrow (name the setting and a concrete number).\n" +
    "You may use **bold** for token names and key figures. Do NOT use Markdown headings (#) or HTML tags. " +
    "Use actual figures and token names from the data. Keep the total to about 180 words maximum; give insights directly without repeating the raw data.";
  const body = JSON.stringify({
    model: env.briefModel,
    messages: [
      { role: "system", content: system },
      { role: "user", content: dataBlock },
    ],
    stream: false,
    temperature: 0.4,
    // cc/claude-sonnet-5 spends completion tokens on THINKING before it writes any content; a big
    // analytical prompt can burn a small budget entirely on thinking (→ finish=max_tokens, empty
    // content). Give generous headroom so thinking + the ~180-word answer both fit. It's a once-a-day
    // call — the extra tokens are free in practice.
    max_tokens: 4000,
  });
  // Retry once: the gateway occasionally returns HTTP 200 with an EMPTY content body (cold model /
  // transient). A second attempt almost always fills it; only then do we fall back to the rule-based text.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(env.briefUrl, {
        method: "POST",
        headers: { Authorization: `Bearer ${env.briefKey}`, "Content-Type": "application/json" },
        body,
        signal: AbortSignal.timeout(70_000),
      });
      if (!res.ok) {
        log.warn(`brief LLM HTTP ${res.status} (attempt ${attempt + 1})`);
        if (attempt === 0) continue;
        return null;
      }
      const j: any = await res.json();
      const ch = j?.choices?.[0] ?? {};
      const msg = ch.message ?? {};
      const text = String(msg.content || msg.reasoning || msg.reasoning_content || ch.text || "").trim();
      if (text) return text;
      log.warn(`brief LLM empty — finish=${ch.finish_reason} usage=${JSON.stringify(j?.usage)} (attempt ${attempt + 1})`);
      if (attempt === 0) continue;
      return null;
    } catch (e) {
      log.warn(`brief LLM failed: ${(e as Error).message.slice(0, 100)} (attempt ${attempt + 1})`);
      if (attempt === 0) continue;
      return null;
    }
  }
  return null;
}

// Deterministic analysis — rule-based, always available so a briefing never comes out empty.
function fallbackAnalysis(d: BriefData): string {
  const R = d.byReason;
  const out: string[] = [];
  if (R.TP?.n) out.push(`🎯 ${R.TP.n} hit take-profit (${usd(R.TP.pnlUsd)}) — well-timed entry, range captured the move. Keep this pattern.`);
  if (R.VFADE?.n) out.push(`📉 ${R.VFADE.n} volume-fade exits (${usd(R.VFADE.pnlUsd)}) — exited before the pool went inactive, good timing.`);
  if (R.SL?.n) out.push(`🛑 ${R.SL.n} hit stop-loss (${usd(R.SL.pnlUsd)}) — possibly late entry (after volume peaked) or a token sell-off. Check whether minSpikeX is too low, causing entries to chase spikes that have already passed.`);
  if (R.OOR?.n) out.push(`↔️ ${R.OOR.n} out-of-range (${usd(R.OOR.pnlUsd)}) — price left the band; the range may be too narrow for this token's volatility${cfg.autoLp.oorAction === "close" ? " (oorAction is still close, not recenter)" : ""}.`);
  if (!d.closes.length) out.push("No positions closed in the last 24 hours — the bot is holding or candidates are scarce.");

  // one concrete suggestion, picked by the dominant failure mode
  let sugg: string;
  const sl = R.SL?.n ?? 0,
    oor = R.OOR?.n ?? 0;
  if (oor >= 2 && oor >= sl) sugg = "Widen the range band (in-range mode width) or increase oorGraceMin — most exits were OOR, suggesting the range is too narrow.";
  else if (sl >= 2) sugg = `Tighten entries: increase minSpikeX (currently ${cfg.scan.minSpikeX}) to target genuinely active pools and reduce stop-losses from late entries.`;
  else if (!d.closes.length) sugg = `Loosen the hunt filters: lower minScore (currently ${cfg.scan.minScore}) or raise screenMaxMcap to find more candidates.`;
  else if (d.wins >= d.losses && d.wins > 0) sugg = `The strategy is net-positive — consider increasing maxOpen (currently ${cfg.autoLp.maxOpen}) / dailyCapEth (currently ${cfg.autoLp.dailyCapEth}) to deploy more capital.`;
  else sugg = "The sample is still small — collect a few more days of data before aggressive tuning.";
  out.push("");
  out.push("🧠 Suggestion for tomorrow: " + sugg);
  return out.join("\n");
}

// ── render ───────────────────────────────────────────────────────────────────
export async function buildBriefing(): Promise<string> {
  return buildCashReport('briefing');
}

/** Legacy manual-position report retained separately; not used by the auto pilot. */
export async function buildLegacyBriefing(): Promise<string> {
  const d = await gather();
  const analysis = (await briefLlm(llmDataBlock(d))) || fallbackAnalysis(d);
  const { label } = wibParts();

  const H: string[] = [];
  H.push(`📋 <b>DAILY BRIEFING</b> — <i>${esc(label)}</i>`);
  H.push("━━━━━━━━━━━━━━━━━━━");
  const wl = `${d.wins}W/${d.losses}L`;
  H.push(`💰 <b>PnL 24h:</b> ${esc(usd(d.dayPnlUsd))}  (${wl}) · fee ~$${d.dayFeeUsd.toFixed(2)}`);
  H.push(`📊 <b>Open:</b> ${d.openCount} · value $${d.openValUsd.toFixed(0)} · unreal ${esc(usd(d.openUnrealUsd))}${d.openOor ? ` · <b>${d.openOor} OOR</b>` : ""}`);
  H.push(`🏆 <b>Lifetime:</b> ${d.life.count} trade · ${d.life.winRate.toFixed(0)}% win · ${esc(usd(d.life.pnlUsd))}`);

  // per-position 24h closes — GROUPED by reason (with breathing room between groups) so it isn't a
  // dense wall; the flat "dead-pool" OOR parks (usually ~$0, same token 3×) collapse to one line.
  H.push("");
  H.push(`📕 <b>CLOSED IN 24 HOURS</b> · ${d.closes.length} pos`);
  if (!d.closes.length) {
    H.push("   <i>— none —</i>");
  } else {
    const groups: [string, string, NonNullable<LedgerEntry["reason"]>][] = [
      ["🎯", "TAKE-PROFIT", "TP"],
      ["🛑", "STOP-LOSS", "SL"],
      ["📉", "VOLUME-FADE", "VFADE"],
      ["🐌", "INACTIVE FEES (rotation)", "FVLOW"],
      ["✋", "MANUAL", "manual"],
    ];
    for (const [emo, label, reason] of groups) {
      const g = d.closes.filter((e) => e.reason === reason);
      if (!g.length) continue;
      H.push("");
      H.push(`${emo} <b>${label}</b> · ${g.length}`);
      for (const e of g.slice(0, 8)) {
        H.push(`   <code>${esc(clip(e.pair || e.sym, 22))}</code>  ${esc(pctS(e.pnlPct))} · ${esc(usd(e.pnlUsd ?? 0))} · ${esc(dur(e.heldMs))}`);
      }
      if (g.length > 8) H.push(`   <i>…+${g.length - 8} more</i>`);
    }
    // OOR cluster → one collapsed line (token×count + total pnl) instead of many repeated ~$0 rows
    const oor = d.closes.filter((e) => e.reason === "OOR");
    if (oor.length) {
      const cnt: Record<string, number> = {};
      for (const e of oor) {
        const nm = (e.pair || e.sym).split("/").find((x) => x !== "USDG" && x !== "ETH" && x !== "WETH") || (e.pair || e.sym);
        cnt[nm] = (cnt[nm] || 0) + 1;
      }
      const names = Object.entries(cnt)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 6)
        .map(([n, c]) => (c > 1 ? `${clip(n, 12)}×${c}` : clip(n, 12)));
      const oorPnl = oor.reduce((s, e) => s + (e.pnlUsd ?? 0), 0);
      H.push("");
      H.push(`↔️ <b>OUT-OF-RANGE</b> · ${oor.length} · ${esc(usd(oorPnl))}`);
      H.push(`   <i>${esc(names.join(", "))}${Object.keys(cnt).length > names.length ? "…" : ""} — inactive range, ~0 fees</i>`);
    }
  }

  // open positions snapshot (compact)
  if (d.openList.length) {
    H.push("");
    H.push("📗 <b>OPEN POSITIONS:</b>");
    for (const o of d.openList.slice(0, 12)) {
      H.push(`${o.inRange ? "🟢" : "🔴"} <b>${esc(clip(o.sym, 26))}</b> ${o.pnlUsd == null ? "" : esc(usd(o.pnlUsd))} ${o.inRange ? "" : "<i>(OOR)</i>"}`.trimEnd());
    }
    if (d.openList.length > 12) H.push(`   <i>…+${d.openList.length - 12} more</i>`);
  }

  H.push("");
  H.push("🧠 <b>ANALYSIS</b>" + (env.briefKey ? "" : " <i>(rule-based)</i>") + ":");
  H.push(analysisMono(analysis));

  return H.join("\n");
}

// Telegram caps a message at 4096 chars — split on line boundaries.
async function sendChunked(text: string): Promise<void> {
  const LIMIT = 3900;
  if (text.length <= LIMIT) {
    await send(text);
    return;
  }
  const lines = text.split("\n");
  let buf = "";
  for (const ln of lines) {
    if (buf.length + ln.length + 1 > LIMIT) {
      await send(buf);
      buf = "";
    }
    buf += (buf ? "\n" : "") + ln;
  }
  if (buf) await send(buf);
}

/** Build + push the briefing to the owner chat. `src` is just for the log line. */
export async function runBriefing(src: "auto" | "manual" = "manual"): Promise<void> {
  try {
    log.info(`briefing (${src}) — building…`);
    const text = await buildBriefing();
    await sendChunked(text);
    log.info(`briefing (${src}) sent (${text.length} char)`);
  } catch (e) {
    log.warn(`briefing (${src}) failed: ${(e as Error).message.slice(0, 120)}`);
    if (src === "manual") await send(`❌ Briefing failed: ${esc((e as Error).message.slice(0, 120))}`);
  }
}

// ── scheduler: fire once per WIB day, at/after 07:00 WIB (00:00 UTC) ──────────
// Keyed on the WIB calendar date persisted to disk, so a restart never double-fires and a bot that
// was down at exactly 07:00 still catches up the moment it comes back (as long as it's still that day).
let lastFiredWib = "";

function tick(): void {
  const { date, hour } = wibParts();
  if (date !== lastFiredWib && hour >= 7) {
    lastFiredWib = date;
    try {
      writeJson(STATE_FILE, { lastFiredWib: date });
    } catch {
      /* non-fatal */
    }
    void runBriefing("auto");
  }
}

export function startBriefingScheduler(): void {
  lastFiredWib = readJson<{ lastFiredWib?: string }>(STATE_FILE, {}).lastFiredWib ?? "";
  // If we boot on a fresh day BEFORE 7am WIB, don't fire a briefing for the day that just ended.
  // Seeding lastFiredWib="" would make the first post-7am tick fire — which is what we want. But if we
  // boot fresh and it's already well past 7am with no state yet, seed to "yesterday" so we DO catch up
  // today. Simplest correct behaviour: leave persisted value as-is; empty → first tick after 7am fires.
  setInterval(tick, 5 * 60_000); // check every 5 min
  setTimeout(tick, 20_000); // and once shortly after boot (catch-up if we're already past 7am)
  log.info(`briefing scheduler active (07:00 WIB) — last=${lastFiredWib || "never"}`);
}
