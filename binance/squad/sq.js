import { chromium as playwrightChromium } from 'playwright-extra';
import stealthPlugin from 'puppeteer-extra-plugin-stealth';
import express from 'express';
import path from 'path';
import axios from 'axios';
import { fileURLToPath } from 'url';

const chromium = playwrightChromium;
chromium.use(stealthPlugin());

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const port = 9003;
const userDataDir = path.join(__dirname, 'bot_session_final');

let isRunning = false;
let totalPosts = 0;
let history = [];
let userInfo = { name: "Chưa kiểm tra", status: "Offline", followers: "0" };
let context = null;
let mainPage = null;
let coinQueue = [];

function logStep(message) {
    console.log(`[${new Date().toLocaleTimeString()}] ➡️ ${message}`);
}

// --- HÀM LÀM TRÒN GIÁ THÔNG MINH ---
function smartRound(price) {
    const p = parseFloat(price);
    if (p > 1000) return Math.round(p / 10) * 10;
    if (p > 10) return Math.round(p * 10) / 10;
    if (p > 1) return Math.round(p * 100) / 100;
    return Math.round(p * 10000) / 10000;
}

// --- KHO DỮ LIỆU ---
const intros = [
    "Điểm tin nhanh về biến động của COIN.", "Anh em đã thấy cú move này của COIN chưa?", "Nhìn lại chart COIN hôm nay có nhiều điều thú vị.", "Cập nhật trạng thái mới nhất cho mã COIN.", "Dòng tiền đang đổ dồn sự chú ý vào COIN.", "Phân tích nhanh vị thế của COIN lúc này.", "Liệu COIN có chuẩn bị cho một cú bứt phá?", "Góc nhìn cá nhân về hướng đi của COIN.", "Sức nóng của COIN trên Square vẫn chưa hạ nhiệt.", "Đừng bỏ qua diễn biến hiện tại của COIN.",
    "Check nhanh cấu trúc nến của COIN anh em nhé.", "Vùng giá này của COIN thực sự rất đáng xem xét.", "Có nên vào hàng COIN lúc này không?", "Mọi con mắt đang đổ dồn về biến động của COIN.", "Tín hiệu từ COIN đang dần rõ nét hơn.", "Phân tích nhanh khung thời gian ngắn hạn của COIN.", "Nhận định về khả năng hồi phục của COIN.", "Góc trading: COIN đang ở vùng nhạy cảm.", "Cơ hội nào cho trader với mã COIN hôm nay?", "Dữ liệu on-chain của COIN đang có dấu hiệu lạ.",
    "Báo động cho các vị thế COIN.", "Chiến thuật giao dịch COIN hiệu quả lúc này.", "Bản tin Crypto: Tâm điểm gọi tên COIN.", "Sóng COIN đang cuộn trào, anh em sẵn sàng chưa?", "Cùng soi qua các mốc quan trọng của COIN.", "Thị trường đang định giá lại COIN khá gắt.", "Sự im lặng của COIN có thể là dấu hiệu bão tố.", "Phá vỡ hay điều chỉnh? Câu hỏi cho COIN.", "Bức tranh toàn cảnh về mã COIN trong phiên này.", "Kèo nhanh cho anh em quan tâm đến COIN.",
    "Vốn hóa COIN đang có sự dịch chuyển đáng kể.", "Khối lượng giao dịch COIN tăng vọt bất ngờ.", "Điểm lại các sự kiện tác động đến giá COIN.", "Dự báo xu hướng tiếp theo của đồng COIN.", "Anh em holder COIN chắc đang rất hồi hộp.", "Cú lội ngược dòng ngoạn mục từ COIN.", "Vùng kháng cự của COIN liệu có bị xuyên thủng?", "Hỗ trợ của COIN đang được kiểm chứng gắt gao.", "Tâm lý thị trường đối với COIN đang rất tốt.", "Phân tích dòng tiền chảy vào COIN.",
    "Tín hiệu phân kỳ xuất hiện trên chart COIN.", "Sức mạnh tương đối của COIN so với thị trường.", "Cập nhật kịch bản giao dịch cho COIN.", "Đánh giá lực mua/bán hiện tại của COIN.", "Những lưu ý quan trọng khi trade COIN lúc này.", "Nhịp đập thị trường: Sức mạnh của COIN.", "Đừng để bị giũ hàng khỏi mã COIN quá sớm.", "Vùng entry của COIN đang hiện ra rất rõ.", "Phân tích sâu về lực cầu tại vùng giá COIN.", "Kế hoạch săn lợi nhuận cùng với COIN.",
    "Thị trường đang định hình lại vị thế COIN.", "COIN đang cho thấy một sự ổn định lạ kỳ.", "Nhịp tăng của COIN liệu có bền vững?", "Cảnh báo rung lắc mạnh cho đồng COIN.", "COIN đang tiến gần đến vùng supply cực mạnh.", "Khám phá tiềm năng của COIN trong ngắn hạn.", "COIN và những con số biết nói trong hôm nay.", "Sự trỗi dậy của COIN sau giai đoạn đi ngang.", "COIN đang tạo ra một vùng đáy mới.", "Hãy chú ý đến volume của COIN vào lúc này.",
    "COIN đang là tâm điểm của các cuộc thảo luận.", "Một kịch bản lạc quan đang mở ra cho COIN.", "COIN đang chịu áp lực từ các tin tức vĩ mô.", "Tìm kiếm điểm đảo chiều tiềm năng cho COIN.", "COIN đang đi đúng theo lộ trình kỹ thuật.", "Sự hưng phấn quanh COIN đang tăng cao.", "COIN có thể sẽ dẫn dắt nhóm Altcoin sắp tới.", "Đánh giá lại rủi ro khi đầu tư vào COIN.", "COIN đang cho thấy sức mạnh của phe bò.", "Nhịp đập 24h: Sự bùng nổ của COIN.",
    "COIN đang ở ngưỡng cửa của sự thay đổi.", "Các lệnh lớn đang đổ bộ vào mã COIN.", "COIN đang hình thành mô hình giá kinh điển.", "Góc nhìn chuyên sâu về đồ thị COIN.", "Sự kỳ vọng vào COIN đang ở mức đỉnh điểm.", "COIN đang bị đánh giá thấp hơn giá trị thực.", "Theo dấu chân cá mập với mã COIN.", "COIN và bài toán cân bằng lợi nhuận.", "Tầm nhìn ngắn hạn dành cho các trader COIN.", "COIN đang vượt xa các đối thủ cùng phân khúc.",
    "Lực đẩy của COIN đang đến từ đâu?", "COIN đang kiểm tra lại mức ATH cũ.", "Sự thận trọng là cần thiết đối với COIN.", "COIN đang cho thấy dấu hiệu kiệt sức tạm thời.", "Điểm lại các mốc lịch sử của giá COIN.", "COIN đang thu hẹp khoảng cách với target.", "Sự biến động của COIN đang mang lại cơ hội.", "COIN đang dần chiếm lĩnh thị phần Square.", "Phân tích nến tuần cho đồng COIN.", "COIN đang trong giai đoạn chuyển giao xu hướng.",
    "Mọi chỉ báo đều đang gọi tên COIN.", "COIN đang đứng trước một đợt xả hàng tiềm năng.", "Cú lừa của thị trường với mã COIN?", "COIN đang chứng minh được sức hút mãnh liệt.", "Tương lai của COIN phụ thuộc vào mốc hỗ trợ này.", "COIN đang tạo ra sự bất ngờ cho giới đầu tư.", "COIN và cuộc chơi của các quỹ lớn.", "Đừng nhìn vào giá, hãy nhìn vào vol COIN.", "COIN đang tiệm cận vùng quá bán cực độ.", "Tóm tắt nhanh chiến lược cho COIN."
];

const bodies = [
    "Giá hiện tại đang neo đậu tại mức ổn định.", "Cấu trúc nến cho thấy phe bò đang kiểm soát.", "Áp lực bán dường như đã cạn kiệt ở vùng này.", "Xu hướng tăng được củng cố bởi khối lượng giao dịch.", "Mô hình hai đáy đang dần hình thành trên đồ thị.", "Giá đang tích lũy trong một biên độ hẹp.", "Biến động CHANGE% tạo ra biên độ dao động lớn.", "Các chỉ báo kỹ thuật đang tiến sát vùng quá mua.", "Kháng cự ngắn hạn đang ngăn cản đà tăng trưởng.", "Lực cầu bắt đáy xuất hiện mạnh mẽ khi giá giảm.",
    "Thị trường đang chờ đợi một cú hích từ tin tức.", "Sự dịch chuyển của dòng tiền đang ưu ái mã này.", "Dấu hiệu rút râu cho thấy lực từ chối giá phía dưới.", "Các đường trung bình động đang bắt đầu cắt nhau.", "Chỉ số RSI cho thấy vẫn còn dư địa để tăng.", "Mô hình nến nhấn chìm xuất hiện ở khung H4.", "Sự phân kỳ kín đang báo hiệu tiếp diễn xu hướng.", "Vùng giá này đóng vai trò là hỗ trợ tâm lý quan trọng.", "Cần chú ý đến các lệnh mua lớn vừa được thực hiện.", "Giá đang bám sát dải trên của Bollinger Bands.",
    "Một cú breakout giả có thể vừa mới xảy ra.", "Thị trường phái sinh đang có OI tăng đột biến.", "Tỷ lệ Long/Short đang nghiêng hẳn về một phía.", "Hành động giá cho thấy sự lưỡng lự của các trader.", "Vùng thanh khoản phía trên là mục tiêu tiếp theo.", "Giá đang kiểm tra lại vùng phá vỡ trước đó.", "Lực bán chủ động đang có dấu hiệu chậm lại.", "Sự tích lũy này thường dẫn đến một biến động mạnh.", "Các mốc fibonacci đang cho thấy điểm xoay chiều.", "Cấu trúc đỉnh sau cao hơn đỉnh trước vẫn duy trì.",
    "Thị trường đang phản ánh đúng các thông tin cơ bản.", "Dòng vốn đang xoay vòng từ các Altcoin sang đây.", "Giá đã thoát khỏi kênh giảm giá dài hạn.", "Lượng cung trên sàn đang giảm dần là tín hiệu tốt.", "Cần cẩn thận với các bẫy giá trong khung nhỏ.", "Lực hồi phục này cần thêm khối lượng để xác nhận.", "Điểm entry này mang lại tỷ lệ R/R rất hấp dẫn.", "Giá đang giao dịch trên các mốc hỗ trợ then chốt.", "Dấu hiệu gom hàng của cá voi đang khá rõ nét.", "Nhịp điều chỉnh này là cần thiết để đi xa hơn.",
    "Sự giao thoa của nhiều chỉ báo tại mốc giá này.", "Cú đẩy giá vừa rồi đã quét hết các lệnh short.", "Thị trường đang trong trạng thái cực kỳ hưng phấn.", "Cần một sự xác nhận rõ ràng hơn từ nến đóng cửa.", "Biên độ dao động đang thu hẹp dần theo mô hình nêm.", "Dòng tiền thông minh đang hoạt động.", "Vùng giá này là nơi tập trung nhiều lệnh chờ mua.", "Xu hướng chính vẫn đang được bảo toàn rất tốt.", "Lực bán từ các thợ đào dường như đã hạ nhiệt.", "Mức giá này phản ánh kỳ vọng tích cực từ nhà đầu tư.",
    "Chỉ số tham lam đang tăng cao quanh mức giá này.", "Thị trường đang hấp thụ tốt lượng cung trôi nổi.", "Vùng mây Ichimoku đang cho thấy sự hỗ trợ tốt.", "Giá đang cố gắng bứt phá khỏi đường xu hướng giảm.", "Lực mua đang áp đảo hoàn toàn trong các phiên gần đây.", "Sự giao cắt vàng của các đường MA đã xuất hiện.", "Thị trường đang chuyển sang trạng thái tích lũy đi ngang.", "Cần phá vỡ mốc này để xác nhận xu hướng tăng dài hạn.", "Áp lực tâm lý đang đè nặng lên các lệnh Long.", "Vùng supply cũ đang được test lại liên tục.",
    "Khối lượng giao dịch mua chủ động chiếm 70%.", "Giá đang hình thành mô hình vai đầu vai ngược.", "Sự biến động này có thể quét sạch đòn bẩy cao.", "Lực mua tại các vùng giá thấp vẫn rất bền bỉ.", "Giá đang ở trạng thái nén cực độ chờ bùng nổ.", "Tin tức tốt đang bắt đầu rò rỉ ra thị trường.", "Sự hoảng loạn của phe bán là cơ hội cho phe mua.", "Thanh khoản đang mỏng dần khiến biên độ giá giãn rộng.", "Vùng hỗ trợ cứng đã được thiết lập rất vững chắc.", "Mọi sự chú ý đều đổ dồn về cây nến đóng cửa hôm nay.",
    "Dòng vốn từ các quỹ lớn đang có sự dịch chuyển nhẹ.", "Cơ hội lướt sóng ngắn hạn đang hiện rõ trên chart.", "Tỷ lệ Funding Rate đang ở mức cực kỳ hấp dẫn.", "Giá đang bám sát đường kênh giá tăng trưởng.", "Sự kiện sắp tới sẽ là chất xúc tác cho mức giá này.", "Lực cầu ẩn đang xuất hiện âm thầm.", "Giá đã hoàn thành nhịp chỉnh sóng Elliott.", "Sự đồng thuận của thị trường đang tăng lên.", "Cần vượt qua vùng cản này để tiến tới target xa hơn.", "Thị trường đang có dấu hiệu hạ nhiệt sau đợt tăng nóng.",
    "Vùng entry này cực kỳ an toàn cho các holder.", "Giá đang được đẩy lên một cách có chủ đích.", "Sự phân phối đang diễn ra ở các khung giờ lớn.", "Cần kiên nhẫn đợi giá retest lại vùng hỗ trợ.", "Mô hình cờ tăng đang được hoàn thiện dần.", "Lực mua từ các sàn DEX đang tác động lên giá.", "Sự biến động của BTC đang chi phối mã này.", "Tâm lý trader đang dần chuyển sang lạc quan.", "Giá đang tiệm cận vùng đỉnh của năm.", "Dấu hiệu đảo chiều đang dần xuất hiện trên RSI.",
    "Khung H1 đang cho thấy một sự bứt phá tiềm năng.", "Lượng Open Interest tăng mạnh xác nhận xu hướng.", "Mô hình mây Ichimoku đang hỗ trợ cho đà tăng.", "RSI đang ở vùng trung tính, sẵn sàng cho move mới.", "Dải Bollinger đang co thắt cực độ.", "Giá đang retest lại đường xu hướng giảm trung hạn.", "Vùng tích lũy này đã kéo dài hơn 48 giờ.", "Thanh khoản tập trung dày đặc ở ngay mốc Entry.", "Phe bò đang bảo vệ rất tốt mốc giá quan trọng.", "Cấu trúc sóng đẩy đang bước vào giai đoạn cuối."
];

const closings = [
    "Chúc anh em có một ngày giao dịch thắng lợi!", "Quản lý vốn là chìa khóa để sống sót lâu dài.", "Đừng quên đặt Stop Loss để bảo vệ tài khoản.", "Hãy luôn tỉnh táo trước mọi biến động.", "Lợi nhuận sẽ đến với người kiên nhẫn.", "Kỷ luật thép sẽ tạo nên lợi nhuận bền vững.", "Cảm ơn anh em đã theo dõi nhận định này.", "Hẹn gặp lại ở những kèo chất lượng tiếp theo.", "Thị trường luôn đúng, hãy đi theo xu hướng.", "Không nên FOMO khi giá đã chạy quá xa.",
    "Giao dịch an toàn và luôn giữ cái đầu lạnh.", "Chúc may mắn với các vị thế đã mở!", "Theo dõi mình để không bỏ lỡ tín hiệu nào.", "Cùng chia sẻ quan điểm của bạn ở dưới nhé.", "Trade ít nhưng chất lượng, đó là bí quyết.", "Hy vọng bài viết mang lại thông tin hữu ích.", "Thị trường Crypto luôn đầy rẫy cơ hội.", "Hãy tự chịu trách nhiệm với túi tiền của mình.", "Đi volume hợp lý là cách tốt nhất để ngủ ngon.", "Sẵn sàng cho những nhịp sóng tiếp theo thôi!",
    "Đừng để cảm xúc chi phối việc vào lệnh.", "Học cách chấp nhận thua lỗ để thắng lớn hơn.", "Bình tĩnh, tự tin và quyết đoán khi giao dịch.", "Mục tiêu là tích lũy chứ không phải đánh bạc.", "Chúc anh em 'về bờ' và có lợi nhuận đậm.", "Mọi phân tích chỉ mang tính chất tham khảo.", "Hãy kiểm chứng lại trước khi giao dịch.", "Trading là một hành trình, không phải cuộc đua.", "Kiên nhẫn chờ đợi điểm entry hoàn hảo nhất.", "Cắt lỗ đúng lúc là chiến thắng bản thân.",
    "Tập trung vào kế hoạch, bỏ qua tiếng ồn.", "Giữ vững tâm lý trước những cú rũ hàng.", "Lợi nhuận chỉ dành cho người có chuẩn bị.", "Chúc mừng anh em đã chốt lời thành công!", "Đừng bao giờ tất tay vào một vị thế duy nhất.", "Thị trường sẽ luôn cho bạn cơ hội thứ hai.", "Hãy là một trader thông minh và có chiến thuật.", "Ghi chép nhật ký giao dịch để tiến bộ hơn.", "Tiền trong túi mình mới thực sự là tiền.", "Chốt lời không bao giờ sai, hãy ghi nhớ.",
    "Tận hưởng hành trình chinh phục thị trường.", "Hãy coi trading là một công việc nghiêm túc.", "Học hỏi từ sai lầm là cách nhanh nhất.", "Cập nhật kiến thức mỗi ngày để không tụt hậu.", "Thành công không đến sau một đêm.", "Hãy trân trọng từng đồng vốn nhỏ của bạn.", "Sự nhất quán tạo nên sự khác biệt lớn.", "Chúc anh em gặt hái được nhiều lúa!", "Trade safe, stay safe anh em Square!", "Hành trình vạn dặm bắt đầu từ một bước chân.",
    "Hẹn gặp lại anh em ở đỉnh cao lợi nhuận.", "Luôn nhớ quy tắc bảo toàn vốn trước tiên.", "Chúc anh em trader Square đại thắng hôm nay.", "Điểm dừng lỗ là bạn tốt nhất của trader.", "Kiếm tiền từ Crypto cần sự tập trung cao độ.", "Thị trường không có chỗ cho sự vội vàng.", "Hãy để thị trường dẫn dắt thay vì dự đoán.", "Làm chủ tâm lý là làm chủ cuộc chơi.", "Thành quả sẽ xứng đáng với sự nỗ lực của bạn.", "Chúc anh em một mùa Bull-run rực rỡ.",
    "Cẩn trọng là cha đẻ của sự an toàn.", "Lợi nhuận không quan trọng bằng sự bền bỉ.", "Duy trì vị thế tốt là chiến thắng một nửa.", "Sẵn sàng cho những biến động lớn phía trước.", "Hãy tin vào phân tích của bản thân mình.", "Tận dụng mọi nhịp điều chỉnh để tối ưu hóa.", "Crypto là cuộc chơi của những cái đầu lạnh.", "Hãy là người cuối cùng ở lại với thị trường.", "Chúc anh em thu hoạch thật nhiều xanh.", "Chào tạm biệt và hẹn gặp lại sớm!",
    "Hãy luôn theo dõi sát sao lệnh của mình.", "Thành công chỉ dành cho người kỷ luật.", "Chúc anh em Square một ngày bùng nổ.", "Trading là nghệ thuật quản trị rủi ro.", "Đừng để một lệnh thua làm hỏng kế hoạch.", "Kiên định với chiến lược đã đề ra.", "Hẹn gặp lại ở những mốc giá cao hơn.", "Chúc anh em trading không tâm lý.", "Thị trường luôn có cơ hội cho người kiên trì.", "Cùng nhau chinh phục thị trường này nhé!"
];

// --- HÀM TẠO NỘI DUNG ---
function generateFinalContent(coin, price, change) {
    const entry = smartRound(price);
    const isUp = parseFloat(change) >= 0;
    const tp1 = smartRound(isUp ? entry * 1.03 : entry * 0.97);
    const tp2 = smartRound(isUp ? entry * 1.08 : entry * 0.92);
    const sl = smartRound(isUp ? entry * 0.95 : entry * 1.05);

    const intro = intros[Math.floor(Math.random() * intros.length)].replace("COIN", coin);
    const body = bodies[Math.floor(Math.random() * bodies.length)].replace("CHANGE%", `${change}%`);
    const closing = closings[Math.floor(Math.random() * closings.length)];

    const text = `🔥 [MARKET SIGNAL]: ${coin}\n\n` +
                 `${intro}\n\n` +
                 `${body}\n\n` +
                 `📍 ENTRY: ${entry}\n` +
                 `🎯 TP1: ${tp1}\n` +
                 `🎯 TP2: ${tp2}\n` +
                 `🛡 SL: ${sl}\n\n` +
                 `${closing}`;

    const randomSelection = coinQueue
        .filter(c => c.symbol !== coin)
        .sort(() => 0.5 - Math.random())
        .slice(0, 5);

    return {
        body: text,
        dollarTags: [coin, randomSelection[0]?.symbol || "BTC", randomSelection[1]?.symbol || "ETH"],
        hashTags: [coin, randomSelection[2]?.symbol || "BNB", randomSelection[3]?.symbol || "SOL"]
    };
}

// --- LOGIC TRÌNH DUYỆT ---
async function initBrowser(show = false) {
    if (context) {
        try { await context.pages(); return context; } catch (e) { context = null; }
    }
    context = await chromium.launchPersistentContext(userDataDir, {
        headless: !show,
        viewport: { width: 1280, height: 800 },
        args: ['--disable-blink-features=AutomationControlled', '--no-sandbox']
    });
    return context;
}

async function ensureMainPage() {
    const ctx = await initBrowser(false);
    if (!mainPage || mainPage.isClosed()) {
        mainPage = await ctx.newPage();
        await mainPage.goto('https://www.binance.com/vi/square', { waitUntil: 'domcontentloaded' });
        await mainPage.waitForTimeout(5000);
    }
    return mainPage;
}

async function postTaskWithForce() {
    if (!isRunning) return;
    
    if (coinQueue.length === 0) {
        try {
            logStep("📊 Lấy danh sách Futures (Giá cao -> thấp)...");
            const res = await axios.get('https://fapi.binance.com/fapi/v1/ticker/24hr');
            coinQueue = res.data
                .filter(c => c.symbol.endsWith('USDT'))
                .map(c => ({ 
                    symbol: c.symbol.replace('USDT', ''), 
                    price: c.lastPrice, 
                    change: c.priceChangePercent 
                }))
                .sort((a, b) => parseFloat(b.price) - parseFloat(a.price));
            logStep(`✅ Nạp thành công ${coinQueue.length} coin.`);
        } catch (e) { logStep("❌ Lỗi API: " + e.message); return; }
    }

    const currentCoin = coinQueue.shift();
    if (!currentCoin) return;

    let page;
    try {
        page = await ensureMainPage();
        const content = generateFinalContent(currentCoin.symbol, currentCoin.price, currentCoin.change);

        const textbox = await page.locator('div[contenteditable="true"], div[role="textbox"]').first();
        logStep(`📝 Soạn bài cho $${currentCoin.symbol}`);
        await textbox.click();
        await page.waitForTimeout(2000);

        await page.keyboard.press('Control+A');
        await page.keyboard.press('Backspace');

        await page.keyboard.type(content.body, { delay: 2 });
        await page.keyboard.press('Enter');
        await page.keyboard.press('Enter');

        for (const symbol of content.dollarTags) {
            await page.keyboard.type(`$${symbol}`, { delay: 2 });
            await page.waitForTimeout(1000); 
            await page.keyboard.press('Enter');
            await page.keyboard.type(' ', { delay: 2 }); 
        }

        await page.keyboard.press('Enter');
        for (const symbol of content.hashTags) {
            await page.keyboard.type(`#${symbol}`, { delay: 2 });
            await page.waitForTimeout(1000);
            await page.keyboard.press('Enter');
            await page.keyboard.type(' ', { delay: 2 });
        }

        await page.waitForTimeout(3000);

        const postBtn = await page.locator('button').filter({ hasText: /^Đăng$|^Post$/ }).last();
        if (await postBtn.isEnabled()) {
            await postBtn.click();
            logStep(`🎯 Đã đăng xong $${currentCoin.symbol}. Nghỉ 15s...`);
            await page.waitForTimeout(5000);
            totalPosts++;
            history.unshift({ coin: currentCoin.symbol, time: new Date().toLocaleTimeString(), status: 'Thành công' });
        }
    } catch (err) {
        logStep(`❌ Lỗi: ${err.message}`);
        if (currentCoin) coinQueue.push(currentCoin);
    }
}

async function startLoop() {
    while (isRunning) {
        try {
            await postTaskWithForce();
        } catch (err) {
            logStep("❌ LOOP CRASH: " + err.message);
            context = null;
            mainPage = null;
        }

        if (isRunning) {
            for (let i = 0; i < 15 && isRunning; i++) {
                await new Promise(r => setTimeout(r, 1000));
            }
        }
    }
}

// --- CÁC ROUTE API ---

// Trang chủ gửi file index.html
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/start', (req, res) => {
    if (!isRunning) { isRunning = true; logStep("🏁 BẮT ĐẦU"); startLoop(); }
    res.json({ status: 'started' });
});

app.get('/stop', async (req, res) => {
    isRunning = false; logStep("🛑 DỪNG");
    if (context) { await context.close().catch(() => {}); context = null; }
    mainPage = null;
    res.json({ status: 'stopped' });
});

app.get('/stats', (req, res) => res.json({ isRunning, totalPosts, history, userInfo }));

// Route để HTML gọi kiểm tra trạng thái Acc
app.get('/check', async (req, res) => {
    try {
        const page = await ensureMainPage();
        // Giả lập lấy tên từ giao diện nếu đã login
        const nameNode = await page.locator('.bn-avatar + div, [class*="userName"]').first();
        if (await nameNode.isVisible()) {
            userInfo.name = await nameNode.innerText();
            userInfo.status = "Online";
        }
    } catch (e) {}
    res.json(userInfo);
});

app.get('/login', async (req, res) => {
    if (context) { await context.close(); context = null; }
    const ctx = await initBrowser(true);
    const p = await ctx.newPage();
    await p.goto('https://www.binance.com/vi/square');
    res.send("Đã mở trình duyệt. Hãy đăng nhập trên cửa sổ Chrome vừa hiện ra, sau đó quay lại trang quản lý.");
});

app.listen(port, '0.0.0.0', async () => {
    logStep(`SERVER MỞ TẠI PORT: ${port}`);
    // Tự động chạy nếu cần
    // isRunning = true; startLoop();
});
