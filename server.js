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

async function getTokenHolders(mintAddress) {
  const holders = new Set();
  let cursor = undefined;
  for (let page = 0; page < 5; page++) {
    const body = {
      jsonrpc: "2.0", id: "h", method: "getTokenAccounts",
      params: { mint: mintAddress, limit: 1000, ...(cursor ? { cursor } : {}) }
    };
    const res = await axios.post(HELIUS_RPC, body);
    const data = res.data?.result;
    if (!data?.token_accounts?.length) break;
    data.token_accounts.forEach(a => { if (a.owner) holders.add(a.owner); });
    cursor = data.cursor;
    if (!cursor) break;
  }
  return holders;
}

async function getTokenTraders(mintAddress) {
  const traders = new Set();
  let before = undefined;
  for (let page = 0; page < 10; page++) {
    const params = new URLSearchParams({ "api-key": HELIUS_API_KEY, limit: 100, type: "SWAP", ...(before ? { before } : {}) });
    try {
      const res = await axios.get(`${HELIUS_API}/addresses/${mintAddress}/transactions?${params}`);
      const txns = res.data;
      if (!txns?.length) break;
      txns.forEach(tx => {
        if (tx.feePayer) traders.add(tx.feePayer);
        (tx.tokenTransfers || []).forEach(t => {
          if (t.toUserAccount) traders.add(t.toUserAccount);
          if (t.fromUserAccount) traders.add(t.fromUserAccount);
        });
      });
      before = txns[txns.length - 1]?.signature;
      if (txns.length < 100) break;
    } catch (e) { break; }
  }
  return traders;
}

function intersect(sets) {
  if (!sets.length) return new Set();
  let result = new Set(sets[0]);
  for (let i = 1; i < sets.length; i++)
    result = new Set([...result].filter(x => sets[i].has(x)));
  return result;
}

app.get("/health", (req, res) => res.json({ status: "ok" }));

app.post("/api/find-wallets", async (req, res) => {
  const { mints } = req.body;
  if (!mints || !Array.isArray(mints) || mints.length < 1)
    return res.status(400).json({ error: "Provide an array of mint addresses." });
  if (mints.length > 5)
    return res.status(400).json({ error: "Maximum 5 tokens at once." });
  try {
    const walletSets = await Promise.all(
      mints.map(async mint => {
        const [holders, traders] = await Promise.all([getTokenHolders(mint), getTokenTraders(mint)]);
        return new Set([...holders, ...traders]);
      })
    );
    const stats = walletSets.map((set, i) => ({ mint: mints[i], count: set.size }));
    const intersection = intersect(walletSets);
    const wallets = [...intersection];
    return res.json({ success: true, stats, matchCount: wallets.length, wallets });
  } catch (err) {
    return res.status(500).json({ error: "Failed to fetch data: " + err.message });
  }
});

app.get("*", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

app.listen(PORT, () => console.log(`✅ SolTrace running on port ${PORT}`));
