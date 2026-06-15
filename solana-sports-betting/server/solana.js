// Payment layer. Two modes, selected by PAYMENT_MODE:
//
//   simulation (default) — no chain, no keys, no network. "Payments" are
//       accepted instantly and recorded with a synthetic reference. Lets the
//       whole app run and be demoed offline. Use this for development.
//
//   devnet / mainnet-beta / <rpc url> — real Solana. Buyers send SOL to the
//       custodial escrow wallet with their own wallet (e.g. Phantom) and pass
//       the transaction signature as the payment reference; we verify it
//       on-chain. Payouts and refunds are signed by the escrow keypair.
//
// SECURITY: a custodial escrow means YOU hold the pot. That carries real
// custody, regulatory and key-management risk. For production, prefer an
// on-chain escrow program (Anchor) so funds are non-custodial. See README.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  clusterApiUrl,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import bs58 from "bs58";

function resolveEndpoint(mode) {
  if (mode === "devnet") return clusterApiUrl("devnet");
  if (mode === "testnet") return clusterApiUrl("testnet");
  if (mode === "mainnet-beta") return clusterApiUrl("mainnet-beta");
  if (mode.startsWith("http")) return mode;
  return null;
}

export class PaymentProvider {
  constructor({ mode = "simulation", escrowKeyPath = ".escrow.json", escrowSecret } = {}) {
    this.mode = mode;
    this.simulation = mode === "simulation";

    if (this.simulation) {
      // Deterministic placeholder address so the UI has something to show.
      this.escrow = Keypair.generate();
      return;
    }

    const endpoint = resolveEndpoint(mode);
    if (!endpoint) throw new Error(`Unsupported PAYMENT_MODE: ${mode}`);
    this.connection = new Connection(endpoint, "confirmed");
    this.escrow = this._loadEscrow(escrowSecret, escrowKeyPath);
  }

  _loadEscrow(escrowSecret, escrowKeyPath) {
    if (escrowSecret) {
      return Keypair.fromSecretKey(bs58.decode(escrowSecret.trim()));
    }
    if (existsSync(escrowKeyPath)) {
      const arr = JSON.parse(readFileSync(escrowKeyPath, "utf8"));
      return Keypair.fromSecretKey(Uint8Array.from(arr));
    }
    // First run on a live cluster: mint a fresh escrow and persist it so the
    // operator can fund it. (On devnet you can airdrop to it.)
    const kp = Keypair.generate();
    writeFileSync(escrowKeyPath, JSON.stringify(Array.from(kp.secretKey)));
    console.warn(
      `[solana] Generated new escrow keypair at ${escrowKeyPath}. ` +
        `Fund ${kp.publicKey.toBase58()} before accepting bets.`
    );
    return kp;
  }

  escrowAddress() {
    return this.escrow.publicKey.toBase58();
  }

  async escrowBalanceLamports() {
    if (this.simulation) return null;
    return this.connection.getBalance(this.escrow.publicKey, "confirmed");
  }

  /**
   * Verify that an incoming payment of at least `expectedLamports` reached the
   * escrow. In simulation we trust the client and synthesize a reference.
   * On a live cluster we look up the signature and inspect the balance delta
   * on the escrow account.
   */
  async verifyIncoming({ paymentRef, expectedLamports, fromUser }) {
    if (this.simulation) {
      return { ok: true, ref: paymentRef || `sim_${randomUUID().slice(0, 12)}` };
    }
    if (!paymentRef) return { ok: false, error: "missing payment signature" };

    const tx = await this.connection.getTransaction(paymentRef, {
      maxSupportedTransactionVersion: 0,
      commitment: "confirmed",
    });
    if (!tx) return { ok: false, error: "transaction not found / not confirmed yet" };
    if (tx.meta?.err) return { ok: false, error: "transaction failed on-chain" };

    const keys = tx.transaction.message.getAccountKeys
      ? tx.transaction.message.getAccountKeys().staticAccountKeys
      : tx.transaction.message.accountKeys;
    const escrowIdx = keys.findIndex((k) => k.equals(this.escrow.publicKey));
    if (escrowIdx === -1) return { ok: false, error: "payment did not credit escrow" };

    const credited = tx.meta.postBalances[escrowIdx] - tx.meta.preBalances[escrowIdx];
    if (credited < expectedLamports) {
      return {
        ok: false,
        error: `underpaid: escrow received ${credited}, expected ${expectedLamports}`,
      };
    }
    if (fromUser) {
      const payerIdx = keys.findIndex((k) => k.toBase58() === fromUser);
      if (payerIdx === -1) {
        return { ok: false, error: "payment not signed by the stated wallet" };
      }
    }
    return { ok: true, ref: paymentRef };
  }

  /** Pay a winner / refund. Signed by the escrow keypair. */
  async payout({ toUser, lamports }) {
    if (lamports <= 0) return { ok: true, ref: `noop_${randomUUID().slice(0, 8)}` };
    if (this.simulation) {
      return { ok: true, ref: `simpay_${randomUUID().slice(0, 12)}` };
    }
    const tx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: this.escrow.publicKey,
        toPubkey: new PublicKey(toUser),
        lamports,
      })
    );
    const sig = await sendAndConfirmTransaction(this.connection, tx, [this.escrow]);
    return { ok: true, ref: sig };
  }
}

export { LAMPORTS_PER_SOL };
