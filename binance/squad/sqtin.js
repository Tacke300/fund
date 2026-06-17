import express from 'express';
import Parser from 'rss-parser';
import axios from 'axios';
import cron from 'node-cron';

const app = express();
const PORT = 9999;
const parser = new Parser();

// --- CẤU HÌNH ---
const SQUAD_API_KEY = "8d794c11cc794c958c2c65924c54f2dd";
const SQUAD_ENDPOINT = "https://www.binance.com/bapi/composite/v1/public/pgc/openApi/content/add";

const RSS_SOURCES = [
    'https://cointelegraph.com/rss',
    'https://www.coindesk.com/arc/outboundfeeds/rss/',
    'https://cryptopotato.com/feed/'
];

// Danh sách 500+ hashtags (Đa dạng niche)
const TAG_POOL = [
    "Crypto", "Bitcoin", "BTC", "ETH", "Ethereum", "Binance", "BNB", "Trading", "Blockchain", "Altcoin", "DeFi", "Web3", "NFT", "Metaverse", "AI", "GameFi", "Layer1", "Layer2", "Staking", "YieldFarming", "DAO", "DEX", "CEX", "Wallet", "Regulation", "ETF", "Stablecoin", "Market", "Bullish", "Bearish", "Investing", "Finance", "Economy", "Sui", "Solana", "SOL", "Ripple", "XRP", "Cardano", "ADA", "Dogecoin", "DOGE", "PEPE", "WIF", "LINK", "AVAX", "NEAR", "FET", "RENDER", "Arbitrum", "Optimism", "Polygon", "MATIC", "Chainlink", "Polkadot", "DOT", "Cosmos", "ATOM", "Avalanche", "Tron", "TRX", "Litecoin", "LTC", "ShibaInu", "SHIB", "Uniswap", "UNI", "Aave", "Maker", "MKR", "Curve", "CRV", "Compound", "COMP", "Synthetix", "SNX", "SushiSwap", "SUSHI", "Yearn", "YFI", "Balancer", "BAL", "PancakeSwap", "CAKE", "1inch", "Terra", "Luna", "Fantom", "FTM", "Harmony", "ONE", "Algorand", "ALGO", "Hedera", "HBAR", "Tezos", "XTZ", "EOS", "IOTA", "MIOTA", "NEO", "Dash", "DASH", "Zcash", "ZEC", "Monero", "XMR", "Stellar", "XLM", "VeChain", "VET", "Iotex", "IOTX", "Gala", "GALA", "Sandbox", "SAND", "Decentraland", "MANA", "Axie", "AXS", "Illuvium", "ILV", "Immutable", "IMX", "Stepn", "GMT", "Render", "RNDR", "Fetch", "FET", "Ocean", "OCEAN", "SingularityNET", "AGIX", "Worldcoin", "WLD", "Optimism", "OP", "Arbitrum", "ARB", "Base", "Optimism", "zkSync", "Starknet", "STRK", "Celestia", "TIA", "Injective", "INJ", "Sei", "SEI", "Pyth", "PYTH", "Jito", "JTO", "Jupiter", "JUP", "Bonk", "BONK", "Dogwifhat", "WIF", "Memecoin", "Airdrop", "Mining", "HardwareWallet", "Hardware", "Security", "Privacy", "Exchange", "Launchpad", "ICO", "IDO", "IEO", "Funding", "VentureCapital", "VC", "Whale", "Alert", "Signals", "Analysis", "Charts", "TechnicalAnalysis", "FundamentalAnalysis", "Sentiment", "Volatility", "Liquidity", "OrderBook", "Spread", "Arbitrage", "HODL", "FOMO", "FUD", "DYOR", "NFA", "Gain", "Loss", "Profit", "Portfolio", "Asset", "Security", "Custody", "Regulation", "Law", "Compliance", "Tax", "CryptoTax", "Audit", "SmartContract", "ZeroKnowledge", "ZK", "Rollup", "Sidechain", "Bridge", "CrossChain", "Interoperability", "PrivacyCoin", "CBDC", "Stablecoin", "Fiat", "Forex", "Stock", "Commodity", "Gold", "Silver", "Oil", "Macro", "Fed", "InterestRate", "Inflation", "Recession", "Growth", "Tech", "Innovation", "Future", "Startup", "Entrepreneur", "Business", "Money", "Payment", "Remittance", "Banking", "Fintech", "PaymentGateway", "PointOfSale", "Merchant", "Consumer", "Retail", "Institutional", "Adoption", "Education", "Event", "Conference", "Meetup", "Podcast", "Newsletter", "News", "Media", "PressRelease", "Interview", "Opinion", "Editorial", "Review", "Guide", "Tutorial", "HowTo", "Tips", "Strategy", "Tools", "Software", "Development", "Coding", "GitHub", "OpenSource", "Security", "BugBounty", "Hack", "Exploit", "Scam", "RugPull", "Ponzi", "Bubble", "Crash", "Correction", "Rally", "Dip", "Pump", "Dump", "Short", "Long", "Leverage", "Margin", "Futures", "Option", "Derivatives", "Perpetual", "Spot", "DCA", "Strategy", "Bot", "Algorithm", "Quant", "HFT", "Arbitrage", "MarketMaker", "LiquidityProvider", "Yield", "Interest", "Lending", "Borrowing", "Collateral", "Liquidation", "MarginCall", "StopLoss", "TakeProfit", "Entry", "Exit", "Target", "Resistance", "Support", "TrendLine", "MovingAverage", "RSI", "MACD", "BollingerBands", "Fibonacci", "ElliottWave", "Harmonic", "ChartPattern", "Candlestick", "Volume", "OpenInterest", "FundingRate", "Premium", "Discount", "Basis", "Spread", "Arbitrage", "ArbitrageBot", "TradingBot", "CryptoBot", "AutomatedTrading", "AlgoTrading", "QuantTrading", "HighFrequencyTrading", "MarketMaking", "LiquidityProvision", "YieldFarming", "LiquidityMining", "StakingRewards", "Validator", "Delegator", "Governance", "Proposal", "Voting", "Snapshot", "DAO", "Multisig", "Wallet", "ColdStorage", "HotWallet", "HardwareWallet", "SeedPhrase", "PrivateKey", "PublicKey", "Address", "Transaction", "Block", "Hash", "Difficulty", "Hashrate", "Node", "Network", "Protocol", "Standard", "EIP", "BIP", "Layer0", "Layer1", "Layer2", "Sidechain", "Bridge", "CrossChain", "Interoperability", "Privacy", "Anonymity", "Mixer", "Tumbler", "ZeroKnowledge", "ZKProof", "STARK", "SNARK", "Recursive", "Scalability", "Throughput", "Latency", "Finality", "Consensus", "ProofOfWork", "ProofOfStake", "ProofOfAuthority", "ProofOfHistory", "ProofOfBurn", "ProofOfCapacity", "DelegatedProofOfStake", "DPoS", "PBFT", "HotStuff", "Tendermint", "Substrate", "CosmosSDK", "EVM", "WASM", "Solidity", "Rust", "Go", "Python", "JavaScript", "TypeScript", "NodeJS", "React", "Vue", "Angular", "Web3JS", "EthersJS", "Hardhat", "Truffle", "Foundry", "OpenZeppelin", "Chainlink", "Oracles", "VRF", "Keepers", "CCIP", "Functions", "Automation", "Payment", "Stream", "Subscription", "Tokenization", "RWA", "SecurityToken", "UtilityToken", "GovernanceToken", "Memecoin", "Stablecoin", "CBDC", "NFT", "SBT", "DID", "VerifiableCredential", "ProofOfHumanity", "SybilResistance", "Reputation", "Identity", "PersonalData", "Privacy", "Encryption", "Cryptography", "Signature", "MultiSig", "MPC", "Threshold", "Hardware", "TEE", "Enclave", "ConfidentialComputing", "ZeroKnowledge", "ZKML", "AI", "MachineLearning", "NeuralNetwork", "DeepLearning", "ComputerVision", "NLP", "LargeLanguageModel", "LLM", "GenerativeAI", "StableDiffusion", "Midjourney", "ChatGPT", "Claude", "Gemini", "Llama", "Mistral", "AutonomousAgent", "AgenticWorkflow", "DePIN", "DeSci", "ReFi", "SocialFi", "GameFi", "Fashion", "Art", "Music", "Media", "Entertainment", "Education", "Healthcare", "SupplyChain", "RealEstate", "Logistics", "Energy", "Agriculture", "Government", "Voting", "Identity", "Taxation", "Legal", "Copyright", "Patent", "Trademark", "Regulation", "Compliance", "KYC", "AML", "CFT", "Sanctions", "Audit", "Forensics", "Investigations", "CyberSecurity", "Whitehat", "BugBounty", "SecurityAudit", "CodeReview", "PenetrationTesting", "IncidentResponse", "Recovery"
];

let isRunning = false;
let postCount = 0;
let logs = [];
let futuresList = ["BTC", "ETH"];

function addLog(msg) {
    const time = new Date().toLocaleTimeString();
    logs.unshift(`[${time}] ${msg}`);
    if (logs.length > 50) logs.pop();
    console.log(`[${time}] ${msg}`);
}

async function updateFuturesList() {
    try {
        const res = await axios.get('https://fapi.binance.com/fapi/v1/exchangeInfo');
        futuresList = res.data.symbols.filter(s => s.symbol.endsWith('USDT')).map(s => s.symbol.replace('USDT', ''));
        addLog(`Đã tải ${futuresList.length} cặp coin Futures.`);
    } catch (e) { addLog("Lỗi lấy danh sách coin!"); }
}
updateFuturesList();

async function runJob() {
    addLog("Bắt đầu quét tin...");
    for (const source of RSS_SOURCES) {
        try {
            const feed = await parser.parseURL(source);
            if (!feed.items?.length) continue;

            const item = feed.items[0];
            const randomCoin = futuresList[Math.floor(Math.random() * futuresList.length)];
            const randomTags = [...TAG_POOL].sort(() => 0.5 - Math.random()).slice(0, 6);

            const content = `$${randomCoin}\n\n${item.title}\n\n${item.contentSnippet || ""}\n\n#${randomTags.join(' #')}\n\nNguồn: ${source}`;

            // Gửi bài
            const response = await axios.post(SQUAD_ENDPOINT, {
                content: content,
                title: item.title, // Thêm title phòng trường hợp server cần
                apiKey: SQUAD_API_KEY
            }, { timeout: 15000, headers: { 'Content-Type': 'application/json' } });

            // LOG FULL PHẢN HỒI ĐỂ DEBUG
            addLog(`Server Response: ${JSON.stringify(response.data)}`);
            
            postCount++;
            addLog(`Đã đăng thành công: ${item.title.substring(0, 20)}...`);
            break; 
        } catch (e) { 
            // Log chi tiết lỗi
            if (e.response) addLog(`Lỗi server: ${JSON.stringify(e.response.data)}`);
            else addLog(`Lỗi kết nối: ${e.message}`);
        }
    }
}

const htmlControl = `
<!DOCTYPE html><html><body style="background:#1a1a1a; color:#00ff00; font-family:monospace; padding:20px;">
<h1>Bot Squad Control</h1>
<button onclick="fetch('/start').then(()=>location.reload())">START</button>
<button onclick="fetch('/stop').then(()=>location.reload())">STOP</button>
<p>Status: ${isRunning ? 'ON' : 'OFF'} | Đã đăng: ${postCount}</p>
<div id="logs" style="background:#000; padding:10px; border:1px solid #333; height:400px; overflow-y:scroll;"></div>
<script>
    setInterval(() => {
        fetch('/logs').then(r => r.json()).then(data => {
            document.getElementById('logs').innerHTML = data.join('<br><hr style="border:0;border-top:1px solid #333">');
        });
    }, 2000);
</script>
</body></html>`;

app.get('/', (req, res) => res.send(htmlControl));
app.get('/logs', (req, res) => res.json(logs));
app.get('/start', (req, res) => { isRunning = true; addLog("Bot đã BẬT"); res.send("OK"); });
app.get('/stop', (req, res) => { isRunning = false; addLog("Bot đã TẮT"); res.send("OK"); });

cron.schedule('*/15 * * * *', async () => {
    if (isRunning && postCount < 50) await runJob();
});

app.listen(PORT, () => console.log(`Server running at http://localhost:${PORT}`));
