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
        marketplace: 'Solana',
        timestamp
      });
    }
  }

  const cutoff = now - 60 * 60 * 1000;
  recentSales = recentSales
    .filter((s) => s.timestamp >= cutoff)
    .slice(0, 500);

  res.status(200).json({ ok: true });
});

app.get('/api/sales', (req, res) => {
  const tf = req.query.tf || '15m';
  const filter = req.query.filter || 'all';
  const mins = getTimeframeMinutes(tf);
  const cutoff = Date.now() - mins * 60 * 1000;

  let filtered = recentSales.filter((s) => s.timestamp >= cutoff);

  if (filter === 'verified') {
    filtered = filtered.filter((s) => s.verified === true);
  } else if (filter === 'unverified') {
    filtered = filtered.filter((s) => s.verified === false);
  }

  const totalVolumeSol = filtered.reduce((sum, s) => sum + (Number(s.priceSol) || 0), 0);

  res.json({
    timeframe: tf,
    filter,
    salesCount: filtered.length,
    totalVolumeSol: Number(totalVolumeSol.toFixed(4)),
    sales: filtered.slice(0, 100)
  });
});

app.get('/', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Solana Live NFT Sales Portal</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, sans-serif; }
    body { background: #0b0e14; color: #f3f4f6; padding: 14px; }
    .container { max-width: 680px; margin: 0 auto; }
    h1 { font-size: 1.25rem; margin-bottom: 10px; }
    .controls { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 12px; }
    button {
      background: #1a202c; color: #e5e7eb; border: 1px solid #2d3748;
      padding: 8px 12px; border-radius: 10px; font-size: 0.85rem; cursor: pointer;
    }
    button.active { background: #6d28d9; border-color: #8b5cf6; color: #fff; font-weight: 600; }
    .stats {
      display: grid; grid-template-columns: repeat(2, 1fr); gap: 10px; margin-bottom: 14px;
    }
    .card {
      background: #131822; border: 1px solid #232b3b; border-radius: 14px; padding: 12px;
    }
    .stat-label { font-size: 0.78rem; color: #9ca3af; }
    .stat-val { font-size: 1.15rem; font-weight: 700; margin-top: 4px; }
    .list { display: flex; flex-direction: column; gap: 10px; }
    .sale-item {
      display: flex; align-items: center; gap: 12px;
      background: #131822; border: 1px solid #232b3b; border-radius: 14px; padding: 10px;
    }
    .thumb {
      width: 54px; height: 54px; border-radius: 10px; object-fit: cover;
      background: #1f2937; flex-shrink: 0;
    }
    .meta { flex: 1; min-width: 0; }
    .nft-name { font-weight: 600; font-size: 0.92rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .col-row { display: flex; align-items: center; gap: 6px; margin-top: 3px; flex-wrap: wrap; }
    .col-name { font-size: 0.78rem; color: #cbd5e1; }
    .badge {
      font-size: 0.7rem; padding: 2px 7px; border-radius: 999px; font-weight: 600;
    }
    .badge.ver { background: rgba(16, 185, 129, 0.18); color: #34d399; }
    .badge.unver { background: rgba(245, 158, 11, 0.18); color: #fbbf24; }
    .price-box { text-align: right; flex-shrink: 0; }
    .sol { font-weight: 700; color: #a78bfa; font-size: 0.95rem; }
    .mkt { font-size: 0.72rem; color: #9ca3af; margin-top: 2px; }
    .empty { text-align: center; color: #9ca3af; padding: 28px 12px; font-size: 0.9rem; }
  </style>
</head>
<body>
  <div class="container">
    <h1>Solana Live NFT Sales</h1>

    <div class="controls" id="tf-group">
      <button data-tf="5m">5m</button>
      <button data-tf="15m" class="active">15m</button>
      <button data-tf="1h">1h</button>
    </div>

    <div class="controls" id="filter-group">
      <button data-filter="all" class="active">All</button>
      <button data-filter="verified">Verified</button>
      <button data-filter="unverified">Unverified / New</button>
    </div>

    <div class="stats">
      <div class="card">
        <div class="stat-label">Sales Count</div>
        <div class="stat-val" id="sales-count">0</div>
      </div>
      <div class="card">
        <div class="stat-label">Volume (SOL)</div>
        <div class="stat-val" id="sales-vol">0 SOL</div>
      </div>
    </div>

    <div class="list" id="sales-list">
      <div class="empty">Waiting for live Solana NFT sales...</div>
    </div>
  </div>

  <script>
    let currentTf = '15m';
    let currentFilter = 'all';

    document.querySelectorAll('#tf-group button').forEach((btn) => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('#tf-group button').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        currentTf = btn.dataset.tf;
        fetchData();
      });
    });

    document.querySelectorAll('#filter-group button').forEach((btn) => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('#filter-group button').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        currentFilter = btn.dataset.filter;
        fetchData();
      });
    });

    async function fetchData() {
      try {
        const res = await fetch(\`/api/sales?tf=\${encodeURIComponent(currentTf)}&filter=\${encodeURIComponent(currentFilter)}\`);
        const data = await res.json();

        document.getElementById('sales-count').textContent = data.salesCount ?? 0;
        document.getElementById('sales-vol').textContent = \`\${data.totalVolumeSol ?? 0} SOL\`;

        const listEl = document.getElementById('sales-list');
        if (!data.sales || data.sales.length === 0) {
          listEl.innerHTML = '<div class="empty">No sales in this timeframe/filter yet.</div>';
          return;
        }

        listEl.innerHTML = data.sales.map((item) => \`
          <div class="sale-item">
            <img class="thumb" src="\${item.image || ''}" alt="" onerror="this.style.display='none'" />
            <div class="meta">
              <div class="nft-name">\${item.name}</div>
              <div class="col-row">
                <span class="col-name">\${item.collectionName}</span>
                <span class="badge \${item.verified ? 'ver' : 'unver'}">\${item.verified ? 'Verified' : 'Unverified'}</span>
              </div>
            </div>
            <div class="price-box">
              <div class="sol">\${item.priceSol} SOL</div>
              <div class="mkt">\${item.marketplace}</div>
            </div>
          </div>
        \`).join('');
      } catch (e) {
        console.error(e);
      }
    }

    fetchData();
    setInterval(fetchData, 3000);
  </script>
</body>
</html>`);
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => console.log(`Server running on port ${PORT}`));
