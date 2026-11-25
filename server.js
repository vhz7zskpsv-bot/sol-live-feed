const express = require('express');
const http = require('http');

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 8080;
const API_SH_KEY = process.env.API_SH_KEY;
const API_SH_BASE = 'https://api.api.sh';
const BITQUERY_CLIENT_ID = process.env.BITQUERY_CLIENT_ID;
const BITQUERY_CLIENT_SECRET = process.env.BITQUERY_CLIENT_SECRET;
const BITQUERY_TOKEN_URL = 'https://oauth2.bitquery.io/oauth2/token';
const BITQUERY_GRAPHQL_URL = 'https://streaming.bitquery.io/graphql';
let bitqueryToken = null;
let bitqueryTokenExpiresAt = 0;

async function getBitqueryToken() {
  if (bitqueryToken && Date.now() < bitqueryTokenExpiresAt - 60000) return bitqueryToken;
  if (!BITQUERY_CLIENT_ID || !BITQUERY_CLIENT_SECRET) {
    const error = new Error('Bitquery client credentials are not configured');
    error.status = 503;
    throw error;
  }
  const form = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: BITQUERY_CLIENT_ID,
    client_secret: BITQUERY_CLIENT_SECRET,
    scope: 'api'
  });
  const response = await fetch(BITQUERY_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'accept': 'application/json' },
    body: form,
    signal: AbortSignal.timeout(20000)
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.access_token) {
    const error = new Error(payload.error_description || payload.error || 'Bitquery OAuth token request failed');
    error.status = response.status || 502;
    throw error;
  }
  bitqueryToken = payload.access_token;
  bitqueryTokenExpiresAt = Date.now() + (Number(payload.expires_in) || 3600) * 1000;
  return bitqueryToken;
}

async function bitqueryGraphql(query) {
  const token = await getBitqueryToken();
  const response = await fetch(BITQUERY_GRAPHQL_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'authorization': 'Bearer ' + token, 'accept': 'application/json' },
    body: JSON.stringify({ query }),
    signal: AbortSignal.timeout(30000)
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.errors?.[0]?.message || 'Bitquery GraphQL request failed');
    error.status = response.status || 502;
    error.details = payload.errors || undefined;
    throw error;
  }
  return payload;
}


app.use(express.static('public'));

async function apiShGet(path, query = {}) {
  if (!API_SH_KEY) {
    const error = new Error('API_SH_KEY is not configured on this NFT Aggregator service');
    error.status = 503;
    throw error;
  }

  const url = new URL(path, API_SH_BASE);
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && String(value).length) {
      url.searchParams.set(key, String(value));
    }
  }

  const response = await fetch(url, {
    method: 'GET',
    headers: { 'x-api-key': API_SH_KEY, 'accept': 'application/json' },
    signal: AbortSignal.timeout(30000)
  });

  const bodyText = await response.text();
  let body;
  try { body = JSON.parse(bodyText); }
  catch { body = { raw: bodyText.slice(0, 2000) }; }

  if (!response.ok) {
    const error = new Error(body?.error || body?.message || `API.SH returned HTTP ${response.status}`);
    error.status = response.status;
    error.details = body;
    throw error;
  }
  return body;
}


const directoryCache = { at: 0, data: null };
const salesCache = new Map();
const listingsCache = new Map();

function findArray(value, predicate, depth = 0) {
  if (!value || depth > 5) return [];
  if (Array.isArray(value)) {
    if (value.some(x => x && typeof x === 'object' && predicate(x))) return value;
    for (const x of value) { const found = findArray(x, predicate, depth + 1); if (found.length) return found; }
    return [];
  }
  if (typeof value === 'object') {
    for (const key of ['collections','results','items','data','listings','tokens','records']) {
      if (key in value) { const found = findArray(value[key], predicate, depth + 1); if (found.length) return found; }
    }
    for (const child of Object.values(value)) { const found = findArray(child, predicate, depth + 1); if (found.length) return found; }
  }
  return [];
}
function normalizeCollection(x) {
  const symbol = x.symbol || x.collectionSymbol || x.collection_symbol || x.id || '';
  return { symbol: String(symbol), name: x.name || x.title || x.collectionName || String(symbol),
    image: x.image || x.imageUrl || x.imageURL || x.imageUri || x.imageURI || x.logo || x.logoUrl || null,
    floorPrice: x.floorPrice ?? x.floor_price ?? x.floor ?? null,
    listedCount: x.listedCount ?? x.listed_count ?? x.listed ?? null,
    verified: x.isVerified ?? x.verified ?? false, raw: x };
}
async function getCollectionDirectory() {
  if (directoryCache.data && Date.now() - directoryCache.at < 60000) return directoryCache.data;
  const raw = await apiShGet('/magiceden/v1/collections', { offset: 0, limit: 100 });
  const rows = findArray(raw, x => x.symbol || x.collectionSymbol || x.collection_symbol).map(normalizeCollection).filter(x => x.symbol);
  directoryCache.at = Date.now(); directoryCache.data = { rows, raw }; return directoryCache.data;
}
async function getGlobalNftSales(minutes) {
  const old = salesCache.get(minutes);
  if (old && Date.now() - old.at < 10000) return old.data;
  const since = new Date(Date.now() - minutes * 60000).toISOString();
  const query = 'query { Solana { DEXTradeByTokens(limit: {count: 250}, orderBy: {descending: Block_Time}, where: {Block: {Time: {since: "' + since + '"}}, Trade: {Currency: {Fungible: false}, Dex: {ProtocolFamily: {is: "MagicEden"}}}, Transaction: {Result: {Success: true}}}) { Block { Time } Transaction { Signature } Trade { Dex { ProtocolFamily ProtocolName } Currency { Symbol MintAddress } Amount Side { Amount Currency { Symbol } } } } } }';
  const payload = await bitqueryGraphql(query);
  if (payload.errors?.length) { const e = new Error(payload.errors[0].message); e.details = payload.errors; throw e; }
  const sales = (payload.data?.Solana?.DEXTradeByTokens || []).map(row => {
    const t = row.Trade || {};
    return { time: row.Block?.Time || null, signature: row.Transaction?.Signature || null,
      symbol: t.Currency?.Symbol || 'Unknown', name: t.Currency?.Symbol || 'Unknown',
      mint: t.Currency?.MintAddress || null, nftAmount: t.Amount ?? null,
      price: t.Side?.Amount ?? null, priceCurrency: t.Side?.Currency?.Symbol || null,
      marketplace: t.Dex?.ProtocolName || t.Dex?.ProtocolFamily || 'Magic Eden' };
  });
  const groups = new Map();
  for (const sale of sales) {
    const key = sale.symbol;
    const g = groups.get(key) || { symbol: key, name: sale.name, salesCount: 0, volumeSol: 0, lastSale: sale.time, marketplace: sale.marketplace };
    g.salesCount++;
    if (sale.priceCurrency === 'SOL' && Number.isFinite(Number(sale.price))) g.volumeSol += Number(sale.price);
    if (sale.time && (!g.lastSale || new Date(sale.time) > new Date(g.lastSale))) g.lastSale = sale.time;
    groups.set(key, g);
  }
  const data = { sales, groups: [...groups.values()].sort((a,b) => b.salesCount-a.salesCount || b.volumeSol-a.volumeSol) };
  salesCache.set(minutes, { at: Date.now(), data }); return data;
}

function proxyApiSh(path, allowedParams) {
  return async (req, res) => {
    try {
      const query = {};
      for (const name of allowedParams) {
        if (req.query[name] !== undefined) query[name] = req.query[name];
      }
      const data = await apiShGet(path, query);
      res.json(data);
    } catch (error) {
      console.error(`API.SH ${path} failed:`, error.status || 'network', error.message);
      res.status(error.status || 502).json({
        success: false,
        source: 'api.sh',
        error: error.message,
        details: error.details || undefined
      });
    }
  };
}

// Read-only Magic Eden data through API.SH. Each successful upstream call costs 1 credit.
app.get('/api/collections', proxyApiSh('/magiceden/v1/collections',
  ['offset', 'limit', 'sort', 'order']));
app.get('/api/activities', proxyApiSh('/magiceden/v1/activities',
  ['symbol', 'type', 'limit', 'page']));
app.get('/api/listings', proxyApiSh('/magiceden/v1/listings',
  ['symbol', 'offset', 'limit', 'sort', 'order', 'minPrice', 'maxPrice', 'attributes']));

// Authentication + schema smoke test against Bitquery V2 Solana NFT trade data.
app.get('/api/bitquery/test', async (req, res) => {
  const query = 'query { Solana { DEXTradeByTokens(limit: { count: 5 }, where: { Trade: { Currency: { Fungible: false } }, Transaction: { Result: { Success: true } } }) { Trade { Dex { ProtocolName ProtocolFamily } Currency { Symbol MintAddress } Amount Side { Currency { Symbol } Amount } } } } }';
  try {
    const payload = await bitqueryGraphql(query);
    res.json({ success: !payload.errors, provider: 'Bitquery V2', endpoint: BITQUERY_GRAPHQL_URL, authentication: 'OAuth client credentials accepted', data: payload.data || null, errors: payload.errors || null });
  } catch (error) {
    console.error('Bitquery test failed:', error.status || 'network', error.message);
    res.status(error.status || 502).json({ success: false, provider: 'Bitquery V2', error: error.message, details: error.details || undefined });
  }
});

app.get('/api/market/collections', async (req, res) => {
  const minutes = [5,15,60,1440].includes(Number(req.query.minutes)) ? Number(req.query.minutes) : 15;
  try {
    const [directoryResult, salesResult] = await Promise.allSettled([getCollectionDirectory(), getGlobalNftSales(minutes)]);
    const directory = directoryResult.status === 'fulfilled' ? directoryResult.value.rows : [];
    const salesData = salesResult.status === 'fulfilled' ? salesResult.value : { sales: [], groups: [] };
    const bySymbol = new Map(directory.map(x => [x.symbol.toLowerCase(), x]));
    const active = salesData.groups.map(g => {
      const meta = bySymbol.get(g.symbol.toLowerCase());
      return { ...(meta || { symbol:g.symbol, name:g.name, image:null, floorPrice:null, listedCount:null, verified:false }),
        salesCount:g.salesCount, volumeSol:g.volumeSol, lastSale:g.lastSale, marketplace:g.marketplace };
    });
    const activeKeys = new Set(active.map(x => x.symbol.toLowerCase()));
    const inactive = directory.filter(x => !activeKeys.has(x.symbol.toLowerCase()))
      .map(x => ({ ...x, salesCount:0, volumeSol:0, lastSale:null, marketplace:null }));
    res.json({ success:true, minutes, collections:[...active, ...inactive], activeCollections:active.length,
      sales:salesData.sales, providerErrors:{ directory:directoryResult.status === 'rejected' ? directoryResult.reason.message : null, sales:salesResult.status === 'rejected' ? salesResult.reason.message : null }, sources:{ directory:'API.SH / Magic Eden', sales:'Bitquery V2 / Magic Eden M2 + MMM' },
      limitations:['Tensor trades are not included in the current Bitquery feed.','Only collections present in the API.SH directory have directory artwork and metadata.'] });
  } catch (error) {
    console.error('NFT marketplace feed failed:', error.status || 'network', error.message);
    res.status(error.status || 502).json({ success:false, source:'NFT marketplace feed', error:error.message, details:error.details || undefined });
  }
});
app.get('/api/market/collection/:symbol/listings', async (req, res) => {
  const symbol = String(req.params.symbol || '').trim();
  if (!symbol || symbol.length > 120) return res.status(400).json({ success:false, error:'Invalid collection symbol' });
  const key = symbol.toLowerCase(), cached = listingsCache.get(key);
  if (cached && Date.now() - cached.at < 15000) return res.json(cached.data);
  try {
    const data = await apiShGet('/magiceden/v1/listings', { symbol, offset:0, limit:50, sort:'listPrice', order:'asc' });
    const result = { success:true, symbol, source:'API.SH / Magic Eden', data };
    listingsCache.set(key, { at:Date.now(), data:result }); res.json(result);
  } catch (error) {
    console.error('Magic Eden listings failed:', error.status || 'network', error.message);
    res.status(error.status || 502).json({ success:false, source:'API.SH Magic Eden listings', error:error.message, details:error.details || undefined });
  }
});

app.get('/api/config', (req, res) => {
  res.json({
    provider: 'API.SH / Magic Eden',
    configured: Boolean(API_SH_KEY),
    mode: 'read-only',
    heliusRequired: false
  });
});

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', provider: 'api.sh', configured: Boolean(API_SH_KEY) });
});

app.get('/', (req, res) => {
  res.type('html').send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Solana NFT Live Feed</title>
<style>
*{box-sizing:border-box}body{margin:0;background:#080b14;color:#e8efff;font:15px system-ui,sans-serif}
main{max-width:1100px;margin:36px auto;padding:0 18px}.top{border:1px solid #202b43;background:#101729;border-radius:16px;padding:22px}
h1{margin:0 0 8px;color:#72e5ff;font-size:25px}.muted{color:#94a3bd}.actions{display:flex;gap:10px;flex-wrap:wrap;margin:20px 0}
button{background:#13243a;border:1px solid #23617b;color:#8beaff;padding:11px 15px;border-radius:9px;font-weight:650}
button:active{transform:scale(.98)}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#0c1220;border:1px solid #202b43;padding:16px;border-radius:12px;min-height:180px;color:#c6d7f4}
.status{margin-top:12px;color:#a5f3c5}.warning{color:#ffd18b}
</style></head><body><main>
<section class="top"><h1>Solana NFT Live Feed</h1>
<div class="muted">Read-only Magic Eden public data via API.SH · No wallet connection · No Helius dependency</div>
<div id="status" class="status">Checking API.SH configuration…</div></section>
<div class="actions">
<input id="symbolInput" value="okay_bears" placeholder="Collection symbol (e.g. okay_bears)" style="min-width:250px;background:#0c1220;border:1px solid #23617b;color:#e8efff;padding:11px;border-radius:9px"><button onclick="loadSales()">Recent sales</button>
<button onclick="loadData('/api/bitquery/test','Bitquery V2 test')">Test Bitquery V2</button>
<button onclick="loadData('/api/collections?limit=20','Collections')">Collections</button>
<button onclick="loadData('/api/listings?symbol=okay_bears&limit=20','Example listings (Okay Bears)')">Example listings</button>
</div>
<div class="muted">API response (raw JSON — no synthetic/demo records)</div><pre id="output">Choose an endpoint above to request live data.</pre>
<script>
const statusEl=document.getElementById('status');
fetch('/api/config').then(r=>r.json()).then(x=>{
 statusEl.textContent=x.configured?'API.SH key detected. Ready to request live marketplace data.':'API_SH_KEY is missing from Railway Variables.';
 if(!x.configured)statusEl.className='warning';
}).catch(()=>{statusEl.textContent='Could not read service configuration';statusEl.className='warning'});
function loadSales(){const symbol=document.getElementById('symbolInput').value.trim();if(!symbol){statusEl.textContent='Enter a collection symbol first.';return;}loadData('/api/activities?symbol='+encodeURIComponent(symbol)+'&type=buyNow&limit=100','Recent sales · '+symbol);}
async function loadData(path,label){
 const out=document.getElementById('output');out.textContent='Loading '+label+'…';
 try{const r=await fetch(path);const data=await r.json();out.textContent=JSON.stringify(data,null,2);
 if(!r.ok)statusEl.textContent='API.SH request failed: '+(data.error||r.status);
 else statusEl.textContent=label+' loaded from API.SH. Check credits_used in response.';
 }catch(e){out.textContent=e.message;statusEl.textContent='Request failed';}
}
</script></main></body></html>`);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`NFT Aggregator server running on 0.0.0.0:${PORT}`);
  if (!API_SH_KEY) {
    console.error('API_SH_KEY is missing. Add it to the NFT Aggregator Railway service variables.');
    return;
  }

  // One low-cost authentication/configuration probe at startup (1 API.SH credit).
  apiShGet('/magiceden/v1/collections', { limit: 20 })
    .then(data => console.log('API.SH authentication OK; collections endpoint responded.',
      'credits_used:', data?.credits_used ?? 'not reported'))
    .catch(error => console.error('API.SH startup check failed:',
      error.status || 'network', error.message));
});
