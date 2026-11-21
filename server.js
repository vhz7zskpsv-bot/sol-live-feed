const express = require('express');
const http = require('http');
const WebSocket = require('ws');

const app = express();
const server = http.createServer(app);

const PORT = process.env.PORT || 8080;
const HELIUS_API_KEY = process.env.HELIUS_API_KEY;

let sales = [];
let totalVolume = 0;
let salesCount = 0;

app.use(express.static('public'));

app.get('/api/sales', (req, res) => {
  res.json({
    sales: sales.slice(0, 50),
    salesCount,
    totalVolume: Number(totalVolume.toFixed(2))
  });
});

app.get('/health', (req, res) => {
  res.status(200).send('OK');
});

app.get('/', (req, res) => {
  res.send(`
    <h1>Solana Live NFT Sales</h1>
    <p>Sales Count: ${salesCount}</p>
    <p>Volume: ${totalVolume.toFixed(2)} SOL</p>
    <p>Waiting for live sales...</p>
  `);
});

function connectHelius() {
  if (!HELIUS_API_KEY) {
    console.error('❌ HELIUS_API_KEY is missing!');
    return;
  }

  const wsUrl = `wss://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;
  const heliusWs = new WebSocket(wsUrl);

  heliusWs.on('open', () => {
    console.log('✅ Connected to Helius WebSocket');

    // Free tier ke liye better filter (Magic Eden + Tensor example)
    const subscribeMsg = {
      jsonrpc: '2.0',
      id: 1,
      method: 'transactionSubscribe',
      params: [
        {
          failed: false,
          accountInclude: [
            "M2mx93ekt1fmXSVkTrUL9xVFHkmME8HTUi5Cyc5aF7K", // Magic Eden v2
            "TSWAPaqyCSx2KABk68Shruf4rp7CxcNi8hAsbdwmHbN"  // Tensor
          ]
        },
        {
          commitment: 'confirmed',
          encoding: 'jsonParsed',
          transactionDetails: 'full',
          maxSupportedTransactionVersion: 0
        }
      ]
    };

    heliusWs.send(JSON.stringify(subscribeMsg));
  });

  heliusWs.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.method === 'transactionNotification') {
        console.log('New transaction received');
        // Yahan baad mein sale parse karenge
      }
    } catch (err) {
      console.error('Parse error:', err.message);
    }
  });

  heliusWs.on('close', () => {
    console.log('WebSocket closed. Reconnecting...');
    setTimeout(connectHelius, 5000);
  });

  heliusWs.on('error', (err) => {
    console.error('WebSocket Error:', err.message);
  });
}

// Yeh line sabse important hai
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server running on 0.0.0.0:${PORT}`);
  connectHelius();
});
