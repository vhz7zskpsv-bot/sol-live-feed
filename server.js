const express = require('express');
const http = require('http');
const fs = require('fs');
const path = require('path');

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
const MAGIC_EDEN_API_BASE = 'https://api-mainnet.magiceden.dev/v2';
let magicEdenQueue = Promise.resolve();
let magicEdenLastRequestAt = 0;
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
const salesPending = new Map();
let bitquerySalesSnapshot = { at: 0, data: null, pending: null };
const collectionLookupCache = new Map();
const collectionLookupPending = new Map();
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
  if (!BITQUERY_CLIENT_ID || !BITQUERY_CLIENT_SECRET) {
    return { configured: false, scannedAt: null, assets: [], collections: [], note: 'Bitquery credentials are required for recent mint discovery.' };
  }

  // Discover creation instructions across Token Metadata (standard NFTs),
  // Bubblegum (compressed NFTs), and MPL Core. This is deliberately separate
  // from the marketplace sales/collection pipeline.
  const tokenMetadataProgram = 'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s';
  const bubblegumProgram = 'BGUMAp9Gq7iTEuizy4pqaxsTyUCBK68MDfK752saRPUY';
  const coreProgram = 'CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d';
  const launchMyNftProgram = 'ArAA6CZC123yMJLUe4uisBEgvfuw2WEvex9iFmFCYiXv';
  const query = 'query { Solana { Instructions(limit: {count: 100}, orderBy: {descending: Block_Time}, where: {Transaction: {Result: {Success: true}}, any: [' +
    '{Instruction: {Program: {Address: {is: "' + tokenMetadataProgram + '"}, Method: {in: ["CreateMetadataAccount", "CreateMetadataAccountV2", "CreateMetadataAccountV3", "CreateV1"]}}}} ' +
    '{Instruction: {Program: {Address: {is: "' + bubblegumProgram + '"}, Method: {in: ["MintV1", "MintToCollectionV1", "MintV2"]}}}} ' +
    '{Instruction: {Program: {Address: {is: "' + coreProgram + '"}, Method: {in: ["create", "createV1"]}}}} ' +
    '{Instruction: {Program: {Address: {is: "' + launchMyNftProgram + '"}, Method: {in: ["MintV6"]}}}}' +
    ']}) { Block { Time } Transaction { Signature Signer } Instruction { Accounts { Address } Logs Program { Address Method AccountNames } } } } }';
  const payload = await bitqueryGraphql(query);
  if (payload.errors?.length) {
    const error = new Error(payload.errors[0].message || 'Bitquery mint discovery query failed');
    error.details = payload.errors;
    throw error;
  }
  const rows = payload.data?.Solana?.Instructions || [];
  const candidates = new Map();
  for (const row of rows) {
    const instruction = row.Instruction || {};
    const program = instruction.Program || {};
    const programAddress = program.Address || '';
    const method = program.Method || '';
    const accounts = (instruction.Accounts || []).map(x => x?.Address).filter(Boolean);
    const names = (program.AccountNames || []).map(x => String(x || '').toLowerCase());
    let assetId = null;
    let standard = 'NFT';

    if (programAddress === bubblegumProgram) {
      standard = 'cNFT';
      const logs = Array.isArray(instruction.Logs) ? instruction.Logs.join('\n') : String(instruction.Logs || '');
      const match = logs.match(/Leaf asset ID:\s*([1-9A-HJ-NP-Za-km-z]{32,44})/i);
      if (match) assetId = match[1];
    } else if (programAddress === coreProgram) {
      standard = 'MPL Core';
      const namedIndex = names.findIndex(x => x === 'asset' || x === 'asset_account');
      assetId = namedIndex >= 0 ? accounts[namedIndex] : accounts[0] || null;
    } else if (programAddress === tokenMetadataProgram) {
      const namedIndex = names.findIndex(x => x === 'mint');
      assetId = namedIndex >= 0 ? accounts[namedIndex] : accounts[1] || null;
    } else if (programAddress === launchMyNftProgram) {
      const namedIndex = names.findIndex(x => x === 'mint' || x === 'nft_mint');
      assetId = namedIndex >= 0 ? accounts[namedIndex] : null;
      standard = 'LaunchMyNFT';
    }
    if (!assetId || candidates.has(assetId)) continue;
    candidates.set(assetId, {
      id: assetId, standard, method, signature: row.Transaction?.Signature || null,
      creator: row.Transaction?.Signer || null, createdAt: row.Block?.Time || null
    });
  }

  // QuickNode's DAS searchAssets is a filtered search, not a global mint feed.
  // Hydrate IDs discovered from Bitquery one-by-one to respect the endpoint's
  // 2 requests/second limit and avoid the previous parallel 429 failures.
  const assets = [];
  const discovered = [...candidates.values()].slice(0, 30);
  for (const candidate of discovered) {
    try {
      const asset = await quicknodeRpc('getAsset', { id: candidate.id, options: { showCollectionMetadata: true } });
      if (!asset?.id) continue;
      const metadata = asset.content?.metadata || {};
      const file = (asset.content?.files || []).find(x => x.mime?.startsWith('image/')) || (asset.content?.files || [])[0];
      const collection = (asset.grouping || []).find(x => x.group_key === 'collection');
      const creators = (asset.creators || []).map(x => x.address).filter(Boolean);
      assets.push({
        id: asset.id, name: metadata.name || 'Unnamed NFT', symbol: metadata.symbol || '',
        image: file?.uri || null, interface: asset.interface || candidate.standard,
        collectionAddress: collection?.group_value || null,
        collectionName: collection?.collection_metadata?.name || collection?.name || null,
        collectionImage: collection?.collection_metadata?.image || null,
        verified: Boolean(collection?.verified), creators,
        createdAt: candidate.createdAt || asset.created_at || asset.createdAt || null,
        printCurrentSupply: asset.supply?.print_current_supply ?? null,
        printMaxSupply: asset.supply?.print_max_supply ?? null,
        mint: asset.id, standard: candidate.standard, mintMethod: candidate.method,
        transaction: candidate.signature, creator: candidate.creator
      });
    } catch (error) {
      console.error('QuickNode getAsset hydration failed for', candidate.standard, error.status || 'network', error.message);
    }
    await new Promise(resolve => setTimeout(resolve, 550));
  }

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
    group.mintedCount = group.observedMints;
    if (asset.createdAt && (!group.latestMintAt || new Date(asset.createdAt) > new Date(group.latestMintAt))) group.latestMintAt = asset.createdAt;
    if (group.sampleAssets.length < 6) group.sampleAssets.push(asset);
    grouped.set(key, group);
  }
  const collections = [...grouped.values()].filter(group => group.observedMints >= 15).sort((a,b) => new Date(b.latestMintAt || 0).getTime() - new Date(a.latestMintAt || 0).getTime());
  const data = {
    configured: true, scannedAt: new Date().toISOString(), assets: assets.slice(0, 80), collections,
    diagnostics: {
      source: 'Bitquery Solana Instructions + QuickNode Metaplex DAS',
      instructionsFound: rows.length, uniqueAssetCandidates: candidates.size,
      hydratedAssets: assets.length, candidatesHydrated: discovered.length,
      standards: ['standard Token Metadata NFTs', 'compressed NFTs (Bubblegum, when the transaction log exposes Leaf asset ID)', 'MPL Core', 'LaunchMyNFT'],
      note: 'Only successfully hydrated assets are shown. Bubblegum mints without a decoded Leaf asset ID are not yet resolvable by this feed.'
    },
    note: 'Recent creations are discovered from on-chain program instructions and hydrated through DAS. Collection counts are observed mints in this scan, not total collection supply.'
  };
  launchCache.at = Date.now();
  launchCache.data = data;
  return data;
}

const SOLANA_PUBLIC_RPC_URL = 'https://api.mainnet-beta.solana.com';
async function solanaPublicRpc(method, params) {
  const response = await fetch(SOLANA_PUBLIC_RPC_URL, {
    method: 'POST', headers: { 'content-type': 'application/json', 'accept': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'free-nft-mint-scan', method, params }),
    signal: AbortSignal.timeout(20000)
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.error) {
    const error = new Error(payload.error?.message || 'Solana public RPC returned HTTP ' + response.status);
    error.status = response.status || 502;
    throw error;
  }
  return payload.result;
}
async function getRecentSolanaMintsFree() {
  if (launchCache.data && Date.now() - launchCache.at < 45000) return launchCache.data;
  if (!QUICKNODE_RPC_URL) return { configured:false, scannedAt:null, assets:[], collections:[], note:'QuickNode DAS is required to hydrate detected NFT mint IDs. No paid indexer is used for discovery.' };
  const programs = [
    { id:'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s', standard:'NFT', kind:'metadata' },
    { id:'CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d', standard:'MPL Core', kind:'core' },
    { id:'BGUMAp9Gq7iTEuizy4pqaxsTyUCBK68MDfK752saRPUY', standard:'cNFT', kind:'bubblegum' },
    { id:'ArAA6CZC123yMJLUe4uisBEgvfuw2WEvex9iFmFCYiXv', standard:'LaunchMyNFT', kind:'launchmynft' }
  ];
  const candidates = new Map();
  let signaturesScanned = 0, transactionsRead = 0;
  for (const program of programs) {
    try {
      const signatures = await solanaPublicRpc('getSignaturesForAddress', [program.id, { limit:5, commitment:'finalized' }]);
      signaturesScanned += Array.isArray(signatures) ? signatures.length : 0;
      for (const sig of (signatures || [])) {
        if (sig.err) continue;
        try {
          const tx = await solanaPublicRpc('getTransaction', [sig.signature, { encoding:'jsonParsed', commitment:'finalized', maxSupportedTransactionVersion:0 }]);
          transactionsRead++;
          const message = tx?.transaction?.message || {};
          const keys = (message.accountKeys || []).map(k => typeof k === 'string' ? k : k.pubkey);
          const instructions = [...(message.instructions || []), ...((tx?.meta?.innerInstructions || []).flatMap(x => x.instructions || []))];
          const logs = (tx?.meta?.logMessages || []).join('\n');
            const targetInstructions = program.kind === 'launchmynft'
              ? instructions.filter(item => [
                  'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s',
                  'CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d',
                  'BGUMAp9Gq7iTEuizy4pqaxsTyUCBK68MDfK752saRPUY'
                ].includes(item.programId || keys[item.programIdIndex] || ''))
              : instructions.filter(item => (item.programId || keys[item.programIdIndex] || '') === program.id);
            for (const targetIx of targetInstructions) {
              const targetProgramId = targetIx.programId || keys[targetIx.programIdIndex] || '';
              const accounts = (targetIx.accounts || []).map(a => typeof a === 'number' ? keys[a] : (typeof a === 'string' ? a : a?.pubkey)).filter(Boolean);
              let id = null, detectedStandard = program.standard;
              if (targetProgramId === 'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s') { id = accounts[1] || null; detectedStandard = 'NFT'; }
              else if (targetProgramId === 'CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d') { id = accounts[0] || null; detectedStandard = 'MPL Core'; }
              else if (targetProgramId === 'BGUMAp9Gq7iTEuizy4pqaxsTyUCBK68MDfK752saRPUY') {
                const match = logs.match(/Leaf asset ID:\\s*([1-9A-HJ-NP-Za-km-z]{32,44})/i);
                id = match?.[1] || null; detectedStandard = 'cNFT';
              }
              if (!id || candidates.has(id)) continue;
              candidates.set(id, { id, standard:detectedStandard, method:targetIx.parsed?.type || targetIx.data || 'create', signature:sig.signature,
                creator:tx?.transaction?.message?.accountKeys?.find(k => typeof k === 'object' && k.signer)?.pubkey || null,
                createdAt:tx?.blockTime ? new Date(tx.blockTime * 1000).toISOString() : null });
            }
        } catch (error) {
          console.error('Solana public RPC transaction lookup failed:', error.status || 'network', error.message);
        }
        await new Promise(resolve => setTimeout(resolve, 350));
      }
    } catch (error) {
      console.error('Solana public RPC signature scan failed for', program.standard, error.status || 'network', error.message);
    }
  }
  const assets = [];
  const discovered = [...candidates.values()].slice(0, 40);
  for (const candidate of discovered) {
    try {
      const asset = await quicknodeRpc('getAsset', { id:candidate.id, options:{ showCollectionMetadata:true } });
      if (!asset?.id) continue;
      const metadata = asset.content?.metadata || {};
      const files = asset.content?.files || [];
      const file = files.find(x => x.mime?.startsWith('image/')) || files[0];
      const collection = (asset.grouping || []).find(x => x.group_key === 'collection');
      const creators = (asset.creators || []).map(x => x.address).filter(Boolean);
      assets.push({
        id:asset.id, name:metadata.name || 'Unnamed NFT', symbol:metadata.symbol || '', image:file?.uri || null,
        interface:asset.interface || candidate.standard, collectionAddress:collection?.group_value || null,
        collectionName:collection?.collection_metadata?.name || collection?.name || null,
        collectionImage:collection?.collection_metadata?.image || null, verified:Boolean(collection?.verified), creators,
        createdAt:candidate.createdAt || asset.created_at || asset.createdAt || null, mint:asset.id, standard:candidate.standard,
        mintMethod:candidate.method, transaction:candidate.signature, creator:candidate.creator
      });
    } catch (error) {
      console.error('QuickNode DAS hydration failed:', candidate.standard, error.status || 'network', error.message);
    }
    await new Promise(resolve => setTimeout(resolve, 550));
  }
  const grouped = new Map();
  for (const asset of assets) {
    const key = asset.collectionAddress || 'unverified:' + (asset.creators[0] || asset.id);
    const group = grouped.get(key) || { id:key, name:asset.collectionName || 'Unverified / ungrouped mints',
      image:asset.collectionImage || asset.image, collectionAddress:asset.collectionAddress, verified:asset.verified,
      observedMints:0, mintedCount:0, latestMintAt:asset.createdAt, sampleAssets:[], supply:null, supplySource:'Maximum collection supply is not published in DAS asset metadata' };
    group.observedMints++;
    group.mintedCount = group.observedMints;
    if (asset.createdAt && (!group.latestMintAt || new Date(asset.createdAt) > new Date(group.latestMintAt))) group.latestMintAt = asset.createdAt;
    if (group.sampleAssets.length < 6) group.sampleAssets.push(asset);
    grouped.set(key, group);
  }
  const data = { configured:true, scannedAt:new Date().toISOString(), assets, collections:[...grouped.values()].filter(group => group.observedMints >= 15).sort((a,b)=>new Date(b.latestMintAt||0)-new Date(a.latestMintAt||0)),
    diagnostics:{ source:'Solana public RPC + QuickNode DAS', signaturesScanned, transactionsRead, uniqueAssetCandidates:candidates.size,
      hydratedAssets:assets.length, standards:['standard Token Metadata NFTs','MPL Core','compressed NFTs only when the transaction log exposes Leaf asset ID'],
      note:'Free public RPC is rate-limited. Bubblegum cNFT asset IDs are not guaranteed to be present in logs, so cNFT coverage is incomplete.' },
    note:'Only collections with at least 15 successfully detected mints are displayed. Counts are observed in the current scan, not guaranteed total collection supply. Maximum supply is shown only when on-chain metadata publishes it; otherwise it is not disclosed.' };
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
  const collectionAddress = x.collectionAddress || x.collection_address ||
    x.collectionMintAddress || x.collection_mint_address ||
    x.collectionMint || x.collection_mint || x.mintAddress || x.mint_address || null;
  return { symbol: String(symbol), name: x.name || x.title || x.collectionName || String(symbol),
    image: x.image || x.imageUrl || x.imageURL || x.imageUri || x.imageURI || x.logo || x.logoUrl || null,
    floorPrice: x.floorPrice ?? x.floor_price ?? x.floor ?? null,
    listedCount: x.listedCount ?? x.listed_count ?? x.listed ?? null,
    verified: x.isVerified ?? x.verified ?? false, collectionAddress, raw: x };
}
async function magicEdenGet(path, query = {}) {
  const run = async () => {
    const wait = Math.max(0, 800 - (Date.now() - magicEdenLastRequestAt));
    if (wait) await new Promise(resolve => setTimeout(resolve, wait));
    magicEdenLastRequestAt = Date.now();
    const url = new URL(MAGIC_EDEN_API_BASE + path);
    for (const [key, value] of Object.entries(query)) if (value !== undefined && value !== null && String(value).length) url.searchParams.set(key, String(value));
    const response = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(12000) });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) { const error = new Error(body?.error || body?.message || 'Magic Eden returned HTTP ' + response.status); error.status = response.status; throw error; }
    return body;
  };
  const pending = magicEdenQueue.then(run, run);
  magicEdenQueue = pending.then(() => undefined, () => undefined);
  return pending;
}
function pickText(...values) { return values.find(value => typeof value === 'string' && value.trim())?.trim() || null; }
function readMagicEdenCollection(token) {
  const collection = token?.collection && typeof token.collection === 'object' ? token.collection : {};
  const onChain = token?.onChainCollection || token?.on_chain_collection || {};
  return {
    collectionSymbol: pickText(token?.collectionSymbol, token?.collection_symbol, token?.collectionSlug, token?.collection_slug, collection.symbol, collection.collectionSymbol, collection.collection_symbol, collection.slug, typeof token?.collection === 'string' ? token.collection : null),
    collectionAddress: pickText(token?.collectionAddress, token?.collection_address, collection.address, collection.key, onChain.address, onChain.key, onChain.collectionAddress),
    name: pickText(token?.collectionName, token?.collection_name, collection.name, collection.title, onChain.name),
    image: pickText(token?.collectionImage, token?.collection_image, collection.image, collection.imageUrl, collection.image_url, onChain.image),
    verified: Boolean(collection.verified || onChain.verified)
  };
}
const collectionDetailsCache = new Map();
let magicEdenCollectionsIndex = { at:0, map:null, pending:null };
async function getMagicEdenCollectionsIndex() {
  if (magicEdenCollectionsIndex.map && Date.now() - magicEdenCollectionsIndex.at < 6 * 60 * 60 * 1000) return magicEdenCollectionsIndex.map;
  if (magicEdenCollectionsIndex.pending) return magicEdenCollectionsIndex.pending;
  magicEdenCollectionsIndex.pending = (async () => {
    try {
      const raw = await magicEdenGet('/collections', { offset:0, limit:500 });
      const rows = Array.isArray(raw) ? raw : (raw?.collections || raw?.results || raw?.data || []);
      const map = new Map(rows.filter(x => x?.symbol).map(x => [String(x.symbol).toLowerCase(), x]));
      magicEdenCollectionsIndex = { at:Date.now(), map, pending:null };
      return map;
    } catch (error) {
      console.error('Magic Eden collection directory lookup failed:', error.status || 'network', error.message);
      magicEdenCollectionsIndex.pending = null;
      return new Map();
    }
  })();
  return magicEdenCollectionsIndex.pending;
}
async function getMagicEdenCollectionDetails(symbol) {
  if (!symbol) return null;
  const key = String(symbol).toLowerCase(), cached = collectionDetailsCache.get(key);
  if (cached && Date.now() - cached.at < 6 * 60 * 60 * 1000) return cached.data;
  try {
    // Use the single cached collection index. Do not fan out to one /collections/:symbol
    // request per NFT group; that was exhausting Magic Eden's public rate limit.
    const index = await getMagicEdenCollectionsIndex();
    const data = index.get(key);
    if (!data) {
      collectionDetailsCache.set(key, { at:Date.now(), data:null });
      return null;
    }
    const result = {
      collectionSymbol: pickText(data?.symbol, data?.collectionSymbol, symbol),
      name: pickText(data?.name, data?.title, data?.collectionName),
      image: pickText(data?.image, data?.imageUrl, data?.imageURL, data?.imageURI, data?.logo),
      collectionAddress: pickText(data?.collectionAddress, data?.collection_address, data?.mintAddress),
      floorPrice: data?.floorPrice ?? data?.floor_price ?? null,
      listedCount: data?.listedCount ?? data?.listed_count ?? null,
      verified: Boolean(data?.isVerified || data?.verified)
    };
    collectionDetailsCache.set(key, { at:Date.now(), data:result }); return result;
  } catch (error) {
    console.error('Magic Eden collection metadata failed:', symbol, error.status || 'network', error.message);
    collectionDetailsCache.set(key, { at:Date.now(), data:null }); return null;
  }
}
async function lookupCollectionFromMint(mint) {
  if (!mint) return null;
  const cached = collectionLookupCache.get(mint), cacheAge = cached?.data ? 6 * 60 * 60 * 1000 : 5 *  60 * 1000;
  if (cached && Date.now() - cached.at < cacheAge) return cached.data;
  if (collectionLookupPending.has(mint)) return collectionLookupPending.get(mint);

  const pending = (async () => {
    let result = null;
    try {
      const token = await magicEdenGet('/tokens/' + encodeURIComponent(mint));
      const fromToken = readMagicEdenCollection(token?.token || token?.nft || token?.item || token);
      if (fromToken.collectionSymbol) {
        const details = await getMagicEdenCollectionDetails(fromToken.collectionSymbol);
        result = { ...fromToken, ...(details || {}), collectionSymbol: fromToken.collectionSymbol,
          name: details?.name || fromToken.name || fromToken.collectionSymbol.replace(/[_-]+/g, ' '),
          image: details?.image || fromToken.image || null,
          collectionAddress: fromToken.collectionAddress || details?.collectionAddress || null,
          source: 'Magic Eden public API' };
      } else if (fromToken.collectionAddress && (fromToken.name || fromToken.image)) {
        result = { ...fromToken, source: 'Magic Eden public API' };
      }
    } catch (error) {
      console.error('Magic Eden token collection lookup failed:', error.status || 'network', error.message);
    }
    if (!result?.collectionSymbol && (!result?.collectionAddress || !result?.name || !result?.image)) {
      try {
        const asset = await quicknodeRpc('getAsset', { id: mint, options: { showCollectionMetadata: true } });
        const grouping = (asset?.grouping || []).find(x => x.group_key === 'collection'), cm = grouping?.collection_metadata || {};
        const das = grouping?.group_value ? { collectionAddress: grouping.group_value, name: cm.name || grouping.name || null,
          onChainSymbol: cm.symbol || null, image: cm.image || null, verified: Boolean(grouping.verified), source: 'QuickNode Metaplex DAS' } : null;
        if (das) result = { ...(result || {}), ...das, collectionSymbol: result?.collectionSymbol || null, onChainSymbol: result?.onChainSymbol || das.onChainSymbol || null,
          name: result?.name || das.name || null, image: result?.image || das.image || null };
      } catch (error) { console.error('QuickNode DAS collection lookup failed:', error.status || 'network', error.message); }
    }
    collectionLookupCache.set(mint, { at: Date.now(), data: result });
    return result;
  })();
  collectionLookupPending.set(mint, pending);
  try { return await pending; }
  finally { collectionLookupPending.delete(mint); }
}
async function getBitquerySalesSnapshot() {
  if (bitquerySalesSnapshot.data && Date.now() - bitquerySalesSnapshot.at < 60000) return bitquerySalesSnapshot.data;
  if (bitquerySalesSnapshot.pending) return bitquerySalesSnapshot.pending;
  bitquerySalesSnapshot.pending = (async () => {
    // Fetch one 24-hour snapshot and derive 5m/15m/1h/24h windows locally.
    // Switching dashboard filters therefore does not create four Bitquery requests.
    const since = new Date(Date.now() - 1440 * 60000).toISOString();
    const query = 'query { Solana { DEXTradeByTokens(limit: {count: 250}, orderBy: {descending: Block_Time}, where: {Block: {Time: {since: "' + since + '"}}, Trade: {Currency: {Fungible: false}, Dex: {ProtocolFamily: {is: "MagicEden"}}}, Transaction: {Result: {Success: true}}}) { Block { Time } Transaction { Signature } Trade { Dex { ProtocolFamily ProtocolName } Currency { Name Symbol MintAddress CollectionAddress } Amount Side { Amount Currency { Symbol MintAddress } } } } } }';
    const payload = await bitqueryGraphql(query);
    if (payload.errors?.length) { const e = new Error(payload.errors[0].message); e.details = payload.errors; throw e; }
    const sales = (payload.data?.Solana?.DEXTradeByTokens || []).map(row => {
      const t = row.Trade || {};
      return { time: row.Block?.Time || null, signature: row.Transaction?.Signature || null,
        symbol: t.Currency?.Symbol || 'Unknown', name: t.Currency?.Name || t.Currency?.Symbol || 'Unknown',
        mint: t.Currency?.MintAddress || null, collectionAddress: t.Currency?.CollectionAddress || null,
        nftAmount: t.Amount ?? null, price: t.Side?.Amount ?? null,
        priceCurrency: t.Side?.Currency?.Symbol || null, priceCurrencyMint: t.Side?.Currency?.MintAddress || null,
        marketplace: t.Dex?.ProtocolName || t.Dex?.ProtocolFamily || 'Magic Eden' };
    });
    bitquerySalesSnapshot = { at: Date.now(), data: sales, pending: null };
    return sales;
  })().catch(error => {
    bitquerySalesSnapshot.pending = null;
    throw error;
  });
  return bitquerySalesSnapshot.pending;
}


const magicEdenSalesCache = new Map();
const magicEdenDirectorySnapshot = { at: 0, collections: null, pages: 0, pending: null };
const SALES_STATE_FILE = process.env.SALES_STATE_FILE || '/tmp/nft-sales-scanner-state.json';
const magicEdenScanner = {
  running: false, collections: [], index: 0, cycle: 0,
  salesById: new Map(), rawActivityRows: 0, recognizedSaleRows: 0,
  missingTimestampSales: 0, activityTypeCounts: {}, errors: [],
  directoryPages: 0, directoryCollectionsAvailable: 0,
  cycleStartedAt: null, lastCycleCompletedAt: null, lastUpdatedAt: null,
  stateLoaded: false, savePending: false
};

function loadMagicEdenScannerState() {
  if (magicEdenScanner.stateLoaded) return;
  magicEdenScanner.stateLoaded = true;
  try {
    const saved = JSON.parse(fs.readFileSync(SALES_STATE_FILE, 'utf8'));
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    const sales = Array.isArray(saved.sales) ? saved.sales.filter(x => x?.time && new Date(x.time).getTime() >= cutoff) : [];
    magicEdenScanner.salesById = new Map(sales.map(sale => {
      const identity = sale.signature ? sale.signature + '|' + (sale.mint || [sale.time, sale.price ?? '', sale.name].join('|')) :
        [sale.collectionSymbol || '', sale.mint || '', sale.time, sale.price ?? '', sale.name].join('|');
      return [identity, sale];
    }));
    magicEdenScanner.index = Number.isInteger(saved.index) ? Math.max(0, saved.index) : 0;
    magicEdenScanner.cycle = Number(saved.cycle) || 0;
    magicEdenScanner.lastUpdatedAt = saved.lastUpdatedAt || null;
    magicEdenScanner.lastCycleCompletedAt = saved.lastCycleCompletedAt || null;
    console.log('Restored NFT sales scanner state:', sales.length, 'recent sales; scan index', magicEdenScanner.index);
  } catch (error) {
    if (error.code !== 'ENOENT') console.warn('Could not restore NFT scanner state:', error.message);
  }
}

function saveMagicEdenScannerState() {
  if (magicEdenScanner.savePending) return;
  magicEdenScanner.savePending = true;
  try {
    const state = {
      savedAt: new Date().toISOString(),
      index: magicEdenScanner.index,
      cycle: magicEdenScanner.cycle,
      lastUpdatedAt: magicEdenScanner.lastUpdatedAt,
      lastCycleCompletedAt: magicEdenScanner.lastCycleCompletedAt,
      sales: [...magicEdenScanner.salesById.values()]
    };
    const temp = SALES_STATE_FILE + '.tmp';
    fs.mkdirSync(path.dirname(SALES_STATE_FILE), { recursive: true });
    fs.writeFileSync(temp, JSON.stringify(state));
    fs.renameSync(temp, SALES_STATE_FILE);
  } catch (error) {
    console.warn('Could not persist NFT scanner state:', error.message);
  } finally {
    magicEdenScanner.savePending = false;
  }
}

function normalizeMagicEdenActivityTime(rawTime) {
  if (typeof rawTime === 'number' && Number.isFinite(rawTime)) {
    return new Date(rawTime < 1000000000000 ? rawTime * 1000 : rawTime).toISOString();
  }
  if (typeof rawTime === 'string') {
    if (/^\d{10}$/.test(rawTime)) return new Date(Number(rawTime) * 1000).toISOString();
    const parsed = Date.parse(rawTime);
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  }
  return null;
}

async function getAllMagicEdenCollections() {
  if (magicEdenDirectorySnapshot.collections &&
      Date.now() - magicEdenDirectorySnapshot.at < 6 * 60 * 60 * 1000) {
    return magicEdenDirectorySnapshot;
  }
  if (magicEdenDirectorySnapshot.pending) return magicEdenDirectorySnapshot.pending;

  magicEdenDirectorySnapshot.pending = (async () => {
    const bySymbol = new Map();
    let pages = 0;

    // Prioritize collections with recent marketplace activity so the first
    // results appear quickly, then append the complete public directory.
    try {
      const popularRaw = await magicEdenGet('/marketplace/popular_collections', { timeRange: '1d' });
      const popularRows = Array.isArray(popularRaw) ? popularRaw :
        (popularRaw?.collections || popularRaw?.results || popularRaw?.data || popularRaw?.items || []);
      popularRows
        .filter(row => row && (row.symbol || row.collectionSymbol))
        .sort((a, b) => Number(b.volumeAll || b.volume24hr || b.volume_24hr || b.volume_24hr_sol || 0) -
                        Number(a.volumeAll || a.volume24hr || a.volume_24hr || a.volume_24hr_sol || 0))
        .forEach(row => {
          const symbol = String(row.symbol || row.collectionSymbol).trim();
          if (symbol && !bySymbol.has(symbol.toLowerCase())) bySymbol.set(symbol.toLowerCase(), normalizeCollection(row));
        });
    } catch (error) {
      console.warn('Magic Eden popular collections lookup failed; continuing with full directory:', error.status || 'network', error.message);
    }

    for (let offset = 0; offset < 10000; offset += 500) {
      const raw = await magicEdenGet('/collections', { offset, limit: 500 });
      const rows = Array.isArray(raw) ? raw :
        (raw?.collections || raw?.results || raw?.data || raw?.items || []);
      pages++;
      for (const row of rows) {
        const symbol = String(row?.symbol || row?.collectionSymbol || '').trim();
        if (symbol && !bySymbol.has(symbol.toLowerCase())) bySymbol.set(symbol.toLowerCase(), normalizeCollection(row));
      }
      if (rows.length < 500) break;
    }
    const result = { at: Date.now(), collections: [...bySymbol.values()], pages, pending: null };
    magicEdenDirectorySnapshot.at = result.at;
    magicEdenDirectorySnapshot.collections = result.collections;
    magicEdenDirectorySnapshot.pages = result.pages;
    magicEdenDirectorySnapshot.pending = null;
    return result;
  })().catch(error => {
    magicEdenDirectorySnapshot.pending = null;
    throw error;
  });
  return magicEdenDirectorySnapshot.pending;
}

function recordMagicEdenActivitySale(item, collection) {
  const originalType = String(item.type || item.activityType || item.activity_type || item.txType || '').trim();
  const normalizedType = originalType.toLowerCase().replace(/[^a-z]/g, '');
  if (originalType) {
    magicEdenScanner.activityTypeCounts[originalType] =
      (magicEdenScanner.activityTypeCounts[originalType] || 0) + 1;
  }
  const isSale = ['buynow','acceptbid','buy','sale','auctionbuy','sold','purchase','purchasesale'].includes(normalizedType);
  if (!isSale) return;

  magicEdenScanner.recognizedSaleRows++;
  const token = item.token || item.nft || item.item || item.asset || {};
  const rawTime = item.blockTime ?? item.block_time ?? item.blocktime ?? item.time ??
    item.createdAt ?? item.created_at ?? null;
  const time = normalizeMagicEdenActivityTime(rawTime);
  if (!time) {
    magicEdenScanner.missingTimestampSales++;
    return;
  }
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  if (new Date(time).getTime() < cutoff) return;

  const rawPrice = item.priceSol ?? item.price_sol ?? item.price ?? item.amount ?? item.paymentAmount ?? null;
  const price = typeof rawPrice === 'object' && rawPrice ? (rawPrice.sol ?? rawPrice.amount ?? null) : rawPrice;
  const mint = item.tokenMint || item.token_mint || item.mint || item.mintAddress ||
    token.tokenMint || token.mint || token.mintAddress || token.id || null;
  const symbol = String(collection.symbol || '');
  const collectionMeta = {
    collectionSymbol: symbol,
    name: collection.name || symbol,
    image: collection.image || null,
    collectionAddress: collection.collectionAddress || null,
    floorPrice: collection.floorPrice ?? null,
    listedCount: collection.listedCount ?? null,
    verified: Boolean(collection.verified)
  };
  const signature = item.signature || item.txSignature || item.tx_signature || item.transaction_id || null;
  const sale = {
    time, signature,
    symbol: token.symbol || symbol,
    name: token.name || token.title || item.name || item.tokenName || collection.name || symbol,
    mint, collectionAddress: collectionMeta.collectionAddress, collectionSymbol: symbol,
    collectionMeta, nftAmount: 1,
    price: price === null ? null : Number(price),
    priceCurrency: item.currency || item.paymentSymbol || item.priceCurrency || 'SOL',
    priceCurrencyMint: item.currencyMint || item.paymentMint || null,
    marketplace: 'Magic Eden'
  };
  const identity = signature ? signature + '|' + (mint || [time, sale.price ?? '', sale.name].join('|')) : [symbol, mint || '', time, sale.price ?? '', sale.name].join('|');
  magicEdenScanner.salesById.set(identity, sale);
}

async function scanMagicEdenCollection(collection) {
  const symbol = String(collection.symbol || '').trim();
  if (!symbol) return;
  try {
    // Keep the compatible 100-row page size. Larger single-page limits have
    // returned HTTP 400, so page with offsets instead when a collection is busy.
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    for (let offset = 0; offset < 1000; offset += 100) {
      const raw = await magicEdenGet('/collections/' + encodeURIComponent(symbol) + '/activities', { offset, limit: 100 });
      const rows = findListingRows(raw);
      magicEdenScanner.rawActivityRows += rows.length;
      for (const item of rows) recordMagicEdenActivitySale(item, collection);
      if (rows.length < 100) break;
      const pageTimes = rows.map(item => normalizeMagicEdenActivityTime(
        item.blockTime ?? item.block_time ?? item.blocktime ?? item.time ?? item.createdAt ?? item.created_at ?? null
      )).filter(Boolean).map(value => new Date(value).getTime());
      if (pageTimes.length && Math.min(...pageTimes) < cutoff) break;
    }
  } catch (error) {
    magicEdenScanner.errors.push(symbol + ': ' + error.message);
    if (magicEdenScanner.errors.length > 40) magicEdenScanner.errors.shift();
    console.error('Magic Eden activity lookup failed for', symbol, error.status || 'network', error.message);
  }
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  for (const [id, sale] of magicEdenScanner.salesById) {
    if (!sale.time || new Date(sale.time).getTime() < cutoff) magicEdenScanner.salesById.delete(id);
  }
  magicEdenScanner.lastUpdatedAt = new Date().toISOString();
  saveMagicEdenScannerState();
}

async function runMagicEdenSalesScanner() {
  if (magicEdenScanner.running) return;
  loadMagicEdenScannerState();
  magicEdenScanner.running = true;
  try {
    while (true) {
      try {
        const directory = await getAllMagicEdenCollections();
        magicEdenScanner.collections = directory.collections;
        magicEdenScanner.directoryPages = directory.pages;
        magicEdenScanner.directoryCollectionsAvailable = directory.collections.length;

        if (!magicEdenScanner.cycleStartedAt) {
          magicEdenScanner.cycleStartedAt = new Date().toISOString();
          // Keep rolling diagnostic counters across cycles; sales themselves
          // are independently pruned to the requested 24-hour window.
          magicEdenScanner.errors = [];
        }

        if (!magicEdenScanner.collections.length) {
          await new Promise(resolve => setTimeout(resolve, 30000));
          continue;
        }

        if (magicEdenScanner.index >= magicEdenScanner.collections.length) {
          magicEdenScanner.lastCycleCompletedAt = new Date().toISOString();
          magicEdenScanner.cycle++;
          magicEdenScanner.index = 0;
          magicEdenScanner.cycleStartedAt = new Date().toISOString();
          saveMagicEdenScannerState();
          // Keep rolling diagnostic counters across cycles; sales themselves
          // are independently pruned to the requested 24-hour window.
          magicEdenScanner.errors = [];
        }

        const collection = magicEdenScanner.collections[magicEdenScanner.index];
        await scanMagicEdenCollection(collection);
        magicEdenScanner.index++;
        saveMagicEdenScannerState();
      } catch (error) {
        magicEdenScanner.errors.push('Scanner: ' + error.message);
        if (magicEdenScanner.errors.length > 40) magicEdenScanner.errors.shift();
        console.error('Magic Eden all-collection scanner error:', error.status || 'network', error.message);
        await new Promise(resolve => setTimeout(resolve, 10000));
      }
    }
  } finally {
    magicEdenScanner.running = false;
  }
}

function ensureMagicEdenSalesScanner() {
  if (!magicEdenScanner.running) {
    runMagicEdenSalesScanner().catch(error => {
      magicEdenScanner.running = false;
      console.error('Magic Eden sales scanner stopped:', error.message);
    });
  }
}

async function getMagicEdenSalesSnapshot() {
  loadMagicEdenScannerState();
  ensureMagicEdenSalesScanner();
  const collections = magicEdenScanner.collections;
  const sales = [...magicEdenScanner.salesById.values()]
    .sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime());
  return {
    sales, collections, errors: [...magicEdenScanner.errors],
    discoverySource: 'Full Magic Eden public collection directory, scanned continuously in the background',
    directoryPages: magicEdenScanner.directoryPages,
    directoryCollectionsAvailable: magicEdenScanner.directoryCollectionsAvailable,
    timeRange: '1d',
    sampledCollections: magicEdenScanner.index,
    rawActivityRows: magicEdenScanner.rawActivityRows,
    activityTypeCounts: { ...magicEdenScanner.activityTypeCounts },
    recognizedSaleRows: magicEdenScanner.recognizedSaleRows,
    missingTimestampSales: magicEdenScanner.missingTimestampSales,
    scanProgress: {
      running: magicEdenScanner.running,
      cycle: magicEdenScanner.cycle + 1,
      scanned: magicEdenScanner.index,
      total: magicEdenScanner.directoryCollectionsAvailable,
      percent: magicEdenScanner.directoryCollectionsAvailable
        ? Math.round(magicEdenScanner.index / magicEdenScanner.directoryCollectionsAvailable * 100) : 0,
      lastUpdatedAt: magicEdenScanner.lastUpdatedAt,
      lastCycleCompletedAt: magicEdenScanner.lastCycleCompletedAt
    }
  };
}

async function getGlobalNftSales(minutes) {
  const old = salesCache.get(minutes);
  if (old && Date.now() - old.at < 45000) return old.data;
  if (salesPending.has(minutes)) return salesPending.get(minutes);

  const pending = (async () => {
    const snapshotData = await getMagicEdenSalesSnapshot(minutes);
    const snapshot = snapshotData.sales;
    const cutoff = Date.now() - minutes * 60000;
    const sales = snapshot.filter(sale => !sale.time || new Date(sale.time).getTime() >= cutoff);
    const groups = new Map();
    for (const sale of sales) {
      const saleCollectionAddress = sale.collectionAddress || sale.collectionMeta?.collectionAddress || null;
      const key = saleCollectionAddress ? 'collection:' + String(saleCollectionAddress).toLowerCase() : (sale.collectionSymbol ? 'symbol:' + String(sale.collectionSymbol).toLowerCase() : (sale.mint ? 'mint:' + sale.mint : 'ticker:' + sale.symbol));
      const g = groups.get(key) || { key, collectionAddress: saleCollectionAddress, sampleMint: sale.mint,
        symbol: sale.symbol, name: sale.name, salesCount: 0, volumeSol: 0,
        lastSale: sale.time, marketplace: sale.marketplace, collectionMeta: sale.collectionMeta || null };
      g.salesCount++;
      if ((['SOL','WSOL'].includes(String(sale.priceCurrency || '').toUpperCase()) || sale.priceCurrencyMint === 'So11111111111111111111111111111111111111112') && Number.isFinite(Number(sale.price))) g.volumeSol += Number(sale.price);
      if (sale.time && (!g.lastSale || new Date(sale.time) > new Date(g.lastSale))) g.lastSale = sale.time;
      groups.set(key, g);
    }
    const lookupCandidates = [...groups.values()]
      .filter(g => g.sampleMint && !g.collectionMeta)
      .sort((a, b) => b.salesCount - a.salesCount)
      .slice(0, 50);

    // Resolve the highest-volume groups before responding; finish the rest in the
    // background so the HTTP request stays short. Per-mint single-flight + cache
    // prevents duplicate lookups when windows are switched or requests overlap.
    await Promise.all(lookupCandidates.slice(0, 16).map(async g => {
      g.collectionMeta = await lookupCollectionFromMint(g.sampleMint);
    }));
    for (const g of lookupCandidates.slice(16)) {
      lookupCollectionFromMint(g.sampleMint).catch(() => null);
    }

    const data = { sales, groups: [...groups.values()].sort((a,b) => b.salesCount-a.salesCount || b.volumeSol-a.volumeSol), sourceDiagnostics:{ source:'Magic Eden public API', sampledCollections:snapshotData.sampledCollections, directoryPages:snapshotData.directoryPages || 0, directoryCollectionsAvailable:snapshotData.directoryCollectionsAvailable || 0, discoverySource:snapshotData.discoverySource, timeRange:snapshotData.timeRange, rawActivityRows:snapshotData.rawActivityRows || 0, activityTypeCounts:snapshotData.activityTypeCounts || {}, recognizedSaleRows:snapshotData.recognizedSaleRows || 0, missingTimestampSales:snapshotData.missingTimestampSales || 0, scanProgress:snapshotData.scanProgress || null, errors:snapshotData.errors || [] } };
    salesCache.set(minutes, { at: Date.now(), data });
    return data;
  })();
  salesPending.set(minutes, pending);
  try { return await pending; }
  finally { salesPending.delete(minutes); }
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
  ['page', 'limit']));
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
    const salesData = await getGlobalNftSales(minutes), collectionsByKey = new Map();
    for (const g of salesData.groups) {
      const meta = g.collectionMeta || {}, address = meta.collectionAddress || g.collectionAddress || null;
      const marketSymbol = meta.collectionSymbol || null;
      if (!address && !marketSymbol) continue;
      // Prefer the on-chain collection address as the canonical identity. Use the
      // Magic Eden symbol only when no collection address is available.
      const key = address ? 'address:' + String(address).toLowerCase() : 'magiceden:' + String(marketSymbol).toLowerCase();
      const symbol = marketSymbol || meta.onChainSymbol || ('COLL-' + String(address).slice(0, 7));
      const name = meta.name || (marketSymbol ? marketSymbol.replace(/[_-]+/g, ' ') : (meta.onChainSymbol || null));
      if (!name) continue;
      const current = collectionsByKey.get(key) || { id:key, symbol, magicEdenSymbol:marketSymbol, name, image:meta.image || null,
        floorPrice:meta.floorPrice ?? null, listedCount:meta.listedCount ?? null, verified:Boolean(meta.verified),
        collectionAddress:address, salesCount:0, volumeSol:0, lastSale:null, marketplace:g.marketplace || 'Magic Eden', collectionResolved:true };
      current.salesCount += Number(g.salesCount || 0); current.volumeSol += Number(g.volumeSol || 0);
      if (!current.collectionAddress && address) current.collectionAddress = address;
      if (!current.magicEdenSymbol && marketSymbol) { current.magicEdenSymbol = marketSymbol; current.symbol = marketSymbol; }
      if ((!current.name || current.name.startsWith('COLL-')) && name) current.name = name;
      if (!current.image && meta.image) current.image = meta.image;
      if (meta.floorPrice !== null && meta.floorPrice !== undefined) current.floorPrice = meta.floorPrice;
      if (meta.listedCount !== null && meta.listedCount !== undefined) current.listedCount = meta.listedCount;
      if (g.lastSale && (!current.lastSale || new Date(g.lastSale) > new Date(current.lastSale))) current.lastSale = g.lastSale;
      collectionsByKey.set(key, current);
    }
    const collections = [...collectionsByKey.values()].sort((a,b) => b.salesCount-a.salesCount || b.volumeSol-a.volumeSol || a.name.localeCompare(b.name));
    const resolvedGroups = salesData.groups.filter(g => Boolean(g.collectionMeta?.collectionAddress || g.collectionAddress || g.collectionMeta?.collectionSymbol)).length;
    const magicEdenGroups = salesData.groups.filter(g => Boolean(g.collectionMeta?.collectionSymbol)).length;
    const unresolvedGroups = salesData.groups.filter(g => !(g.collectionMeta?.collectionAddress || g.collectionAddress || g.collectionMeta?.collectionSymbol))
      .slice(0,8).map(g => ({ nftSymbol:g.symbol, sampleMint:g.sampleMint, salesCount:g.salesCount }));
    const salesDiagnostics = { requestedWindowMinutes:minutes, source:'Magic Eden public API', sampledCollections:salesData.sourceDiagnostics?.sampledCollections || 0, directoryPages:salesData.sourceDiagnostics?.directoryPages || 0, directoryCollectionsAvailable:salesData.sourceDiagnostics?.directoryCollectionsAvailable || 0, scanProgress:salesData.sourceDiagnostics?.scanProgress || null, missingTimestampSales:salesData.sourceDiagnostics?.missingTimestampSales || 0, sourceTimeRange:salesData.sourceDiagnostics?.timeRange || null, discoverySource:salesData.sourceDiagnostics?.discoverySource || null, sourceErrors:salesData.sourceDiagnostics?.errors || [], rawActivityRows:salesData.sourceDiagnostics?.rawActivityRows || 0, activityTypeCounts:salesData.sourceDiagnostics?.activityTypeCounts || {}, recognizedSaleRows:salesData.sourceDiagnostics?.recognizedSaleRows || 0, decodedSales:salesData.sales.length,
      groupedSaleIdentities:salesData.groups.length, groupsResolvedToCollections:resolvedGroups, groupsResolvedToMagicEden:magicEdenGroups,
      groupsNotMatchedToCollections:Math.max(0,salesData.groups.length-resolvedGroups), unresolvedSamples:unresolvedGroups,
      note:salesData.sales.length===0?(salesData.sourceDiagnostics?.rawActivityRows ? 'Activity records were returned, but no timestamped sales in the last 24 hours were decoded. Check activityTypeCounts and missingTimestampSales.' : 'The all-collection background scan is still running; results fill in as each collection is checked.'):(salesData.sourceDiagnostics?.scanProgress?.percent < 100 ? 'Background scan in progress: '+salesData.sourceDiagnostics.scanProgress.scanned+' of '+salesData.sourceDiagnostics.scanProgress.total+' Magic Eden collections checked. The list grows as the scan continues.' : 'All collections in the current Magic Eden directory have been checked. This source does not include sales on other marketplaces.') };
    res.json({ success:true, minutes, collections, activeCollections:collections.length, directoryCount:collections.length,
      directoryPages:1, directoryHasMore:false, sales:salesData.sales, salesDiagnostics, providerErrors:{},
      sources:{ sales:'Magic Eden public Solana API (popular collections + per-collection activities)', collectionMetadata:'Magic Eden public Solana API + optional QuickNode Metaplex DAS' },
      limitations:[
        'Collection cards are grouped by Magic Eden collection symbol or on-chain collection address, never by an individual NFT name.',
        'Magic Eden public read endpoints are rate-limited; collection metadata is cached.',
        'Unresolved assets remain in recent sales and diagnostics but are not shown as collections.',
        'Magic Eden collections are scanned continuously from its public directory; the first full pass takes time and each collection activity page is limited to 100 rows. This is not a complete all-marketplace Solana sales index and does not include Tensor-only or other marketplace sales.'
      ] });
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
    const activityRows = findListingRows(data);
    const items = activityRows.filter(item => {
      const type = String(item.type || item.activityType || '').toLowerCase();
      if (['buynow','acceptbid','buy','sale','auctionbuy'].includes(type)) return true;
      return !type && Boolean(item.buyer && item.seller && (item.price !== undefined || item.amount !== undefined));
    });
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
    const data = await magicEdenGet('/collections/' + encodeURIComponent(symbol) + '/listings', { offset:0, limit:40, sort:'listPrice', sort_direction:'asc', listingAggMode:true });
    const items = findListingRows(data), result = { success:true, symbol, source:'Magic Eden public Solana API', count:items.length, items, data };
    listingsCache.set(key, { at:Date.now(), data:result }); res.json(result);
  } catch (error) {
    console.error('Magic Eden listings failed:', error.status || 'network', error.message);
    res.status(error.status || 502).json({ success:false, source:'Magic Eden public Solana API', error:error.message, details:error.details || undefined });
  }
});
app.get('/api/launches/recent', async (req, res) => {
  try {
    const data = await getRecentSolanaMintsFree();
    res.json({ success: true, ...data });
  } catch (error) {
    console.error('Free-source launch discovery failed:', error.status || 'network', error.message);
    res.status(error.status || 502).json({
      success: false,
      source: 'Solana public RPC + QuickNode Metaplex DAS',
      error: error.message
    });
  }
});

app.get('/api/config', (req, res) => {
  res.json({
    provider: 'Magic Eden public API + Solana public RPC',
    configured: Boolean(QUICKNODE_RPC_URL),
    mode: 'read-only',
    heliusRequired: false
  });
});

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', provider: 'Magic Eden + Solana public RPC', configured: true });
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
  console.log('Sales feed: continuous scan of the full Magic Eden public collection directory and recent collection activities.');
  console.log('Mint discovery: Solana public RPC. Asset metadata hydration: existing QuickNode Metaplex DAS endpoint.');
});
