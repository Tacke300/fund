import https from 'https';
import crypto from 'crypto';
import express from 'express';
import { exec } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv'; // For secure environment variable loading
import winston from 'winston'; // For advanced logging
import WebSocket from 'ws'; // For real-time log streaming to UI

// --- INITIALIZATION AND CONFIGURATION ---

// Load environment variables from .env file
dotenv.config();

// Get __filename and __dirname in ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- SECURE API KEY AND SECRET KEY LOADING ---
// It's highly recommended to load these from environment variables
// or a secure configuration management system, NOT directly in code.
const API_KEY = process.env.BINANCE_API_KEY || '';
const SECRET_KEY = process.env.BINANCE_SECRET_KEY || '';

// --- BINANCE FUTURES API BASE URL ---
const BASE_HOST = 'fapi.binance.com';

// --- GLOBAL STATE VARIABLES ---
let serverTimeOffset = 0; // Time offset to synchronize with Binance server
let exchangeInfoCache = null; // Cache for exchangeInfo to avoid redundant API calls
let isClosingPosition = false; // Flag to prevent multiple close orders concurrently
let botRunning = false; // Bot operational status flag
let botStartTime = null; // Timestamp when bot started
let currentOpenPosition = null; // Tracks the current open position
let positionCheckInterval = null; // setInterval for periodic position checks
let nextScheduledCycleTimeout = null; // setTimeout for the next main trading cycle (runTradingLogic)
let retryBotTimeout = null; // setTimeout for automatic bot restart after critical errors

// --- ERROR MANAGEMENT & LOGGING FREQUENCY CONTROL ---
let consecutiveApiErrors = 0; // Counts consecutive API errors
const MAX_CONSECUTIVE_API_ERRORS = 5; // Max consecutive API errors before pausing bot
const CRITICAL_ERROR_RETRY_DELAY_MS = 60 * 1000; // Delay (ms) before bot attempts restart after critical errors (e.g., 1 minute)

// Custom Error class for critical API errors
class CriticalApiError extends Error {
    constructor(message, originalError = null) {
        super(message);
        this.name = 'CriticalApiError';
        this.originalError = originalError;
    }
}

// --- BOT CONFIGURATION PARAMETERS (DEFAULT VALUES) ---
// These should ideally be configurable via environment variables or a config file
// and updated via the UI.
let INITIAL_INVESTMENT_AMOUNT = parseFloat(process.env.INITIAL_INVESTMENT_AMOUNT || '1'); // Default 1 USDT
let TARGET_COIN_SYMBOL = process.env.TARGET_COIN_SYMBOL || 'ETHUSDT'; // Default ETHUSDT
let APPLY_DOUBLE_STRATEGY = process.env.APPLY_DOUBLE_STRATEGY === 'true'; // Default false

// Take Profit & Stop Loss Configuration
const TAKE_PROFIT_PERCENTAGE_MAIN = parseFloat(process.env.TAKE_PROFIT_PERCENTAGE_MAIN || '0.60'); // 60% profit on capital
const STOP_LOSS_PERCENTAGE_MAIN = parseFloat(process.env.STOP_LOSS_PERCENTAGE_MAIN || '0.175'); // 17.5% loss on capital

// Maximum consecutive losses before resetting to initial capital
const MAX_CONSECUTIVE_LOSSES = parseInt(process.env.MAX_CONSECUTIVE_LOSSES || '5');

// Variables for managing current trading state
let currentInvestmentAmount = INITIAL_INVESTMENT_AMOUNT;
let consecutiveLossCount = 0;
let nextTradeDirection = 'SHORT'; // Initial trade direction

// --- WEB SERVER AND PM2 LOG CONFIGURATION ---
const WEB_SERVER_PORT = parseInt(process.env.WEB_SERVER_PORT || '1997');
const BOT_LOG_FILE = process.env.BOT_LOG_FILE || path.join(__dirname, 'bot_activity.log'); // Using a local log file by default for simplicity
const THIS_BOT_PM2_NAME = process.env.PM2_BOT_NAME || 'binance-futures-bot'; // Must match PM2 process name

// --- WEBSOCKET SERVER FOR REAL-TIME LOGS ---
const wsServer = new WebSocket.Server({ noServer: true }); // Initialize without a server, attach later

wsServer.on('connection', ws => {
    logger.info('WebSocket client connected.');
    ws.on('close', () => logger.info('WebSocket client disconnected.'));
    ws.on('error', error => logger.error('WebSocket error:', error));
});

// --- ADVANCED LOGGING (WINSTON) ---
const logger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(
        winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
        winston.format.printf(info => `[${info.timestamp}] [${info.level.toUpperCase()}] ${info.message}`)
    ),
    transports: [
        new winston.transports.Console(),
        new winston.transports.File({
            filename: BOT_LOG_FILE,
            maxsize: 10 * 1024 * 1024, // 10MB
            maxFiles: 5,
            tailable: true // Start from the end of the file
        })
    ],
    exceptionHandlers: [
        new winston.transports.File({ filename: path.join(__dirname, 'exceptions.log') })
    ],
    rejectionHandlers: [
        new winston.transports.File({ filename: path.join(__dirname, 'rejections.log') })
    ]
});

// Stream logs to WebSocket clients
const originalLog = logger.info;
logger.info = function (message, ...args) {
    originalLog.apply(this, [message, ...args]);
    wsServer.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(`[${new Date().toLocaleTimeString('en-US', { hour12: false })}.${String(new Date().getMilliseconds()).padStart(3, '0')}] ${message}`);
        }
    });
};

// --- UTILITY FUNCTIONS ---

/**
 * Formats a Date object to a string in UTC+7 (Asia/Ho_Chi_Minh) timezone.
 * @param {Date} dateObject - The Date object to format.
 * @returns {string} Formatted time string.
 */
function formatTimeUTC7(dateObject) {
    const formatter = new Intl.DateTimeFormat('en-GB', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        fractionalSecondDigits: 3,
        hour12: false,
        timeZone: 'Asia/Ho_Chi_Minh'
    });
    return formatter.format(dateObject);
}

/**
 * Creates an HMAC SHA256 signature for Binance API requests.
 * @param {string} queryString - The query string to sign.
 * @param {string} apiSecret - Your Binance API Secret Key.
 * @returns {string} The HMAC SHA256 signature.
 */
function createSignature(queryString, apiSecret) {
    return crypto.createHmac('sha256', apiSecret)
        .update(queryString)
        .digest('hex');
}

/**
 * Makes a generic HTTP request.
 * @param {string} method - HTTP method (GET, POST, DELETE).
 * @param {string} hostname - The hostname (e.g., 'fapi.binance.com').
 * @param {string} path - The request path (e.g., '/fapi/v1/time').
 * @param {object} headers - HTTP headers.
 * @param {string} [postData=''] - Data for POST requests.
 * @returns {Promise<string>} Raw response data.
 * @throws {object} HTTP error details or network error.
 */
async function makeHttpRequest(method, hostname, path, headers, postData = '') {
    return new Promise((resolve, reject) => {
        const options = { hostname, path, method, headers };

        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    resolve(data);
                } else {
                    let errorDetails = { code: res.statusCode, msg: `HTTP Error: ${res.statusCode} ${res.statusMessage}` };
                    try {
                        const parsedData = JSON.parse(data);
                        errorDetails = { ...errorDetails, ...parsedData };
                    } catch (e) {
                        errorDetails.msg += ` - Raw: ${data.substring(0, Math.min(data.length, 200))}`;
                    }
                    logger.error(`HTTP Request failed: ${errorDetails.msg}`);
                    reject(errorDetails);
                }
            });
        });

        req.on('error', (e) => {
            logger.error(`Network error: ${e.message}`);
            reject({ code: 'NETWORK_ERROR', msg: e.message });
        });

        if (method === 'POST' && postData) {
            req.write(postData);
        }
        req.end();
    });
}

/**
 * Calls a signed Binance API endpoint (requires API Key and Secret).
 * Handles timestamp synchronization and error logging.
 * @param {string} fullEndpointPath - The API endpoint path.
 * @param {string} [method='GET'] - HTTP method.
 * @param {object} [params={}] - Query parameters.
 * @returns {Promise<object>} Parsed JSON response.
 * @throws {CriticalApiError} If API Key/Secret are not configured or on consecutive critical errors.
 * @throws {object} Other API errors.
 */
async function callSignedAPI(fullEndpointPath, method = 'GET', params = {}) {
    if (!API_KEY || !SECRET_KEY) {
        throw new CriticalApiError("API Key or Secret Key is not configured. Please set them in .env.");
    }
    const recvWindow = 5000;
    const timestamp = Date.now() + serverTimeOffset;

    let queryString = Object.keys(params)
        .map(key => `${key}=${params[key]}`)
        .join('&');

    queryString += (queryString ? '&' : '') + `timestamp=${timestamp}&recvWindow=${recvWindow}`;

    const signature = createSignature(queryString, SECRET_KEY);

    let requestPath;
    let requestBody = '';
    const headers = { 'X-MBX-APIKEY': API_KEY };

    if (method === 'GET' || method === 'DELETE') {
        requestPath = `${fullEndpointPath}?${queryString}&signature=${signature}`;
        headers['Content-Type'] = 'application/json';
    } else if (method === 'POST') {
        requestPath = fullEndpointPath;
        requestBody = `${queryString}&signature=${signature}`;
        headers['Content-Type'] = 'application/x-www-form-urlencoded';
    } else {
        throw new Error(`Unsupported method: ${method}`);
    }

    try {
        const rawData = await makeHttpRequest(method, BASE_HOST, requestPath, headers, requestBody);
        consecutiveApiErrors = 0; // Reset error count on success
        return JSON.parse(rawData);
    } catch (error) {
        consecutiveApiErrors++;
        logger.error(`Binance Signed API error (${fullEndpointPath}): ${error.code || 'UNKNOWN'} - ${error.msg || error.message}`);
        if (error.code === -2015) {
            logger.error("  -> Check API Key/Secret and Futures permissions.");
        } else if (error.code === -1021) {
            logger.error("  -> Timestamp error. Synchronize system clock.");
        } else if (error.code === -1022) {
            logger.error("  -> Signature error. Check API Key/Secret or parameter string.");
        } else if (error.code === 404) {
            logger.error("  -> 404 Error. Incorrect API path.");
        } else if (error.code === 'NETWORK_ERROR') {
            logger.error("  -> Network error.");
        }

        if (consecutiveApiErrors >= MAX_CONSECUTIVE_API_ERRORS) {
            logger.error(`Critical: Consecutive API errors (${consecutiveApiErrors}). Stopping bot.`);
            throw new CriticalApiError("Critical API error, bot stopping.", error);
        }
        throw error; // Re-throw to propagate for specific handling
    }
}

/**
 * Calls a public Binance API endpoint (does not require signature).
 * @param {string} fullEndpointPath - The API endpoint path.
 * @param {object} [params={}] - Query parameters.
 * @returns {Promise<object>} Parsed JSON response.
 * @throws {CriticalApiError} On consecutive critical errors.
 * @throws {object} Other API errors.
 */
async function callPublicAPI(fullEndpointPath, params = {}) {
    const queryString = Object.keys(params)
        .map(key => `${key}=${params[key]}`)
        .join('&');
    const fullPathWithQuery = `${fullEndpointPath}` + (queryString ? `?${queryString}` : '');

    const headers = { 'Content-Type': 'application/json' };

    try {
        const rawData = await makeHttpRequest('GET', BASE_HOST, fullPathWithQuery, headers);
        consecutiveApiErrors = 0; // Reset error count on success
        return JSON.parse(rawData);
    } catch (error) {
        consecutiveApiErrors++;
        logger.error(`Binance Public API error (${fullEndpointPath}): ${error.code || 'UNKNOWN'} - ${error.msg || error.message}`);
        if (error.code === 404) {
            logger.error("  -> 404 Error. Incorrect API path.");
        } else if (error.code === 'NETWORK_ERROR') {
            logger.error("  -> Network error.");
        }
        if (consecutiveApiErrors >= MAX_CONSECUTIVE_API_ERRORS) {
            logger.error(`Critical: Consecutive API errors (${consecutiveApiErrors}). Stopping bot.`);
            throw new CriticalApiError("Critical API error, bot stopping.", error);
        }
        throw error;
    }
}

/**
 * Synchronizes local time with Binance server time.
 * @returns {Promise<void>}
 * @throws {Error} If time synchronization fails.
 */
async function syncServerTime() {
    try {
        const data = await callPublicAPI('/fapi/v1/time');
        const binanceServerTime = data.serverTime;
        const localTime = Date.now();
        serverTimeOffset = binanceServerTime - localTime;
        logger.info(`Time synchronized. Offset: ${serverTimeOffset} ms.`);
    } catch (error) {
        logger.error(`Failed to synchronize time: ${error.message}. Setting offset to 0.`);
        serverTimeOffset = 0; // Reset offset to avoid compounding issues
        throw error; // Re-throw to indicate a problem at startup
    }
}

/**
 * Retrieves the maximum leverage for a given symbol.
 * @param {string} symbol - The trading pair symbol (e.g., 'ETHUSDT').
 * @returns {Promise<number|null>} Max leverage as a number, or null if not found/error.
 */
async function getLeverageBracketForSymbol(symbol) {
    try {
        const response = await callSignedAPI('/fapi/v1/leverageBracket', 'GET', { symbol: symbol });
        if (response && Array.isArray(response) && response.length > 0) {
            const symbolData = response.find(item => item.symbol === symbol);
            if (symbolData && symbolData.brackets && Array.isArray(symbolData.brackets) && symbolData.brackets.length > 0) {
                // Return the maxInitialLeverage from the first bracket, or initialLeverage if max isn't specified
                return parseInt(symbolData.brackets[0].maxInitialLeverage || symbolData.brackets[0].initialLeverage);
            }
        }
        logger.warn(`No valid leverage bracket found for ${symbol}.`);
        return null;
    } catch (error) {
        logger.error(`Error getting leverage for ${symbol}: ${error.msg || error.message}`);
        return null;
    }
}

/**
 * Sets the leverage for a given symbol.
 * @param {string} symbol - The trading pair symbol.
 * @param {number} leverage - The desired leverage.
 * @returns {Promise<boolean>} True if successful, false otherwise.
 */
async function setLeverage(symbol, leverage) {
    try {
        logger.info(`Setting leverage to ${leverage}x for ${symbol}.`);
        await callSignedAPI('/fapi/v1/leverage', 'POST', { symbol, leverage });
        logger.info(`Successfully set leverage to ${leverage}x for ${symbol}.`);
        return true;
    } catch (error) {
        logger.error(`Failed to set leverage ${leverage}x for ${symbol}: ${error.msg || error.message}`);
        return false;
    }
}

/**
 * Fetches and caches exchange information (filters, precision).
 * @returns {Promise<object|null>} Cached exchange info or null on failure.
 */
async function getExchangeInfo() {
    if (exchangeInfoCache) {
        return exchangeInfoCache;
    }

    logger.info('Fetching exchangeInfo...');
    try {
        const data = await callPublicAPI('/fapi/v1/exchangeInfo');
        logger.info(`Received exchangeInfo. Symbols: ${data.symbols.length}`);

        const newCache = {};
        data.symbols.forEach(s => {
            const lotSizeFilter = s.filters.find(f => f.filterType === 'LOT_SIZE');
            const marketLotSizeFilter = s.filters.find(f => f.filterType === 'MARKET_LOT_SIZE');
            const minNotionalFilter = s.filters.find(f => f.filterType === 'MIN_NOTIONAL');
            const priceFilter = s.filters.find(f => f.filterType === 'PRICE_FILTER');

            newCache[s.symbol] = {
                minQty: lotSizeFilter ? parseFloat(lotSizeFilter.minQty) : (marketLotSizeFilter ? parseFloat(marketLotSizeFilter.minQty) : 0),
                stepSize: lotSizeFilter ? parseFloat(lotSizeFilter.stepSize) : (marketLotSizeFilter ? parseFloat(marketLotSizeFilter.stepSize) : 0.001),
                minNotional: minNotionalFilter ? parseFloat(minNotionalFilter.notional) : 0,
                pricePrecision: s.pricePrecision,
                quantityPrecision: s.quantityPrecision,
                tickSize: priceFilter ? parseFloat(priceFilter.tickSize) : 0.001
            };
        });
        exchangeInfoCache = newCache; // Update cache only on successful fetch
        logger.info('Exchange information loaded and cached.');
        return exchangeInfoCache;
    } catch (error) {
        logger.error('Error fetching exchangeInfo: ' + (error.msg || error.message));
        exchangeInfoCache = null; // Clear cache on error
        throw error;
    }
}

/**
 * Combines all relevant symbol details (filters and max leverage).
 * @param {string} symbol - The trading pair symbol.
 * @returns {Promise<object|null>} Object containing symbol details, or null if not found/error.
 */
async function getSymbolDetails(symbol) {
    const filters = await getExchangeInfo();
    if (!filters || !filters[symbol]) {
        logger.warn(`No filters found for ${symbol}.`);
        return null;
    }
    const maxLeverage = await getLeverageBracketForSymbol(symbol);
    if (maxLeverage === null) {
        logger.warn(`Could not determine max leverage for ${symbol}.`);
        return null; // Return null if max leverage can't be fetched
    }
    return { ...filters[symbol], maxLeverage: maxLeverage };
}

/**
 * Gets the current market price of a symbol.
 * @param {string} symbol - The trading pair symbol.
 * @returns {Promise<number|null>} Current price as a number, or null on error.
 */
async function getCurrentPrice(symbol) {
    try {
        const data = await callPublicAPI('/fapi/v1/ticker/price', { symbol });
        return parseFloat(data.price);
    } catch (error) {
        if (error instanceof CriticalApiError) {
            logger.critical(`Critical error getting price for ${symbol}: ${error.msg || error.message}`);
        } else {
            logger.error(`Error getting price for ${symbol}: ${error.msg || error.message}`);
        }
        return null;
    }
}

/**
 * Cancels all open orders for a specific symbol.
 * @param {string} symbol - The trading pair symbol.
 */
async function cancelOpenOrdersForSymbol(symbol) {
    try {
        logger.info(`Cancelling all open orders for ${symbol}...`);
        await callSignedAPI('/fapi/v1/allOpenOrders', 'DELETE', { symbol });
        logger.info(`Successfully cancelled open orders for ${symbol}.`);
    } catch (error) {
        if (error.code === -2011) { // No orders to cancel
            logger.info(`No open orders to cancel for ${symbol}.`);
        } else {
            logger.error(`Error cancelling open orders for ${symbol}: ${error.msg || error.message}`);
        }
    }
}

/**
 * Closes the current open position.
 * Handles the logic for resetting capital, consecutive losses, and next trade direction.
 * @param {string} symbol - The trading pair symbol.
 * @param {number} quantityToClose - The quantity to attempt to close.
 * @param {string} reason - The reason for closing the position (e.g., 'TP', 'SL', 'Manual').
 */
async function closePosition(symbol, quantityToClose, reason) {
    if (isClosingPosition) {
        logger.warn(`Already in the process of closing a position. Skipping new close request for ${symbol}.`);
        return;
    }
    isClosingPosition = true; // Set flag to prevent re-entry

    // Capture position side BEFORE currentOpenPosition is reset
    const positionSideBeforeClose = currentOpenPosition?.side;

    logger.info(`Closing ${positionSideBeforeClose || 'UNKNOWN'} position for ${symbol} (Reason: ${reason}). Quantity: ${quantityToClose}.`);

    try {
        const symbolInfo = await getSymbolDetails(symbol);
        if (!symbolInfo) {
            logger.error(`Failed to get symbol info for ${symbol}. Cannot close position gracefully.`);
            return; // Cannot proceed without symbol info
        }
        const quantityPrecision = symbolInfo.quantityPrecision;

        const positions = await callSignedAPI('/fapi/v2/positionRisk', 'GET');
        const currentPositionOnBinance = positions.find(p => p.symbol === symbol && parseFloat(p.positionAmt) !== 0);

        if (!currentPositionOnBinance || parseFloat(currentPositionOnBinance.positionAmt) === 0) {
            logger.info(`Position for ${symbol} is already closed on exchange or no position found. Reason: ${reason}.`);
        } else {
            const actualPositionAmount = parseFloat(currentPositionOnBinance.positionAmt);
            const actualQuantityToClose = Math.abs(actualPositionAmount);
            const adjustedActualQuantity = parseFloat(actualQuantityToClose.toFixed(quantityPrecision));

            // Determine 'side' to close the current position
            const closeSide = (actualPositionAmount < 0) ? 'BUY' : 'SELL'; // BUY to close SHORT, SELL to close LONG

            logger.info(`Sending MARKET order to close ${positionSideBeforeClose}: Symbol: ${symbol}, Side: ${closeSide}, Qty: ${adjustedActualQuantity}`);

            await callSignedAPI('/fapi/v1/order', 'POST', {
                symbol,
                side: closeSide,
                type: 'MARKET',
                quantity: adjustedActualQuantity,
                reduceOnly: 'true'
            });
            logger.info(`Successfully sent MARKET order to close ${positionSideBeforeClose} position for ${symbol}. Reason: ${reason}.`);
        }

        // --- Logic for capital/loss streak reset and next trade direction ---
        if (reason.includes('TP')) {
            consecutiveLossCount = 0; // Reset consecutive losses on TP
            currentInvestmentAmount = INITIAL_INVESTMENT_AMOUNT; // Reset capital to initial
            nextTradeDirection = positionSideBeforeClose; // Keep same direction after TP
            logger.info(`TP hit. Resetting capital to ${currentInvestmentAmount} USDT, consecutive losses to 0. Next trade: ${nextTradeDirection}.`);
        } else if (reason.includes('SL') || reason.includes('Timeout') || reason.includes('Vị thế sót')) { // Added 'Vị thế sót' for proper handling of leftover positions
            if (APPLY_DOUBLE_STRATEGY) {
                consecutiveLossCount++; // Increment consecutive losses
                logger.info(`SL hit or timeout. Consecutive losses: ${consecutiveLossCount}.`);
                if (consecutiveLossCount >= MAX_CONSECUTIVE_LOSSES) {
                    currentInvestmentAmount = INITIAL_INVESTMENT_AMOUNT; // Reset capital after max losses
                    consecutiveLossCount = 0;
                    logger.info(`Max consecutive losses (${MAX_CONSECUTIVE_LOSSES}) reached. Resetting capital to ${currentInvestmentAmount} USDT and losses to 0.`);
                } else {
                    currentInvestmentAmount *= 2; // Double capital for next trade
                    logger.info(`Doubling capital for next trade: ${currentInvestmentAmount} USDT.`);
                }
            } else {
                logger.info(`SL hit or timeout. Double strategy not applied.`);
                currentInvestmentAmount = INITIAL_INVESTMENT_AMOUNT; // Reset capital to initial
                consecutiveLossCount = 0; // Reset losses
            }
            // Reverse trade direction
            nextTradeDirection = (positionSideBeforeClose === 'LONG' ? 'SHORT' : 'LONG');
            logger.info(`Next trade: ${nextTradeDirection}.`);
        } else {
            // Other reasons (e.g., manual close, unknown error)
            // Assume a state reset is needed for safety
            currentInvestmentAmount = INITIAL_INVESTMENT_AMOUNT;
            consecutiveLossCount = 0;
            nextTradeDirection = (positionSideBeforeClose === 'LONG' ? 'SHORT' : 'LONG'); // Still reverse direction
            logger.warn(`Position closed due to special reason (${reason}). Resetting capital to ${currentInvestmentAmount} USDT and losses to 0. Next trade: ${nextTradeDirection}.`);
        }
        // --- End of logic handling ---

        currentOpenPosition = null; // Clear local tracking of open position
        if (positionCheckInterval) {
            clearInterval(positionCheckInterval);
            positionCheckInterval = null;
        }
        await cancelOpenOrdersForSymbol(symbol); // Cancel any remaining TP/SL orders
        await checkAndHandleRemainingPosition(symbol); // Double-check for any leftover position
        if (botRunning) scheduleNextMainCycle(); // Trigger next cycle to potentially open new trade
    } catch (error) {
        logger.error(`Error closing position for ${symbol}: ${error.msg || error.message}`);
    } finally {
        isClosingPosition = false; // Reset flag
    }
}

/**
 * Checks for and attempts to close any remaining partial positions.
 * @param {string} symbol - The trading pair symbol.
 */
async function checkAndHandleRemainingPosition(symbol) {
    logger.info(`Checking for any remaining position for ${symbol}...`);
    try {
        const positions = await callSignedAPI('/fapi/v2/positionRisk', 'GET');
        const remainingPosition = positions.find(p => p.symbol === symbol && parseFloat(p.positionAmt) !== 0);

        if (remainingPosition && Math.abs(parseFloat(remainingPosition.positionAmt)) > 0) {
            const currentPositionAmount = parseFloat(remainingPosition.positionAmt);
            const currentPrice = await getCurrentPrice(symbol);
            const positionSide = currentPositionAmount > 0 ? 'LONG' : 'SHORT';

            logger.warn(`Remaining position for ${symbol}: ${currentPositionAmount} (${positionSide}) @ ${currentPrice}. Attempting to close it.`);

            // Temporarily set currentOpenPosition to allow closePosition to work
            currentOpenPosition = {
                symbol: symbol,
                quantity: Math.abs(currentPositionAmount),
                entryPrice: parseFloat(remainingPosition.entryPrice),
                initialTPPrice: 0, // Placeholder
                initialSLPrice: 0, // Placeholder
                initialMargin: 0, // Placeholder
                openTime: new Date(parseFloat(remainingPosition.updateTime)),
                pricePrecision: (exchangeInfoCache[symbol] ? exchangeInfoCache[symbol].pricePrecision : 8),
                side: positionSide,
                tickSize: (exchangeInfoCache[symbol] ? exchangeInfoCache[symbol].tickSize : 0.001)
            };
            await closePosition(symbol, Math.abs(currentPositionAmount), 'Vị thế sót');
        } else {
            logger.info(`Confirmed no remaining position for ${symbol}.`);
        }
    } catch (error) {
        logger.error(`Error checking for remaining position for ${symbol}: ${error.code} - ${error.msg || error.message}.`);
    }
}

/**
 * Sleeps for a given number of milliseconds.
 * @param {number} ms - The number of milliseconds to sleep.
 * @returns {Promise<void>}
 */
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Opens a Long or Short position.
 * @param {string} symbol - The trading pair symbol.
 * @param {string} tradeDirection - 'LONG' or 'SHORT'.
 * @param {number} usdtBalance - Available USDT balance.
 * @param {number} maxLeverage - Maximum allowed leverage for the symbol.
 */
async function openPosition(symbol, tradeDirection, usdtBalance, maxLeverage) {
    if (currentOpenPosition) {
        logger.warn(`Already have an open position (${currentOpenPosition.symbol}). Skipping new order for ${symbol}.`);
        if (botRunning) scheduleNextMainCycle();
        return;
    }

    logger.info(`Attempting to open ${tradeDirection} position for ${symbol}.`);
    logger.info(`Initial capital for this trade: ${currentInvestmentAmount} USDT.`);

    try {
        const symbolDetails = await getSymbolDetails(symbol);
        if (!symbolDetails) {
            logger.error(`Failed to get symbol details for ${symbol}. Cannot open position.`);
            if (botRunning) scheduleNextMainCycle();
            return;
        }

        const leverageSetSuccess = await setLeverage(symbol, maxLeverage);
        if (!leverageSetSuccess) {
            logger.error(`Failed to set ${maxLeverage}x leverage for ${symbol}. Cancelling order.`);
            if (botRunning) scheduleNextMainCycle();
            return;
        }

        const { pricePrecision, quantityPrecision, minNotional, minQty, stepSize, tickSize } = symbolDetails;

        const currentPrice = await getCurrentPrice(symbol);
        if (!currentPrice) {
            logger.error(`Failed to get current price for ${symbol}. Cannot open position.`);
            if (botRunning) scheduleNextMainCycle();
            return;
        }
        logger.info(`Current price of ${symbol} at order submission: ${currentPrice.toFixed(pricePrecision)}`);

        const capitalToUse = currentInvestmentAmount;

        if (usdtBalance < capitalToUse) {
            logger.warn(`Insufficient USDT balance (${usdtBalance.toFixed(2)}) to open trade (${capitalToUse.toFixed(2)}). Resetting to initial capital.`);
            currentInvestmentAmount = INITIAL_INVESTMENT_AMOUNT;
            consecutiveLossCount = 0;
            logger.info(`Balance insufficient. Reset capital to ${currentInvestmentAmount} USDT, losses to 0. Next trade direction: ${nextTradeDirection}.`);
            if (botRunning) scheduleNextMainCycle();
            return;
        }

        let quantity = (capitalToUse * maxLeverage) / currentPrice;
        quantity = Math.floor(quantity / stepSize) * stepSize; // Quantize to stepSize
        quantity = parseFloat(quantity.toFixed(quantityPrecision)); // Round to quantity precision

        if (quantity < minQty) {
            logger.warn(`Calculated quantity (${quantity.toFixed(quantityPrecision)}) is too small for ${symbol}. Minimum is ${minQty}. Cannot open position.`);
            if (botRunning) scheduleNextMainCycle();
            return;
        }

        const currentNotional = quantity * currentPrice;
        if (currentNotional < minNotional) {
            logger.warn(`Calculated notional value (${currentNotional.toFixed(pricePrecision)}) is too small for ${symbol}. Minimum is ${minNotional}. Cannot open position.`);
            if (botRunning) scheduleNextMainCycle();
            return;
        }
        if (quantity <= 0) {
            logger.warn(`Calculated quantity for ${symbol} is ${quantity}. Invalid. Aborting.`);
            if (botRunning) scheduleNextMainCycle();
            return;
        }

        const orderSide = (tradeDirection === 'LONG') ? 'BUY' : 'SELL';

        // Submit market order
        const orderResult = await callSignedAPI('/fapi/v1/order', 'POST', {
            symbol,
            side: orderSide,
            type: 'MARKET',
            quantity,
            newOrderRespType: 'FULL'
        });

        logger.info(`Successfully sent MARKET order to open ${tradeDirection} position for ${symbol}.`);

        // Wait a moment for the order to fill and position to update
        await sleep(1000);
        logger.info(`Waited 1 second after submitting order. Fetching actual entry price from Binance.`);

        const positions = await callSignedAPI('/fapi/v2/positionRisk', 'GET');
        const openPositionOnBinance = positions.find(p => p.symbol === symbol && Math.abs(parseFloat(p.positionAmt)) > 0);

        if (!openPositionOnBinance) {
            logger.error(`Could not find open position for ${symbol} after 1 second. Order might not have filled or closed immediately.`);
            if (botRunning) scheduleNextMainCycle();
            return;
        }

        const entryPrice = parseFloat(openPositionOnBinance.entryPrice);
        const actualQuantity = Math.abs(parseFloat(openPositionOnBinance.positionAmt));
        const openTime = new Date(parseFloat(openPositionOnBinance.updateTime || Date.now()));
        const formattedOpenTime = formatTimeUTC7(openTime);

        logger.info(`Successfully opened ${tradeDirection} position for ${symbol} at ${formattedOpenTime}`);
        logger.info(`  + Leverage: ${maxLeverage}x`);
        logger.info(`  + Margin: ${capitalToUse.toFixed(2)} USDT | Actual Qty: ${actualQuantity} ${symbol} | Actual Entry Price: ${entryPrice.toFixed(pricePrecision)}`);

        // Cancel existing TP/SL orders before placing new ones
        await cancelOpenOrdersForSymbol(symbol);
        logger.info(`Cancelled any old TP/SL orders for ${symbol}.`);

        // --- CALCULATE TP/SL BASED ON % CAPITAL (using actual entry price and quantity) ---
        const profitTargetUSDT = capitalToUse * TAKE_PROFIT_PERCENTAGE_MAIN;
        const lossLimitUSDT = capitalToUse * STOP_LOSS_PERCENTAGE_MAIN;

        const priceChangeForTP = profitTargetUSDT / actualQuantity;
        const priceChangeForSL = lossLimitUSDT / actualQuantity;

        let slPrice, tpPrice;
        let slOrderSide, tpOrderSide;

        if (tradeDirection === 'LONG') {
            slPrice = entryPrice - priceChangeForSL;
            tpPrice = entryPrice + priceChangeForTP;
            slOrderSide = 'SELL';
            tpOrderSide = 'SELL';

            slPrice = Math.floor(slPrice / tickSize) * tickSize;
            tpPrice = Math.floor(tpPrice / tickSize) * tickSize;

        } else { // SHORT
            slPrice = entryPrice + priceChangeForSL;
            tpPrice = entryPrice - priceChangeForTP;
            slOrderSide = 'BUY';
            tpOrderSide = 'BUY';

            slPrice = Math.ceil(slPrice / tickSize) * tickSize;
            tpPrice = Math.ceil(tpPrice / tickSize) * tickSize;
        }

        slPrice = parseFloat(slPrice.toFixed(pricePrecision));
        tpPrice = parseFloat(tpPrice.toFixed(pricePrecision));

        logger.info(`Calculated TP: ${tpPrice.toFixed(pricePrecision)}, SL: ${slPrice.toFixed(pricePrecision)}`);

        // Place STOP_MARKET (SL) order
        try {
            await callSignedAPI('/fapi/v1/order', 'POST', {
                symbol,
                side: slOrderSide,
                type: 'STOP_MARKET',
                quantity: actualQuantity,
                stopPrice: slPrice,
                closePosition: 'true',
                newOrderRespType: 'FULL'
            });
            logger.info(`Placed SL order for ${symbol} @ ${slPrice.toFixed(pricePrecision)}.`);
        } catch (slError) {
            logger.error(`Error placing SL for ${symbol}: ${slError.msg || slError.message}.`);
            // If SL triggers immediately (price already crossed SL), close position
            if (slError.code === -2021 || (slError.msg && slError.msg.includes('Order would immediately trigger'))) {
                logger.warn(`SL for ${symbol} triggered immediately. Closing position.`);
                await closePosition(symbol, actualQuantity, 'SL activated immediately');
                return;
            }
        }

        // Place TAKE_PROFIT_MARKET (TP) order
        try {
            await callSignedAPI('/fapi/v1/order', 'POST', {
                symbol,
                side: tpOrderSide,
                type: 'TAKE_PROFIT_MARKET',
                quantity: actualQuantity,
                stopPrice: tpPrice,
                closePosition: 'true',
                newOrderRespType: 'FULL'
            });
            logger.info(`Placed TP order for ${symbol} @ ${tpPrice.toFixed(pricePrecision)}.`);
        } catch (tpError) {
            logger.error(`Error placing TP for ${symbol}: ${tpError.msg || tpError.message}.`);
            // If TP triggers immediately (price already crossed TP), close position
            if (tpError.code === -2021 || (tpError.msg && tpError.msg.includes('Order would immediately trigger'))) {
                logger.warn(`TP for ${symbol} triggered immediately. Closing position.`);
                await closePosition(symbol, actualQuantity, 'TP activated immediately');
                return;
            }
        }

        currentOpenPosition = {
            symbol: symbol,
            quantity: actualQuantity,
            entryPrice: entryPrice,
            initialTPPrice: tpPrice,
            initialSLPrice: slPrice,
            initialMargin: capitalToUse,
            openTime: openTime,
            pricePrecision: pricePrecision,
            side: tradeDirection,
            tickSize: tickSize
        };

        // Start periodic position check if not already running
        if (!positionCheckInterval) {
            positionCheckInterval = setInterval(async () => {
                if (botRunning && currentOpenPosition) {
                    try {
                        await manageOpenPosition();
                    } catch (error) {
                        logger.error(`Error during periodic position check: ${error.msg || error.message}.`);
                        if (error instanceof CriticalApiError) {
                            logger.critical(`Bot stopping due to critical API error during periodic position check.`);
                            stopBotLogicInternal(); // Ensure bot stops
                            if (!retryBotTimeout) { // Only schedule if not already scheduled
                                logger.info(`Scheduling automatic bot restart in ${CRITICAL_ERROR_RETRY_DELAY_MS / 1000}s.`);
                                retryBotTimeout = setTimeout(async () => {
                                    logger.info('Attempting to restart bot...');
                                    await startBotLogicInternal();
                                    retryBotTimeout = null;
                                }, CRITICAL_ERROR_RETRY_DELAY_MS);
                            }
                        }
                    }
                } else if (!botRunning && positionCheckInterval) {
                    clearInterval(positionCheckInterval);
                    positionCheckInterval = null;
                }
            }, 300); // Check every 300ms
        }

    } catch (error) {
        logger.error(`Failed to open ${tradeDirection} position for ${symbol}: ${error.msg || error.message}`);
        if (error instanceof CriticalApiError) {
            logger.critical(`Bot stopping due to critical API error when opening order.`);
            stopBotLogicInternal(); // Ensure bot stops
            if (!retryBotTimeout) { // Only schedule if not already scheduled
                logger.info(`Scheduling automatic bot restart in ${CRITICAL_ERROR_RETRY_DELAY_MS / 1000}s.`);
                retryBotTimeout = setTimeout(async () => {
                    logger.info('Attempting to restart bot...');
                    await startBotLogicInternal();
                    retryBotTimeout = null;
                }, CRITICAL_ERROR_RETRY_DELAY_MS);
            }
        } else if (botRunning) {
            scheduleNextMainCycle(); // Retry main cycle if not critical
        }
    }
}

/**
 * Checks and manages the open position (TP/SL monitoring).
 * This function is called periodically via positionCheckInterval.
 */
async function manageOpenPosition() {
    if (!currentOpenPosition || isClosingPosition) {
        if (!currentOpenPosition && positionCheckInterval) { // If position is cleared but interval is still running
            clearInterval(positionCheckInterval);
            positionCheckInterval = null;
            if (botRunning) scheduleNextMainCycle(); // Schedule next main cycle to look for new trade
        }
        return;
    }

    const { symbol, quantity, initialTPPrice, initialSLPrice, side, tickSize } = currentOpenPosition;

    try {
        const positions = await callSignedAPI('/fapi/v2/positionRisk', 'GET');
        const currentPositionOnBinance = positions.find(p => p.symbol === symbol && parseFloat(p.positionAmt) !== 0);

        // If position is no longer on Binance
        if (!currentPositionOnBinance || parseFloat(currentPositionOnBinance.positionAmt) === 0) {
            // Attempt to infer closing reason from recent trades
            const recentTrades = await callSignedAPI('/fapi/v1/userTrades', 'GET', { symbol, limit: 10 });
            let closeReason = "closed on exchange";

            if (recentTrades.length > 0) {
                const latestTrade = recentTrades.find(t =>
                    (side === 'LONG' && t.side === 'SELL' && Math.abs(parseFloat(t.qty) - quantity) < 0.00001) ||
                    (side === 'SHORT' && t.side === 'BUY' && Math.abs(parseFloat(t.qty) - quantity) < 0.00001)
                );

                if (latestTrade) {
                    const priceDiffTP = Math.abs(parseFloat(latestTrade.price) - initialTPPrice);
                    const priceDiffSL = Math.abs(parseFloat(latestTrade.price) - initialSLPrice);

                    if (priceDiffTP <= tickSize * 2) {
                        closeReason = "TP hit";
                    } else if (priceDiffSL <= tickSize * 2) {
                        closeReason = "SL hit";
                    }
                }
            }

            logger.info(`Position for ${symbol} ${closeReason}. Updating bot state.`);
            await closePosition(symbol, quantity, closeReason);
            return;
        }

        // Logic to check if current price hits TP or SL (if orders haven't filled yet)
        const currentPrice = await getCurrentPrice(symbol);
        if (!currentPrice) {
            logger.warn(`Could not get current price for ${symbol} while managing position. Retrying next cycle.`);
            return;
        }

        let hitCondition = false;
        let reasonForClose = '';

        if (side === 'LONG') {
            if (currentPrice >= initialTPPrice) {
                hitCondition = true;
                reasonForClose = 'TP reached';
            } else if (currentPrice <= initialSLPrice) {
                hitCondition = true;
                reasonForClose = 'SL reached';
            }
        } else { // SHORT
            if (currentPrice <= initialTPPrice) {
                hitCondition = true;
                reasonForClose = 'TP reached';
            } else if (currentPrice >= initialSLPrice) {
                hitCondition = true;
                reasonForClose = 'SL reached';
            }
        }

        if (hitCondition) {
            logger.info(`Position for ${symbol} has reached ${reasonForClose}. Initiating close.`);
            await closePosition(symbol, quantity, reasonForClose);
        }

    } catch (error) {
        logger.error(`Error managing open position for ${symbol}: ${error.msg || error.message}`);
        if (error instanceof CriticalApiError) {
            logger.critical(`Bot stopping due to critical API error during position management.`);
            stopBotLogicInternal();
            if (!retryBotTimeout) {
                logger.info(`Scheduling automatic bot restart in ${CRITICAL_ERROR_RETRY_DELAY_MS / 1000}s.`);
                retryBotTimeout = setTimeout(async () => {
                    logger.info('Attempting to restart bot...');
                    await startBotLogicInternal();
                    retryBotTimeout = null;
                }, CRITICAL_ERROR_RETRY_DELAY_MS);
            }
        }
    }
}

/**
 * Executes the main trading logic to find and open a new position.
 * This function runs only when no position is open.
 */
async function runTradingLogic() {
    if (!botRunning) {
        logger.info('Bot is stopped. Cancelling trading cycle.');
        return;
    }

    if (currentOpenPosition) {
        logger.info('An open position exists. Skipping new trade scan.');
        return;
    }

    logger.info(`Attempting to find trade opportunity for ${TARGET_COIN_SYMBOL}...`);
    try {
        const accountInfo = await callSignedAPI('/fapi/v2/account', 'GET');
        const usdtAsset = accountInfo.assets.find(a => a.asset === 'USDT')?.availableBalance || 0;
        const availableBalance = parseFloat(usdtAsset);

        const targetSymbol = TARGET_COIN_SYMBOL;
        let eligibleSymbol = null;

        const symbolDetails = await getSymbolDetails(targetSymbol);
        if (symbolDetails && typeof symbolDetails.maxLeverage === 'number' && symbolDetails.maxLeverage > 1) {
            const currentPrice = await getCurrentPrice(targetSymbol);
            if (currentPrice === null) {
                logger.warn(`Failed to get price for ${targetSymbol}. Skipping and retrying soon.`);
            } else {
                let estimatedQuantity = (currentInvestmentAmount * symbolDetails.maxLeverage) / currentPrice;
                estimatedQuantity = Math.floor(estimatedQuantity / symbolDetails.stepSize) * symbolDetails.stepSize;
                estimatedQuantity = parseFloat(estimatedQuantity.toFixed(symbolDetails.quantityPrecision));

                const currentNotional = estimatedQuantity * currentPrice;

                if (currentNotional >= symbolDetails.minNotional && estimatedQuantity >= symbolDetails.minQty) {
                    eligibleSymbol = { symbol: targetSymbol, maxLeverage: symbolDetails.maxLeverage };
                } else {
                    logger.warn(`${targetSymbol}: Does NOT meet minimum requirements (minNotional: ${symbolDetails.minNotional}, minQty: ${symbolDetails.minQty}). Retrying soon.`);
                }
            }
        } else {
            logger.warn(`${targetSymbol}: No valid leverage or symbol details found. Retrying soon.`);
        }

        if (availableBalance < currentInvestmentAmount) {
            logger.warn(`Insufficient USDT balance (${availableBalance.toFixed(2)}) to open trade (${currentInvestmentAmount.toFixed(2)} USDT). Resetting to initial capital.`);
            currentInvestmentAmount = INITIAL_INVESTMENT_AMOUNT;
            consecutiveLossCount = 0;
            logger.info(`Balance insufficient. Reset capital to ${currentInvestmentAmount} USDT, losses to 0. Next trade direction: ${nextTradeDirection}.`);
            scheduleNextMainCycle(); // Re-schedule
            return;
        }

        if (eligibleSymbol) {
            logger.info(`\nSelected: ${eligibleSymbol.symbol}`);
            logger.info(`  + Leverage: ${eligibleSymbol.maxLeverage}x | Capital: ${currentInvestmentAmount.toFixed(2)} USDT`);
            logger.info(`Opening ${nextTradeDirection} position immediately.`);

            await openPosition(eligibleSymbol.symbol, nextTradeDirection, availableBalance, eligibleSymbol.maxLeverage);

        } else {
            logger.info(`No eligible symbol found for opening a ${nextTradeDirection} position. Retrying soon.`);
            if (botRunning) scheduleNextMainCycle(); // Re-schedule
        }
    } catch (error) {
        logger.error('Error in trading cycle: ' + (error.msg || error.message));
        if (error instanceof CriticalApiError) {
            logger.critical(`Bot stopping due to repeated API errors. Automatic retry in ${CRITICAL_ERROR_RETRY_DELAY_MS / 1000}s.`);
            stopBotLogicInternal();
            if (!retryBotTimeout) {
                retryBotTimeout = setTimeout(async () => {
                    logger.info('Attempting to restart bot...');
                    await startBotLogicInternal();
                    retryBotTimeout = null;
                }, CRITICAL_ERROR_RETRY_DELAY_MS);
            }
        } else {
            if (botRunning) scheduleNextMainCycle(); // Re-schedule for non-critical errors
        }
    }
}

/**
 * Schedules the next main trading cycle.
 * The bot attempts to run immediately if no position is open.
 */
async function scheduleNextMainCycle() {
    if (!botRunning) {
        logger.info('Bot is stopped. Not scheduling new cycle.');
        clearTimeout(nextScheduledCycleTimeout);
        return;
    }

    if (currentOpenPosition) {
        logger.info('An open position exists. Waiting for it to close.');
        return;
    }

    clearTimeout(nextScheduledCycleTimeout); // Clear any previous scheduled timeout

    // With current logic, the bot will try to re-run immediately if no position is open.
    // If a delay is desired between scans when no position is open, add a setTimeout here:
    // nextScheduledCycleTimeout = setTimeout(runTradingLogic, 5000); // Wait 5 seconds before next scan
    await runTradingLogic();
}


// --- BOT START/STOP LOGIC (INTERNAL, NOT PM2 COMMANDS) ---

/**
 * Starts the internal bot logic.
 * Performs initial checks and sets up periodic tasks.
 * @returns {Promise<string>} Status message.
 */
async function startBotLogicInternal() {
    if (botRunning) {
        logger.info('Bot is already running.');
        return 'Bot is already running.';
    }

    if (!API_KEY || !SECRET_KEY) {
        logger.error('Error: API Key or Secret Key not configured. Please set them in .env.');
        return 'Error: API Key or Secret Key not configured.';
    }

    if (retryBotTimeout) {
        clearTimeout(retryBotTimeout);
        retryBotTimeout = null;
        logger.info('Cancelled automatic bot restart schedule.');
    }

    logger.info('--- Starting Bot ---');
    logger.info('Checking Binance Futures API connection...');

    try {
        await syncServerTime();

        const account = await callSignedAPI('/fapi/v2/account', 'GET');
        const usdtBalance = account.assets.find(a => a.asset === 'USDT')?.availableBalance || 0;
        logger.info(`API Key is valid! Available USDT balance: ${parseFloat(usdtBalance).toFixed(2)}`);

        consecutiveApiErrors = 0; // Reset error counter on successful API call

        await getExchangeInfo();
        if (!exchangeInfoCache) {
            logger.error('Failed to load exchangeInfo. Bot stopping.');
            botRunning = false;
            return 'Failed to load exchangeInfo.';
        }

        botRunning = true;
        botStartTime = new Date();
        logger.info(`--- Bot started at ${formatTimeUTC7(botStartTime)} ---`);
        logger.info(`Initial capital per trade: ${INITIAL_INVESTMENT_AMOUNT} USDT.`);

        // Reset trading state on fresh start
        currentInvestmentAmount = INITIAL_INVESTMENT_AMOUNT;
        consecutiveLossCount = 0;
        nextTradeDirection = 'SHORT'; // Always start with SHORT as default, or make configurable

        scheduleNextMainCycle(); // Kick off the main trading loop

        // Start periodic position management if not already running
        if (!positionCheckInterval) {
            positionCheckInterval = setInterval(async () => {
                if (botRunning && currentOpenPosition) {
                    try {
                        await manageOpenPosition();
                    } catch (error) {
                        logger.error(`Error during periodic position check: ${error.msg || error.message}.`);
                        if (error instanceof CriticalApiError) {
                            logger.critical(`Bot stopping due to critical API error during position check.`);
                            stopBotLogicInternal();
                            if (!retryBotTimeout) {
                                logger.info(`Scheduling automatic bot restart in ${CRITICAL_ERROR_RETRY_DELAY_MS / 1000}s.`);
                                retryBotTimeout = setTimeout(async () => {
                                    logger.info('Attempting to restart bot...');
                                    await startBotLogicInternal();
                                    retryBotTimeout = null;
                                }, CRITICAL_ERROR_RETRY_DELAY_MS);
                            }
                        }
                    }
                } else if (!botRunning && positionCheckInterval) {
                    clearInterval(positionCheckInterval);
                    positionCheckInterval = null;
                }
            }, 300); // Check every 300ms
        }

        return 'Bot started successfully.';

    } catch (error) {
        const errorMsg = error.msg || error.message;
        logger.critical(`[Bot Startup Error] ${errorMsg}`);
        logger.critical('   -> Bot stopped. Please check configurations and restart.');

        stopBotLogicInternal(); // Ensure bot state is stopped
        if (error instanceof CriticalApiError && !retryBotTimeout) {
            logger.info(`Scheduling automatic bot restart in ${CRITICAL_ERROR_RETRY_DELAY_MS / 1000}s.`);
            retryBotTimeout = setTimeout(async () => {
                logger.info('Attempting to restart bot...');
                await startBotLogicInternal();
                retryBotTimeout = null;
            }, CRITICAL_ERROR_RETRY_DELAY_MS);
        }
        return `Error starting bot: ${errorMsg}`;
    }
}

/**
 * Stops the internal bot logic.
 * Clears timers and resets state.
 * @returns {string} Status message.
 */
function stopBotLogicInternal() {
    if (!botRunning) {
        logger.info('Bot is not running.');
        return 'Bot is not running.';
    }
    botRunning = false;
    clearTimeout(nextScheduledCycleTimeout);
    if (positionCheckInterval) {
        clearInterval(positionCheckInterval);
        positionCheckInterval = null;
    }
    consecutiveApiErrors = 0; // Reset error count on stop
    if (retryBotTimeout) {
        clearTimeout(retryBotTimeout);
        retryBotTimeout = null;
        logger.info('Cancelled automatic bot restart schedule.');
    }
    currentOpenPosition = null; // Clear any open position state
    botStartTime = null;
    logger.info('--- Bot Stopped ---');
    return 'Bot stopped successfully.';
}

// --- WEB SERVER AND API ENDPOINTS ---
const app = express();
app.use(express.json()); // To parse JSON in request body

// Serve static frontend files (e.g., index.html, CSS, JS)
app.use(express.static(path.join(__dirname, 'public'))); // Assuming a 'public' folder for frontend

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'), (err) => {
        if (err) {
            logger.error(`Error sending index.html: ${err.message}`);
            res.status(404).send('Frontend file (index.html) not found. Please ensure it\'s in the "public" directory.');
        }
    });
});

// Endpoint to stream logs in real-time via WebSocket
app.get('/api/logs-stream', (req, res) => {
    // This is handled by the WebSocket server, not HTTP GET.
    // The frontend client will initiate a WebSocket connection.
    res.status(200).send('Connect via WebSocket to /ws/logs');
});

// Endpoint to fetch historical logs (for initial load)
app.get('/api/logs', (req, res) => {
    fs.readFile(BOT_LOG_FILE, 'utf8', (err, data) => {
        if (err) {
            logger.error('Error reading log file:', err);
            if (err.code === 'ENOENT') {
                return res.status(404).send(`Log file not found at: ${BOT_LOG_FILE}. Please check PM2 log path or bot_activity.log.`);
            }
            return res.status(500).send('Error reading log file');
        }
        // Clean ANSI escape codes if present (from PM2 logs)
        const cleanData = data.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, '');

        const lines = cleanData.split('\n');
        const maxDisplayLines = 1000; // Increased lines for UI
        const startIndex = Math.max(0, lines.length - maxDisplayLines);
        const limitedLogs = lines.slice(startIndex).join('\n');

        res.send(limitedLogs);
    });
});

// Endpoint to get bot and PM2 status
app.get('/api/status', async (req, res) => {
    try {
        const pm2List = await new Promise((resolve, reject) => {
            exec('pm2 jlist', (error, stdout, stderr) => {
                if (error) reject(stderr || error.message);
                resolve(stdout);
            });
        });
        const processes = JSON.parse(pm2List);
        const botProcess = processes.find(p => p.name === THIS_BOT_PM2_NAME);

        let statusMessage = 'PM2 Server: OFFLINE';
        let botInternalStatus = 'INTERNAL: UNKNOWN';
        let botUptime = 'N/A';

        if (botProcess) {
            statusMessage = `PM2 Server: ${botProcess.pm2_env.status.toUpperCase()} (Restarts: ${botProcess.pm2_env.restart_time})`;
            if (botProcess.pm2_env.status === 'online') {
                botInternalStatus = `INTERNAL: ${botRunning ? 'RUNNING' : 'STOPPED'}`;
                if (botStartTime) {
                    const uptimeMs = Date.now() - botStartTime.getTime();
                    const uptimeMinutes = Math.floor(uptimeMs / (1000 * 60));
                    botUptime = `${uptimeMinutes} minutes`;
                }
            }
        } else {
            statusMessage = `PM2 Bot: NOT FOUND (Name: ${THIS_BOT_PM2_NAME})`;
        }
        res.json({ pm2Status: statusMessage, botStatus: botInternalStatus, botUptime: botUptime });
    } catch (error) {
        logger.error('Error getting PM2 status:', error);
        res.status(500).json({ error: `Failed to get PM2 status. (${error.message})` });
    }
});

// Endpoint to configure bot parameters from frontend
app.post('/api/configure', (req, res) => {
    const { apiKey, secretKey, coinSymbol, initialAmount, applyDoubleStrategy } = req.body;

    // Validate inputs
    if (!apiKey || !secretKey || !coinSymbol || isNaN(parseFloat(initialAmount))) {
        return res.status(400).json({ success: false, message: 'Invalid configuration parameters.' });
    }

    // Update variables
    // API_KEY = apiKey.trim(); // Removed direct update for security reasons, load from .env
    // SECRET_KEY = secretKey.trim(); // Removed direct update for security reasons, load from .env
    TARGET_COIN_SYMBOL = coinSymbol.trim().toUpperCase();
    INITIAL_INVESTMENT_AMOUNT = parseFloat(initialAmount);
    APPLY_DOUBLE_STRATEGY = !!applyDoubleStrategy;

    // Apply immediate state resets if bot is not running
    if (!botRunning) {
        currentInvestmentAmount = INITIAL_INVESTMENT_AMOUNT;
        consecutiveLossCount = 0;
        nextTradeDirection = 'SHORT';
    } else {
        // If bot is running, only update config relevant to new trades.
        // Current open position state (currentInvestmentAmount, consecutiveLossCount, nextTradeDirection)
        // should only change after a position closes or based on trading strategy.
        logger.warn('Bot is running. Some configurations (initial investment, double strategy) will apply to future trades.');
    }

    logger.info(`Configuration updated:`);
    logger.info(`  API Key: ${API_KEY ? 'Configured (via .env)' : 'NOT CONFIGURED'}`); // Indicate .env loading
    logger.info(`  Secret Key: ${SECRET_KEY ? 'Configured (via .env)' : 'NOT CONFIGURED'}`);
    logger.info(`  Target Coin: ${TARGET_COIN_SYMBOL}`);
    logger.info(`  Initial Investment: ${INITIAL_INVESTMENT_AMOUNT} USDT`);
    logger.info(`  Double Strategy: ${APPLY_DOUBLE_STRATEGY ? 'Enabled' : 'Disabled'}`);

    res.json({ success: true, message: 'Configuration updated. Restart bot to apply changes fully if it was running.', currentConfig: {
        targetCoinSymbol: TARGET_COIN_SYMBOL,
        initialInvestmentAmount: INITIAL_INVESTMENT_AMOUNT,
        applyDoubleStrategy: APPLY_DOUBLE_STRATEGY
    } });
});

// Endpoint to start the bot
app.get('/api/start_bot', async (req, res) => {
    const message = await startBotLogicInternal();
    res.send(message);
});

// Endpoint to stop the bot
app.get('/api/stop_bot', (req, res) => {
    const message = stopBotLogicInternal();
    res.send(message);
});

// Start the HTTP server
const server = app.listen(WEB_SERVER_PORT, () => {
    logger.info(`Web server listening on port ${WEB_SERVER_PORT}`);
    logger.info(`Access bot UI at: http://localhost:${WEB_SERVER_PORT}`);
});

// Attach WebSocket server to the same HTTP server
server.on('upgrade', (request, socket, head) => {
    if (request.url === '/ws/logs') {
        wsServer.handleUpgrade(request, socket, head, ws => {
            wsServer.emit('connection', ws, request);
        });
    } else {
        socket.destroy(); // Reject other WebSocket connections
    }
});

// --- Graceful Shutdown ---
process.on('SIGINT', async () => {
    logger.info('SIGINT received. Initiating graceful shutdown...');
    stopBotLogicInternal();
    if (server) {
        server.close(() => {
            logger.info('HTTP server closed.');
            // Give Winston a moment to flush logs
            logger.on('finish', () => process.exit(0));
            logger.end();
        });
    } else {
        logger.info('HTTP server not running. Exiting.');
        process.exit(0);
    }
});

process.on('SIGTERM', async () => {
    logger.info('SIGTERM received. Initiating graceful shutdown...');
    stopBotLogicInternal();
    if (server) {
        server.close(() => {
            logger.info('HTTP server closed.');
            logger.on('finish', () => process.exit(0));
            logger.end();
        });
    } else {
        logger.info('HTTP server not running. Exiting.');
        process.exit(0);
    }
});

