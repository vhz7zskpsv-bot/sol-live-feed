const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const WebSocket = require('ws');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const PORT = process.env.PORT || 8080;
const HELIUS_API_KEY = process.env.HELIUS_API_KEY;

// Simple in-memory storage
let sales = [];
let totalVolume = 0;
let salesCount = 0;

// Frontend ko static files serve karne ke liye (agar public folder hai)
app.use(express.static('public'));

// API endpoint
app.get('/api/sales', (req, res) => {
  res.json({
    sales: sales.slice(0, 50),
    salesCount,
    totalVolume: totalVolume.toFixed(2)
  });
});

// Health check (Fly ke liye zaroori)
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

// Helius WebSocket connection
function connectHelius() {
  if (!HELIUS_API_KEY) {
    console.error('❌ HELIUS_API_KEY missing!');
    return;
  }

  const wsUrl = `wss://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;
  const heliusWs = new WebSocket(wsUrl);

  heliusWs.on('open', () => {
    console.log('✅ Connected to Helius WebSocket');

    // NFT sales ke liye subscribe
    const subscribeMsg = {
      jsonrpc: '2.0',
      id: 1,
      method: 'transactionSubscribe',
      params: [
        {
          accountInclude: [], // empty = all
          failed: false
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
      const message = JSON.parse(data.toString());
      
      // Yahan aap NFT sale detect kar sakte ho
      // Filhaal simple logging
      if (message.method === 'transactionNotification') {
        console.log('New transaction received');
        // Sale parse karke sales array mein add karo
      }
    } catch (err) {
      console.error('Error parsing message:', err);
    }
  });

  heliusWs.on('close', () => {
    console.log('Helius WebSocket closed. Reconnecting in 5s...');
    setTimeout(connectHelius, 5000);
  });

  heliusWs.on('error', (err) => {
    console.error('Helius WebSocket error:', err.message);
  });
}

// Server start - IMPORTANT: 0.0.0.0 pe listen karo
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server running on port ${PORT}`);
  connectHelius();
});
