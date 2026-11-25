const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 8080;
const ME_BASE = 'https://api-mainnet.magiceden.dev/v2';
const API_KEY = process.env.MAGIC_EDEN_API_KEY || '';
const CACHE_MS = 20_000;
let cache = { at: 0, data: null, error: null };

app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (_req, res) => res.json({ ok: true, service: 'nft-sales-aggregator' }));

async function me(pathname) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  try {
    const headers = { accept: 'application/json' };
    if (API_KEY) headers['Authorization'] = 'Bearer ' + API_KEY;
    const response = await fetch(ME_BASE + pathname, { headers, signal: controller.signal });
    if (!response.ok) throw new Error('Magic Eden API returned HTTP ' + response.status);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

function arr(value) { return Array.isArray(value) ? value : (value && Array.isArray(value.collections) ? value.collections : []); }
function asNumber(value) { const n = Number(value); return Number.isFinite(n) ? n : 0; }
function pickTime(a) {
  const raw = a.blockTime ?? a.timestamp ?? a.createdAt ?? a.time;
  if (typeof raw === 'number') return raw > 1e12 ? raw : raw * 1000;
  const parsed = Date.parse(raw || '');
  return Number.isFinite(parsed) ? parsed : 0;
}
function pickPrice(a) {
  const raw = a.price ?? a.tokenPrice ?? a.amount ?? a.priceInfo?.solPrice;
  let n = asNumber(raw);
  if (a.priceInfo?.solPrice != null) n = asNumber(a.priceInfo.solPrice);
  else if (a.priceLamports != null) n = asNumber(a.priceLamports) / 1e9;
  return n;
}
function isSale(a) {
  const type = String(a.type || a.txType || a.activityType || '').toLowerCase();
  return ['buynow', 'buy_now', 'sale', 'acceptbid', 'accept_bid', 'purchase'].some(x => type.includes(x));
}
function normalizeSale(a, collection) {
  return {
    collection: collection.name || collection.symbol || 'Unknown collection',
    symbol: collection.symbol || '',
    price: pickPrice(a),
    buyer: a.buyer || a.buyerAddress || a.taker || a.owner || '',
    seller: a.seller || a.sellerAddress || '',
    mint: a.tokenMint || a.mint || a.tokenAddress || '',
    signature: a.signature || a.txSignature || a.txid || '',
    time: pickTime(a),
    marketplace: 'Magic Eden'
  };
}

async function buildDashboard() {
  const raw = await me('/collections?offset=0&limit=30');
  const collections = arr(raw);
  const activityResults = await Promise.allSettled(collections.slice(0, 15).map(async c => {
    const symbol = c.symbol || c.id;
    if (!symbol) return [];
    const result = await me('/collections/' + encodeURIComponent(symbol) + '/activities?offset=0&limit=100');
    return arr(result).filter(isSale).map(a => normalizeSale(a, c)).filter(s => s.time);
  }));
  const sales = activityResults.flatMap(r => r.status === 'fulfilled' ? r.value : []);
  sales.sort((a, b) => b.time - a.time);
  const now = Date.now();
  const windows = {};
  for (const [key, ms] of Object.entries({ '5m': 300000, '15m': 900000, '1h': 3600000 })) {
    const items = sales.filter(s => now - s.time <= ms && now >= s.time);
    windows[key] = {
      count: items.length,
      volumeSol: Number(items.reduce((sum, s) => sum + s.price, 0).toFixed(4)),
      sales: items.slice(0, 40)
    };
  }
  const ranked = collections.map(c => ({
    name: c.name || c.symbol || 'Unknown',
    symbol: c.symbol || '',
    floor: asNumber(c.floorPrice),
    volume24h: asNumber(c.volume24hr ?? c.volume24h),
    listed: asNumber(c.listedCount),
    image: c.image || c.imageURL || c.img || ''
  })).sort((a, b) => b.volume24h - a.volume24h).slice(0, 20);
  return {
    updatedAt: new Date().toISOString(),
    provider: 'Magic Eden',
    apiKeyConfigured: Boolean(API_KEY),
    coverage: 'Magic Eden activity only; not all Solana marketplaces',
    collections: ranked,
    windows,
    salesScanned: sales.length
  };
}

app.get('/api/dashboard', async (_req, res) => {
  if (cache.data && Date.now() - cache.at < CACHE_MS) return res.json(cache.data);
  try {
    const data = await buildDashboard();
    cache = { at: Date.now(), data, error: null };
    res.json(data);
  } catch (error) {
    res.status(502).json({
      error: error.message || 'Market data unavailable',
      hint: 'Live data could not be fetched. Configure MAGIC_EDEN_API_KEY if your API access requires one. No sample trades are shown.',
      updatedAt: new Date().toISOString()
    });
  }
});

app.listen(PORT, '0.0.0.0', () => console.log('NFT Sales Aggregator listening on ' + PORT));
