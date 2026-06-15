// Pure parimutuel pool math. No I/O, no side effects — fully unit-testable.
//
// A parimutuel ("mutuel" / tote) pool works like this:
//   - Every bettor buys one or more equal-priced "slots" on an outcome.
//   - All money (net of the operator's entry fee) goes into a single pot.
//   - When the event resolves, the pot — minus an optional house rake — is
//     split among the winning side, in proportion to how many slots each
//     winner holds. The more slots you hold, the bigger your share.
//   - Losers get nothing; their stake is what funds the winners' upside.
//
// The "odds" are therefore not fixed at bet time: your payout depends on how
// the pool fills up. We expose live projected payouts so bettors can see it.

export const LAMPORTS_PER_SOL = 1_000_000_000;

/** Floor(amount * bps / 10000). bps = basis points (100 bps = 1%). */
export function bpsCut(amountLamports, bps) {
  if (!Number.isInteger(amountLamports) || amountLamports < 0) {
    throw new Error("amountLamports must be a non-negative integer");
  }
  if (!Number.isInteger(bps) || bps < 0 || bps > 10_000) {
    throw new Error("bps must be an integer in [0, 10000]");
  }
  return Math.floor((amountLamports * bps) / 10_000);
}

export function solToLamports(sol) {
  return Math.round(sol * LAMPORTS_PER_SOL);
}

export function lamportsToSol(lamports) {
  return lamports / LAMPORTS_PER_SOL;
}

/**
 * Quote the cost of buying slots, splitting the operator's entry fee out of
 * the gross. `net` is what actually enters the pot.
 */
export function quotePurchase({ slots, slotPriceLamports, entryFeeBps }) {
  if (!Number.isInteger(slots) || slots <= 0) {
    throw new Error("slots must be a positive integer");
  }
  const gross = slots * slotPriceLamports;
  const fee = bpsCut(gross, entryFeeBps);
  return { slots, gross, fee, net: gross - fee };
}

/**
 * Quote a pre-resolution cash-out ("sell"). The bettor pulls their net stake
 * back out of the pot, less the operator's cash-out fee.
 */
export function quoteCashout({ netStakeLamports, cashoutFeeBps }) {
  if (!Number.isInteger(netStakeLamports) || netStakeLamports < 0) {
    throw new Error("netStakeLamports must be a non-negative integer");
  }
  const fee = bpsCut(netStakeLamports, cashoutFeeBps);
  return { fee, refund: netStakeLamports - fee };
}

/**
 * Aggregate active bets into per-outcome pools (net lamports in the pot) and
 * per-outcome slot counts. Cashed-out / refunded bets are excluded.
 */
export function buildPools(market) {
  const pools = {};
  const slotsByOutcome = {};
  for (const o of market.outcomes) {
    pools[o.id] = 0;
    slotsByOutcome[o.id] = 0;
  }
  for (const bet of market.bets) {
    if (bet.status !== "active") continue;
    pools[bet.outcomeId] += bet.net;
    slotsByOutcome[bet.outcomeId] += bet.slots;
  }
  const total = Object.values(pools).reduce((a, b) => a + b, 0);
  return { pools, slotsByOutcome, total };
}

/**
 * Live projection of what one slot on each outcome would pay if the event
 * resolved right now (after rake). Useful for showing "implied odds".
 * Returns { [outcomeId]: { perSlotLamports, multiple } }.
 */
export function projectPayouts(market) {
  const { pools, slotsByOutcome, total } = buildPools(market);
  const distributable = total - bpsCut(total, market.rakeBps ?? 0);
  const out = {};
  for (const o of market.outcomes) {
    const winningStake = pools[o.id];
    const winningSlots = slotsByOutcome[o.id];
    if (winningStake <= 0 || winningSlots <= 0) {
      out[o.id] = { perSlotLamports: 0, multiple: 0 };
      continue;
    }
    // Each winning slot's net contribution to the pot:
    const netPerSlot = winningStake / winningSlots;
    const perSlotLamports = Math.floor((distributable * netPerSlot) / winningStake);
    out[o.id] = {
      perSlotLamports,
      multiple: netPerSlot > 0 ? perSlotLamports / netPerSlot : 0,
    };
  }
  return out;
}

/**
 * Settle a market against a winning outcome. Returns the list of payouts to
 * make (one per winning bettor) plus the operator's rake. Pure: it does not
 * mutate the market or move money — the caller applies the result.
 *
 * Edge cases:
 *   - No winning stake (nobody bet the winner, or pot is empty): everyone with
 *     an active bet is refunded their net stake. Operator earns no rake.
 *   - Integer division dust (lamports that don't divide evenly) is assigned to
 *     the operator so the books always balance exactly.
 */
export function settle(market, winningOutcomeId) {
  const valid = market.outcomes.some((o) => o.id === winningOutcomeId);
  if (!valid) throw new Error(`unknown outcome: ${winningOutcomeId}`);

  const { pools, total } = buildPools(market);
  const winningStake = pools[winningOutcomeId] ?? 0;

  // Nobody backed the winner — refund every active bettor their net stake.
  if (winningStake <= 0) {
    const refunds = market.bets
      .filter((b) => b.status === "active")
      .map((b) => ({ betId: b.id, user: b.user, amount: b.net, kind: "refund" }));
    return { winningOutcomeId, rake: 0, distributable: 0, payouts: refunds, voided: total === 0 };
  }

  const rake = bpsCut(total, market.rakeBps ?? 0);
  const distributable = total - rake;

  let paidOut = 0;
  const payouts = [];
  for (const bet of market.bets) {
    if (bet.status !== "active") continue;
    if (bet.outcomeId !== winningOutcomeId) continue;
    const amount = Math.floor((distributable * bet.net) / winningStake);
    paidOut += amount;
    payouts.push({ betId: bet.id, user: bet.user, amount, kind: "win" });
  }

  // Any lamports lost to integer division go to the operator.
  const dust = distributable - paidOut;
  return { winningOutcomeId, rake: rake + dust, distributable, payouts, voided: false };
}
