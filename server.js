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
const QUICKNODE_RPC_URL = process.env.QUICKNODE_RPC_URL;
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
const collectionLookupCache = new Map();
const listingsCache = new Map();
const activitiesCache = new Map();
const launchCache = { at: 0, data: null };

async function quicknodeRpc(method, params) {
  if (!QUICKNODE_RPC_URL) {
    const error = new Error('QUICKNODE_RPC_URL is not configured on this NFT Aggregator service');
    error.status = 503;
    throw error;
  }
  const response = await fetch(QUICKNODE_RPC_URL, {
    method: 'POST', headers: { 'content-type': 'application/json', 'accept': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'nft-launch-scan', method, params }),
    signal: AbortSignal.timeout(25000)
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.error) {
    const error = new Error(payload.error?.message || `QuickNode returned HTTP ${response.status}`);
    error.status = response.status || 502;
    throw error;
  }
  return payload.result;
}

async function getRecentSolanaMints() {
  if (launchCache.data && Date.now() - launchCache.at < 45000) return launchCache.data;
  if (!QUICKNODE_RPC_URL) return { configured: false, scannedAt: null, assets: [], collections: [], note: 'Add QUICKNODE_RPC_URL to enable Solana mint discovery.' };
  const interfaces = ['V1_NFT', 'V2_NFT', 'ProgrammableNFT', 'MplCoreAsset'];
  const batches = await Promise.all(interfaces.map(async assetInterface => {
    try {
      const result = await quicknodeRpc('searchAssets', {
        interface: assetInterface,
        sortBy: { sortBy: 'created', sortDirection: 'desc' },
        limit: 40,
        options: { showCollectionMetadata: true }
      });
      return Array.isArray(result?.items) ? result.items : [];
    } catch (error) {
      console.error('QuickNode searchAssets failed for', assetInterface, error.status || 'network', error.message);
      return [];
    }
  }));
  const seen = new Set();
  const assets = batches.flat().filter(asset => {
    const id = asset?.id;
    if (!id || seen.has(id)) return false;
    seen.add(id); return true;
  }).map(asset => {
    const metadata = asset.content?.metadata || {};
    const file = (asset.content?.files || []).find(x => x.mime?.startsWith('image/')) || (asset.content?.files || [])[0];
    const collection = (asset.grouping || []).find(x => x.group_key === 'collection');
    const creators = (asset.creators || []).map(x => x.address).filter(Boolean);
    return {
      id: asset.id, name: metadata.name || 'Unnamed NFT', symbol: metadata.symbol || '',
      image: file?.uri || null, interface: asset.interface || 'NFT',
      collectionAddress: collection?.group_value || null,
      collectionName: collection?.collection_metadata?.name || collection?.name || null,
      collectionImage: collection?.collection_metadata?.image || null,
      verified: Boolean(collection?.verified), creators,
      createdAt: asset.created_at || asset.createdAt || null,
      printCurrentSupply: asset.supply?.print_current_supply ?? null,
      printMaxSupply: asset.supply?.print_max_supply ?? null,
      mint: asset.id
    };
  }).sort((a,b) => (new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime()));
  const grouped = new Map();
  for (const asset of assets) {
    const key = asset.collectionAddress || 'unverified:' + (asset.creators[0] || asset.id);
    const group = grouped.get(key) || {
      id: key, name: asset.collectionName || (asset.collectionAddress ? 'Unverified collection' : 'Unverified / ungrouped mints'),
      image: asset.collectionImage || asset.image, collectionAddress: asset.collectionAddress,
      verified: asset.verified, observedMints: 0, latestMintAt: asset.createdAt,
      sampleAssets: [], supply: null, supplySource: 'Not reported by asset indexer'
    };
    group.observedMints++;
    if (asset.createdAt && (!group.latestMintAt || new Date(asset.createdAt) > new Date(group.latestMintAt))) group.latestMintAt = asset.createdAt;
    if (group.sampleAssets.length < 6) group.sampleAssets.push(asset);
    grouped.set(key, group);
  }
  const collections = [...grouped.values()].sort((a,b) => new Date(b.latestMintAt || 0) - new Date(a.latestMintAt || 0));
  await Promise.all(collections.filter(x => x.collectionAddress).slice(0, 20).map(async group => {
    try {
      const result = await quicknodeRpc('getAssetsByGroup', { groupKey: 'collection', groupValue: group.collectionAddress, limit: 1, options: { showCollectionMetadata: true } });
      if (Number.isFinite(Number(result?.total))) group.mintedCount = Number(result.total);
    } catch (error) { console.error('QuickNode collection count failed:', error.status || 'network', error.message); }
  }));
  const data = { configured: true, scannedAt: new Date().toISOString(), assets: assets.slice(0, 80), collections, note: 'Minted count is indexed assets in each collection. Maximum supply is shown only when the launch program exposes it; otherwise it is not disclosed.' };
  launchCache.at = Date.now(); launchCache.data = data; return data;
}

function findArray(value, predicate, depth = 0) {
  if (!value || depth > 5) return [];
  if (Array.isArray(value)) {
    if (value.some(x => x && typeof x === 'object' && predicate(x))) return value;
    for (const x of value) { const found = findArray(x, predicate, depth + 1); if (found.length) return found; }
    return [];
  }
  if (typeof value === 'object') {
    for (const key of ['collections','results','items','data','listings','activities','tokens','records']) {
      if (key in value) { const found = findArray(value[key], predicate, depth + 1); if (found.length) return found; }
    }
    for (const child of Object.values(value)) { const found = findArray(child, predicate, depth + 1); if (found.length) return found; }
  }
  return [];
}

function isListingRecord(x) {
  if (!x || typeof x !== 'object' || Array.isArray(x)) return false;
  const keys = Object.keys(x).join(' ').toLowerCase();
  const nested = x.token || x.nft || x.item || x.asset;
  return /mint|price|token|listing|seller|image|rarity|name/.test(keys) ||
    (nested && typeof nested === 'object');
}
function findListingRows(value, depth = 0) {
  if (!value || depth > 9) return [];
  if (Array.isArray(value)) {
    const rows = value.filter(x => x && typeof x === 'object' && !Array.isArray(x));
    const score = rows.reduce((n, x) => {
      const k = Object.keys(x).join(' ').toLowerCase();
      return n + (/mint|token|price|listing|seller|pda|escrow|rarity|image|name/.test(k) || x.token || x.nft || x.asset ? 1 : 0);
    }, 0);
    if (rows.length && score > 0) return rows;
    for (const item of value) { const found = findListingRows(item, depth + 1); if (found.length) return found; }
    return [];
  }
  if (typeof value === 'object') {
    for (const key of ['listings','activities','items','results','tokens','nfts','assets','records','data']) {
      if (key in value) { const found = findListingRows(value[key], depth + 1); if (found.length) return found; }
    }
    for (const child of Object.values(value)) { const found = findListingRows(child, depth + 1); if (found.length) return found; }
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
async function lookupCollectionSymbolFromMint(mint) {
  if (!mint) return null;
  const cached = collectionLookupCache.get(mint);
  if (cached && Date.now() - cached.at < 3600000) return cached.symbol;
  try {
    const raw = await apiShGet('/magiceden/v1/token', { mint });
    const roots = [raw, raw?.token, raw?.data, raw?.result].filter(Boolean);
    let symbol = null;
    for (const root of roots) {
      if (root.collection && typeof root.collection === 'object') {
        symbol = root.collection.symbol || root.collection.collectionSymbol || root.collection.slug || null;
      }
      symbol = symbol || root.collectionSymbol || root.collection_symbol || null;
      if (symbol) break;
    }
    collectionLookupCache.set(mint, { at: Date.now(), symbol });
    return symbol;
  } catch (error) {
    console.error('Magic Eden mint-to-collection lookup failed:', error.status || 'network', error.message);
    return null;
  }
}

async function getGlobalNftSales(minutes) {
  const old = salesCache.get(minutes);
  if (old && Date.now() - old.at < 10000) return old.data;
  const since = new Date(Date.now() - minutes * 60000).toISOString();
  const query = 'query { Solana { DEXTradeByTokens(limit: {count: 250}, orderBy: {descending: Block_Time}, where: {Block: {Time: {since: "' + since + '"}}, Trade: {Currency: {Fungible: false}, Dex: {ProtocolFamily: {is: "MagicEden"}}}, Transaction: {Result: {Success: true}}}) { Block { Time } Transaction { Signature } Trade { Dex { ProtocolFamily ProtocolName } Currency { Name Symbol MintAddress CollectionAddress } Amount Side { Amount Currency { Symbol } } } } } }';
  const payload = await bitqueryGraphql(query);
  if (payload.errors?.length) { const e = new Error(payload.errors[0].message); e.details = payload.errors; throw e; }
  const sales = (payload.data?.Solana?.DEXTradeByTokens || []).map(row => {
    const t = row.Trade || {};
    return { time: row.Block?.Time || null, signature: row.Transaction?.Signature || null,
      symbol: t.Currency?.Symbol || 'Unknown', name: t.Currency?.Name || t.Currency?.Symbol || 'Unknown',
      mint: t.Currency?.MintAddress || null, collectionAddress: t.Currency?.CollectionAddress || null,
      nftAmount: t.Amount ?? null, price: t.Side?.Amount ?? null,
      priceCurrency: t.Side?.Currency?.Symbol || null,
      marketplace: t.Dex?.ProtocolName || t.Dex?.ProtocolFamily || 'Magic Eden' };
  });
  const groups = new Map();
  for (const sale of sales) {
    const key = sale.collectionAddress || sale.symbol;
    const g = groups.get(key) || { key, collectionAddress: sale.collectionAddress, sampleMint: sale.mint,
      symbol: sale.symbol, name: sale.name, salesCount: 0, volumeSol: 0,
      lastSale: sale.time, marketplace: sale.marketplace };
    g.salesCount++;
    if (sale.priceCurrency === 'SOL' && Number.isFinite(Number(sale.price))) g.volumeSol += Number(sale.price);
    if (sale.time && (!g.lastSale || new Date(sale.time) > new Date(g.lastSale))) g.lastSale = sale.time;
    groups.set(key, g);
  }
  await Promise.all([...groups.values()].filter(g => g.collectionAddress && g.sampleMint)
    .map(async g => { g.resolvedSymbol = await lookupCollectionSymbolFromMint(g.sampleMint); }));
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
    // Bitquery Currency.Symbol is the individual NFT's token symbol (e.g. Y00),
    // not reliably the Magic Eden collection slug (e.g. y00ts). Only promote a
    // trade group to a collection when its symbol exactly matches the ME directory.
    const active = salesData.groups.flatMap(g => {
      const resolved = g.resolvedSymbol || g.symbol;
      const meta = bySymbol.get(String(resolved || '').toLowerCase());
      if (!meta) return [];
      return [{ ...meta, salesCount:g.salesCount, volumeSol:g.volumeSol,
        lastSale:g.lastSale, marketplace:g.marketplace }];
    });
    // Return only collections backed by at least one real sale in this time window.
    // Never append zero-sale directory entries to the live sales leaderboard.
    const liveCollections = active.filter(x => Number(x.salesCount) > 0);
    res.json({ success:true, minutes, collections:liveCollections, activeCollections:liveCollections.length,
      sales:salesData.sales, providerErrors:{ directory:directoryResult.status === 'rejected' ? directoryResult.reason.message : null, sales:salesResult.status === 'rejected' ? salesResult.reason.message : null }, sources:{ directory:'API.SH / Magic Eden', sales:'Bitquery V2 / Magic Eden M2 + MMM' },
      limitations:['Tensor trades are not included in the current Bitquery feed.','Only collections present in the API.SH directory have directory artwork and metadata.'] });
  } catch (error) {
    console.error('NFT marketplace feed failed:', error.status || 'network', error.message);
    res.status(error.status || 502).json({ success:false, source:'NFT marketplace feed', error:error.message, details:error.details || undefined });
  }
});
app.get('/api/market/collection/:symbol/activities', async (req, res) => {
  const symbol = String(req.params.symbol || '').trim();
  if (!symbol || symbol.length > 120) return res.status(400).json({ success:false, error:'Invalid collection symbol' });
  const key = symbol.toLowerCase(), cached = activitiesCache.get(key);
  if (cached && Date.now() - cached.at < 15000) return res.json(cached.data);
  try {
    const data = await apiShGet('/magiceden/v1/activities', { symbol, type:'buyNow', limit:40, page:1 });
    const items = findListingRows(data);
    const result = { success:true, symbol, source:'API.SH / Magic Eden activity', count:items.length,
      credits_used:data?.credits_used ?? data?.meta?.credits_used ?? null, items, data };
    activitiesCache.set(key, { at:Date.now(), data:result }); res.json(result);
  } catch (error) {
    console.error('Magic Eden collection activities failed:', error.status || 'network', error.message);
    res.status(error.status || 502).json({ success:false, source:'API.SH Magic Eden activities', error:error.message, details:error.details || undefined });
  }
});

app.get('/api/market/collection/:symbol/listings', async (req, res) => {
  const symbol = String(req.params.symbol || '').trim();
  if (!symbol || symbol.length > 120) return res.status(400).json({ success:false, error:'Invalid collection symbol' });
  const key = symbol.toLowerCase(), cached = listingsCache.get(key);
  if (cached && Date.now() - cached.at < 15000) return res.json(cached.data);
  try {
    const data = await apiShGet('/magiceden/v1/listings', { symbol, offset:0, limit:40, sort:'listPrice', order:'asc', sort_direction:'asc' });
    const items = findListingRows(data);
    const result = { success:true, symbol, source:'API.SH / Magic Eden', count:items.length,
      credits_used:data?.credits_used ?? data?.meta?.credits_used ?? null, items, data };
    listingsCache.set(key, { at:Date.now(), data:result }); res.json(result);
  } catch (error) {
    console.error('Magic Eden listings failed:', error.status || 'network', error.message);
    res.status(error.status || 502).json({ success:false, source:'API.SH Magic Eden listings', error:error.message, details:error.details || undefined });
  }
});

app.get('/api/launches/recent', async (req, res) => {
  try {
    const data = await getRecentSolanaMints();
    res.json({ success: true, ...data });
  } catch (error) {
    console.error('QuickNode launch discovery failed:', error.status || 'network', error.message);
    res.status(error.status || 502).json({
      success: false,
      source: 'QuickNode Metaplex DAS',
      error: error.message
    });
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
