const express = require('express');
const cors = require('cors');
const WebSocket = require('ws');
const http = require('http');
const axios = require('axios');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(cors());
app.use(express.json());

// Configuration - Optimized for speed
const API_BASE_URL = 'https://api.liqd.ag';
const MAX_CONCURRENT_REQUESTS = 20; // Increased from 8
const REQUEST_DELAY = 25; // Reduced from 100ms
const BATCH_SIZE = 5; // Process tokens in batches

// Dynamic update intervals
const BASE_UPDATE_INTERVAL = 8000; // Base interval (8 seconds)
const MIN_UPDATE_INTERVAL = 5000; // Minimum 5s between updates
const MAX_UPDATE_INTERVAL = 20000; // Maximum 20s between updates

// Token addresses for HyperEVM
const TOKENS = {
    'HYPE': '0x5555555555555555555555555555555555555555',
    'BTC': '0x9FDBdA0A5e284c32744D2f17Ee5c74B284993463',
    'ETH': '0xBe6727B535545C67d5cAa73dEa54865B92CF7907',
    'USDTO': '0xB8CE59FC3717ada4C02eaDF9682A9e934F625ebb',
    'USDE': '0x5d3a1Ff2b6BAb83b63cd9AD0787074081a52ef34',
    'PURR': '0x9b498C3c8A0b8CD9BA1D9851d40D186F1872b44E',
    'FEUSD': '0x02c6a2fA58cC01A18B8D9E00eA48d65E4dF26c70',
    'USDXL': '0xca79db4B49f608eF54a5CB813FbEd3a6387bC645',
    'BUDDY': '0x47bb061C0204Af921F43DC73C7D7768d2672DdEE'
};

const HYPERCORE_TOKEN_MAPPING = {
    'BTC': 'BTC', 'ETH': 'ETH', 'HYPE': 'HYPE', 'USDTO': 'USDT0',
    'USDE': 'USDE', 'PURR': 'PURR', 'FEUSD': 'FEUSD', 'USDXL': 'USDXL', 'BUDDY': 'BUDDY'
};

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

class Semaphore {
    constructor(max) {
        this.max = max;
        this.current = 0;
        this.queue = [];
    }
    async acquire() {
        return new Promise((resolve) => {
            if (this.current < this.max) {
                this.current++;
                resolve();
            } else {
                this.queue.push(resolve);
            }
        });
    }
    release() {
        this.current--;
        if (this.queue.length > 0) {
            this.current++;
            const next = this.queue.shift();
            next();
        }
    }
}

const semaphore = new Semaphore(MAX_CONCURRENT_REQUESTS);

// Optimized request function with shorter timeout
async function makeRequest(url, params = {}, retries = 2) {
    await semaphore.acquire();
    try {
        await delay(REQUEST_DELAY);
        const response = await axios.get(url, { 
            params, 
            timeout: 8000, // Reduced from 15000ms
            headers: {
                'Connection': 'keep-alive',
                'Accept-Encoding': 'gzip, deflate'
            }
        });
        return response.data;
    } catch (error) {
        if (retries > 0 && (error.code === 'ECONNRESET' || error.response?.status >= 500 || error.code === 'ETIMEDOUT')) {
            await delay(500); // Reduced retry delay
            return makeRequest(url, params, retries - 1);
        }
        throw error;
    } finally {
        semaphore.release();
    }
}

// Cache for HyperCore prices (valid for 10 seconds)
let hyperCorePricesCache = null;
let hyperCoreCacheTime = 0;
const HYPERCORE_CACHE_DURATION = 10000;

async function fetchHyperCorePrices() {
    const now = Date.now();
    if (hyperCorePricesCache && (now - hyperCoreCacheTime) < HYPERCORE_CACHE_DURATION) {
        return hyperCorePricesCache;
    }

    try {
        const apiUrl = "https://api.hyperliquid.xyz/info";
        const payload = { type: "allMids" };
        
        const response = await fetch(apiUrl, {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/json',
                'Accept-Encoding': 'gzip, deflate'
            },
            body: JSON.stringify(payload),
            timeout: 5000
        });
        
        if (!response.ok) throw new Error(`HTTP error! Status: ${response.status}`);
        
        const allMids = await response.json();
        const targetTokens = ["BTC", "ETH", "HYPE", "USDT0", "USDE", "PURR", "FEUSD", "USDXL", "BUDDY"];
        const tokenPrices = {};
        
        for (const token of targetTokens) {
            if (allMids[token]) {
                tokenPrices[token] = parseFloat(allMids[token]);
            }
        }
        
        // Cache the result
        hyperCorePricesCache = tokenPrices;
        hyperCoreCacheTime = now;
        
        return tokenPrices;
    } catch (error) {
        console.error(`Error fetching HyperCore prices: ${error.message}`);
        // Return cached data if available, even if expired
        return hyperCorePricesCache || {};
    }
}

// Batch processing for HYPE prices with error resilience
async function getHYPEPriceBatch(tokenEntries) {
    const promises = tokenEntries.map(async ([symbol, address]) => {
        try {
            const hypeAddress = TOKENS['HYPE'];
            
            // Try direct route first
            const directResponse = await makeRequest(`${API_BASE_URL}/route`, {
                tokenA: address,
                tokenB: hypeAddress,
                amountIn: 1,
                multiHop: true
            });
            
            if (directResponse.success && directResponse.data && directResponse.data.bestPath) {
                const route = directResponse.data.bestPath;
                const amountOut = parseFloat(route.estimatedAmountOut || route.amountOut || 0);
                if (amountOut > 0) {
                    return [symbol, { hypePrice: amountOut, direct: true }];
                }
            }
            
            // Try reverse route
            const reverseResponse = await makeRequest(`${API_BASE_URL}/route`, {
                tokenA: hypeAddress,
                tokenB: address,
                amountIn: 1,
                multiHop: true
            });
            
            if (reverseResponse.success && reverseResponse.data && reverseResponse.data.bestPath) {
                const route = reverseResponse.data.bestPath;
                const amountOut = parseFloat(route.estimatedAmountOut || route.amountOut || 0);
                if (amountOut > 0) {
                    return [symbol, { hypePrice: 1 / amountOut, direct: false }];
                }
            }
            
            return [symbol, null];
        } catch (error) {
            // Only log if it's not a 500 error (which is common for some tokens)
            if (!error.response || error.response.status !== 500) {
                console.error(`Error getting HYPE price for ${symbol}:`, error.message);
            }
            return [symbol, null];
        }
    });
    
    const results = await Promise.allSettled(promises);
    const evmHYPEPrices = {};
    const failedTokens = [];
    
    results.forEach((result) => {
        if (result.status === 'fulfilled') {
            const [symbol, priceData] = result.value;
            if (priceData) {
                evmHYPEPrices[symbol] = priceData;
            } else {
                failedTokens.push(symbol);
            }
        }
    });
    
    if (failedTokens.length > 0) {
        console.log(`⚠️  Failed to fetch prices for: ${failedTokens.join(', ')}`);
    }
    
    return evmHYPEPrices;
}

function calculateCoreHYPEPrices(hyperCorePrices) {
    const coreHYPEPrices = {};
    const hypeUSDPrice = hyperCorePrices['HYPE'];
    
    if (!hypeUSDPrice) return {};
    
    for (const [token, usdPrice] of Object.entries(hyperCorePrices)) {
        if (token !== 'HYPE' && usdPrice > 0) {
            coreHYPEPrices[token] = usdPrice / hypeUSDPrice;
        }
    }
    
    coreHYPEPrices['HYPE'] = 1;
    return coreHYPEPrices;
}

async function generatePriceData() {
    try {
        console.log('🔄 Updating price data...');
        const startTime = Date.now();
        
        // Fetch HyperCore prices (with caching)
        const hyperCorePrices = await fetchHyperCorePrices();
        if (!hyperCorePrices['HYPE']) {
            throw new Error('HYPE price not found on HyperCore');
        }
        
        const coreHYPEPrices = calculateCoreHYPEPrices(hyperCorePrices);
        
        // Process EVM tokens in parallel batches
        const tokenEntries = Object.entries(TOKENS).filter(([symbol]) => symbol !== 'HYPE');
        const evmHYPEPrices = await getHYPEPriceBatch(tokenEntries);
        
        const priceComparisons = [];
        for (const [symbol, evmData] of Object.entries(evmHYPEPrices)) {
            const coreToken = HYPERCORE_TOKEN_MAPPING[symbol];
            const coreHYPEPrice = coreHYPEPrices[coreToken];
            
            if (coreHYPEPrice) {
                const priceDiff = evmData.hypePrice - coreHYPEPrice;
                const priceDiffPercent = (priceDiff / coreHYPEPrice) * 100;
                
                let direction = 'None';
                if (Math.abs(priceDiffPercent) > 0.2) {
                    direction = priceDiffPercent > 0 ? 'Core → EVM' : 'EVM → Core';
                }
                
                priceComparisons.push({
                    token: symbol,
                    corePrice: coreHYPEPrice,
                    evmPrice: evmData.hypePrice,
                    priceDifference: priceDiff,
                    priceDifferencePercent: priceDiffPercent,
                    arbitrageDirection: direction
                });
            }
        }
        
        const endTime = Date.now();
        const result = {
            priceComparisons: priceComparisons.sort((a, b) => Math.abs(b.priceDifferencePercent) - Math.abs(a.priceDifferencePercent)),
            lastUpdated: new Date().toISOString(),
            apiTime: (endTime - startTime) / 1000, // Renamed from updateTime
            hypeUSDPrice: hyperCorePrices['HYPE'],
            tokensProcessed: Object.keys(evmHYPEPrices).length
        };
        
        console.log(`✅ API fetch completed in ${result.apiTime.toFixed(2)}s (${result.tokensProcessed}/${tokenEntries.length} tokens)`);
        return result;
        
    } catch (error) {
        console.error('❌ Error generating price data:', error.message);
        return { error: error.message, lastUpdated: new Date().toISOString() };
    }
}

// Store latest data and timing
let latestData = null;
let lastUpdateTime = null;

// WebSocket connections
const clients = new Set();

wss.on('connection', (ws) => {
    clients.add(ws);
    console.log('Client connected. Total clients:', clients.size);
    
    // Send current data immediately
    if (latestData) {
        ws.send(JSON.stringify({ type: 'priceUpdate', data: latestData }));
    }
    
    ws.on('close', () => {
        clients.delete(ws);
        console.log('Client disconnected. Total clients:', clients.size);
    });
});

// Broadcast to all clients
function broadcastUpdate(data) {
    const message = JSON.stringify({ type: 'priceUpdate', data });
    clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(message);
        }
    });
}

// Update loop with dynamic interval
async function updateLoop() {
    const updateStartTime = Date.now();
    
    // Calculate time since last update
    let timeSinceLastUpdate = null;
    if (lastUpdateTime) {
        timeSinceLastUpdate = (updateStartTime - lastUpdateTime) / 1000;
    }
    
    const data = await generatePriceData();
    latestData = data;
    
    // Add cycle timing to the data
    if (timeSinceLastUpdate) {
        latestData.cycleTime = timeSinceLastUpdate;
        console.log(`⏱️  Time since last update: ${timeSinceLastUpdate.toFixed(2)}s`);
    }
    
    lastUpdateTime = updateStartTime;
    broadcastUpdate(data);
    
    // Dynamic interval based on API performance
    let nextInterval = BASE_UPDATE_INTERVAL;
    if (data.apiTime) {
        // If API is fast, update more frequently
        if (data.apiTime < 3) {
            nextInterval = MIN_UPDATE_INTERVAL;
        } else if (data.apiTime > 8) {
            nextInterval = MAX_UPDATE_INTERVAL;
        }
    }
    
    console.log(`⏭️  Next update in ${nextInterval/1000}s`);
    setTimeout(updateLoop, nextInterval);
}

// REST endpoints
app.get('/api/prices', (req, res) => {
    res.json(latestData || { message: 'Data not ready yet' });
});

app.get('/api/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        clients: clients.size, 
        lastUpdate: latestData?.lastUpdated,
        cacheStatus: {
            hyperCoreCached: hyperCorePricesCache !== null,
            cacheAge: hyperCorePricesCache ? Date.now() - hyperCoreCacheTime : 0
        }
    });
});

// Force refresh endpoint for testing
app.post('/api/refresh', async (req, res) => {
    console.log('🔄 Manual refresh triggered');
    const data = await generatePriceData();
    latestData = data;
    broadcastUpdate(data);
    res.json({ success: true, data });
});

// Fast update endpoint (skips interval)
app.post('/api/update-now', async (req, res) => {
    console.log('⚡ Immediate update triggered');
    const updateStartTime = Date.now();
    
    // Calculate time since last update
    let timeSinceLastUpdate = null;
    if (lastUpdateTime) {
        timeSinceLastUpdate = (updateStartTime - lastUpdateTime) / 1000;
    }
    
    const data = await generatePriceData();
    latestData = data;
    
    if (timeSinceLastUpdate) {
        latestData.cycleTime = timeSinceLastUpdate;
    }
    
    lastUpdateTime = updateStartTime;
    broadcastUpdate(data);
    
    res.json({ 
        success: true, 
        data,
        timeSinceLastUpdate: timeSinceLastUpdate 
    });
});

// Start server
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`📊 WebSocket endpoint: ws://localhost:${PORT}`);
    console.log(`🔗 REST API: http://localhost:${PORT}/api/prices`);
    console.log(`🔄 Manual refresh: POST http://localhost:${PORT}/api/refresh`);
    console.log(`⚡ Immediate update: POST http://localhost:${PORT}/api/update-now`);
    
    // Start update loop
    updateLoop();
});
