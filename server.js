const express = require('express');
const cors = require('cors');
const app = express();

app.use(cors());
app.use(express.json({ limit: '5mb' }));

const HELIUS_API_KEY = process.env.HELIUS_API_KEY || '';
const HELIUS_RPC = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;

let recentSales = [];
const metadataCache = new Map();

// Purani sales (1 ghante se zyada) har 30 second mein clean karein
setInterval(() => {
  const oneHourAgo = Date.now() - 60 * 60 * 1000;
  recentSales = recentSales.filter(sale => sale.timestamp >= oneHourAgo);
}, 30000);

function deriveCollectionName(rawName, symbol) {
  const cleaned = (rawName || '').replace(/#\d+.*$/, '').trim();
  if (cleaned && cleaned.length > 1) return cleaned;
  if (symbol && symbol.trim().length > 0) return symbol.trim();
  return 'New Unverified NFT';
}

async function fetchNftMetadata(mint) {
  if (!mint || !HELIUS_API_KEY) return null;
  if (metadataCache.has(mint)) return metadataCache.get(mint);

  try {
    const response = await fetch(HELIUS_RPC, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'nft-meta',
        method: 'getAsset',
        params: { id: mint }
      })
    });
    const data = await response.json();
    const result = data.result;
    if (!result) return null;

    const nftName = result.content?.metadata?.name || `${mint.slice(0, 6)}...`;
    const symbol = result.content?.metadata?.symbol || '';
    const image = result.content?.links?.image || result.content?.files?.[0]?.uri || '';

    const collectionGroup = result.grouping?.find(g => g.group_key === 'collection');
    const isVerified = Boolean(collectionGroup?.group_value);

    const authority =
      result.authorities?.find(a => a.scopes?.includes('full'))?.address ||
      result.authorities?.[0]?.address ||
      '';

    const collectionName = deriveCollectionName(nftName, symbol);

    const groupKey = isVerified
      ? `ver:${collectionGroup.group_value}`
      : `unver:${collectionName.toLowerCase()}:${authority.slice(0, 8)}`;

    const meta = {
      nftName,
      image,
      collectionName,
      groupKey,
      isVerified,
      mint
    };

    metadataCache.set(mint, meta);
    return meta;
  } catch (err) {
    console.error('Metadata fetch error:', err.message);
    return null;
  }
}

// 1. HELIUS WEBHOOK ENDPOINT
app.post('/webhook/helius', async (req, res) => {
  res.status(200).send('OK');

  const events = Array.isArray(req.body) ? req.body : [req.body];

  for (const tx of events) {
    if (tx.type === 'NFT_SALE' && tx.events && tx.events.nft) {
      const nftEvent = tx.events.nft;
      const amountSol = (nftEvent.amount || 0) / 1e9;
      const mint = nftEvent.nfts?.[0]?.mint || '';
      const source = tx.source || 'MARKETPLACE';

      const meta = await fetchNftMetadata(mint);

      const nftName = meta?.nftName || nftEvent.nfts?.[0]?.name || `${mint.slice(0, 6)}...`;
      const collectionName =
        meta?.collectionName || deriveCollectionName(nftName, '');
      const isVerified = meta ? meta.isVerified : false;
      const groupKey =
        meta?.groupKey || `unver:${collectionName.toLowerCase()}:${mint.slice(0, 6)}`;
      const image = meta?.image || '';

      recentSales.unshift({
        id: tx.signature,
        groupKey,
        collection: collectionName,
        isVerified,
        nftName,
        mint,
        image,
        price: Number(amountSol.toFixed(3)),
        marketplace: source,
        timestamp: Date.now()
      });
    }
  }
});

// 2. API ENDPOINT FOR 5M / 15M / 1H + FILTER (all | unverified | verified)
app.get('/api/trending', (req, res) => {
  const minutes = parseInt(req.query.tf) || 5;
  const filter = req.query.filter || 'all';
  const cutoff = Date.now() - minutes * 60 * 1000;

  let filtered = recentSales.filter(s => s.timestamp >= cutoff);

  if (filter === 'unverified') {
    filtered = filtered.filter(s => !s.isVerified);
  } else if (filter === 'verified') {
    filtered = filtered.filter(s => s.isVerified);
  }

  const grouped = {};
  filtered.forEach(sale => {
    const key = sale.groupKey;
    if (!grouped[key]) {
      grouped[key] = {
        name: sale.collection,
        isVerified: sale.isVerified,
        lastMint: sale.mint,
        image: sale.image,
        salesCount: 0,
        totalVolume: 0,
        lastPrice: sale.price,
        lastMarketplace: sale.marketplace
      };
    }
    if (!grouped[key].image && sale.image) grouped[key].image = sale.image;
    grouped[key].salesCount += 1;
    grouped[key].totalVolume = Number((grouped[key].totalVolume + sale.price).toFixed(3));
    grouped[key].lastPrice = sale.price;
    grouped[key].lastMarketplace = sale.marketplace;
    grouped[key].lastMint = sale.mint;
  });

  const leaderboard = Object.values(grouped).sort(
    (a, b) => b.salesCount - a.salesCount || b.totalVolume - a.totalVolume
  );

  res.json({
    timeframe: `${minutes}m`,
    filter,
    totalSalesInWindow: filtered.length,
    collections: leaderboard,
    liveFeed: filtered.slice(0, 20)
  });
});

// 3. IPHONE MOBILE UI
app.get('/', (req, res) => {
  res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no" />
  <meta name="apple-mobile-web-app-capable" content="yes" />
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
  <title>Solana NFT Pulse</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, sans-serif; }
    body { background: #0b0e14; color: #f1f5f9; padding: 16px; padding-top: env(safe-area-inset-top, 20px); }
    .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 14px; }
    .title { font-size: 20px; font-weight: 700; display: flex; align-items: center; gap: 8px; }
    .dot { width: 10px; height: 10px; background: #14f195; border-radius: 50%; box-shadow: 0 0 8px #14f195; animation: pulse 1.5s infinite; }
    @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }
    .tabs { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; background: #151a24; padding: 4px; border-radius: 12px; margin-bottom: 10px; }
    .tab { padding: 9px; text-align: center; border-radius: 9px; font-weight: 600; font-size: 14px; color: #94a3b8; cursor: pointer; border: none; background: transparent; }
    .tab.active { background: #9945ff; color: #fff; }
    .filters { display: flex; gap: 8px; margin-bottom: 14px; }
    .f-btn { flex: 1; padding: 7px 10px; border-radius: 9px; font-size: 12px; font-weight: 600; border: 1px solid #222938; background: #151a24; color: #94a3b8; cursor: pointer; }
    .f-btn.active { border-color: #14f195; color: #14f195; background: rgba(20, 241, 149, 0.1); }
    .f-btn.unver.active { border-color: #fbbf24; color: #fbbf24; background: rgba(251, 191, 36, 0.12); }
    .stats-bar { font-size: 13px; color: #94a3b8; margin-bottom: 12px; display: flex; justify-content: space-between; }
    .card { background: #151a24; border: 1px solid #222938; border-radius: 14px; padding: 12px; margin-bottom: 10px; display: flex; justify-content: space-between; align-items: center; text-decoration: none; color: inherit; }
    .left { display: flex; align-items: center; gap: 12px; min-width: 0; }
    .thumb { width: 46px; height: 46px; border-radius: 10px; object-fit: cover; background: #1e2533; flex-shrink: 0; }
    .col-name-row { display: flex; align-items: center; gap: 6px; margin-bottom: 3px; }
    .col-name { font-size: 15px; font-weight: 600; color: #fff; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 145px; }
    .tag-unver { font-size: 10px; font-weight: 700; padding: 2px 6px; border-radius: 6px; background: rgba(251, 191, 36, 0.16); color: #fbbf24; flex-shrink: 0; }
    .tag-ver { font-size: 10px; font-weight: 700; padding: 2px 6px; border-radius: 6px; background: rgba(20, 241, 149, 0.14); color: #14f195; flex-shrink: 0; }
    .col-meta { font-size: 12px; color: #94a3b8; }
    .badge { background: rgba(153, 69, 255, 0.2); color: #c084fc; padding: 4px 10px; border-radius: 20px; font-size: 13px; font-weight: 700; display: inline-block; }
    .vol { font-size: 12px; color: #cbd5e1; text-align: right; margin-top: 4px; }
    .section-title { font-size: 13px; font-weight: 700; color: #94a3b8; margin: 20px 0 10px; text-transform: uppercase; letter-spacing: 0.5px; }
    .feed-item { background: #11151e; border-left: 3px solid #9945ff; padding: 10px 12px; border-radius: 8px; margin-bottom: 8px; font-size: 13px; display: flex; justify-content: space-between; align-items: center; text-decoration: none; color: inherit; }
    .empty { text-align: center; padding: 40px 20px; color: #64748b; font-size: 14px; line-height: 1.5; }
  </style>
</head>
<body>
  <div class="header">
    <div class="title"><span class="dot"></span> SOL NFT Live</div>
    <div id="clock" style="font-size:12px; color:#64748b;">Connecting...</div>
  </div>

  <div class="tabs">
    <button class="tab active" onclick="setTf(5, this)">5M</button>
    <button class="tab" onclick="setTf(15, this)">15M</button>
    <button class="tab" onclick="setTf(60, this)">1H</button>
  </div>

  <div class="filters">
    <button class="f-btn active" onclick="setFilter('all', this)">All Collections</button>
    <button class="f-btn unver" onclick="setFilter('unverified', this)">Unverified Only</button>
    <button class="f-btn" onclick="setFilter('verified', this)">Verified Only</button>
  </div>

  <div class="stats-bar">
    <span>Trending Collections</span>
    <span id="total-count">0 sales</span>
  </div>

  <div id="collections-list"></div>

  <div class="section-title">Live Sale Ticker (Tap for Solscan)</div>
  <div id="live-feed"></div>

  <script>
    let currentTf = 5;
    let currentFilter = 'all';
    const fallbackImg = 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="46" height="46"><rect width="46" height="46" fill="%231e2533"/></svg>';

    function setTf(tf, el) {
      currentTf = tf;
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      el.classList.add('active');
      fetchData();
    }

    function setFilter(filter, el) {
      currentFilter = filter;
      document.querySelectorAll('.f-btn').forEach(b => b.classList.remove('active'));
      el.classList.add('active');
      fetchData();
    }

    async function fetchData() {
      try {
        const res = await fetch('/api/trending?tf=' + currentTf + '&filter=' + currentFilter);
        const data = await res.json();

        document.getElementById('total-count').innerText = data.totalSalesInWindow + ' sales';
        document.getElementById('clock').innerText = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

        const listEl = document.getElementById('collections-list');
        if (data.collections.length === 0) {
          listEl.innerHTML = '<div class="empty">Is filter aur timeframe mein abhi koi sale nahi hui.<br/>Jaise hi sale hogi yahan live show hogi.</div>';
        } else {
          listEl.innerHTML = data.collections.map((c, i) => \`
            <a class="card" href="https://solscan.io/token/\${c.lastMint}" target="_blank">
              <div class="left">
                <img class="thumb" src="\${c.image || fallbackImg}" onerror="this.src='\${fallbackImg}'" />
                <div>
                  <div class="col-name-row">
                    <span class="col-name">#\${i + 1} \${c.name}</span>
                    <span class="\${c.isVerified ? 'tag-ver' : 'tag-unver'}">\${c.isVerified ? 'VERIFIED' : 'UNVERIFIED'}</span>
                  </div>
                  <div class="col-meta">Last: \${c.lastPrice} SOL • \${c.lastMarketplace}</div>
                </div>
              </div>
              <div style="text-align:right; flex-shrink:0;">
                <span class="badge">\${c.salesCount} Sales</span>
                <div class="vol">Vol: \${c.totalVolume} SOL</div>
              </div>
            </a>
          \`).join('');
        }

        const feedEl = document.getElementById('live-feed');
        feedEl.innerHTML = data.liveFeed.map(f => \`
          <a class="feed-item" href="https://solscan.io/tx/\${f.id}" target="_blank">
            <span><strong>\${f.nftName}</strong> <span style="color:#64748b;">(\${f.marketplace})</span></span>
            <span style="color:#14f195; font-weight:600;">\${f.price} SOL ↗</span>
          </a>
        \`).join('');
      } catch (e) {
        console.error(e);
      }
    }

    fetchData();
    setInterval(fetchData, 3000);
  </script>
</body>
</html>
  `);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(\`Server running on port \${PORT}\`));
