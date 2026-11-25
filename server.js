const express = require('express');
const http = require('http');

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 8080;
const API_SH_KEY = process.env.API_SH_KEY;
const API_SH_BASE = 'https://api.api.sh';

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
