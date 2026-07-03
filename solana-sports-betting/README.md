# SlotPool — Parimutuel Sports Betting on Solana

A working MVP of the betting site you described: people buy **slots** on a sports
outcome, every slot's money goes into one **pot**, and when the event resolves
the **winners split the pot** in proportion to how many slots they hold. You,
the operator, earn a configurable **fee on every buy**, a **fee on cash-outs**,
and an optional **house rake** on the pot at settlement.

This is the classic *parimutuel* (tote / pool) model used in horse racing — the
fairest way to "everyone pits their SOL and winners share it", because the house
never takes the other side of the bet. It just runs the pool and skims fees.

> ⚠️ **Legal:** running this for real money is **regulated gambling** in most
> places (licensing, KYC/AML, geo-blocking, responsible-gaming rules). It ships
> in **simulation mode** and is meant for devnet/demo. Get legal review before
> mainnet.

---

## How a bet works

```
Market: "World Cup Final — Brazil vs Argentina"
Outcomes: [ Brazil win ] [ Argentina win ] [ Draw ]
Slot price: 1 SOL   Entry fee: 2.5%

Alice buys 1 slot on Brazil      → pays 1 SOL  (0.975 into pot, 0.025 fee to you)
Bob   buys 1 slot on Argentina   → pays 1 SOL  (0.975 into pot, 0.025 fee to you)
Carol buys 2 slots on Brazil     → pays 2 SOL  (1.95  into pot, 0.05  fee to you)

Pot = 0.975 + 0.975 + 1.95 = 3.9 SOL

→ Brazil wins. Brazil side has 3 winning slots (Alice 1, Carol 2).
   Each winning slot is worth pot / 3 = 1.3 SOL.
   Alice gets 1.3 SOL.  Carol gets 2.6 SOL.  Bob gets nothing.
```

The more slots on the winning side overall, the smaller each share — and the
more slots *you personally* hold of the winners, the bigger *your* cut. The app
shows a **live projected payout per slot** so bettors see the implied odds move
as the pool fills.

### Where your money comes from
| Fee | Default | When |
|-----|---------|------|
| Entry fee | 2.5% (`ENTRY_FEE_BPS=250`) | every slot purchase |
| Cash-out fee | 5% (`CASHOUT_FEE_BPS=500`) | when a bettor sells before resolution |
| House rake | 0% (`RAKE_BPS=0`) | skimmed off the pot at settlement |

All are configurable globally (env) and per-market (at creation).

---

## Quick start

```bash
cd solana-sports-betting
npm install
npm run seed     # optional: creates two sample markets
npm start
# open http://localhost:3000
```

It boots in **simulation mode** — no wallet, no real SOL. Click **Connect
Wallet** (mints a demo wallet), buy slots, then open the **Operator console**
(admin token `dev-admin-token`) to lock/settle markets and watch payouts.

Run the math test suite:

```bash
npm test
```

---

## Going live on Solana (devnet)

1. Set in `.env`:
   ```
   PAYMENT_MODE=devnet
   ADMIN_TOKEN=<something-strong>
   ```
2. Start once — an escrow keypair is generated at `data/.escrow.json` and its
   address is printed. **Fund it** (devnet airdrop):
   ```bash
   solana airdrop 2 <escrow-address> --url devnet
   ```
   The escrow must hold enough SOL to pay winners + transaction fees.
3. Visitors connect **Phantom**, and buying a slot now signs a real transfer to
   the escrow. The server verifies the on-chain transaction before recording the
   bet. Settlement/cash-out send real SOL back out, signed by the escrow.

`PAYMENT_MODE` also accepts `testnet`, `mainnet-beta`, or any custom RPC URL.

---

## API

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET | `/api/config` | — | mode, escrow address, defaults |
| GET | `/api/markets` | — | list markets with live pools & projected payouts |
| GET | `/api/markets/:id` | — | one market |
| GET | `/api/markets/:id/positions?user=` | — | a wallet's own bets |
| POST | `/api/markets/:id/quote` | — | price a purchase, get pay-to address |
| POST | `/api/markets/:id/bets` | — | record a bet after payment is verified |
| POST | `/api/bets/:id/cashout` | — | sell a position before resolution |
| POST | `/api/markets` | admin | create a market |
| POST | `/api/markets/:id/lock` | admin | stop new bets |
| POST | `/api/markets/:id/settle` | admin | set winner, pay everyone out |
| POST | `/api/markets/:id/void` | admin | cancel & refund all stakes |

Admin endpoints require the `x-admin-token` header.

---

## Architecture

```
server/
  pari.js     Pure parimutuel math (fees, pools, projected odds, settlement).
              Fully unit-tested — this is the heart of the product.
  solana.js   Payment layer: simulation OR real Solana (verify deposits,
              sign payouts from a custodial escrow).
  store.js    JSON-file persistence (swap for Postgres/SQLite in prod).
  index.js    Express API + lifecycle (open → locked → settled/void).
  seed.js     Sample markets.
public/       Single-page UI (vanilla JS, Phantom wallet, no build step).
test/         node:test unit tests for the math.
```

### Production hardening checklist
- **Custody:** this MVP is *custodial* — the escrow keypair holds the pot, which
  is the biggest risk. For a trust-minimized version, move the pool on-chain as
  an **Anchor program** so funds are escrowed by code, not by your server key.
- **Oracle / result feed:** settlement is operator-driven here. Wire it to a
  trusted sports data oracle (or a dispute window) so you can't (and don't have
  to) call results by hand.
- **Database & idempotency:** replace the JSON store; make payment verification
  and payouts idempotent and atomic so a crash can't double-pay.
- **Compliance:** KYC/AML, geo-blocking, age checks, responsible-gambling tools,
  and a gambling licence for your jurisdiction(s).
- **Abuse:** rate-limit quotes/bets, validate that a payment signature isn't
  reused across bets, and reconcile escrow balance against the ledger.

---

## License
MIT. For educational/demo use.
