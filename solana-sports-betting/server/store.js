// Tiny JSON-file persistence. Good enough for an MVP / demo; swap for a real
// database (Postgres, SQLite) before production. Writes are synchronous and
// debounced via a simple "save after every mutation" approach.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

export class Store {
  constructor(path) {
    this.path = path;
    this.data = { markets: [] };
    this._load();
  }

  _load() {
    if (existsSync(this.path)) {
      try {
        this.data = JSON.parse(readFileSync(this.path, "utf8"));
        if (!Array.isArray(this.data.markets)) this.data.markets = [];
      } catch (err) {
        throw new Error(`Failed to read store at ${this.path}: ${err.message}`);
      }
    }
  }

  save() {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(this.data, null, 2));
  }

  listMarkets() {
    return this.data.markets;
  }

  getMarket(id) {
    return this.data.markets.find((m) => m.id === id);
  }

  createMarket(market) {
    const now = new Date().toISOString();
    const record = {
      id: market.id || `mkt_${randomUUID().slice(0, 8)}`,
      title: market.title,
      category: market.category || "Sports",
      description: market.description || "",
      outcomes: market.outcomes.map((o, i) => ({
        id: o.id || `o${i + 1}`,
        label: o.label,
      })),
      slotPriceLamports: market.slotPriceLamports,
      entryFeeBps: market.entryFeeBps,
      cashoutFeeBps: market.cashoutFeeBps,
      rakeBps: market.rakeBps ?? 0,
      status: "open", // open -> locked -> settled | void
      winningOutcomeId: null,
      closesAt: market.closesAt || null,
      bets: [],
      payouts: [],
      feesCollectedLamports: 0,
      createdAt: now,
      settledAt: null,
    };
    this.data.markets.unshift(record);
    this.save();
    return record;
  }

  addBet(market, bet) {
    const record = {
      id: `bet_${randomUUID().slice(0, 8)}`,
      user: bet.user,
      outcomeId: bet.outcomeId,
      slots: bet.slots,
      gross: bet.gross,
      fee: bet.fee,
      net: bet.net,
      status: "active", // active -> won | lost | cashed | refunded
      paymentRef: bet.paymentRef,
      payoutRef: null,
      createdAt: new Date().toISOString(),
    };
    market.bets.push(record);
    market.feesCollectedLamports += bet.fee;
    this.save();
    return record;
  }

  getBet(betId) {
    for (const m of this.data.markets) {
      const b = m.bets.find((x) => x.id === betId);
      if (b) return { market: m, bet: b };
    }
    return null;
  }
}

export { randomUUID };
