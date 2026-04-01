require("dotenv").config();
const express = require("express");
const cors = require("cors");
const axios = require("axios");
const rateLimit = require("express-rate-limit");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3001;
const HELIUS_API_KEY = process.env.HELIUS_API_KEY || "72099335-bd1f-4fb2-b3b9-74caf6656d3f";
const HELIUS_RPC = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;
const HELIUS_API = `https://api.helius.xyz/v0`;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const limiter = rateLimit({ windowMs: 60 * 1000, max: 30 });
app.use("/api", limiter);

// ── Blocklist of known non-human addresses ────────────────────────────────────
const BLOCKED_ADDRESSES = new Set([
  // Jupiter
  "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",
  "JUP4Fb2cqiRUcaTHdrPC8h2gNsA2ETXiPDD33WcGuJB",
  "JUP3c2Uh3WA4Ng34tw6kPd2G4i5evpx97iXXs2YgrpE",
  "jupoNjAxXgZ4rjzxzPMP4QiCg7v9U5G5DPG1GDTQM2z",
  "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn",
  // Pump.fun
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P",
  "TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM",
  "Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1",
  "39azUYFWPz3VHgKCf3VChUwbpURdCHRxjWVowf5jUJjg",
  // Raydium
  "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8",
  "5quBtoiQqxF9Jv6KYKctB59NT3gtJD2Y65kdnB1Uev3h",
  "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK",
  "27haf8L6oxUeXrHrgEgsexjSY5hbVUWEmvv9Nyxg8vQv",
  "HWy1jotHpo6UqeQxx49dpYYdQB8wj9Qk9MdxwjLvDHB8",
  "routeUGWgWzqBWFcrCfv8tritsqukccJPu3q5GPP3xS",
  // Orca / Whirlpool
  "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc",
  "9W959DqEETiGZocYWCQPaJ6sBmUzgfxXfqGeTEdp3aQP",
  "DjVE6JNiYqPL2QXyCUUh8rNjHrbz9hXHNYt99MQ59qw1",
  // Meteora
  "Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EkQAb8Z",
  "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo",
  // Serum / OpenBook
  "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin",
  "srmqPvymJeFKQ4zGQed1GFppgkRHL9kaELCbyksJtPX",
  "opnb2LAfJYbRMAHHvqjCwQxanZn7n89LuGdX5XBkgmR",
  // System / native programs
  "11111111111111111111111111111111",
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJe1bsn",
  "ComputeBudget111111111111111111111111111111",
  "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
  "Sysvar1nstructions1111111111111111111111111",
  "SysvarRent111111111111111111111111111111111",
  "SysvarC1ock11111111111111111111111111111111",
]);

function looksLikeRealWallet(address) {
  if (BLOCKED_ADDRESSES.has(address)) return false;
  if (address.length < 32 || address.length > 44) return false;
  return true;
}

// ── Verify wallets on-chain: keep only System Program-owned (real wallets) ────
async function filterRealWallets(addresses) {
  const BATCH_SIZE = 100;
  const realWallets = [];

  for (let i = 0; i < addresses.length; i += BATCH_SIZE) {
    const batch = addresses.slice(i, i + BATCH_SIZE);
    try {
      const body = {
        jsonrpc: "2.0", id: "batch",
        method: "getMultipleAccounts",
        params: [batch, { encoding: "base64" }]
      };
      const res = await axios.post(HELIUS_RPC, body);
      const accounts = res.data?.result?.value || [];
      accounts.forEach((acct, idx) => {
        if (!acct) return;
        // Real user wallets are owned by the System Program
        if (acct.owner === "11111111111111111111111111111111") {
          realWallets.push(batch[idx]);
        }
      });
    } catch (e) {
      // fallback: include all if batch fails
      realWallets.push(...batch);
    }
  }
  return realWallets;
}

// ── Fetch DEX swappers only ───────────────────────────────────────────────────
async function getTokenTraders(mintAddress) {
  const traders = new Set();
  let before = undefined;

  for (let page = 0; page < 10; page++) {
    const params = new URLSearchParams({
      "api-key": HELIUS_API_KEY,
      limit: 100,
      type: "SWAP",
      ...(before ? { before } : {})
    });
    try {
      const res = await axios.get(`${HELIUS_API}/addresses/${mintAddress}/transactions?${params}`);
      const txns = res.data;
      if (!txns?.length) break;
      txns.forEach(tx => {
        // feePayer = the real human who signed and paid for the swap
        if (tx.feePayer && looksLikeRealWallet(tx.feePayer)) {
          traders.add(tx.feePayer);
        }
      });
      before = txns[txns.length - 1]?.signature;
      if (txns.length < 100) break;
    } catch (e) {
      console.error(`Page ${page} error:`, e.message);
      break;
    }
  }
  return traders;
}

// ── Intersect ─────────────────────────────────────────────────────────────────
function intersect(sets) {
  if (!sets.length) return new Set();
  let result = new Set(sets[0]);
  for (let i = 1; i < sets.length; i++)
    result = new Set([...result].filter(x => sets[i].has(x)));
  return result;
}

// ── Routes ────────────────────────────────────────────────────────────────────
app.get("/health", (req, res) => res.json({ status: "ok" }));

app.post("/api/find-wallets", async (req, res) => {
  const { mints } = req.body;
  if (!mints || !Array.isArray(mints) || mints.length < 1)
    return res.status(400).json({ error: "Provide an array of mint addresses." });
  if (mints.length > 5)
    return res.status(400).json({ error: "Maximum 5 tokens at once." });

  try {
    // Step 1: Get DEX swappers for each token
    const walletSets = await Promise.all(mints.map(mint => getTokenTraders(mint)));
    const stats = walletSets.map((set, i) => ({ mint: mints[i], count: set.size }));

    // Step 2: Intersect
    const intersection = intersect(walletSets);
    let wallets = [...intersection];

    // Step 3: On-chain verify — keep only real user wallets
    console.log(`Verifying ${wallets.length} wallets on-chain…`);
    wallets = await filterRealWallets(wallets);
    console.log(`${wallets.length} real wallets after filtering`);

    return res.json({ success: true, stats, matchCount: wallets.length, wallets });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Failed to fetch data: " + err.message });
  }
});

app.get("*", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));
app.listen(PORT, () => console.log(`✅ SolTrace running on port ${PORT}`));
