import { test } from "node:test";
import assert from "node:assert/strict";
import {
  bpsCut,
  quotePurchase,
  quoteCashout,
  buildPools,
  projectPayouts,
  settle,
  solToLamports,
  LAMPORTS_PER_SOL,
} from "../server/pari.js";

const SOL = solToLamports;

function market(overrides = {}) {
  return {
    outcomes: [
      { id: "a", label: "A" },
      { id: "b", label: "B" },
      { id: "c", label: "C" },
    ],
    slotPriceLamports: SOL(1),
    entryFeeBps: 250,
    cashoutFeeBps: 500,
    rakeBps: 0,
    bets: [],
    ...overrides,
  };
}

function activeBet(user, outcomeId, slots, m) {
  const q = quotePurchase({ slots, slotPriceLamports: m.slotPriceLamports, entryFeeBps: m.entryFeeBps });
  return { id: `${user}-${outcomeId}`, user, outcomeId, slots, ...q, status: "active" };
}

test("bpsCut floors correctly and validates", () => {
  assert.equal(bpsCut(SOL(1), 250), SOL(1) * 0.025);
  assert.equal(bpsCut(100, 250), 2); // floor(2.5)
  assert.equal(bpsCut(0, 1000), 0);
  assert.throws(() => bpsCut(-1, 100));
  assert.throws(() => bpsCut(100, 20000));
});

test("quotePurchase splits the entry fee out of gross", () => {
  const q = quotePurchase({ slots: 4, slotPriceLamports: SOL(1), entryFeeBps: 250 });
  assert.equal(q.gross, SOL(4));
  assert.equal(q.fee, SOL(4) * 0.025);
  assert.equal(q.net, q.gross - q.fee);
  assert.throws(() => quotePurchase({ slots: 0, slotPriceLamports: SOL(1), entryFeeBps: 250 }));
});

test("quoteCashout applies the cash-out fee", () => {
  const { fee, refund } = quoteCashout({ netStakeLamports: SOL(10), cashoutFeeBps: 500 });
  assert.equal(fee, SOL(10) * 0.05);
  assert.equal(refund, SOL(10) - fee);
});

test("buildPools aggregates only active bets", () => {
  const m = market();
  m.bets = [
    activeBet("u1", "a", 2, m),
    activeBet("u2", "b", 1, m),
    { ...activeBet("u3", "a", 5, m), status: "cashed" }, // excluded
  ];
  const { pools, slotsByOutcome, total } = buildPools(m);
  assert.equal(slotsByOutcome.a, 2);
  assert.equal(slotsByOutcome.b, 1);
  assert.equal(pools.a, SOL(2) * 0.975);
  assert.equal(total, pools.a + pools.b);
});

test("settle: classic split — Brazil bettors share the whole pot", () => {
  // 1 person on A (Brazil), 1 on B. Each 1 SOL. A wins.
  const m = market({ rakeBps: 0 });
  m.bets = [activeBet("brazilFan", "a", 1, m), activeBet("argFan", "b", 1, m)];
  const total = buildPools(m).total; // 2 * 0.975 SOL
  const result = settle(m, "a");
  assert.equal(result.voided, false);
  assert.equal(result.rake, 0);
  assert.equal(result.payouts.length, 1);
  assert.equal(result.payouts[0].user, "brazilFan");
  // Winner takes the entire net pot.
  assert.equal(result.payouts[0].amount, total);
});

test("settle: more slots => bigger share, proportional", () => {
  const m = market({ rakeBps: 0 });
  m.bets = [
    activeBet("whale", "a", 3, m), // 3 winning slots
    activeBet("minnow", "a", 1, m), // 1 winning slot
    activeBet("loser", "b", 4, m),
  ];
  const total = buildPools(m).total;
  const result = settle(m, "a");
  const byUser = Object.fromEntries(result.payouts.map((p) => [p.user, p.amount]));
  // whale should get 3x the minnow (within dust).
  assert.equal(byUser.whale, Math.floor((total * (SOL(3) * 0.975)) / (SOL(4) * 0.975)));
  assert.equal(byUser.minnow, Math.floor((total * (SOL(1) * 0.975)) / (SOL(4) * 0.975)));
  // Books balance: payouts + rake(dust) == distributable == total (rake 0).
  const paid = result.payouts.reduce((a, p) => a + p.amount, 0);
  assert.equal(paid + result.rake, total);
});

test("settle: house rake is taken from the pot", () => {
  const m = market({ rakeBps: 1000 }); // 10% rake
  m.bets = [activeBet("w", "a", 1, m), activeBet("l", "b", 1, m)];
  const total = buildPools(m).total;
  const result = settle(m, "a");
  const expectedRake = Math.floor(total * 0.1);
  // rake includes any division dust; with a single winner there is none.
  assert.equal(result.rake, expectedRake);
  assert.equal(result.payouts[0].amount, total - expectedRake);
});

test("settle: nobody backed the winner => everyone refunded, no rake", () => {
  const m = market({ rakeBps: 500 });
  m.bets = [activeBet("u1", "a", 1, m), activeBet("u2", "b", 2, m)];
  const result = settle(m, "c"); // no one on C
  assert.equal(result.rake, 0);
  assert.equal(result.distributable, 0);
  assert.equal(result.payouts.length, 2);
  assert.ok(result.payouts.every((p) => p.kind === "refund"));
  const m1 = m.bets.find((b) => b.user === "u1");
  assert.equal(result.payouts.find((p) => p.user === "u1").amount, m1.net);
});

test("settle: books always balance (dust goes to operator)", () => {
  const m = market({ rakeBps: 0 });
  // 3 winners create non-divisible lamports.
  m.bets = [
    activeBet("a", "a", 1, m),
    activeBet("b2", "a", 1, m),
    activeBet("c3", "a", 1, m),
    activeBet("x", "b", 1, m), // adds to pot, not winning
  ];
  const total = buildPools(m).total;
  const result = settle(m, "a");
  const paid = result.payouts.reduce((s, p) => s + p.amount, 0);
  assert.equal(paid + result.rake, total);
  assert.ok(result.rake >= 0 && result.rake < result.payouts.length);
});

test("projectPayouts reflects live pool with rake", () => {
  const m = market({ rakeBps: 0 });
  m.bets = [activeBet("w", "a", 1, m), activeBet("l", "b", 3, m)];
  const proj = projectPayouts(m);
  // One slot on A would scoop the whole pot of 4*0.975 SOL.
  assert.equal(proj.a.perSlotLamports, buildPools(m).total);
  assert.ok(proj.a.multiple > 1);
  // B has 3 slots sharing the same pot.
  assert.ok(proj.b.perSlotLamports > 0);
});

test("LAMPORTS_PER_SOL constant", () => {
  assert.equal(LAMPORTS_PER_SOL, 1_000_000_000);
});
