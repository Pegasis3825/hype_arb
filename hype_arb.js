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

// Dynamic update intervals - FIXED: Added missing constants
const BASE_UPDATE_INTERVAL = 8000; // Base interval (8 seconds)
const MIN_UPDATE_INTERVAL = 5000; // Minimum 5s between updates  
const MAX_UPDATE_INTERVAL = 20000; // Maximum 20s between updates

// Token addresses for HyperEVM - EXPANDED LIST
const TOKENS = {
    'HYPE': '0x5555555555555555555555555555555555555555',
    'BTC': '0x9FDBdA0A5e284c32744D2f17Ee5c74B284993463',
    'ETH': '0xBe6727B535545C67d5cAa73dEa54865B92CF7907',
    'USDTO': '0xB8CE59FC3717ada4C02eaDF9682A9e934F625ebb',
    'USDE': '0x5d3a1Ff2b6BAb83b63cd9AD0787074081a52ef34',
    'PURR': '0x9b498C3c8A0b8CD9BA1D9851d40D186F1872b44E',
    'FEUSD': '0x02c6a2fA58cC01A18B8D9E00eA48d65E4dF26c70',
    'USDXL': '0xca79db4B49f608eF54a5CB813FbEd3a6387bC645',
    'BUDDY': '0x47bb061C0204Af921F43DC73C7D7768d2672DdEE',
    'HFUN': '0xa320D9f65ec992EfF38622c63627856382Db726c',
    'LIQD': '0x1Ecd15865D7F8019D546f76d095d9c93cc34eDFa',
    'PIP': '0x1bEe6762F0B522c606DC2Ffb106C0BB391b2E309',
    'UFART': '0xTBD_UFART_ADDRESS',  // TODO: Add actual UFART address
    'USOL': '0xTBD_USOL_ADDRESS',   // TODO: Add actual USOL address  
    'RUB': '0xTBD_RUB_ADDRESS'      // TODO: Add actual RUB address
};

const HYPERCORE_TOKEN_MAPPING = {
    'BTC': 'BTC', 
    'ETH': 'ETH', 
    'HYPE': 'HYPE', 
    'USDTO': 'USDT0',
    'USDE': 'USDE', 
    'PURR': 'PURR', 
    'FEUSD': 'FEUSD', 
    'USDXL': 'USDXL', 
    'BUDDY': 'BUDDY',
    'HFUN': 'HFUN',
    'LIQD': 'LIQD', 
    'PIP': 'PIP',
    'UFART': 'UFART',
    'USOL': 'USOL',
    'RUB': 'RUB'
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
        const targetTokens = ["BTC", "ETH", "HYPE", "USDT0", "USDE", "PURR", "FEUSD", "USDXL", "BUDDY", "HFUN", "LIQD", "PIP", "UFART", "USOL", "RUB"];
        const tokenPrices = {};
        
        for (const token of targetTokens) {
            if (allMids[token]) {
                tokenPrices[token] = parseFloat(allMids[token]);
            }
        }
        
        // If missing tokens, try to get them from spot metadata
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
        
        // Cache the result
        hyperCorePricesCache = tokenPrices;
        hyperCoreCacheTime = now;
        
        console.log(`📊 HyperCore prices fetched: ${Object.keys(tokenPrices).join(', ')}`);
        return tokenPrices;
    } catch (error) {
        console.error(`Error fetching HyperCore prices: ${error.message}`);
        // Return cached data if available, even if expired
        return hyperCorePricesCache || {};
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

// Realistic trade amounts for each token to account for price impact
// These amounts represent the actual quantities you would trade to test for arbitrage
// Adjust these based on your trading strategy and risk tolerance
const REALISTIC_TRADE_AMOUNTS = {
    'BTC': '0.001',      // 0.001 BTC (~$100-200) - Conservative amount for expensive token
    'ETH': '0.1',        // 0.1 ETH (~$200-400) - Conservative amount for expensive token
    'USDTO': '100',      // 100 USDT - Reasonable stablecoin amount
    'USDE': '100',       // 100 USDe - Reasonable stablecoin amount
    'PURR': '1000',      // 1000 PURR - Mid-tier token amount
    'FEUSD': '100',      // 100 FEUSD - Stablecoin-like amount
    'USDXL': '100',      // 100 USDXL - Stablecoin-like amount
    'BUDDY': '10000',    // 10000 BUDDY - As requested by user
    'HFUN': '300',       // 500 HFUN - Gaming token amount
    'LIQD': '20000',       // 200 LIQD - DEX token amount
    'PIP': '500',       // 1000 PIP - Mid-tier amount
    'UFART': '50000',    // 50000 UFART - Meme token, large amounts normal
    'USOL': '1',         // 1 USOL (~$200-300) - Expensive token, small amount
    'RUB': '5000'        // 5000 RUB - Currency token, larger amount
};

// Function to update trade amounts dynamically (useful for testing)
function updateTradeAmount(token, amount) {
    REALISTIC_TRADE_AMOUNTS[token] = amount.toString();
    console.log(`📊 Updated ${token} trade amount to ${amount}`);
}

// Batch processing for HYPE prices with REALISTIC trade amounts
async function getHYPEPriceBatch(tokenEntries) {
    const promises = tokenEntries.map(async ([symbol, address]) => {
        try {
            const hypeAddress = TOKENS['HYPE'];
            const tradeAmount = REALISTIC_TRADE_AMOUNTS[symbol] || '1';
            
            console.log(`🔍 Getting quote for ${tradeAmount} ${symbol} → HYPE`);
            
            // Try direct route first (Token → HYPE)
            const directResponse = await makeRequest(`${API_BASE_URL}/route`, {
                tokenA: address,
                tokenB: hypeAddress,
                amountIn: tradeAmount,
                multiHop: true
            });
            
            if (directResponse.success && directResponse.data && directResponse.data.bestPath) {
                const route = directResponse.data.bestPath;
                const amountOut = parseFloat(route.estimatedAmountOut || route.amountOut || 0);
                if (amountOut > 0) {
                    const pricePerUnit = amountOut / parseFloat(tradeAmount);
                    return [symbol, { 
                        hypePrice: pricePerUnit, 
                        direct: true,
                        tradeAmount: parseFloat(tradeAmount),
                        totalHypeOut: amountOut,
                        route: 'direct'
                    }];
                }
            }
            
            // Try reverse route (HYPE → Token)
            // For reverse, we need to estimate how much HYPE to get our target token amount
            const estimatedHypeIn = parseFloat(tradeAmount) * 0.5; // Start with rough estimate
            
            const reverseResponse = await makeRequest(`${API_BASE_URL}/route`, {
                tokenA: hypeAddress,
                tokenB: address,
                amountIn: estimatedHypeIn.toString(),
                multiHop: true
            });
            
            if (reverseResponse.success && reverseResponse.data && reverseResponse.data.bestPath) {
                const route = reverseResponse.data.bestPath;
                const tokenAmountOut = parseFloat(route.estimatedAmountOut || route.amountOut || 0);
                if (tokenAmountOut > 0) {
                    const pricePerUnit = estimatedHypeIn / tokenAmountOut;
                    return [symbol, { 
                        hypePrice: pricePerUnit, 
                        direct: false,
                        tradeAmount: tokenAmountOut,
                        totalHypeIn: estimatedHypeIn,
                        route: 'reverse'
                    }];
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
                console.log(`💰 ${symbol}: ${priceData.tradeAmount} tokens = ${priceData.totalHypeOut || priceData.totalHypeIn} HYPE (${priceData.route})`);
            } else {
                failedTokens.push(symbol);
            }
        }
    });
    
    if (failedTokens.length > 0) {
        console.log(`⚠️  Failed to fetch prices for: ${failedTokens.join(', ')}`);
    }
    
    console.log(`📈 EVM prices fetched with realistic amounts: ${Object.keys(evmHYPEPrices).join(', ')}`);
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
        console.log(`💎 Core HYPE prices calculated: ${Object.keys(coreHYPEPrices).join(', ')}`);
        
        // Process EVM tokens in parallel batches
        const tokenEntries = Object.entries(TOKENS).filter(([symbol]) => symbol !== 'HYPE');
        const evmHYPEPrices = await getHYPEPriceBatch(tokenEntries);
        
        const priceComparisons = [];
        for (const [symbol, evmData] of Object.entries(evmHYPEPrices)) {
            const coreToken = HYPERCORE_TOKEN_MAPPING[symbol];
            const coreUnitPrice = coreHYPEPrices[coreToken];
            
            if (coreUnitPrice) {
                const tradeAmount = REALISTIC_TRADE_AMOUNTS[symbol] || '1';
                const tokenAmount = parseFloat(tradeAmount);
                
                // Calculate Core price for the realistic amount
                const corePrice = coreUnitPrice * tokenAmount;
                
                // EVM price for the realistic amount (from the quote)
                const evmPrice = evmData.totalHypeOut || evmData.totalHypeIn;
                
                // Calculate difference based on actual amounts
                const priceDiff = evmPrice - corePrice;
                const priceDiffPercent = (priceDiff / corePrice) * 100;
                
                let direction = 'None';
                if (Math.abs(priceDiffPercent) > 0.2) {
                    direction = priceDiffPercent > 0 ? 'Core → EVM' : 'EVM → Core';
                }
                
                // Calculate suggested HYPE amount based on the profitable difference
                let suggestedAmount = null;
                if (Math.abs(priceDiffPercent) > 0.5) { // Only suggest for profitable opportunities
                    const baseHypeAmount = Math.abs(priceDiff); // Use the actual profit amount
                    
                    // Scale based on profit percentage
                    if (Math.abs(priceDiffPercent) > 2.0) {
                        suggestedAmount = baseHypeAmount * 2.0;   // 2x the profit for high profit
                    } else if (Math.abs(priceDiffPercent) > 1.0) {
                        suggestedAmount = baseHypeAmount * 1.5;   // 1.5x for medium profit
                    } else {
                        suggestedAmount = baseHypeAmount;         // Just the profit amount for low profit
                    }
                    
                    // Cap the suggested amount to reasonable limits
                    suggestedAmount = Math.min(suggestedAmount, 100); // Max 100 HYPE
                    suggestedAmount = Math.max(suggestedAmount, 1);   // Min 1 HYPE
                }

                priceComparisons.push({
                    token: symbol,
                    tokenAmount: tokenAmount,           // Show the actual token amount being quoted
                    corePrice: corePrice,              // Core price for the full amount
                    evmPrice: evmPrice,                // EVM price for the full amount
                    priceDifference: priceDiff,        // Difference in HYPE for the full amount
                    priceDifferencePercent: priceDiffPercent,
                    arbitrageDirection: direction,
                    suggestedAmount: suggestedAmount,
                    // Additional info about the quote
                    quoteInfo: {
                        tokenAmount: evmData.tradeAmount,
                        route: evmData.route,
                        coreUnitPrice: coreUnitPrice,
                        evmUnitPrice: evmData.hypePrice
                    }
                });
            } else {
                console.log(`⚠️  No Core price found for ${symbol} (looking for ${coreToken})`);
            }
        }
        
        const endTime = Date.now();
        const result = {
            priceComparisons: priceComparisons.sort((a, b) => Math.abs(b.priceDifferencePercent) - Math.abs(a.priceDifferencePercent)),
            lastUpdated: new Date().toISOString(),
            apiTime: (endTime - startTime) / 1000,
            hypeUSDPrice: hyperCorePrices['HYPE'],
            tokensProcessed: Object.keys(evmHYPEPrices).length,
            comparisonsCreated: priceComparisons.length
        };
        
        console.log(`✅ API fetch completed in ${result.apiTime.toFixed(2)}s (${result.tokensProcessed}/${tokenEntries.length} tokens, ${result.comparisonsCreated} comparisons)`);
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
        tokensProcessed: latestData?.tokensProcessed,
        comparisonsCreated: latestData?.comparisonsCreated,
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

// Get current trade amounts
app.get('/api/trade-amounts', (req, res) => {
    res.json({ 
        success: true, 
        tradeAmounts: REALISTIC_TRADE_AMOUNTS,
        description: "Current realistic trade amounts used for price quotes"
    });
});

// Update trade amounts
app.post('/api/trade-amounts', (req, res) => {
    try {
        const { token, amount } = req.body;
        
        if (!token || amount === undefined) {
            return res.status(400).json({ 
                success: false, 
                error: "Missing token or amount in request body" 
            });
        }
        
        if (!REALISTIC_TRADE_AMOUNTS.hasOwnProperty(token.toUpperCase())) {
            return res.status(400).json({ 
                success: false, 
                error: `Token ${token} not found. Available tokens: ${Object.keys(REALISTIC_TRADE_AMOUNTS).join(', ')}` 
            });
        }
        
        const numAmount = parseFloat(amount);
        if (isNaN(numAmount) || numAmount <= 0) {
            return res.status(400).json({ 
                success: false, 
                error: "Amount must be a positive number" 
            });
        }
        
        updateTradeAmount(token.toUpperCase(), numAmount);
        
        res.json({ 
            success: true, 
            message: `Updated ${token.toUpperCase()} trade amount to ${numAmount}`,
            newAmount: REALISTIC_TRADE_AMOUNTS[token.toUpperCase()]
        });
        
    } catch (error) {
        res.status(500).json({ 
            success: false, 
            error: error.message 
        });
    }
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

// Arbitrage execution planning endpoint
app.post('/api/plan-arbitrage', (req, res) => {
    try {
        const { token, direction, tokenAmount, corePrice, evmPrice, priceDifference } = req.body;
        
        if (!token || !direction || !tokenAmount || !corePrice || !evmPrice) {
            return res.status(400).json({ 
                success: false, 
                error: "Missing required parameters" 
            });
        }
        
        // Generate arbitrage execution plan
        const plan = generateArbitragePlan(token, direction, tokenAmount, corePrice, evmPrice, priceDifference);
        
        res.json({ 
            success: true, 
            plan: plan
        });
        
    } catch (error) {
        res.status(500).json({ 
            success: false, 
            error: error.message 
        });
    }
});

// Execute arbitrage endpoint (placeholder for now)
app.post('/api/execute-arbitrage', (req, res) => {
    try {
        const { token, direction, plan } = req.body;
        
        if (!token || !direction || !plan) {
            return res.status(400).json({ 
                success: false, 
                error: "Missing required parameters" 
            });
        }
        
        // For now, just return a simulation message
        // Later this will call bridge.py functions
        res.json({ 
            success: true, 
            message: "Arbitrage execution will be implemented next",
            execution: {
                status: "simulated",
                steps: plan.steps.map(step => ({...step, status: "pending"}))
            }
        });
        
    } catch (error) {
        res.status(500).json({ 
            success: false, 
            error: error.message 
        });
    }
});

function generateArbitragePlan(token, direction, tokenAmount, corePrice, evmPrice, priceDifference) {
    const steps = [];
    
    // Determine which chain has better price and execute round-trip arbitrage
    // Always start and end on the same chain to maintain HYPE balance
    
    if (direction === "EVM → Core") {
        // Token is cheaper on EVM, more expensive on Core
        // Strategy: Buy on EVM → Bridge to Core → Sell on Core → Bridge HYPE back to EVM
        
        const startingHype = Math.ceil(evmPrice);
        const expectedCoreHype = Math.floor(corePrice);
        
        steps.push({
            step: 1,
            action: "swap_evm_buy",
            description: `[EVM] Buy ${tokenAmount.toLocaleString()} ${token} with ${startingHype} HYPE`,
            chain: "HyperEVM",
            type: "swap",
            from: "HYPE",
            to: token,
            amount: startingHype,
            expected: tokenAmount,
            startChain: true
        });
        
        steps.push({
            step: 2,
            action: "bridge_token_to_core",
            description: `[Bridge] Transfer ${tokenAmount.toLocaleString()} ${token}: EVM → Core`,
            chain: "Bridge",
            type: "bridge",
            token: token,
            amount: tokenAmount,
            direction: "evm_to_core"
        });
        
        steps.push({
            step: 3,
            action: "spot_sell_core",
            description: `[Core] Sell ${tokenAmount.toLocaleString()} ${token} for ${expectedCoreHype} HYPE`,
            chain: "HyperCore",
            type: "spot_trade",
            side: "sell",
            token: token,
            amount: tokenAmount,
            expected: expectedCoreHype
        });
        
        steps.push({
            step: 4,
            action: "bridge_hype_back_to_evm",
            description: `[Bridge] Transfer ${expectedCoreHype} HYPE: Core → EVM (Return to start)`,
            chain: "Bridge",
            type: "bridge",
            token: "HYPE",
            amount: expectedCoreHype,
            direction: "core_to_evm",
            endChain: true
        });
        
        return {
            token: token,
            direction: direction,
            tokenAmount: tokenAmount,
            startChain: "HyperEVM",
            endChain: "HyperEVM",
            steps: steps,
            summary: {
                totalCost: startingHype,
                totalReturn: expectedCoreHype,
                estimatedProfit: expectedCoreHype - startingHype,
                profitPercent: (((expectedCoreHype - startingHype) / startingHype) * 100).toFixed(2),
                isProfitable: expectedCoreHype > startingHype
            },
            risks: [
                "Price slippage during swaps",
                "Bridge transfer delays (5-10 minutes each)",
                "Gas costs on HyperEVM swaps",
                "Market movement during execution",
                "Spot trading slippage on HyperCore"
            ]
        };
        
    } else if (direction === "Core → EVM") {
        // Token is cheaper on Core, more expensive on EVM
        // Strategy: Bridge HYPE to Core → Buy on Core → Bridge to EVM → Sell on EVM
        
        const startingHype = Math.ceil(corePrice);
        const expectedEvmHype = Math.floor(evmPrice);
        
        steps.push({
            step: 1,
            action: "bridge_hype_to_core",
            description: `[Bridge] Transfer ${startingHype} HYPE: EVM → Core`,
            chain: "Bridge",
            type: "bridge",
            token: "HYPE",
            amount: startingHype,
            direction: "evm_to_core",
            startChain: true
        });
        
        steps.push({
            step: 2,
            action: "spot_buy_core",
            description: `[Core] Buy ${tokenAmount.toLocaleString()} ${token} with ${startingHype} HYPE`,
            chain: "HyperCore",
            type: "spot_trade",
            side: "buy",
            token: token,
            amount: tokenAmount,
            cost: startingHype
        });
        
        steps.push({
            step: 3,
            action: "bridge_token_to_evm",
            description: `[Bridge] Transfer ${tokenAmount.toLocaleString()} ${token}: Core → EVM`,
            chain: "Bridge",
            type: "bridge",
            token: token,
            amount: tokenAmount,
            direction: "core_to_evm"
        });
        
        steps.push({
            step: 4,
            action: "swap_evm_sell",
            description: `[EVM] Sell ${tokenAmount.toLocaleString()} ${token} for ${expectedEvmHype} HYPE (Return to start)`,
            chain: "HyperEVM",
            type: "swap",
            from: token,
            to: "HYPE",
            amount: tokenAmount,
            expected: expectedEvmHype,
            endChain: true
        });
        
        return {
            token: token,
            direction: direction,
            tokenAmount: tokenAmount,
            startChain: "HyperEVM",
            endChain: "HyperEVM",
            steps: steps,
            summary: {
                totalCost: startingHype,
                totalReturn: expectedEvmHype,
                estimatedProfit: expectedEvmHype - startingHype,
                profitPercent: (((expectedEvmHype - startingHype) / startingHype) * 100).toFixed(2),
                isProfitable: expectedEvmHype > startingHype
            },
            risks: [
                "Price slippage during swaps",
                "Bridge transfer delays (5-10 minutes each)",
                "Gas costs on HyperEVM swaps",
                "Market movement during execution",
                "Spot trading slippage on HyperCore"
            ]
        };
    }
    
    // Alternative: Start from Core chain
    else if (direction === "Core → EVM (Start Core)") {
        // Start with HYPE on Core, end with HYPE on Core
        const startingHype = Math.ceil(corePrice);
        const expectedEvmHype = Math.floor(evmPrice);
        
        steps.push({
            step: 1,
            action: "spot_buy_core",
            description: `[Core] Buy ${tokenAmount.toLocaleString()} ${token} with ${startingHype} HYPE`,
            chain: "HyperCore",
            type: "spot_trade",
            side: "buy",
            token: token,
            amount: tokenAmount,
            cost: startingHype,
            startChain: true
        });
        
        steps.push({
            step: 2,
            action: "bridge_token_to_evm",
            description: `[Bridge] Transfer ${tokenAmount.toLocaleString()} ${token}: Core → EVM`,
            chain: "Bridge",
            type: "bridge",
            token: token,
            amount: tokenAmount,
            direction: "core_to_evm"
        });
        
        steps.push({
            step: 3,
            action: "swap_evm_sell",
            description: `[EVM] Sell ${tokenAmount.toLocaleString()} ${token} for ${expectedEvmHype} HYPE`,
            chain: "HyperEVM",
            type: "swap",
            from: token,
            to: "HYPE",
            amount: tokenAmount,
            expected: expectedEvmHype
        });
        
        steps.push({
            step: 4,
            action: "bridge_hype_back_to_core",
            description: `[Bridge] Transfer ${expectedEvmHype} HYPE: EVM → Core (Return to start)`,
            chain: "Bridge",
            type: "bridge",
            token: "HYPE",
            amount: expectedEvmHype,
            direction: "evm_to_core",
            endChain: true
        });
        
        return {
            token: token,
            direction: direction,
            tokenAmount: tokenAmount,
            startChain: "HyperCore",
            endChain: "HyperCore",
            steps: steps,
            summary: {
                totalCost: startingHype,
                totalReturn: expectedEvmHype,
                estimatedProfit: expectedEvmHype - startingHype,
                profitPercent: (((expectedEvmHype - startingHype) / startingHype) * 100).toFixed(2),
                isProfitable: expectedEvmHype > startingHype
            },
            risks: [
                "Price slippage during swaps",
                "Bridge transfer delays (5-10 minutes each)",
                "Gas costs on HyperEVM swaps",
                "Market movement during execution",
                "Spot trading slippage on HyperCore"
            ]
        };
    }
    
    // Default fallback
    return {
        token: token,
        direction: direction,
        tokenAmount: tokenAmount,
        startChain: "Unknown",
        endChain: "Unknown",
        steps: [],
        summary: {
            totalCost: 0,
            totalReturn: 0,
            estimatedProfit: 0,
            profitPercent: "0.00",
            isProfitable: false
        },
        risks: ["Invalid direction specified"]
    };
}

// Start server
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`📊 WebSocket endpoint: ws://localhost:${PORT}`);
    console.log(`🔗 REST API: http://localhost:${PORT}/api/prices`);
    console.log(`🔄 Manual refresh: POST http://localhost:${PORT}/api/refresh`);
    console.log(`⚡ Immediate update: POST http://localhost:${PORT}/api/update-now`);
    console.log(`📈 Trade amounts: GET http://localhost:${PORT}/api/trade-amounts`);
    console.log(`⚙️  Update amounts: POST http://localhost:${PORT}/api/trade-amounts`);
    console.log(`🎯 Plan arbitrage: POST http://localhost:${PORT}/api/plan-arbitrage`);
    console.log(`⚡ Execute arbitrage: POST http://localhost:${PORT}/api/execute-arbitrage`);
    console.log(`\n💡 Example: Update BUDDY trade amount to 15000:`);
    console.log(`   curl -X POST http://localhost:${PORT}/api/trade-amounts -H "Content-Type: application/json" -d '{"token":"BUDDY","amount":15000}'`);
    
    // Start update loop
    updateLoop();
});
