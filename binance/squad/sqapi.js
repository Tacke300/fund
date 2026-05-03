import WebSocket from 'ws';
import express from 'express';
import axios from 'axios';
import Binance from 'node-binance-api';
import { API_KEY, SECRET_KEY } from './config.js'; 

const PORT = 8888;
const SQUAD_API_KEY = "8d794c11cc794c958c2c65924c54f2dd"; 

const binance = new Binance().options({
    APIKEY: API_KEY,
    APISECRET: SECRET_KEY,
    family: 4,
    useServerTime: true 
});

const SETTINGS = {
    SQUARE_URL: "https://www.binance.com/bapi/composite/v1/public/pgc/openApi/content/add",
    VOL_LIMIT: 7.0,    
    DAY_LIMIT: 10.0,   
    MAX_TOTAL: 100,
    TYPE_LIMIT: 33, 
    MIN_GAP: 60000, 
};

const BANK = {
    P1: [
        "🔥 Dòng tiền thông minh đang đổ mạnh vào hệ sinh thái này.", "🐳 Dữ liệu on-chain cho thấy cá voi đang gom hàng.",
        "🚀 Một đợt bùng nổ khối lượng giao dịch vừa được ghi nhận.", "📊 Chỉ số tích lũy đang ở mức cao nhất trong nhiều tuần.",
        "⚡ Tín hiệu dòng tiền đang tập trung vào nhóm dẫn dắt thị trường.", "💎 Đây là thời điểm vàng để quan sát các vị thế tiềm năng.",
        "📈 Xu hướng tăng trưởng dài hạn đang được củng cố vững chắc.", "🌟 Một dự án tiềm năng đang nhận được sự chú ý đặc biệt.",
        "🔍 Phân tích dòng tiền cho thấy áp lực mua đang áp đảo.", "💡 Cơ hội đang mở ra cho những ai nắm bắt được xu hướng.",
        "🔥 Sức nóng của thị trường đang tập trung vào khu vực này.", "🦾 Lực mua chủ động tăng vọt tại các vùng hỗ trợ quan trọng.",
        "📡 Hệ thống cảnh báo sớm vừa kích hoạt tín hiệu gom hàng.", "🏦 Các tổ chức lớn dường như đang bắt đầu giải ngân.",
        "💸 Khối lượng giao dịch đột biến so với trung bình 24 giờ.", "🛰️ Quỹ đạo giá đang di chuyển vào vùng tích lũy tích cực.",
        "🔋 Năng lượng tăng trưởng đang được nạp đầy cho chu kỳ tới.", "🧩 Các mảnh ghép của một đợt tăng giá đang dần hoàn thiện.",
        "🥇 Top những đồng coin dẫn đầu về tỉ lệ thu hút vốn.", "🎯 Mục tiêu tăng trưởng đang được các trader chuyên nghiệp hướng tới.",
        "🕯️ Nến ngày đóng đẹp cho thấy tâm lý lạc quan đang quay lại.", "🎢 Bất chấp biến động, dòng tiền vẫn giữ vững vị thế.",
        "⚔️ Cuộc chiến giữa phe bò và phe gấu đang dần ngã ngũ.", "🛡️ Vùng hỗ trợ cứng đã được kiểm chứng thành công.",
        "🔭 Tầm nhìn trung hạn đang mở rộng với nhiều triển vọng.", "🌈 Thị trường đang chuyển mình sang giai đoạn khởi sắc.",
        "📢 Tin tức tích cực đang hỗ trợ mạnh cho đà tăng giá.", "🔔 Chuông báo động cho một đợt sóng mới đã vang lên.",
        "🧱 Nền tảng giá vững chắc đang được xây dựng rất bài bản.", "🏗️ Quá trình tích lũy đã diễn ra đủ lâu để bứt phá.",
        "🏎️ Tốc độ giao dịch đang được đẩy lên mức cực cao.", "🔋 Pin của phe mua đang cực khỏe ở thời điểm hiện tại.",
        "⛈️ Sau cơn mưa trời lại sáng, cơ hội đang trở lại.", "⚓ Neo đậu tại vùng giá thấp, phe mua bắt đầu hành động.",
        "🧠 Tư duy cá mập đang dẫn dắt cuộc chơi này.", "👣 Theo dấu chân người khổng lồ để tìm kiếm lợi nhuận.",
        "🧪 Công thức thành công đang nằm ở việc theo sát dòng tiền.", "🧬 Mã gen của một siêu phẩm đang dần lộ diện.",
        "🌋 Núi lửa dòng tiền chuẩn bị phun trào mạnh mẽ.", "🌌 Một bầu trời cơ hội đang mở rộng trước mắt chúng ta.",
        "🧭 Kim chỉ nam cho giao dịch hôm nay chính là đây.", "🗝️ Chìa khóa mở ra cánh cửa lợi nhuận đã xuất hiện.",
        "🪄 Phép màu của lãi suất kép bắt đầu từ những cơ hội này.", "🛸 Phi thuyền tăng trưởng đã sẵn sàng rời bệ phóng.",
        "🌊 Làn sóng mua vào đang lan tỏa khắp thị trường.", "🌋 Sức ép tăng giá đang tích tụ dưới lòng đất.",
        "🦾 Sự kiên cường của phe mua đang mang lại thành quả.", "🎨 Bức tranh thị trường đang được tô điểm bởi sắc xanh.",
        "🎼 Bản giao hưởng tăng giá đang bắt đầu những nốt đầu tiên.", "🎭 Mặt nạ của phe bán đã bị gỡ bỏ, phe mua làm chủ.",
        "🔮 Tương lai của đợt sóng này đang rất rộng mở.", "🧿 Tầm nhìn xuyên thấu thị trường giúp ta thấy rõ cơ hội.",
        "🧿 Sự hội tụ của các chỉ báo đang ủng hộ phe tăng.", "🕯️ Thắp sáng hy vọng với những tín hiệu tích cực nhất.",
        "🛠️ Công cụ phân tích đang chỉ về hướng tăng trưởng.", "🧪 Phản ứng hóa học giữa cung và cầu đang tạo ra đột phá.",
        "🧬 Cấu trúc thị trường đang thay đổi theo hướng tích cực.", "📈 Biểu đồ đang vẽ nên một câu chuyện đầy hứa hẹn.",
        "📉 Kháng cự cũ đang dần trở thành hỗ trợ mới.", "🚩 Lá cờ chiến thắng đang vẫy gọi phe mua.",
        "🏰 Lâu đài giá đang được xây dựng trên nền móng tốt.", "⛲ Nguồn vốn đang chảy vào như suối nguồn không tận.",
        "💎 Viên kim cương thô này đang chờ ngày tỏa sáng.", "🪵 Củi đã sẵn, chỉ chờ mồi lửa của dòng tiền lớn.",
        "🌬️ Làn gió mới đang thổi bùng ngọn lửa thị trường.", "🚜 Sự lầm lũi của phe gom hàng sẽ sớm được đền đáp.",
        "🚲 Khởi động chậm nhưng sẽ tăng tốc rất nhanh.", "🚆 Con tàu cao tốc lợi nhuận đang vào ga đón khách.",
        "🚁 Góc nhìn từ trên cao cho thấy toàn cảnh đà tăng.", "🛰️ Kết nối với những tín hiệu mạnh mẽ nhất từ sàn.",
        "📱 Thông báo về một đợt sóng lớn đang được gửi đi.", "💻 Thuật toán đang ưu tiên các vị thế mua vào.",
        "🧬 Hệ sinh thái đang phát triển cực kỳ mạnh mẽ.", "🍀 Sự may mắn luôn đến với người chuẩn bị kỹ càng.",
        "🌠 Một ngôi sao mới đang trỗi dậy trên bảng điện tử.", "🌅 Bình minh của một chu kỳ mới đang bắt đầu.",
        "🏙️ Thành phố giá đang nhộn nhịp trở lại sau kỳ nghỉ.", "🏖️ Tận hưởng cảm giác chiến thắng cùng thị trường.",
        "🎆 Pháo hoa lợi nhuận chuẩn bị thắp sáng màn đêm.", "🧨 Mồi lửa đã cháy, chuẩn bị cho cú nổ lớn.",
        "📦 Hàng hóa đang được đóng gói chuẩn bị vận chuyển.", "🚛 Những lô hàng lớn đang được di chuyển về ví cá voi.",
        "🏢 Tòa nhà lợi nhuận đang được xây thêm tầng mới.", "🏟️ Sân vận động giao dịch đang nóng hơn bao giờ hết.",
        "🏛️ Giá trị cốt lõi đang được thị trường định giá lại.", "🛖 Sự đơn giản trong chiến lược mang lại hiệu quả cao.",
        "⛰️ Đỉnh cao mới đang chờ đợi chúng ta chinh phục.", "🌋 Sức mạnh nội tại của dự án là không thể phủ nhận.",
        "🕹️ Cuộc chơi đang nằm trong tầm kiểm soát của chúng ta.", "🎮 Game này phe mua đang nắm lợi thế tuyệt đối.",
        "🎲 Xúc xắc đã đổ, và phần thắng nghiêng về phe bò.", "🃏 Lá bài tẩy của thị trường vừa mới được lật lên.",
        "🎈 Bong bóng nỗi sợ đã vỡ, nhường chỗ cho sự tự tin.", "🪄 Mọi thứ đang diễn ra đúng như kịch bản dự tính.",
        "🧘 Bình thản trước biến động để gặt hái thành công.", "🥇 Vị thế dẫn đầu đang được khẳng định mạnh mẽ.",
        "🥈 Sự bám đuổi quyết liệt tạo nên động lực tăng.", "🥉 Nền tảng vững chắc từ vị trí thấp nhất.",
        "🏁 Về đích với lợi nhuận tối ưu là mục tiêu cuối.", "🚩 Lá cờ dẫn đầu đang thuộc về nhóm ngành này."
    ],
    P2: [
        "📐 Về kỹ thuật giá đã bứt phá khỏi kênh giảm giá.", "🪄 Đường EMA đang thực hiện cú cắt vàng báo hiệu tăng.",
        "📊 RSI đang thoát khỏi vùng quá bán một cách mạnh mẽ.", "🕯️ Mô hình nến nhấn chìm tăng trưởng vừa xuất hiện.",
        "🌀 Bollinger Bands đang co thắt chuẩn bị cho biến động.", "📐 Fibonacci đang hỗ trợ cực tốt tại vùng 0.618.",
        "📈 Khối lượng xác nhận đà tăng (Volume Confirmation).", "📉 Phân kỳ kín (Hidden Divergence) báo hiệu tiếp diễn.",
        "🧱 Vùng cung (Supply zone) đã bị hấp thụ hoàn toàn.", "🧱 Vùng cầu (Demand zone) đang giữ giá cực kỳ tốt.",
        "📊 MACD vừa cắt lên trên đường tín hiệu (Signal line).", "🏹 Giá đang bám sát dải trên của hệ thống xu hướng.",
        "🏔️ Mô hình hai đáy (Double Bottom) đã hoàn thiện.", "⛰️ Mô hình vai đầu vai ngược đang hình thành rõ nét.",
        "🎢 Sóng Elliot đang đi vào giai đoạn sóng 3 đẩy mạnh.", "🛑 Lệnh bán giải chấp đã cạn kiệt trên bảng điện.",
        "🔋 Chỉ số sức mạnh tương đối đang hướng về vùng 70.", "🕯️ Pinbar rút chân cho thấy lực mua cực mạnh tại hỗ trợ.",
        "📏 Khoảng cách giữa các đường trung bình đang mở rộng.", "🎯 Target ngắn hạn đang nằm trong tầm tay.",
        "🏹 Mũi tên xu hướng đang chỉ thẳng lên phía trên.", "🧪 Các chỉ báo dao động đều cho tín hiệu đồng thuận.",
        "🔗 Sự liên kết giữa các khung thời gian rất chặt chẽ.", "📍 Điểm xoay Pivot đang nằm dưới mức giá hiện tại.",
        "🚥 Đèn xanh cho một đợt tăng giá dài hạn đã bật.", "🏁 Sự bứt phá (Breakout) kèm khối lượng lớn.",
        "💎 Cấu trúc thị trường Bullish Structure rất rõ ràng.", "🌊 Dòng tiền đang luân chuyển đúng theo chu kỳ.",
        "🧬 Hệ thống Ichimoku cho thấy giá đã vượt mây Kumo.", "🔭 Các khung giờ lớn đang ủng hộ cho đà tăng.",
        "🏗️ Nền giá phẳng (Flat Base) là bệ phóng cho cú nhảy.", "🧗 Giá đang leo dốc một cách bền vững và ổn định.",
        "🥊 Phe bò đã giành lại quyền kiểm soát hoàn toàn.", "🛡️ Hàng rào bảo vệ giá tại vùng tâm lý rất kiên cố.",
        "🧱 Tường mua lớn đang chặn đứng mọi đợt điều chỉnh.", "🛰️ Tín hiệu từ vệ tinh phân tích đang ở mức tích cực.",
        " toán học đang chứng minh đây là vùng giá rẻ.", "📉 Độ dốc của đường xu hướng đang tăng dần lên.",
        "🔋 Năng lượng tích lũy đủ để phá vỡ mọi kháng cự.", "🌪️ Cơn lốc tăng trưởng đang cuốn phăng phe bán.",
        "⚓ Neo giữ tâm lý ổn định để không mất hàng sớm.", "🧩 Mọi chỉ báo kỹ thuật đang khớp nhau như tranh vẽ.",
        "🕯️ Cụm nến Morning Star báo hiệu bình minh rạng rỡ.", "🌋 Sự bùng nổ vượt ra ngoài mọi dự đoán thông thường.",
        "💎 Tỉ lệ Risk/Reward đang ở mức cực kỳ hấp dẫn.", "📏 Thước đo kỹ thuật cho thấy tiềm năng x2 là có thể.",
        "🥊 Knock-out phe bán chỉ trong một vài nhịp đẩy.", "🏃 Tốc độ di chuyển giá đang nhanh hơn trung bình.",
        "🧗 Đỉnh sau cao hơn đỉnh trước, đáy sau cao hơn đáy.", "🧘 Sự kiên nhẫn đang được đền đáp bằng phân tích đúng.",
        "🧬 Gen tăng trưởng đang lan tỏa mạnh mẽ trong chart.", "🏹 Mục tiêu dài hạn vẫn chưa thay đổi dù có rung lắc.",
        "🎢 Những đợt điều chỉnh nhẹ là cơ hội để gia tăng.", "🔭 Nhìn rộng ra để thấy chúng ta đang ở chân sóng.",
        "📊 Bảng thông số đang hiện màu xanh hy vọng.", "🕯️ Nến Marubozu xác nhận sức mạnh tuyệt đối.",
        "🔩 Vặn chặt các ốc vít quản trị để chuẩn bị bay.", "⚖️ Sự cân bằng đã bị phá vỡ theo hướng có lợi.",
        "🏹 Cung tên đã kéo căng, chỉ chờ thời điểm bung.", "🛠️ Bộ công cụ của trader chuyên nghiệp báo Buy.",
        "🔬 Phân tích chi tiết cho thấy cấu trúc rất bền.", "🧬 Sự tương quan giữa các cặp tiền đang ủng hộ.",
        "📈 Biểu đồ giá đang di chuyển theo mô hình cái nêm.", "📉 Thoát ra khỏi cái nêm giảm là một cú bùng nổ.",
        "🚩 Mô hình lá cờ (Flag Pattern) đang tiếp diễn xu hướng.", "🏗️ Những viên gạch đầu tiên của sóng tăng đã đặt xong.",
        "🏛️ Nền tảng phân tích kỹ thuật là chỗ dựa vững chắc.", "🏔️ Chinh phục các mốc cao hơn một cách thuyết phục.",
        "⛰️ Kháng cự tâm lý đã trở thành bàn đạp cho giá.", "🌋 Dòng dung nham giá đang chảy về vùng cao hơn.",
        "🔌 Kết nối với nguồn năng lượng tăng trưởng mạnh.", "💡 Ánh sáng cuối đường hầm cho những ai nắm giữ.",
        "🔦 Soi rọi vào những góc tối của bảng lệnh để thấy.", "🔍 Chi tiết nhỏ tạo nên sự khác biệt lớn trong trade.",
        "📏 Đo lường dòng tiền thông qua khối lượng cân bằng.", "🧪 Phản ứng tại vùng Flipzone cực kỳ ấn tượng.",
        "🧪 Sự kết hợp giữa Price Action và Volume rất tốt.", "📈 Đường trung bình động 200 ngày đã bị chinh phục.",
        "📉 Áp lực bán tại vùng đỉnh cũ đã biến mất.", "🏗️ Tái cấu trúc danh mục theo hướng tập trung vốn.",
        "🏢 Tòa tháp lợi nhuận đang cao dần theo thời gian.", "🏛️ Sự uy tín của các mô hình giá kinh điển.",
        "🥇 Top 1 các đồng coin có cấu trúc đẹp nhất hiện nay.", "🥈 Duy trì phong độ ổn định qua các khung giờ.",
        "🥉 Nỗ lực không ngừng của phe mua đã có kết quả.", "🥊 Cú đấm quyết định vào vùng kháng cự quan trọng.",
        "🏁 Cán mốc mục tiêu đầu tiên của hành trình.", "🚩 Vẫy cờ chào đón những kỷ lục giá mới.",
        "🧱 Sự kiên cố của vùng hỗ trợ là không thể phá vỡ.", "🧱 Hấp thụ toàn bộ áp lực chốt lời trong ngắn hạn.",
        "💎 Độ lấp lánh của biểu đồ đang thu hút mọi ánh nhìn.", "💎 Tài sản của bạn đang được bảo vệ bởi xu hướng.",
        "🔋 Sạc đầy năng lượng cho những đợt bứt tốc tiếp theo.", "🔋 Không có dấu hiệu suy yếu trong lực đẩy hiện tại.",
        "🚀 Động cơ phản lực của giá đang hoạt động hết công suất.", "🛫 Cất cánh khỏi vùng giá thấp một cách dứt khoát.",
        "🛰️ Theo dõi sát sao từng biến động nhỏ nhất.", "🧭 Không bao giờ lạc lối khi có kế hoạch kỹ thuật."
    ],
    P3: [
        "📝 Kế hoạch tối ưu là kiên nhẫn chờ điểm vào lệnh đẹp.", "🛡️ Quản trị rủi ro bằng cách đặt dừng lỗ tuyệt đối.",
        "💰 Chia vốn vào lệnh theo chiến lược DCA thông minh.", "🔒 Bảo vệ lợi nhuận bằng cách dời SL về điểm hòa vốn.",
        "🧘 Tâm lý vững vàng là chìa khóa của mọi thành công.", "⏳ Đừng vội vàng, cơ hội luôn còn đó trên thị trường.",
        "📊 Luôn tuân thủ kỷ luật giao dịch dù có chuyện gì.", "🚀 Mục tiêu là lợi nhuận bền vững chứ không phải nhất thời.",
        "💡 Hãy nhớ: 'Lợi nhuận đi đôi với sự kiên nhẫn'.", "💎 Giữ chặt vị thế để không bị rớt hàng giữa sóng.",
        "🔍 Quan sát kỹ phản ứng giá tại các vùng quan trọng.", "📈 Tận dụng lãi suất kép để tối đa hóa tài sản.",
        "📉 Không bao giờ 'all-in' vào một vị thế duy nhất.", "🧠 Luôn giữ một cái đầu lạnh trước mọi biến động.",
        "⚖️ Cân bằng giữa lòng tham và nỗi sợ hãi cá nhân.", "🎯 Chỉ vào lệnh khi tất cả các điều kiện đã thỏa mãn.",
        "🛠️ Sử dụng các công cụ hỗ trợ để kiểm tra lại tín hiệu.", "📝 Ghi chép nhật ký giao dịch để học từ sai lầm.",
        "🌟 Thành công đến từ việc lặp đi lặp lại những việc đúng.", "🛡️ Ưu tiên hàng đầu là bảo vệ vốn của chính mình.",
        "💰 Tiền chỉ chuyển từ túi người vội vàng sang người kiên nhẫn.", "🧘 Ngồi yên cũng là một loại kỹ năng trong trading.",
        "🚪 Biết lúc nào nên vào và khi nào nên rút lui.", "🗺️ Bản đồ lợi nhuận đã có, chỉ cần đi đúng hướng.",
        "🌊 Thuận theo xu hướng là cách dễ nhất để kiếm tiền.", "🌪️ Tránh xa những lúc thị trường đang hỗn loạn.",
        "🧩 Ghép các mảnh ghép thông tin để có bức tranh tổng quát.", "📡 Lắng nghe nhịp đập của thị trường mỗi giây.",
        "🔌 Ngắt kết nối khi tâm lý không còn được ổn định.", "💡 Một ý tưởng tốt cần thời gian để đơm hoa kết trái.",
        "🏗️ Xây dựng danh mục đầu tư đa dạng và an toàn.", "🏛️ Đầu tư vào kiến thức là khoản đầu tư sinh lời nhất.",
        "🏢 Mở rộng quy mô khi chiến thắng đang đứng về phía bạn.", "🥊 Sẵn sàng chiến đấu nhưng không bao giờ liều lĩnh.",
        "🥇 Hãy là người chiến thắng trong cuộc đua dài hạn.", "🏁 Đích đến còn xa, hãy bảo trọng sức lực và vốn.",
        "🏔️ Leo lên đỉnh cao cần sự bền bỉ hơn là tốc độ.", "⛰️ Mỗi bước chân đều phải vững chãi trên nền tảng quản trị.",
        "🌋 Đừng để cảm xúc bùng nổ làm hỏng kế hoạch ban đầu.", "🎢 Thị trường là trò chơi của những con số và xác suất.",
        "🎲 Đặt cược vào những nơi có tỉ lệ thắng cao nhất.", "🃏 Đừng bao giờ để lộ bài khi chưa đến lúc quyết định.",
        "🎈 Giữ cho tâm hồn nhẹ nhàng trước những cú sụt giảm.", "🪄 Phép màu sẽ đến với những ai tin vào hệ thống của mình.",
        "🧿 Nhìn thấu bản chất của những đợt rung rũ hàng.", "🕯️ Thắp sáng con đường bằng sự hiểu biết sâu sắc.",
        "🔭 Phóng tầm mắt ra xa để không bị rối bởi nến ngắn hạn.", "🔬 Tập trung vào tiểu tiết để lọc ra những nhiễu loạn.",
        "🧬 Mã hóa thành công bằng kỷ luật thép mỗi ngày.", "📈 Xu hướng là bạn, đừng bao giờ chống lại bạn mình.",
        "📉 Chấp nhận thua lỗ nhỏ để tránh những cú sập lớn.", "🔩 Siết chặt kỷ luật như siết chặt một con ốc vít.",
        "⚖️ Cân nhắc kỹ lưỡng trước khi nhấn nút đặt lệnh.", "🏹 Bắn trúng mục tiêu nhờ sự chuẩn bị kỹ càng.",
        "🛠️ Công cụ tốt giúp trader làm việc nhàn hạ hơn.", "🧪 Thử nghiệm chiến lược trên vốn nhỏ trước khi đánh lớn.",
        "🧬 Sự ổn định là yếu tố quyết định sự tồn tại.", "📉 Đừng bao giờ trung bình giá xuống trong một xu hướng giảm.",
        "📈 Hãy để lợi nhuận chạy và cắt lỗ thật nhanh chóng.", "🚩 Luôn có phương án dự phòng cho mọi tình huống xấu.",
        "🏗️ Nền tảng tốt sẽ giúp bạn vượt qua mọi cơn bão.", "🏛️ Sự chuyên nghiệp thể hiện qua cách bạn quản lý rủi ro.",
        "🏢 Từng bước xây dựng đế chế tài chính của riêng bạn.", "🏟️ Hãy tỏa sáng như một ngôi sao trên sàn giao dịch.",
        "💎 Giá trị của sự chờ đợi đôi khi là vô giá.", "🪵 Đốt cháy nỗi sợ bằng ngọn lửa của tri thức.",
        "🌬️ Đón nhận những thay đổi của thị trường một cách chủ động.", "🚜 Cần mẫn tích lũy lợi nhuận mỗi ngày một ít.",
        "🚲 Đi chậm mà chắc còn hơn chạy nhanh mà ngã.", "🚆 Đừng bỏ lỡ chuyến tàu của cuộc đời mình.",
        "🚁 Bay cao cùng những giấc mơ về tự do tài chính.", "🛰️ Kết nối với cộng đồng để cùng nhau phát triển.",
        "📱 Cập nhật thông tin nhưng lọc bỏ những tin rác.", "💻 Công nghệ là trợ thủ đắc lực trong kỷ nguyên số.",
        "🧬 Hiểu rõ luật chơi trước khi tham gia đặt cược.", "🍀 May mắn chỉ dành cho người có sự chuẩn bị tốt nhất.",
        "🌠 Hướng về những vì sao để chạm tới những đỉnh cao.", "🌅 Mỗi ngày mới là một cơ hội mới để bắt đầu lại.",
        "🏙️ Nhìn vào thành công của người khác để làm động lực.", "🏖️ Phần thưởng cuối cùng là sự tự do và thảnh thơi.",
        "🎆 Thành công không dành cho số đông lười biếng.", "🧨 Đừng để sự nôn nóng phá hủy mọi công sức tích lũy.",
        "📦 Đóng gói lợi nhuận và rút về tài khoản định kỳ.", "🚛 Vận chuyển thành quả về cho gia đình và người thân.",
        "🏢 Đầu tư vào tương lai bằng những quyết định hôm nay.", "🏟️ Sân chơi này công bằng cho tất cả mọi người.",
        "🏛️ Uy tín cá nhân được xây dựng trên sự trung thực.", "🛖 Tìm kiếm sự bình yên trong chính tâm hồn mình.",
        "⛰️ Khó khăn chỉ là thuốc thử cho lòng kiên nhẫn.", "🌋 Sức mạnh thực sự nằm ở khả năng tự kiểm soát.",
        "🕹️ Làm chủ cuộc chơi, làm chủ vận mệnh chính mình.", "🎮 Trò chơi này bạn là người viết nên luật cho bản thân.",
        "🎲 Xác suất thắng nằm ở sự phân tích kỹ lưỡng.", "🃏 Quân bài cuối cùng luôn là sự bất ngờ thú vị.",
        "🎈 Hãy để nỗi buồn trôi đi như những quả bóng bay.", "🪄 Mọi giấc mơ đều có thể trở thành hiện thực.",
        "🧘 Thiền định để giữ sự tập trung cao độ nhất.", "🥇 Hãy luôn tin rằng mình là người giỏi nhất.",
        "🥈 Khiêm tốn để học hỏi được nhiều hơn mỗi ngày.", "🥉 Trân trọng những bước đi đầu tiên đầy khó khăn.",
        "🏁 Cán đích thành công trong sự ngưỡng mộ của mọi người.", "🚩 Cắm cờ chiến thắng trên mọi thị trường bạn tham gia."
    ],
    P4: [
        "🍻 Chúc anh em có ngày giao dịch bùng nổ lợi nhuận.", "🍀 Hy vọng may mắn mỉm cười với mọi quyết định.",
        "🚀 Hẹn gặp lại các bạn tại những đỉnh cao mới của giá.", "🌟 Chúc cộng đồng chúng ta ngày càng lớn mạnh và giàu có.",
        "🤝 Cảm ơn mọi người đã luôn đồng hành và ủng hộ.", "🔥 Hãy cùng nhau chinh phục thị trường đầy tiềm năng này.",
        "🌈 Một ngày xanh tươi đang chờ đón tất cả chúng ta.", "💪 Mạnh mẽ và quyết đoán để gặt hái thành công lớn.",
        "🎯 Chúc các bạn sớm đạt được mục tiêu tự do tài chính.", "📣 Hãy chia sẻ niềm vui chiến thắng cùng bạn bè nhé.",
        "🔔 Đừng quên theo dõi kênh để nhận thông tin sớm nhất.", "🔋 Chúc anh em luôn tràn đầy năng lượng tích cực.",
        "⚓ Chúc mọi người luôn giữ vững tay lái trên biển lớn.", "🚜 Chăm chỉ gieo hạt để chờ ngày thu hoạch bội thu.",
        "🏗️ Chúc dự án của chúng ta thành công ngoài mong đợi.", "🏢 Chúc sự nghiệp trading của bạn thăng tiến không ngừng.",
        "🏟️ Chúc bạn luôn là người tỏa sáng nhất trên bảng điện.", "🏛️ Chúc gia đình bạn luôn bình an và hạnh phúc.",
        "🥇 Chúc bạn luôn đứng đầu trong mọi cuộc đua tài chính.", "🏁 Chúc mừng những ai đã kiên trì đến tận cuối cùng.",
        "🚩 Chúc lá cờ chiến thắng luôn vẫy chào bạn mỗi ngày.", "💎 Chúc cuộc đời bạn tỏa sáng như những viên kim cương.",
        "🪵 Chúc ngọn lửa đam mê trong bạn không bao giờ tắt.", "🌬️ Chúc bạn luôn thuận buồm xuôi gió trong mọi việc.",
        "🚲 Chúc bạn có một hành trình thú vị và đáng nhớ.", "🚆 Chúc con tàu tài chính của bạn luôn đi đúng hướng.",
        "🚁 Chúc bạn luôn có cái nhìn bao quát và sáng suốt.", "🛰️ Chúc bạn kết nối được với nhiều vận may bất ngờ.",
        "📱 Chúc bạn luôn nhận được những tin vui từ thị trường.", "💻 Chúc hệ thống của bạn vận hành trơn tru và hiệu quả.",
        "🧬 Chúc bạn có một tư duy của nhà đầu tư lỗi lạc.", "🍀 Chúc sự may mắn luôn là người bạn đồng hành của bạn.",
        "🌠 Chúc mọi ước mơ của bạn sớm trở thành hiện thực.", "🌅 Chúc bạn có một khởi đầu mới đầy thuận lợi.",
        "🏙️ Chúc cuộc sống của bạn luôn nhộn nhịp và tươi vui.", "🏖️ Chúc bạn có những kỳ nghỉ dưỡng tuyệt vời sau khi thắng.",
        "🎆 Chúc pháo hoa thành công thắp sáng cuộc đời bạn.", "🧨 Chúc bạn bùng nổ mạnh mẽ như những cú pump của coin.",
        "📦 Chúc bạn thu hoạch được thật nhiều 'quà' từ sàn.", "🚛 Chúc những chuyến hàng lợi nhuận luôn đầy ắp ví.",
        "🏢 Chúc bạn xây dựng được một tương lai vững chắc.", "🏟️ Chúc bạn luôn giữ vững phong độ đỉnh cao của mình.",
        "🏛️ Chúc bạn có được sự tôn trọng từ cộng đồng trader.", "🛖 Chúc bạn luôn tìm thấy niềm vui trong những điều nhỏ bé.",
        "⛰️ Chúc bạn vượt qua mọi thử thách để chạm tới đỉnh.", "🌋 Chúc sức mạnh nội tại giúp bạn chiến thắng tất cả.",
        "🕹️ Chúc bạn làm chủ được mọi tình huống trong trade.", "🎮 Chúc bạn tận hưởng cuộc chơi này một cách trọn vẹn.",
        "🎲 Chúc những con số may mắn luôn thuộc về phía bạn.", "🃏 Chúc bạn luôn nắm trong tay những quân bài chiến thắng.",
        "🎈 Chúc mọi phiền muộn của bạn tan biến vào hư không.", "🪄 Chúc điều kỳ diệu sẽ đến với tài khoản của bạn.",
        "🧘 Chúc bạn có được sự tĩnh lặng trong tâm hồn.", "🥇 Chúc bạn đạt được những kỷ lục cá nhân mới.",
        "🥈 Chúc bạn luôn có sự tiến bộ vượt bậc mỗi ngày.", "🥉 Chúc bạn không bao giờ bỏ cuộc trước khó khăn.",
        "🏁 Chúc bạn về đích với nụ cười mãn nguyện trên môi.", "🚩 Chúc hành trình của bạn là một thiên anh hùng ca.",
        "🧱 Chúc bạn xây dựng được một nền móng tài chính thép.", "🧱 Chúc mọi rào cản chỉ là bàn đạp cho bạn tiến xa hơn.",
        "💎 Chúc bạn luôn nhìn thấy cơ hội trong mọi biến động.", "💎 Chúc tài sản của bạn tăng trưởng theo cấp số nhân.",
        "🔋 Chúc bạn luôn dồi dào sức khỏe để chiến đấu dài hạn.", "🔋 Chúc tinh thần của bạn luôn ở trạng thái tốt nhất.",
        "🚀 Chúc bạn bay cao và xa hơn những gì mình mong đợi.", "🛫 Chúc chuyến bay đến giàu sang của bạn thật êm ái.",
        "🛰️ Chúc bạn luôn đi trước thị trường một bước chân.", "🧭 Chúc bạn luôn tìm thấy hướng đi đúng trong bóng tối.",
        "📡 Chúc bạn luôn nhận được những tín hiệu tích cực nhất.", "💡 Chúc trí tuệ của bạn luôn tỏa sáng rạng ngời.",
        "🔦 Chúc bạn soi sáng được con đường dẫn đến thành công.", "🔍 Chúc bạn khám phá ra những bí mật của sự giàu có.",
        "📏 Chúc mọi dự tính của bạn đều chính xác đến từng li.", "🧪 Chúc các chiến lược của bạn đều mang lại kết quả tốt.",
        "🧬 Chúc bạn có một tinh thần thép không thể lay chuyển.", "📈 Chúc biểu đồ cuộc đời bạn luôn là một đường thẳng lên.",
        "📉 Chúc bạn biết cách biến rủi ro thành cơ hội lớn.", "🔩 Chúc bạn luôn kiểm soát tốt mọi mắt xích trong trade.",
        "⚖️ Chúc bạn luôn có sự công bằng và sáng suốt.", "🏹 Chúc bạn bắn trúng mọi mục tiêu đã đề ra.",
        "🛠️ Chúc bạn có đủ công cụ để chinh phục thế giới.", "🧪 Chúc mọi thử nghiệm của bạn đều dẫn tới thành công.",
        "🧬 Chúc bạn có một cuộc sống thịnh vượng bền lâu.", "📉 Chúc bạn luôn bình tĩnh trước những pha sập giá.",
        "📈 Chúc bạn luôn hưng phấn trong những đợt sóng tăng.", "🚩 Chúc bạn luôn là người truyền cảm hứng cho người khác.",
        "🏗️ Chúc sự kiên trì của bạn sớm đơm hoa kết trái.", "🏛️ Chúc bạn để lại một di sản tài chính lẫy lừng.",
        "🏢 Chúc bạn luôn có những quyết định đầu tư đúng đắn.", "🏟️ Chúc bạn luôn là nhà vô địch trong mắt người thân.",
        "💎 Chúc bạn tìm thấy viên ngọc quý trong đống cát thị trường.", "🪵 Chúc ngọn lửa thành công lan tỏa tới mọi người quanh bạn.",
        "🌬️ Chúc bạn có được sự tự do mà bạn hằng khao khát.", "🚜 Chúc mỗi ngày của bạn đều là một ngày hạnh phúc.",
        "🚲 Chúc bạn luôn tận hưởng hành trình, không chỉ là đích đến.", "🚆 Chúc cuộc đời bạn là một hành trình đầy màu sắc.",
        "🚁 Chúc bạn luôn ở trên cao để thấy rõ mọi cơ hội.", "🛰️ Chúc bạn kết nối được với những người thầy giỏi.",
        "📱 Chúc điện thoại của bạn luôn hiện thông báo Ting Ting.", "💻 Chúc bạn làm chủ được công nghệ và thị trường.",
        "🧬 Chúc bạn có một cuộc sống viên mãn về mọi mặt.", "🍀 Chúc tất cả những gì tốt đẹp nhất sẽ đến với bạn."
    ]
};

let state = {
    isRunning: false,
    postsToday: 0,
    stats: { biendong: 0, day: 0, vol: 0 },
    lastPostTime: 0,
    postedTodaySymbols: new Set(),
    logs: [],
    coinData: {} 
};

function addLog(msg) {
    const time = new Date().toLocaleTimeString();
    state.logs.unshift(`[${time}] ${msg}`);
    if (state.logs.length > 50) state.logs.pop();
}

async function getBasePrice(symbol, currentPrice) {
    try {
        const now = new Date();
        const sevenAM = new Date();
        sevenAM.setHours(7, 0, 0, 0);
        if (now.getTime() > sevenAM.getTime()) {
            const ticks = await binance.futuresCandles(symbol, "1m", { startTime: sevenAM.getTime(), limit: 1 });
            if (ticks.length > 0) return parseFloat(ticks[0][1]);
        }
        return currentPrice;
    } catch (e) { return currentPrice; }
}

function calculateChange(pArr, min) {
    if (!pArr || pArr.length < 2) return 0;
    const now = Date.now();
    const startTime = now - min * 60000;
    let startPoint = pArr.find(i => i.t >= startTime) || pArr[0];
    const currentPrice = pArr[pArr.length - 1].p;
    return parseFloat((((currentPrice - startPoint.p) / startPoint.p) * 100).toFixed(2));
}

async function updatePriceLogic(s, p, now, vol) {
    if (!s.endsWith('USDT')) return;
    if (!state.coinData[s]) {
        state.coinData[s] = { symbol: s, prices: [], p7am: null, vol: 0, live: { c1: 0, c5: 0, cd: 0, cp: p } };
        getBasePrice(s, p).then(val => { if(state.coinData[s]) state.coinData[s].p7am = val; });
    }
    let d = state.coinData[s];
    d.prices.push({ p, t: now });
    d.prices = d.prices.filter(i => i.t > now - 360000);
    d.vol = parseFloat(vol);
    const c1 = calculateChange(d.prices, 1);
    const c5 = calculateChange(d.prices, 5);
    const cd = d.p7am ? parseFloat((((p - d.p7am) / d.p7am) * 100).toFixed(2)) : 0;
    d.live = { c1, c5, cd, cp: p };
    if (state.isRunning) {
        if (state.stats.biendong < SETTINGS.TYPE_LIMIT && (Math.abs(c1) >= SETTINGS.VOL_LIMIT || Math.abs(c5) >= SETTINGS.VOL_LIMIT)) {
            postToSquare(s, c5, 'biendong');
        } else if (state.stats.day < SETTINGS.TYPE_LIMIT && Math.abs(cd) >= SETTINGS.DAY_LIMIT) {
            postToSquare(s, cd, 'day');
        }
    }
}

function initWS() {
    addLog("⚡ Engine Luffy Pro V2 Starting...");
    binance.futuresTickerStream((tickers) => {
        const now = Date.now();
        if (Array.isArray(tickers)) {
            tickers.forEach(t => updatePriceLogic(t.symbol, parseFloat(t.close), now, t.quoteVolume));
        } else {
            updatePriceLogic(tickers.symbol, parseFloat(tickers.close), now, tickers.quoteVolume);
        }
    });
}

async function postToSquare(symbol, change, type) {
    if (state.postsToday >= SETTINGS.MAX_TOTAL || state.postedTodaySymbols.has(symbol)) return;
    if (Date.now() - state.lastPostTime < SETTINGS.MIN_GAP) return;
    const content = `${BANK.P1[Math.floor(Math.random()*100)]}\n\n${BANK.P2[Math.floor(Math.random()*100)]}\n\n${BANK.P3[Math.floor(Math.random()*100)]}\n\n${BANK.P4[Math.floor(Math.random()*100)]}\n\n#${symbol} $${symbol}`;
    try {
        await axios.post(SETTINGS.SQUARE_URL, { bodyTextOnly: content }, {
            headers: { "X-Square-OpenAPI-Key": SQUAD_API_KEY, "Content-Type": "application/json" }
        });
        state.postsToday++;
        state.stats[type]++;
        state.lastPostTime = Date.now();
        state.postedTodaySymbols.add(symbol);
        addLog(`✅ ĐĂNG ${type.toUpperCase()}: ${symbol} (${change}%)`);
    } catch (e) { addLog(`❌ Lỗi Square: ${e.message}`); }
}

async function postTypeVol() {
    if (!state.isRunning || state.stats.vol >= SETTINGS.TYPE_LIMIT) return;
    try {
        const tickers = await binance.futures24hrTicker();
        const topVol = tickers.filter(t => t.symbol.endsWith('USDT') && !state.postedTodaySymbols.has(t.symbol)).sort((a, b) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume)).slice(0, 1);
        if (topVol.length > 0) await postToSquare(topVol[0].symbol, 0, 'vol');
    } catch (e) { addLog("❌ Lỗi API Volume"); }
}
setInterval(postTypeVol, 600000);

const app = express();
app.get('/api/status', (req, res) => {
    const table = Object.values(state.coinData).map(v => ({ s: v.symbol, c1: v.live.c1, c5: v.live.c5, cd: v.live.cd })).sort((a, b) => Math.abs(b.c5) - Math.abs(a.c5)).slice(0, 15);
    res.json({ ...state, table, postedTodaySymbols: Array.from(state.postedTodaySymbols) });
});
app.get('/api/toggle', (req, res) => { state.isRunning = !state.isRunning; res.json({ s: state.isRunning }); });
app.get('/', (req, res) => {
    res.send(`
    <!DOCTYPE html><html><head><title>LUFFY SQUAD PRO</title><link href="https://fonts.googleapis.com/css2?family=Orbitron:wght@400;700&display=swap" rel="stylesheet"><style>
    body{background:#000;color:#0f0;font-family:'Orbitron',sans-serif;margin:0;padding:20px;display:flex;flex-direction:column;align-items:center}
    .card{background:#111;border:1px solid #0f0;box-shadow:0 0 15px #0f0;padding:20px;border-radius:10px;width:90%;max-width:1000px;margin-bottom:20px}
    h1{text-align:center;text-shadow:0 0 10px #0f0;margin-top:0}
    .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:20px;margin-bottom:20px}
    .stat{text-align:center;padding:15px;background:#051a05;border:1px solid #0f0}
    .btn{width:100%;padding:15px;font-size:1.2em;cursor:pointer;background:#0f0;color:#000;border:none;font-weight:bold;box-shadow:0 0 10px #0f0}
    .btn.off{background:#f00;color:#fff;box-shadow:0 0 10px #f00}
    table{width:100%;border-collapse:collapse;margin-top:20px}
    th,td{border:1px solid #0f0;padding:10px;text-align:center}
    .log-box{height:200px;overflow-y:scroll;background:#000;border:1px solid #0f0;padding:10px;font-family:monospace;font-size:0.9em}
    </style></head><body>
    <div class="card"><h1>🏴‍☠️ LUFFY SQUARE SQUAD BOT</h1><div class="grid">
    <div class="stat">POSTS TODAY<br><span id="postsToday">0</span>/100</div>
    <div class="stat">BIẾN ĐỘNG<br><span id="st-bd">0</span>/33</div>
    <div class="stat">DAILY GAIN<br><span id="st-day">0</span>/33</div>
    <div class="stat">TOP VOLUME<br><span id="st-vol">0</span>/33</div></div>
    <button id="btn" class="btn off" onclick="toggle()">ENGINE: STOPPED</button></div>
    <div class="card"><h3>📊 TOP BIẾN ĐỘNG (5M)</h3><table><thead><tr><th>SYMBOL</th><th>1M %</th><th>5M %</th><th>DAILY %</th></tr></thead><tbody id="table"></tbody></table></div>
    <div class="card"><h3>📜 SYSTEM LOGS</h3><div id="logs" class="log-box"></div></div>
    <script>
    async function update(){
        const r=await fetch('/api/status').then(res=>res.json());
        document.getElementById('postsToday').innerText=r.postsToday;
        document.getElementById('st-bd').innerText=r.stats.biendong;
        document.getElementById('st-day').innerText=r.stats.day;
        document.getElementById('st-vol').innerText=r.stats.vol;
        const b=document.getElementById('btn');
        b.innerText=r.isRunning?"ENGINE: RUNNING":"ENGINE: STOPPED";
        b.className=r.isRunning?"btn":"btn off";
        document.getElementById('logs').innerHTML=r.logs.join('<br>');
        document.getElementById('table').innerHTML=r.table.map(t=>\`<tr><td>\${t.s}</td><td>\${t.c1}%</td><td style="color:\${t.c5>=0?'#0f0':'#f00'}">\${t.c5}%</td><td>\${t.cd}%</td></tr>\`).join('');
    }
    async function toggle(){await fetch('/api/toggle');update();}
    setInterval(update,2000);update();
    </script></body></html>
    `);
});

app.listen(PORT, '0.0.0.0', () => {
    initWS();
    console.log(`Luffy Pro Ready: http://localhost:${PORT}`);
});
