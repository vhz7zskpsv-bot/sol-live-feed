'use strict';

const crypto = require('crypto');
const WebSocket = require('ws');

const TENSOR_MARKETPLACE_PROGRAM = 'TCMPhJdwDryooaGtiocG1u3xcYbRpiJzb283XfCZsDp';
const DEFAULT_RPC_HTTP = 'https://api.mainnet-beta.solana.com';
const DEFAULT_RPC_WS = 'wss://api.mainnet-beta.solana.com';
const LAMPORTS_PER_SOL = 1_000_000_000;
const EVENT_DISCRIMINATOR = crypto.createHash('sha256')
  .update('global:tcomp_noop')
  .digest()
  .subarray(0, 8);

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const BASE58_MAP = new Map([...BASE58].map((char, index) => [char, index]));

function decodeBase58(value) {
  if (typeof value !== 'string' || !value.length) return Buffer.alloc(0);
  let number = 0n;
  for (const char of value) {
    const digit = BASE58_MAP.get(char);
    if (digit === undefined) throw new Error('Invalid base58 instruction data');
    number = number * 58n + BigInt(digit);
  }
  let hex = number.toString(16);
  if (hex.length % 2) hex = '0' + hex;
  const body = number === 0n ? Buffer.alloc(0) : Buffer.from(hex, 'hex');
  let zeroes = 0;
  while (zeroes < value.length && value[zeroes] === '1') zeroes++;
  return Buffer.concat([Buffer.alloc(zeroes), body]);
}

function encodeBase58(buffer) {
  if (!buffer || !buffer.length) return '';
  let number = BigInt('0x' + buffer.toString('hex'));
  let encoded = '';
  while (number > 0n) {
    const remainder = Number(number % 58n);
    number /= 58n;
    encoded = BASE58[remainder] + encoded;
  }
  let zeroes = 0;
  while (zeroes < buffer.length && buffer[zeroes] === 0) zeroes++;
  return '1'.repeat(zeroes) + encoded;
}

function readPubkey(buffer, state) {
  if (state.offset + 32 > buffer.length) throw new Error('Truncated Tensor event public key');
  const value = encodeBase58(buffer.subarray(state.offset, state.offset + 32));
  state.offset += 32;
  return value;
}

function readOptionPubkey(buffer, state) {
  if (state.offset >= buffer.length) throw new Error('Truncated Tensor event option');
  const present = buffer[state.offset++];
  if (present === 0) return null;
  if (present !== 1) throw new Error('Invalid Tensor event option tag');
  return readPubkey(buffer, state);
}

// Decodes the public TcompEvent::Taker payload emitted by Tensor's
// Marketplace program through its tcomp_noop CPI wrapper.
function decodeTakerEvent(instructionData) {
  const data = decodeBase58(instructionData);
  if (data.length < 10 || !data.subarray(0, 8).equals(EVENT_DISCRIMINATOR)) return null;
  const state = { offset: 8 };
  const variant = data[state.offset++];
  if (variant !== 1) return null; // 0 = Maker, 1 = Taker

  const taker = readPubkey(data, state);
  const bidId = readOptionPubkey(data, state);
  const target = data[state.offset++];
  const targetId = readPubkey(data, state);

  if (state.offset >= data.length) throw new Error('Truncated Tensor event field');
  const hasField = data[state.offset++];
  if (hasField === 1) state.offset += 1; // Borsh enum Field
  else if (hasField !== 0) throw new Error('Invalid Tensor event field option');

  const fieldId = readOptionPubkey(data, state);
  if (state.offset + 8 + 4 + 8 * 4 > data.length) throw new Error('Truncated Tensor event amounts');

  const amount = data.readBigUInt64LE(state.offset); state.offset += 8;
  const quantity = data.readUInt32LE(state.offset); state.offset += 4;
  const tensorFee = data.readBigUInt64LE(state.offset); state.offset += 8;
  const takerBrokerFee = data.readBigUInt64LE(state.offset); state.offset += 8;
  const makerBrokerFee = data.readBigUInt64LE(state.offset); state.offset += 8;
  const creatorFee = data.readBigUInt64LE(state.offset); state.offset += 8;
  const currency = readOptionPubkey(data, state);
  const assetId = readOptionPubkey(data, state);

  return {
    taker, bidId, target, targetId, fieldId,
    amountLamports: amount.toString(),
    quantity,
    tensorFeeLamports: tensorFee.toString(),
    takerBrokerFeeLamports: takerBrokerFee.toString(),
    makerBrokerFeeLamports: makerBrokerFee.toString(),
    creatorFeeLamports: creatorFee.toString(),
    currency,
    assetId: assetId || null
  };
}

function isTensorSaleInstruction(logs) {
  const saleInstruction = /Program log: Instruction: (buy|buySpl|buyLegacy|buyLegacySpl|buyT22|buyT22Spl|buyWns|buyWnsSpl|buyCore|buyCoreSpl|takeBidMetaHash|takeBidFullMeta|takeBidLegacy|takeBidT22|takeBidWns|takeBidCore)\b/i;
  return (logs || []).some(line => saleInstruction.test(String(line)));
}

function findTakerEvents(transaction) {
  const groups = transaction?.meta?.innerInstructions || [];
  const topLevel = transaction?.transaction?.message?.instructions || [];
  const instructions = [
    ...groups.flatMap(group => group.instructions || []),
    ...topLevel
  ];
  const found = [];
  for (const instruction of instructions) {
    if (instruction?.programId !== TENSOR_MARKETPLACE_PROGRAM || typeof instruction.data !== 'string') continue;
    try {
      const event = decodeTakerEvent(instruction.data);
      if (event) found.push(event);
    } catch (_) {
      // Ignore malformed or unrelated wrapper payloads; keep the listener alive.
    }
  }
  return found;
}

function createTensorScanner(options = {}) {
  const rpcHttp = options.rpcHttp || process.env.SOLANA_RPC_HTTP_URL || DEFAULT_RPC_HTTP;
  const rpcWs = options.rpcWs || process.env.SOLANA_RPC_WS_URL || DEFAULT_RPC_WS;
  const state = {
    enabled: true,
    connection: 'disconnected',
    subscriptionId: null,
    startedAt: null,
    lastMessageAt: null,
    lastSaleAt: null,
    transactionsObserved: 0,
    saleInstructionsObserved: 0,
    decodedSales: 0,
    saleInstructionsWithoutEvent: 0,
    rpcErrors: 0,
    websocketErrors: 0,
    queueDropped: 0,
    lastError: null,
    queue: [],
    pending: new Set(),
    sales: new Map(),
    socket: null,
    reconnectTimer: null,
    processing: false,
    stopping: false,
    lastRpcStartedAt: 0
  };

  function recordSale(signature, blockTime, instructionName, event) {
    const mint = event.assetId || null;
    if (!mint) return;
    const time = blockTime ? new Date(blockTime * 1000).toISOString() : null;
    if (!time || !Number.isFinite(Date.parse(time))) return;
    const amountLamports = BigInt(event.amountLamports || '0');
    const creatorFeeLamports = BigInt(event.creatorFeeLamports || '0');
    const priceLamports = amountLamports + creatorFeeLamports;
    const sale = {
      time,
      signature,
      marketplace: 'Tensor',
      instruction: instructionName,
      mint,
      collectionAddress: null,
      collectionSymbol: null,
      symbol: 'TENSOR',
      name: 'Tensor NFT · ' + mint.slice(0, 5) + '…' + mint.slice(-5),
      price: event.currency ? null : Number(priceLamports) / LAMPORTS_PER_SOL,
      priceCurrency: event.currency ? 'SPL' : 'SOL',
      priceCurrencyMint: event.currency || 'So11111111111111111111111111111111111111112',
      amountLamports: event.amountLamports,
      creatorFeeLamports: event.creatorFeeLamports,
      tensorFeeLamports: event.tensorFeeLamports,
      taker: event.taker,
      quantity: event.quantity,
      collectionMeta: null,
      transactionUrl: 'https://solscan.io/tx/' + signature
    };
    const key = signature + '|' + mint;
    if (state.sales.has(key)) return;
    state.sales.set(key, sale);
    state.decodedSales++;
    state.lastSaleAt = time;
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    for (const [id, row] of state.sales) {
      if (Date.parse(row.time) < cutoff) state.sales.delete(id);
    }
  }

  async function getTransaction(signature) {
    const wait = Math.max(0, 1100 - (Date.now() - state.lastRpcStartedAt));
    if (wait) await sleep(wait);
    state.lastRpcStartedAt = Date.now();
    for (let attempt = 0; attempt < 4; attempt++) {
      const response = await fetch(rpcHttp, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 'tensor-onchain-sales',
          method: 'getTransaction',
          params: [signature, {
            encoding: 'jsonParsed',
            commitment: 'confirmed',
            maxSupportedTransactionVersion: 1
          }]
        }),
        signal: AbortSignal.timeout(18000)
      });
      const payload = await response.json().catch(() => ({}));
      const message = payload.error?.message || '';
      const limited = response.status === 429 || /too many requests|rate.?limit/i.test(message);
      if (limited && attempt < 3) {
        await sleep(1500 * (2 ** attempt));
        state.lastRpcStartedAt = Date.now();
        continue;
      }
      if (!response.ok || payload.error) throw new Error(message || 'Solana RPC HTTP ' + response.status);
      return payload.result;
    }
    return null;
  }

  async function processQueue() {
    if (state.processing) return;
    state.processing = true;
    try {
      while (!state.stopping) {
        const item = state.queue.shift();
        if (!item) break;
        try {
          const transaction = await getTransaction(item.signature);
          if (!transaction || transaction.meta?.err) continue;
          const events = findTakerEvents(transaction);
          if (!events.length) {
            state.saleInstructionsWithoutEvent++;
            continue;
          }
          const blockTime = transaction.blockTime || null;
          for (const event of events) recordSale(item.signature, blockTime, item.instructionName, event);
        } catch (error) {
          state.rpcErrors++;
          state.lastError = error.message;
        } finally {
          state.pending.delete(item.signature);
        }
      }
    } finally {
      state.processing = false;
    }
  }

  function enqueue(signature, logs) {
    if (!signature || state.pending.has(signature)) return;
    state.transactionsObserved++;
    if (!isTensorSaleInstruction(logs)) return;
    state.saleInstructionsObserved++;
    const match = (logs || []).map(line => String(line).match(/Program log: Instruction: ([A-Za-z0-9_]+)/i)).find(Boolean);
    const instructionName = match?.[1] || 'Tensor sale';
    if (state.queue.length >= 200) {
      const dropped = state.queue.shift();
      if (dropped) state.pending.delete(dropped.signature);
      state.queueDropped++;
    }
    state.pending.add(signature);
    state.queue.push({ signature, instructionName });
    processQueue().catch(error => {
      state.lastError = error.message;
      state.rpcErrors++;
    });
  }

  function connect() {
    if (state.stopping) return;
    state.connection = 'connecting';
    const socket = new WebSocket(rpcWs);
    state.socket = socket;

    socket.on('open', () => {
      state.connection = 'connected';
      state.lastError = null;
      socket.send(JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'logsSubscribe',
        params: [
          { mentions: [TENSOR_MARKETPLACE_PROGRAM] },
          { commitment: 'confirmed' }
        ]
      }));
    });

    socket.on('message', raw => {
      let message;
      try { message = JSON.parse(raw.toString()); } catch (_) { return; }
      if (message.id === 1 && message.result) {
        state.subscriptionId = message.result;
        state.startedAt = state.startedAt || new Date().toISOString();
        return;
      }
      if (message.method !== 'logsNotification') return;
      const value = message.params?.result?.value;
      if (!value) return;
      state.lastMessageAt = new Date().toISOString();
      if (value.err) return;
      enqueue(value.signature, value.logs || []);
    });

    socket.on('error', error => {
      state.websocketErrors++;
      state.lastError = error.message;
    });

    socket.on('close', () => {
      state.connection = 'disconnected';
      state.subscriptionId = null;
      state.socket = null;
      if (!state.stopping && !state.reconnectTimer) {
        state.reconnectTimer = setTimeout(() => {
          state.reconnectTimer = null;
          connect();
        }, 10000);
      }
    });
  }

  function start() {
    if (state.socket || state.stopping) return;
    state.stopping = false;
    connect();
    console.log('Tensor on-chain scanner starting: Marketplace program via free Solana RPC WebSocket.');
  }

  function stop() {
    state.stopping = true;
    if (state.reconnectTimer) clearTimeout(state.reconnectTimer);
    state.reconnectTimer = null;
    if (state.socket) state.socket.close();
    state.socket = null;
    state.connection = 'stopped';
  }

  function getStatus() {
    const sales = [...state.sales.values()].sort((a, b) => Date.parse(b.time) - Date.parse(a.time));
    return {
      enabled: state.enabled,
      connection: state.connection,
      programId: TENSOR_MARKETPLACE_PROGRAM,
      source: 'Solana public RPC logsSubscribe + getTransaction',
      scope: 'Tensor Marketplace program; Tensor AMM pool swaps are not included in this first pass.',
      startedAt: state.startedAt,
      lastMessageAt: state.lastMessageAt,
      lastSaleAt: state.lastSaleAt,
      transactionsObserved: state.transactionsObserved,
      saleInstructionsObserved: state.saleInstructionsObserved,
      decodedSales: state.decodedSales,
      saleInstructionsWithoutEvent: state.saleInstructionsWithoutEvent,
      rpcErrors: state.rpcErrors,
      websocketErrors: state.websocketErrors,
      queueDepth: state.queue.length,
      queueDropped: state.queueDropped,
      lastError: state.lastError,
      sales: sales.slice(0, 25)
    };
  }

  return { start, stop, getStatus };
}

module.exports = { createTensorScanner, decodeTakerEvent, TENSOR_MARKETPLACE_PROGRAM };
