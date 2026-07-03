import "dotenv/config";
import express from "express";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Store } from "./store.js";
import { PaymentProvider } from "./solana.js";
import {
  quotePurchase,
  quoteCashout,
  projectPayouts,
  buildPools,
  settle,
  solToLamports,
  LAMPORTS_PER_SOL,
} from "./pari.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT || 3000);
const PAYMENT_MODE = process.env.PAYMENT_MODE || "simulation";
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "dev-admin-token";
const DATA_PATH = process.env.DATA_PATH || join(__dirname, "..", "data", "store.json");

// Default fee schedule (override per-market on creation). In basis points.
const DEFAULTS = {
  slotPriceLamports: solToLamports(Number(process.env.SLOT_PRICE_SOL || 1)),
  entryFeeBps: Number(process.env.ENTRY_FEE_BPS || 250), // 2.5% on every buy
  cashoutFeeBps: Number(process.env.CASHOUT_FEE_BPS || 500), // 5% on cash-out
  rakeBps: Number(process.env.RAKE_BPS || 0), // house cut of the pot at settlement
};

const store = new Store(DATA_PATH);
const payments = new PaymentProvider({
  mode: PAYMENT_MODE,
  escrowSecret: process.env.ESCROW_SECRET_KEY,
  escrowKeyPath: process.env.ESCROW_KEY_PATH || join(__dirname, "..", "data", ".escrow.json"),
});

const app = express();
app.use(express.json());
app.use(express.static(join(__dirname, "..", "public")));

const asyncH = (fn) => (req, res) => fn(req, res).catch((err) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.message || "internal error" });
});

function requireAdmin(req, res, next) {
  const token = req.get("x-admin-token");
  if (token !== ADMIN_TOKEN) return res.status(401).json({ error: "admin token required" });
  next();
}

// Serialize a market for the client, enriched with live pool/odds data.
function marketView(m) {
  const { pools, slotsByOutcome, total } = buildPools(m);
  const proj = projectPayouts(m);
  return {
    id: m.id,
    title: m.title,
    category: m.category,
    description: m.description,
    status: m.status,
    closesAt: m.closesAt,
    winningOutcomeId: m.winningOutcomeId,
    slotPriceLamports: m.slotPriceLamports,
    entryFeeBps: m.entryFeeBps,
    cashoutFeeBps: m.cashoutFeeBps,
    rakeBps: m.rakeBps,
    totalPotLamports: total,
    totalSlots: Object.values(slotsByOutcome).reduce((a, b) => a + b, 0),
    feesCollectedLamports: m.feesCollectedLamports,
    outcomes: m.outcomes.map((o) => ({
      id: o.id,
      label: o.label,
      poolLamports: pools[o.id],
      slots: slotsByOutcome[o.id],
      projectedPerSlotLamports: proj[o.id].perSlotLamports,
      projectedMultiple: Number(proj[o.id].multiple.toFixed(3)),
    })),
    betCount: m.bets.length,
  };
}

// ---- public config ----------------------------------------------------------
app.get("/api/config", (req, res) => {
  res.json({
    paymentMode: PAYMENT_MODE,
    simulation: payments.simulation,
    escrowAddress: payments.escrowAddress(),
    lamportsPerSol: LAMPORTS_PER_SOL,
    defaults: DEFAULTS,
  });
});

// ---- markets ----------------------------------------------------------------
app.get("/api/markets", (req, res) => {
  res.json({ markets: store.listMarkets().map(marketView) });
});

app.get("/api/markets/:id", (req, res) => {
  const m = store.getMarket(req.params.id);
  if (!m) return res.status(404).json({ error: "market not found" });
  res.json(marketView(m));
});

// Full bet ledger for a market (admin only — contains every wallet's position).
app.get("/api/markets/:id/bets", requireAdmin, (req, res) => {
  const m = store.getMarket(req.params.id);
  if (!m) return res.status(404).json({ error: "market not found" });
  res.json({ bets: m.bets, payouts: m.payouts });
});

// A single wallet's own positions in a market.
app.get("/api/markets/:id/positions", (req, res) => {
  const m = store.getMarket(req.params.id);
  if (!m) return res.status(404).json({ error: "market not found" });
  const user = req.query.user;
  if (!user) return res.status(400).json({ error: "user query param required" });
  res.json({ bets: m.bets.filter((b) => b.user === user) });
});

app.post("/api/markets", requireAdmin, (req, res) => {
  const b = req.body || {};
  if (!b.title || !Array.isArray(b.outcomes) || b.outcomes.length < 2) {
    return res.status(400).json({ error: "title and >= 2 outcomes required" });
  }
  const market = store.createMarket({
    title: b.title,
    category: b.category,
    description: b.description,
    outcomes: b.outcomes,
    closesAt: b.closesAt,
    slotPriceLamports: b.slotPriceLamports ?? DEFAULTS.slotPriceLamports,
    entryFeeBps: b.entryFeeBps ?? DEFAULTS.entryFeeBps,
    cashoutFeeBps: b.cashoutFeeBps ?? DEFAULTS.cashoutFeeBps,
    rakeBps: b.rakeBps ?? DEFAULTS.rakeBps,
  });
  res.status(201).json(marketView(market));
});

// ---- buying slots -----------------------------------------------------------

// Quote a purchase + return the payment instructions (where/how much to pay).
app.post("/api/markets/:id/quote", (req, res) => {
  const m = store.getMarket(req.params.id);
  if (!m) return res.status(404).json({ error: "market not found" });
  const { outcomeId, slots } = req.body || {};
  if (!m.outcomes.some((o) => o.id === outcomeId)) {
    return res.status(400).json({ error: "unknown outcome" });
  }
  const n = Number(slots);
  if (!Number.isInteger(n) || n <= 0) {
    return res.status(400).json({ error: "slots must be a positive integer" });
  }
  const quote = quotePurchase({
    slots: n,
    slotPriceLamports: m.slotPriceLamports,
    entryFeeBps: m.entryFeeBps,
  });
  res.json({
    ...quote,
    outcomeId,
    payTo: payments.escrowAddress(),
    paymentMode: PAYMENT_MODE,
    simulation: payments.simulation,
  });
});

// Record a bet after the buyer has paid the escrow.
app.post("/api/markets/:id/bets", asyncH(async (req, res) => {
  const m = store.getMarket(req.params.id);
  if (!m) return res.status(404).json({ error: "market not found" });
  if (m.status !== "open") return res.status(409).json({ error: `market is ${m.status}` });

  const { user, outcomeId, slots, paymentRef } = req.body || {};
  if (!user) return res.status(400).json({ error: "user (wallet) required" });
  if (!m.outcomes.some((o) => o.id === outcomeId)) {
    return res.status(400).json({ error: "unknown outcome" });
  }
  const n = Number(slots);
  if (!Number.isInteger(n) || n <= 0) {
    return res.status(400).json({ error: "slots must be a positive integer" });
  }

  const quote = quotePurchase({
    slots: n,
    slotPriceLamports: m.slotPriceLamports,
    entryFeeBps: m.entryFeeBps,
  });

  const verified = await payments.verifyIncoming({
    paymentRef,
    expectedLamports: quote.gross,
    fromUser: user,
  });
  if (!verified.ok) return res.status(402).json({ error: `payment failed: ${verified.error}` });

  const bet = store.addBet(m, { user, outcomeId, ...quote, paymentRef: verified.ref });
  res.status(201).json({ bet, market: marketView(m) });
}));

// ---- cashing out (selling before resolution) --------------------------------
app.post("/api/bets/:id/cashout", asyncH(async (req, res) => {
  const found = store.getBet(req.params.id);
  if (!found) return res.status(404).json({ error: "bet not found" });
  const { market, bet } = found;
  const { user } = req.body || {};

  if (bet.user !== user) return res.status(403).json({ error: "not your bet" });
  if (bet.status !== "active") return res.status(409).json({ error: `bet is ${bet.status}` });
  if (market.status !== "open") {
    return res.status(409).json({ error: `market is ${market.status}; cannot cash out` });
  }

  const { fee, refund } = quoteCashout({
    netStakeLamports: bet.net,
    cashoutFeeBps: market.cashoutFeeBps,
  });
  const paid = await payments.payout({ toUser: user, lamports: refund });
  if (!paid.ok) return res.status(502).json({ error: "payout failed" });

  bet.status = "cashed";
  bet.payoutRef = paid.ref;
  market.feesCollectedLamports += fee;
  market.payouts.push({ user, betId: bet.id, amount: refund, kind: "cashout", ref: paid.ref });
  store.save();

  res.json({ refundLamports: refund, feeLamports: fee, ref: paid.ref, market: marketView(market) });
}));

// ---- lifecycle: lock / settle / void ---------------------------------------
app.post("/api/markets/:id/lock", requireAdmin, (req, res) => {
  const m = store.getMarket(req.params.id);
  if (!m) return res.status(404).json({ error: "market not found" });
  if (m.status !== "open") return res.status(409).json({ error: `market is ${m.status}` });
  m.status = "locked";
  store.save();
  res.json(marketView(m));
});

app.post("/api/markets/:id/settle", requireAdmin, asyncH(async (req, res) => {
  const m = store.getMarket(req.params.id);
  if (!m) return res.status(404).json({ error: "market not found" });
  if (m.status === "settled" || m.status === "void") {
    return res.status(409).json({ error: `market already ${m.status}` });
  }
  const { winningOutcomeId } = req.body || {};
  const result = settle(m, winningOutcomeId);

  // Pay out (or refund) each entitled bettor.
  for (const p of result.payouts) {
    const paid = await payments.payout({ toUser: p.user, lamports: p.amount });
    const bet = m.bets.find((b) => b.id === p.betId);
    if (bet) {
      bet.status = p.kind === "refund" ? "refunded" : "won";
      bet.payoutRef = paid.ref;
    }
    m.payouts.push({ user: p.user, betId: p.betId, amount: p.amount, kind: p.kind, ref: paid.ref });
  }
  // Mark losing bets.
  for (const bet of m.bets) {
    if (bet.status === "active") bet.status = "lost";
  }

  m.status = result.voided ? "void" : "settled";
  m.winningOutcomeId = winningOutcomeId;
  m.feesCollectedLamports += result.rake;
  m.settledAt = new Date().toISOString();
  store.save();

  res.json({
    status: m.status,
    winningOutcomeId,
    distributableLamports: result.distributable,
    operatorRakeLamports: result.rake,
    payouts: result.payouts,
    market: marketView(m),
  });
}));

// Cancel a market and refund every active bettor their net stake.
app.post("/api/markets/:id/void", requireAdmin, asyncH(async (req, res) => {
  const m = store.getMarket(req.params.id);
  if (!m) return res.status(404).json({ error: "market not found" });
  if (m.status === "settled" || m.status === "void") {
    return res.status(409).json({ error: `market already ${m.status}` });
  }
  for (const bet of m.bets) {
    if (bet.status !== "active") continue;
    const paid = await payments.payout({ toUser: bet.user, lamports: bet.net });
    bet.status = "refunded";
    bet.payoutRef = paid.ref;
    m.payouts.push({ user: bet.user, betId: bet.id, amount: bet.net, kind: "refund", ref: paid.ref });
  }
  m.status = "void";
  m.settledAt = new Date().toISOString();
  store.save();
  res.json(marketView(m));
}));

app.listen(PORT, () => {
  console.log(`\n  Solana Sports Betting — parimutuel pools`);
  console.log(`  ➜  http://localhost:${PORT}`);
  console.log(`  payment mode: ${PAYMENT_MODE}${payments.simulation ? " (no real funds move)" : ""}`);
  console.log(`  escrow: ${payments.escrowAddress()}`);
  console.log(`  admin token: ${ADMIN_TOKEN === "dev-admin-token" ? "dev-admin-token (CHANGE ME)" : "set"}\n`);
});
