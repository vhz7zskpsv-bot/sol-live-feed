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
    if (API_KEY) headers.Authorization = 'Bearer ' + API_KEY;
    const response = await fetch(ME_BASE + pathname, { headers, signal: controller.signal });
    if (!response.ok) {
      const body = (await response.text()).slice(0, 500);
      const error = new Error('Magic Eden HTTP ' + response.status + ' at ' + pathname + (body ? ': ' + body : ''));
      error.status = response.status;
      throw error;
    }
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

function arr(value) { if (Array.isArray(value)) return value; if (!value || typeof value !== 'object') return []; for (const key of ['collections','results','activities','listings','tokens','data']) if (Array.isArray(value[key])) return value[key]; return []; }
function asNumber(value) { const n = Number(value); return Number.isFinite(n) ? n : 0; }
function asNullableNumber(value) { if (value === null || value === undefined || value === '') return null; const n = Number(value); return Number.isFinite(n) ? n : null; }
function pickTime(a) {
  const raw = a.blockTime ?? a.block_time ?? a.timestamp ?? a.createdAt ?? a.created_at ?? a.time;
  if (typeof raw === 'number') return raw > 1e12 ? raw : raw * 1000;
  const parsed = Date.parse(raw || '');
  return Number.isFinite(parsed) ? parsed : 0;
}
function pickPrice(a) {
  let n = asNumber(a.price ?? a.tokenPrice ?? a.amount ?? a.priceInfo?.solPrice ?? a.listPrice);
  if (a.priceInfo?.solPrice != null) n = asNumber(a.priceInfo.solPrice);
  else if (a.priceLamports != null) n = asNumber(a.priceLamports) / 1e9;
  return n;
}
function isSale(a) {
  const type = String(a.type || a.txType || a.activityType || a.eventType || a.event || '').toLowerCase().replace(/[\\s_-]/g, '');
  return ['buynow', 'sale', 'acceptbid', 'purchase', 'sold'].some(x => type.includes(x));
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
  const raw = await me('/collections?offset=0&limit=20');
  const collections = arr(raw);
  const activityResults = [];
  // Stay within Magic Eden's public read rate limits while checking the full visible collection page.
  for (let i = 0; i < collections.slice(0, 20).length; i += 4) {
    const batch = collections.slice(i, i + 4);
    const results = await Promise.allSettled(batch.map(async c => {
      if (!c.symbol || typeof c.symbol !== 'string') return [];
      const result = await me('/collections/' + encodeURIComponent(c.symbol) + '/activities?offset=0&limit=100');
      return arr(result).filter(isSale).map(a => normalizeSale(a, c)).filter(s => s.time);
    }));
    activityResults.push(...results);
  }
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
  const ranked = collections.map(c => {
    const ownSales = sales.filter(s => s.symbol === (c.symbol || '') && now - s.time <= 3600000 && now >= s.time);
    return {
      name: c.name || c.symbol || 'Unknown', symbol: c.symbol || '',
      floor: asNumber(c.floorPrice), volume24h: asNumber(c.volume24hr ?? c.volume24h),
      listed: asNumber(c.listedCount), image: c.image || c.imageURL || c.img || '',
      sales1h: ownSales.length, lastSaleAt: ownSales[0]?.time || 0
    };
  }).sort((a, b) => b.sales1h - a.sales1h || b.lastSaleAt - a.lastSaleAt || b.volume24h - a.volume24h).slice(0, 20);
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

app.get('/api/collections/:symbol/listings', async (req, res) => {
  try {
    const symbol = String(req.params.symbol || '').trim();
    if (!symbol || symbol.length > 100) return res.status(400).json({ error: 'Invalid collection symbol' });
    const limit = Math.min(40, Math.max(1, Number(req.query.limit) || 20));
    const offset = Math.max(0, Number(req.query.offset) || 0);
    const result = await me('/collections/' + encodeURIComponent(symbol) + '/listings?offset=' + offset + '&limit=' + limit + '&sort=listPrice&sort_direction=asc&listingAggMode=false');
    const listingRows = Array.isArray(result) ? result : arr(result);
    const listings = listingRows.map(item => {
      const token = item.token || item;
      const mint = item.tokenMint || item.mint || item.tokenAddress || token.mint || token.tokenMint || '';
      const rawPrice = item.price ?? item.listPrice ?? item.priceInfo?.solPrice ?? token.price ?? 0;
      return { mint, name: token.name || item.name || token.title || (mint ? mint.slice(0, 8) + '…' : 'Listed NFT'),
        image: token.image || token.imageURL || token.img || item.image || item.imageURL || '',
        price: asNumber(rawPrice), seller: item.seller || item.sellerAddress || '',
        magicEdenUrl: mint ? 'https://magiceden.io/item-details/' + encodeURIComponent(mint) : 'https://magiceden.io/marketplace/' + encodeURIComponent(symbol) };
    });
    res.json({ symbol, listings, count: listings.length, offset, limit, provider: 'Magic Eden' });
  } catch (error) {
    res.status(502).json({ error: error.message || 'Could not load collection listings' });
  }
});

app.get('/api/dashboard', async (_req, res) => {
  if (cache.data && Date.now() - cache.at < CACHE_MS) return res.json(cache.data);
  try {
    const data = await buildDashboard();
    cache = { at: Date.now(), data, error: null };
    res.json(data);
  } catch (error) {
    const status = error.status || 0;
    res.status(502).json({
      error: error.message || 'Market data unavailable',
      hint: status === 400
        ? 'Magic Eden rejected the request or collection symbol. This is not proof that an API key is missing.'
        : (status === 401 || status === 403)
          ? 'Magic Eden denied access. A valid MAGIC_EDEN_API_KEY may be required.'
          : 'Live data could not be fetched. No sample trades are shown.',
      updatedAt: new Date().toISOString()
    });
  }
});

app.listen(PORT, '0.0.0.0', () => console.log('NFT Sales Aggregator listening on ' + PORT));
