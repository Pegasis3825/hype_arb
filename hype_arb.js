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

// Configuration
const API_BASE_URL = 'https://api.liqd.ag';
const MAX_CONCURRENT_REQUESTS = 8;
const REQUEST_DELAY = 100;
const UPDATE_INTERVAL = 30000; // 30 seconds

// Token addresses for HyperEVM
const TOKENS = {
    'HYPE': '0x5555555555555555555555555555555555555555',
    'BTC': '0x9FDBdA0A5e284c32744D2f17Ee5c74B284993463',
    'ETH': '0xBe6727B535545C67d5cAa73dEa54865B92CF7907',
    'USDTO': '0xB8CE59FC3717ada4C02eaDF9682A9e934F625ebb',
    'USDE': '0x5d3a1Ff2b6BAb83b63cd9AD0787074081a52ef34',
    'PURR': '0x9b498C3c8A0b8CD8BA1D9851d40D186F1872b44E',
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

async function makeRequest(url, params = {}, retries = 3) {
    await semaphore.acquire();
    try {
        await delay(REQUEST_DELAY);
        const response = await axios.get(url, { params, timeout: 15000 });
        return response.data;
    } catch (error) {
        if (retries > 0 && (error.code === 'ECONNRESET' || error.response?.status >= 500 || error.code === 'ETIMEDOUT')) {
            await delay(2000);
            return makeRequest(url, params, retries - 1);
        }
        throw error;
    } finally {
        semaphore.release();
    }
}

async function fetchHyperCorePrices() {
    try {
        const apiUrl = "https://api.hyperliquid.xyz/info";
        const payload = { type: "allMids" };
        
        const response = await fetch(apiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
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
        
        if (Object.keys(tokenPrices).length < targetTokens.length) {
            const spotMeta = await fetchSpotMeta();
            if (spotMeta && spotMeta.tokens) {
                for (const token of targetTokens) {
                    if (!tokenPrices[token]) {
                        let tokenId = null;
                        for (const t of spotMeta.tokens) {
                            if (t.name === token) {
                                tokenId = t.index;
                                break;
                            }
                        }
                        if (tokenId !== null && spotMeta.universe) {
                            for (const pair of spotMeta.universe) {
                                const tokens = pair.tokens || [];
                                if (tokens.length >= 2 && tokens.includes(tokenId)) {
                                    const indexName = `@${pair.index}`;
                                    if (allMids[indexName]) {
                                        tokenPrices[token] = parseFloat(allMids[indexName]);
                                        break;
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
        
        return tokenPrices;
    } catch (error) {
        console.error(`Error fetching HyperCore prices: ${error.message}`);
        return {};
    }
}

async function fetchSpotMeta() {
    try {
        const response = await fetch("https://api.hyperliquid.xyz/info", {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type: "spotMeta" })
        });
        return await response.json();
    } catch (error) {
        return null;
    }
}

async function getHYPEPrice(tokenAddress, tokenSymbol) {
    try {
        const hypeAddress = TOKENS['HYPE'];
        
        const directResponse = await makeRequest(`${API_BASE_URL}/route`, {
            tokenA: tokenAddress,
            tokenB: hypeAddress,
            amountIn: 1,
            multiHop: true
        });
        
        if (directResponse.success && directResponse.data && directResponse.data.bestPath) {
            const route = directResponse.data.bestPath;
            const amountOut = parseFloat(route.estimatedAmountOut || route.amountOut || 0);
            if (amountOut > 0) {
                return { hypePrice: amountOut, direct: true };
            }
        }
        
        const reverseResponse = await makeRequest(`${API_BASE_URL}/route`, {
            tokenA: hypeAddress,
            tokenB: tokenAddress,
            amountIn: 1,
            multiHop: true
        });
        
        if (reverseResponse.success && reverseResponse.data && reverseResponse.data.bestPath) {
            const route = reverseResponse.data.bestPath;
            const amountOut = parseFloat(route.estimatedAmountOut || route.amountOut || 0);
            if (amountOut > 0) {
                return { hypePrice: 1 / amountOut, direct: false };
            }
        }
        
        return null;
    } catch (error) {
        console.error(`Error getting HYPE price for ${tokenSymbol}:`, error.message);
        return null;
    }
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
        
        const hyperCorePrices = await fetchHyperCorePrices();
        if (!hyperCorePrices['HYPE']) {
            throw new Error('HYPE price not found on HyperCore');
        }
        
        const coreHYPEPrices = calculateCoreHYPEPrices(hyperCorePrices);
        const evmHYPEPrices = {};
        
        for (const [symbol, address] of Object.entries(TOKENS)) {
            if (symbol === 'HYPE') continue;
            const hypePrice = await getHYPEPrice(address, symbol);
            if (hypePrice) {
                evmHYPEPrices[symbol] = hypePrice;
            }
            await delay(200);
        }
        
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
            updateTime: (endTime - startTime) / 1000,
            hypeUSDPrice: hyperCorePrices['HYPE']
        };
        
        console.log(`✅ Price data updated in ${result.updateTime.toFixed(2)}s`);
        return result;
        
    } catch (error) {
        console.error('❌ Error generating price data:', error.message);
        return { error: error.message, lastUpdated: new Date().toISOString() };
    }
}

// Store latest data
let latestData = null;

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

// Update loop
async function updateLoop() {
    const data = await generatePriceData();
    latestData = data;
    broadcastUpdate(data);
    setTimeout(updateLoop, UPDATE_INTERVAL);
}

// REST endpoints
app.get('/api/prices', (req, res) => {
    res.json(latestData || { message: 'Data not ready yet' });
});

app.get('/api/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        clients: clients.size, 
        lastUpdate: latestData?.lastUpdated 
    });
});

// Start server
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`📊 WebSocket endpoint: ws://localhost:${PORT}`);
    console.log(`🔗 REST API: http://localhost:${PORT}/api/prices`);
    
    // Start update loop
    updateLoop();
});