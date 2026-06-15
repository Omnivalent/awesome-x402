// SlotPool frontend. Talks to the Express API. In simulation mode no real
// funds move, so a "demo wallet" (a random local id) is enough. In live mode
// it uses Phantom to sign a real SOL transfer to the escrow before recording
// the bet.

const $ = (sel, el = document) => el.querySelector(sel);
const api = (path, opts) => fetch(path, opts).then(async (r) => {
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
  return body;
});

const state = {
  config: null,
  wallet: null,        // base58 / demo id
  provider: null,      // Phantom provider in live mode
  web3: null,          // lazily-loaded @solana/web3.js in live mode
};

const SOL = (lamports) => {
  if (lamports == null) return "—";
  const v = lamports / (state.config?.lamportsPerSol || 1e9);
  return `${v.toLocaleString(undefined, { maximumFractionDigits: 4 })} SOL`;
};

function toast(msg, kind = "") {
  const el = $("#toast");
  el.textContent = msg;
  el.className = `toast ${kind}`;
  setTimeout(() => el.classList.add("hidden"), 4200);
  el.classList.remove("hidden");
}

// ---- wallet -----------------------------------------------------------------
async function connectWallet() {
  if (state.config.simulation) {
    // No chain — use (or mint) a persistent demo wallet id.
    let id = localStorage.getItem("slotpool_demo_wallet");
    if (!id) {
      id = "Demo" + Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 8);
      localStorage.setItem("slotpool_demo_wallet", id);
    }
    state.wallet = id;
    renderWalletButton();
    toast("Connected demo wallet (simulation mode)", "ok");
    refresh();
    return;
  }

  const provider = window.phantom?.solana || window.solana;
  if (!provider?.isPhantom) {
    toast("Phantom wallet not found. Install it to bet on a live cluster.", "err");
    return;
  }
  try {
    const resp = await provider.connect();
    state.provider = provider;
    state.wallet = resp.publicKey.toString();
    if (!state.web3) {
      state.web3 = await import("https://esm.sh/@solana/web3.js@1.95.3");
    }
    renderWalletButton();
    toast("Wallet connected", "ok");
    refresh();
  } catch (err) {
    toast(`Connect failed: ${err.message}`, "err");
  }
}

function renderWalletButton() {
  const btn = $("#connect-btn");
  if (state.wallet) {
    const short = state.wallet.length > 12
      ? `${state.wallet.slice(0, 4)}…${state.wallet.slice(-4)}`
      : state.wallet;
    btn.textContent = short;
    btn.classList.add("ghost");
  } else {
    btn.textContent = "Connect Wallet";
    btn.classList.remove("ghost");
  }
}

// ---- buying -----------------------------------------------------------------
async function buy(market, outcomeId) {
  if (!state.wallet) return toast("Connect a wallet first", "err");
  const slots = Number(prompt(`How many slots on this outcome? (each = ${SOL(market.slotPriceLamports)})`, "1"));
  if (!Number.isInteger(slots) || slots <= 0) return;

  try {
    const quote = await api(`/api/markets/${market.id}/quote`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ outcomeId, slots }),
    });

    let paymentRef = null;
    if (!quote.simulation) {
      paymentRef = await payEscrow(quote.payTo, quote.gross);
    }

    const res = await api(`/api/markets/${market.id}/bets`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ user: state.wallet, outcomeId, slots, paymentRef }),
    });
    toast(`Bought ${slots} slot(s) for ${SOL(quote.gross)} (fee ${SOL(quote.fee)})`, "ok");
    renderMarket(res.market);
    loadPositions(res.market.id);
  } catch (err) {
    toast(err.message, "err");
  }
}

// Build, sign and send a SOL transfer to the escrow; return the signature.
async function payEscrow(payTo, lamports) {
  const { Connection, PublicKey, SystemProgram, Transaction, clusterApiUrl } = state.web3;
  const endpoint = state.config.paymentMode.startsWith("http")
    ? state.config.paymentMode
    : clusterApiUrl(state.config.paymentMode);
  const connection = new Connection(endpoint, "confirmed");
  const fromPubkey = new PublicKey(state.wallet);
  const tx = new Transaction().add(
    SystemProgram.transfer({ fromPubkey, toPubkey: new PublicKey(payTo), lamports })
  );
  tx.feePayer = fromPubkey;
  tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
  const signed = await state.provider.signTransaction(tx);
  const sig = await connection.sendRawTransaction(signed.serialize());
  await connection.confirmTransaction(sig, "confirmed");
  return sig;
}

async function cashout(bet) {
  if (!confirm("Cash out this position now? A cash-out fee applies and you forfeit any upside.")) return;
  try {
    const res = await api(`/api/bets/${bet.id}/cashout`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ user: state.wallet }),
    });
    toast(`Cashed out ${SOL(res.refundLamports)} (fee ${SOL(res.feeLamports)})`, "ok");
    renderMarket(res.market);
    loadPositions(res.market.id);
  } catch (err) {
    toast(err.message, "err");
  }
}

// ---- rendering --------------------------------------------------------------
async function refresh() {
  const { markets } = await api("/api/markets");
  const container = $("#markets");
  container.innerHTML = "";
  if (!markets.length) {
    container.innerHTML = `<p class="muted">No markets yet. Open the operator console below to create one.</p>`;
    return;
  }
  for (const m of markets) {
    const card = document.createElement("div");
    card.className = "card";
    card.id = `card-${m.id}`;
    container.appendChild(card);
    renderMarket(m);
    if (state.wallet) loadPositions(m.id);
  }
}

function renderMarket(m) {
  const card = $(`#card-${m.id}`);
  if (!card) return;
  const totalSlots = m.totalSlots || 0;
  const outcomesHtml = m.outcomes.map((o) => {
    const pct = totalSlots ? Math.round((o.slots / totalSlots) * 100) : 0;
    const isWinner = m.winningOutcomeId === o.id;
    const canBet = m.status === "open";
    const payoutLine = o.slots
      ? `pays ~${SOL(o.projectedPerSlotLamports)}/slot · ${o.projectedMultiple.toFixed(2)}×`
      : "no slots yet";
    const action = canBet
      ? `<button class="small" data-buy="${m.id}|${o.id}">Buy slot</button>`
      : (isWinner ? `<span class="win-tag">WINNER</span>` : "");
    return `
      <div class="outcome-row">
        <div class="outcome-info">
          <div class="name">${escapeHtml(o.label)} ${isWinner ? '<span class="win-tag">✓</span>' : ""}</div>
          <div class="meta">${o.slots} slot(s) · pool ${SOL(o.poolLamports)} · ${payoutLine}</div>
          <div class="bar"><span style="width:${pct}%"></span></div>
        </div>
        ${action}
      </div>`;
  }).join("");

  card.innerHTML = `
    <div class="card-head">
      <div>
        <div class="cat">${escapeHtml(m.category)}</div>
        <h3>${escapeHtml(m.title)}</h3>
      </div>
      <span class="status-pill status-${m.status}">${m.status}</span>
    </div>
    ${m.description ? `<p class="desc">${escapeHtml(m.description)}</p>` : ""}
    <div class="pot">
      <div class="stat"><div class="v accent">${SOL(m.totalPotLamports)}</div><div class="l">Total pot</div></div>
      <div class="stat"><div class="v">${totalSlots}</div><div class="l">Slots sold</div></div>
      <div class="stat"><div class="v">${SOL(m.slotPriceLamports)}</div><div class="l">Per slot</div></div>
      <div class="stat"><div class="v">${(m.entryFeeBps/100)}% / ${(m.cashoutFeeBps/100)}%</div><div class="l">Entry / cash-out fee</div></div>
    </div>
    <div class="outcomes">${outcomesHtml}</div>
    <div class="positions hidden" id="pos-${m.id}"></div>
    <div class="admin-actions" id="adm-${m.id}"></div>`;

  card.querySelectorAll("[data-buy]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const [mid, oid] = btn.dataset.buy.split("|");
      buy(m, oid);
    });
  });
  renderAdminActions(m);
}

async function loadPositions(marketId) {
  if (!state.wallet) return;
  try {
    const { bets } = await api(`/api/markets/${marketId}/positions?user=${encodeURIComponent(state.wallet)}`);
    const el = $(`#pos-${marketId}`);
    if (!el) return;
    if (!bets.length) { el.classList.add("hidden"); el.innerHTML = ""; return; }
    el.classList.remove("hidden");
    const rows = bets.map((b) => {
      const canCash = b.status === "active";
      const right = canCash
        ? `<button class="small danger" data-cash="${b.id}">Cash out</button>`
        : `<span class="tag">${b.status}</span>`;
      return `<div class="position">
        <span>${b.slots} slot(s) · staked ${SOL(b.net)} <span class="tag">on ${b.outcomeId}</span></span>
        ${right}</div>`;
    }).join("");
    el.innerHTML = `<h4>Your positions</h4>${rows}`;
    el.querySelectorAll("[data-cash]").forEach((btn) => {
      const bet = bets.find((x) => x.id === btn.dataset.cash);
      btn.addEventListener("click", () => cashout(bet));
    });
  } catch { /* ignore */ }
}

// ---- admin ------------------------------------------------------------------
function adminToken() { return $("#admin-token").value.trim(); }
function adminHeaders() {
  return { "content-type": "application/json", "x-admin-token": adminToken() };
}

function renderAdminActions(m) {
  const el = $(`#adm-${m.id}`);
  if (!el) return;
  if (!adminToken()) { el.innerHTML = ""; return; }
  if (m.status === "settled" || m.status === "void") { el.innerHTML = ""; return; }
  const settleBtns = m.outcomes.map((o) =>
    `<button class="small ghost" data-settle="${m.id}|${o.id}">Settle: ${escapeHtml(o.label)}</button>`
  ).join(" ");
  el.innerHTML = `<div style="margin-top:14px;display:flex;gap:8px;flex-wrap:wrap;">
    ${m.status === "open" ? `<button class="small ghost" data-lock="${m.id}">Lock</button>` : ""}
    ${settleBtns}
    <button class="small danger" data-void="${m.id}">Void & refund</button>
  </div>`;
  el.querySelector("[data-lock]")?.addEventListener("click", () => adminPost(`/api/markets/${m.id}/lock`));
  el.querySelector("[data-void]")?.addEventListener("click", () => {
    if (confirm("Void this market and refund all active bettors?")) adminPost(`/api/markets/${m.id}/void`);
  });
  el.querySelectorAll("[data-settle]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const [mid, oid] = btn.dataset.settle.split("|");
      if (confirm(`Settle market with winner "${oid}"? Payouts will be sent.`)) {
        adminPost(`/api/markets/${mid}/settle`, { winningOutcomeId: oid });
      }
    });
  });
}

async function adminPost(path, body) {
  try {
    const res = await api(path, { method: "POST", headers: adminHeaders(), body: JSON.stringify(body || {}) });
    toast("Done", "ok");
    refresh();
    return res;
  } catch (err) {
    toast(err.message, "err");
  }
}

async function createMarket() {
  const outcomes = $("#m-outcomes").value.split("\n").map((s) => s.trim()).filter(Boolean)
    .map((label) => ({ label }));
  if (!$("#m-title").value || outcomes.length < 2) {
    return toast("Need a title and at least 2 outcomes", "err");
  }
  const lps = state.config.lamportsPerSol;
  await adminPost("/api/markets", {
    title: $("#m-title").value,
    category: $("#m-cat").value || "Sports",
    description: $("#m-desc").value,
    outcomes,
    slotPriceLamports: Math.round(Number($("#m-price").value) * lps),
    entryFeeBps: Number($("#m-entry").value),
    cashoutFeeBps: Number($("#m-cashout").value),
    rakeBps: Number($("#m-rake").value),
  });
  $("#m-title").value = ""; $("#m-outcomes").value = "";
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---- boot -------------------------------------------------------------------
async function boot() {
  state.config = await api("/api/config");
  const badge = $("#mode-badge");
  if (state.config.simulation) {
    badge.textContent = "SIMULATION"; badge.classList.add("sim");
    $("#banner").classList.remove("hidden");
    $("#banner").innerHTML =
      `Running in <b>simulation mode</b> — no real SOL moves. Escrow address: <code>${state.config.escrowAddress}</code>. ` +
      `Set <code>PAYMENT_MODE=devnet</code> and fund the escrow to use real wallets.`;
  } else {
    badge.textContent = state.config.paymentMode.toUpperCase(); badge.classList.add("live");
    $("#banner").classList.remove("hidden");
    $("#banner").innerHTML = `Live on <b>${state.config.paymentMode}</b>. Bets pay escrow <code>${state.config.escrowAddress}</code>.`;
  }

  $("#connect-btn").addEventListener("click", connectWallet);
  $("#refresh-btn").addEventListener("click", refresh);
  $("#create-btn").addEventListener("click", createMarket);
  $("#admin-token").addEventListener("input", () => refresh());

  await refresh();
}

boot().catch((err) => toast(`Failed to load: ${err.message}`, "err"));
