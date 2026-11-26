app.get('/api/market/collections', async (req, res) => {
  const minutes = [5,15,60,1440].includes(Number(req.query.minutes)) ? Number(req.query.minutes) : 15;
  try {
    const salesData = await getGlobalNftSales(minutes);
    const collectionsByKey = new Map();
    for (const g of salesData.groups) {
      const meta = g.collectionMeta || {};
      const address = meta.collectionAddress || g.collectionAddress || null;
      // Only show assets with a real collection address in the collection directory.
      // Unresolved individual NFT mints remain in the recent-sales feed and diagnostics.
      if (!address) continue;
      const key = 'collection:' + String(address).toLowerCase();
      // Keep grouping by the real collection address, but show readable metadata.
      // When DAS metadata is unavailable, fall back to Bitquery's NFT name/symbol
      // instead of exposing a long mint/collection address in the directory.
      const symbol = meta.symbol || g.symbol || 'NFT';
      const name = meta.name || g.name || symbol;
      const current = collectionsByKey.get(key) || {
        symbol, name, image: meta.image || null, floorPrice: null, listedCount: null,
        verified: Boolean(meta.verified), collectionAddress: address,
        sampleMint: g.sampleMint || null, salesCount: 0, volumeSol: 0,
        lastSale: null, marketplace: g.marketplace || 'Magic Eden',
        collectionResolved: Boolean(address)
      };
      current.salesCount += Number(g.salesCount || 0);
      current.volumeSol += Number(g.volumeSol || 0);
      if (!current.sampleMint && g.sampleMint) current.sampleMint = g.sampleMint;
      if (!current.image && meta.image) current.image = meta.image;
      if (g.lastSale && (!current.lastSale || new Date(g.lastSale) > new Date(current.lastSale))) current.lastSale = g.lastSale;
      collectionsByKey.set(key, current);
    }
    const collections = [...collectionsByKey.values()]
      .sort((a,b) => b.salesCount-a.salesCount || b.volumeSol-a.volumeSol || a.name.localeCompare(b.name));
    const resolvedGroups = salesData.groups.filter(g => Boolean(g.collectionMeta?.collectionAddress || g.collectionAddress)).length;
    const unresolvedGroups = salesData.groups.filter(g => !(g.collectionMeta?.collectionAddress || g.collectionAddress))
      .slice(0, 8).map(g => ({ nftSymbol: g.symbol, sampleMint: g.sampleMint, salesCount: g.salesCount }));
    const salesDiagnostics = {
      requestedWindowMinutes: minutes, bitqueryRequest: 'fulfilled',
      decodedSales: salesData.sales.length, groupedNftSymbols: salesData.groups.length,
      groupsResolvedToCollections: resolvedGroups,
      groupsNotMatchedToCollections: Math.max(0, salesData.groups.length - resolvedGroups),
      unresolvedSamples: unresolvedGroups,
      note: salesData.sales.length === 0 ? 'Bitquery returned zero decoded Magic Eden NFT trades in this time window.' : null
    };
    res.json({
      success: true, minutes, collections, activeCollections: collections.length,
      directoryCount: null, directoryPages: 0, directoryHasMore: false,
      sales: salesData.sales, salesDiagnostics, providerErrors: {},
      sources: {
        sales: 'Bitquery V2 / Magic Eden M2 + MMM',
        collectionMetadata: QUICKNODE_RPC_URL ? 'QuickNode Metaplex DAS' : 'Bitquery on-chain collection fields'
      },
      limitations: [
        'Collections are grouped from real sales in the selected time window; inactive collections are not requested.',
        'QuickNode DAS enriches collection names and images when on-chain collection metadata exists.',
        'Assets without a resolvable collection address are excluded from the collection directory but remain in recent sales and diagnostics.',
        'API.SH is not used by the main collections and sales feed. Per-collection listings and detail endpoints still require API.SH credits.'
      ]
    });
  } catch (error) {
    console.error('NFT marketplace feed failed:', error.status || 'network', error.message);
    res.status(error.status || 502).json({ success:false, source:'NFT marketplace feed', error:error.message, details:error.details || undefined });
  }
});
app.get('/api/market/collection/:symbol/activities', async (req, res) => {
  const symbol = String(req.params.symbol || '').trim();
  if (!symbol || symbol.length > 120) return res.status(400).json({ success:false, error:'Invalid Magic Eden collection symbol' });
  const key = symbol.toLowerCase(), cached = activitiesCache.get(key);
  if (cached && Date.now() - cached.at < 15000) return res.json(cached.data);
  try {
    const data = await magicEdenGet('/collections/' + encodeURIComponent(symbol) + '/activities', { offset:0, limit:100 });
    const items = findListingRows(data);
    const result = { success:true, symbol, source:'Magic Eden public Solana API', count:items.length, items, data };
    activitiesCache.set(key, { at:Date.now(), data:result }); res.json(result);
  } catch (error) {
    console.error('Magic Eden collection activities failed:', error.status || 'network', error.message);
    res.status(error.status || 502).json({ success:false, source:'Magic Eden public Solana API', error:error.message, details:error.details || undefined });
  }
});

app.get('/api/market/collection/:symbol/listings', async (req, res) => {
  const symbol = String(req.params.symbol || '').trim();
  if (!symbol || symbol.length > 120) return res.status(400).json({ success:false, error:'Invalid Magic Eden collection symbol' });
  const key = symbol.toLowerCase(), cached = listingsCache.get(key);
  if (cached && Date.now() - cached.at < 15000) return res.json(cached.data);
  try {
    const data = await magicEdenGet('/collections/' + encodeURIComponent(symbol) + '/listings', {
      offset:0, limit:40, sort:'listPrice', sort_direction:'asc', listingAggMode:true
    });
    const items = findListingRows(data);
    const result = { success:true, symbol, source:'Magic Eden public Solana API', count:items.length, items, data };
    listingsCache.set(key, { at:Date.now(), data:result }); res.json(result);
  } catch (error) {
    console.error('Magic Eden listings failed:', error.status || 'network', error.message);
    res.status(error.status || 502).json({ success:false, source:'Magic Eden public Solana API', error:error.message, details:error.details || undefined });
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

  console.log('Sales feed: Bitquery V2. Collection metadata and detail reads: Magic Eden public API.');
});
app.get('/api/market/collections', async (req, res) => {
  const minutes = [5,15,60,1440].includes(Number(req.query.minutes)) ? Number(req.query.minutes) : 15;
  try {
    const salesData = await getGlobalNftSales(minutes);
    const collectionsByKey = new Map();
    for (const g of salesData.groups) {
      const meta = g.collectionMeta || {};
      const address = meta.collectionAddress || g.collectionAddress || null;
      const marketSymbol = meta.collectionSymbol || null;
      // Only publish a collection when its identity is backed by a collection address
      // or Magic Eden's own collection symbol. Never substitute an individual NFT name.
      if (!address && !marketSymbol) continue;
      const key = marketSymbol
        ? 'magiceden:' + String(marketSymbol).toLowerCase()
        : 'address:' + String(address).toLowerCase();
      const symbol = marketSymbol || ('COLL-' + String(address).slice(0, 7));
      const name = meta.name || (marketSymbol ? marketSymbol.replace(/[_-]+/g, ' ') : null);
      if (!name) continue;
      const current = collectionsByKey.get(key) || {
        id: key, symbol, magicEdenSymbol: marketSymbol, name,
        image: meta.image || null,
        floorPrice: meta.floorPrice ?? null, listedCount: meta.listedCount ?? null,
        verified: Boolean(meta.verified), collectionAddress: address,
        salesCount: 0, volumeSol: 0, lastSale: null,
        marketplace: g.marketplace || 'Magic Eden',
        collectionResolved: true
      };
      current.salesCount += Number(g.salesCount || 0);
      current.volumeSol += Number(g.volumeSol || 0);
      if (!current.collectionAddress && address) current.collectionAddress = address;
      if (!current.magicEdenSymbol && marketSymbol) current.magicEdenSymbol = marketSymbol;
      if (!current.image && meta.image) current.image = meta.image;
      if (meta.floorPrice !== null && meta.floorPrice !== undefined) current.floorPrice = meta.floorPrice;
      if (meta.listedCount !== null && meta.listedCount !== undefined) current.listedCount = meta.listedCount;
      if (g.lastSale && (!current.lastSale || new Date(g.lastSale) > new Date(current.lastSale))) current.lastSale = g.lastSale;
      collectionsByKey.set(key, current);
    }
    const collections = [...collectionsByKey.values()]
      .sort((a,b) => b.salesCount-a.salesCount || b.volumeSol-a.volumeSol || a.name.localeCompare(b.name));
    const resolvedGroups = salesData.groups.filter(g =>
      Boolean(g.collectionMeta?.collectionAddress || g.collectionAddress || g.collectionMeta?.collectionSymbol)).length;
    const magicEdenGroups = salesData.groups.filter(g => Boolean(g.collectionMeta?.collectionSymbol)).length;
    const unresolvedGroups = salesData.groups.filter(g =>
      !(g.collectionMeta?.collectionAddress || g.collectionAddress || g.collectionMeta?.collectionSymbol))
      .slice(0, 8).map(g => ({ nftSymbol: g.symbol, sampleMint: g.sampleMint, salesCount: g.salesCount }));
    const salesDiagnostics = {
      requestedWindowMinutes: minutes, bitqueryRequest: 'fulfilled',
      decodedSales: salesData.sales.length, groupedSaleIdentities: salesData.groups.length,
      groupsResolvedToCollections: resolvedGroups,
      groupsResolvedToMagicEden: magicEdenGroups,
      groupsNotMatchedToCollections: Math.max(0, salesData.groups.length - resolvedGroups),
      unresolvedSamples: unresolvedGroups,
      note: salesData.sales.length === 0 ? 'Bitquery returned zero decoded Magic Eden NFT trades in this time window.' : null
    };
    res.json({
      success: true, minutes, collections, activeCollections: collections.length,
      directoryCount: collections.length, directoryPages: 1, directoryHasMore: false,
      sales: salesData.sales, salesDiagnostics, providerErrors: {},
      sources: {
        sales: 'Bitquery V2 / Magic Eden M2 + MMM',
        collectionMetadata: 'Magic Eden public Solana API + optional QuickNode Metaplex DAS'
      },
      limitations: [
        'Collection cards are grouped by Magic Eden collection symbol or on-chain collection address, never by an individual NFT name.',
        'Magic Eden public read endpoints are rate-limited; collection metadata is cached.',
        'Unresolved assets remain in recent sales and diagnostics but are not shown as collections.',
        'API.SH credits are not required for the main feed, collection links, listings, or activities.'
      ]
    });
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
