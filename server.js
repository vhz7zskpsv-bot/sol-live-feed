const express = require('express');
const app = express();

app.use(express.json({ limit: '2mb' }));

let recentSales = [];
const metadataCache = new Map();

function getTimeframeMinutes(tf) {
  if (tf === '5m') return 5;
  if (tf === '15m') return 15;
  return 60;
}

async function fetchAssetMetadata(mint) {
  if (!mint) return null;
  if (metadataCache.has(mint)) {
    return metadataCache.get(mint);
  }

  const apiKey = process.env.HELIUS_API_KEY;
  if (!apiKey) {
    return {
      name: `NFT ${mint.slice(0, 4)}...${mint.slice(-4)}`,
      collectionName: 'Unverified / New Collection',
      verified: false,
      image: ''
    };
  }

  try {
    const res = await fetch(`https://mainnet.helius-rpc.com/?api-key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'das-asset',
        method: 'getAsset',
        params: { id: mint }
      })
    });

    const json = await res.json();
    const result = json?.result;

    const name =
      result?.content?.metadata?.name ||
      `NFT ${mint.slice(0, 4)}...${mint.slice(-4)}`;

    const grouping = Array.isArray(result?.grouping) ? result.grouping : [];
    const collectionGroup = grouping.find((g) => g.group_key === 'collection');

    const verified = Boolean(collectionGroup?.verified);
    const collectionName =
      result?.content?.metadata?.collection ||
      (collectionGroup?.group_value
        ? `Collection ${collectionGroup.group_value.slice(0, 4)}...${collectionGroup.group_value.slice(-4)}`
        : 'Unverified / New Mint');

    const image =
      result?.content?.links?.image ||
      result?.content?.files?.[0]?.uri ||
      '';

    const data = {
      name,
      collectionName,
      verified,
      image
    };

    metadataCache.set(mint, data);
    return data;
  } catch (err) {
    return {
      name: `NFT ${mint.slice(0, 4)}...${mint.slice(-4)}`,
      collectionName: 'Unverified / New Collection',
      verified: false,
      image: ''
    };
  }
}

app.post('/webhook/helius', async (req, res) => {
  const events = Array.isArray(req.body) ? req.body : [req.body];
  const now = Date.now();

  for (const ev of events) {
    if (!ev || ev.type !== 'NFT_SALE') continue;

    const saleInfo = ev.events?.nft || {};
    const nfts = Array.isArray(saleInfo.nfts) ? saleInfo.nfts : [];
    const amountLamports = Number(saleInfo.amount || 0);
    const priceSol = amountLamports > 0 ? amountLamports / 1e9 : 0;
    const timestamp = ev.timestamp ? Number(ev.timestamp) * 1000 : now;
    const signature = ev.signature || `${now}-${Math.random().toString(36).slice(2, 8)}`;

    if (nfts.length === 0) continue;

    for (const item of nfts) {
      const mint = item.mint || '';
      const meta = await fetchAssetMetadata(mint);

      recentSales.unshift({
        id: `${signature}-${mint}`,
        signature,
        mint,
        name: meta?.name || `NFT ${mint.slice(0, 4)}...${mint.slice(-4)}`,
        collectionName: meta?.collectionName || 'Unverified / New Collection',
        verified: Boolean(meta?.verified),
        image: meta?.image || '',
        priceSol,
        marketplace: saleInfo.source || ev.source || 'Solana
