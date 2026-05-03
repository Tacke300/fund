import WebSocket from 'ws';
import express from 'express';
import fetch from 'node-fetch';
import axios from 'axios';

const PORT = 8888;
const SQUAD_API_KEY = "8d794c11cc794c958c2c65924c54f2dd"; 

const SETTINGS = {
    SQUARE_URL: "https://www.binance.com/bapi/composite/v1/public/pgc/openApi/content/add",
    VOL_LIMIT: 7.0,    // Ngưỡng biến động cho Loại 1 (M1 hoặc M5)
    DAY_LIMIT: 10.0,   // Ngưỡng biến động cho Loại 2 (24h)
    MAX_TOTAL: 100,
    TYPE_LIMIT: 33, 
    MIN_GAP: 60000, 
};

const BANK = {
    P1: [
        "🔥 Dòng tiền thông minh đang đổ mạnh vào hệ sinh thái này.", "🐳 Dữ liệu on-chain cho thấy cá voi đang gom hàng.", "💎 Áp lực bán đã cạn kiệt tại vùng hỗ trợ tâm lý.", "📊 Sự gia tăng đột biến về khối lượng giao dịch ngắn hạn.", "🔎 Các địa chỉ ví lớn đang có dấu hiệu tích lũy âm thầm.", "📰 Thị trường đang phản ứng tích cực với tin vĩ mô.", "⚡ Lực mua chủ động đang áp đảo hoàn toàn trên bảng điện.", "📈 Chỉ số tâm lý thị trường đang chuyển sang hưng phấn.", "🏛️ Sự bứt phá này mang đậm dấu ấn của các quỹ lớn.", "🚀 Nhu cầu sở hữu đang tăng cao bất chấp biến động chung.",
        "💰 Cấu trúc dòng tiền đang tập trung vào nhóm dẫn dắt này.", "🌍 Dòng vốn ngoại đang quay trở lại vị thế mua ròng.", "🛒 Các lệnh mua lớn liên tục xuất hiện trên sổ lệnh.", "⏳ Sự khan hiếm nguồn cung tạm thời đang đẩy giá đi lên.", "💸 Dòng tiền đầu cơ bắt đầu chuyển dịch sang khu vực này.", "✅ Tín hiệu dòng tiền xác nhận sự tham gia của tổ chức.", "💪 Sức mạnh tương đối so với phần còn lại đang rất tốt.", "🛡️ Dòng vốn đang tìm nơi trú ẩn tại các mã tiềm năng.", "🌋 Thanh khoản tăng vọt đi kèm với sự bứt phá về giá.", "🤝 Sự đồng thuận của dòng tiền đang ở mức cao nhất.",
        "🧲 Lực cầu tiềm năng đang chờ đợi tại các vùng giá thấp.", "🏗️ Các tay chơi lớn đang thiết lập vị thế dài hạn mới.", "🌀 Dòng tiền xoay vòng đã tìm đến điểm dừng chân này.", "🏎️ Tốc độ khớp lệnh mua đang nhanh hơn rõ rệt.", "🔄 Sự dịch chuyển của dòng vốn từ các nhóm ngành khác.", "🌟 Tín hiệu tích cực từ hành động giá của nhóm dẫn dắt.", "🚧 Dòng tiền lớn đã vượt qua các ngưỡng kháng cự tâm lý.", "💥 Khối lượng giao dịch bùng nổ xác nhận xu hướng mới.", "🛌 Dòng tiền nhàn rỗi đang quay trở lại thị trường.", "🎯 Sự tập trung của dòng vốn vào các tài sản chất lượng.",
        "⚓ Cấu trúc dòng vốn đang trở nên bền vững hơn bao giờ hết.", "🥊 Lực mua tại các vùng hỗ trợ đang rất quyết liệt.", "🔭 Dòng tiền đang kỳ vọng vào một nhịp tăng trưởng dài.", "📈 Sự gia tăng vị thế mua từ các nhà đầu tư chuyên nghiệp.", "🧠 Dòng vốn thông minh đang đi trước một bước.", "🎲 Tín hiệu từ thị trường phái sinh đang hỗ trợ dòng tiền.", "🌈 Dòng tiền đang lan tỏa đều khắp các nhóm vốn hóa lớn.", "🧘 Sự ổn định của dòng vốn trong các nhịp điều chỉnh.", "🚩 Dòng tiền đang nhắm tới các mục tiêu trung hạn mới.", "🧽 Khả năng hấp thụ lực bán của dòng tiền đang rất tốt.",
        "🧗 Sự kiên trì của dòng vốn tại các vùng giá quan trọng.", "🧱 Dòng tiền đang tạo ra những nền tảng giá vững chắc.", "🔥 Sức nóng từ dòng tiền đang lan tỏa sang các mã lân cận.", "🥇 Sự ưu tiên của dòng vốn dành cho các mã có nền tảng tốt.", "⛏️ Dòng tiền đang khai thác các cơ hội bị định giá thấp.", "📷 Tín hiệu gom hàng rõ nét từ biểu đồ khối lượng.", "🔙 Dòng tiền đang quay trở lại sau thời gian quan sát.", "🦁 Sự tự tin của dòng tiền đang được củng cố mạnh mẽ.", "🧬 Cơ cấu dòng vốn đang hướng tới sự tăng trưởng đột phá.", "📍 Dòng tiền đang tạo ra những cột mốc thanh khoản mới.",
        "🔔 Lực cầu đang tăng dần theo thời gian giao dịch.", "🏠 Sự hỗ trợ mạnh mẽ từ dòng tiền nội khối.", "🔨 Dòng tiền đang tìm cách phá vỡ các rào cản kỹ thuật.", "🔉 Sự gia tăng khối lượng giao dịch một cách có chủ đích.", "⏲️ Dòng tiền đang chờ đợi những tín hiệu bùng nổ tiếp theo.", "👑 Sự dẫn dắt của dòng tiền tại các mã đầu ngành.", "🎋 Dòng tiền đang tạo ra một xu hướng tăng trưởng mới.", "🔋 Sức mua đang được duy trì ở mức cao và ổn định.", "🪄 Dòng tiền đang thể hiện ý chí đẩy giá rất rõ ràng.", "🌊 Sự lan tỏa của dòng tiền vào các nhóm chưa tăng giá.",
        "☄️ Dòng tiền đang tạo ra sự đột phá từ các mô hình tích lũy.", "🐜 Lực mua đang len lỏi vào từng lệnh giao dịch nhỏ.", "🎖️ Dòng tiền đang khẳng định vị thế dẫn dắt thị trường.", "🎢 Sự quay lại của dòng vốn sau nhịp rũ bỏ mạnh mẽ.", "⚖️ Dòng tiền đang tìm kiếm sự cân bằng tại vùng giá cao.", "🛡️ Sự ổn định của dòng vốn trong bối cảnh vĩ mô mới.", "🎰 Dòng tiền đang đặt cược vào kịch bản tăng trưởng mạnh.", "🛸 Sự dịch chuyển thông minh giữa các lớp tài sản.", "⚡ Dòng tiền đang tạo ra những cú hích quan trọng.", "🏹 Lực cầu đang chờ đợi sự xác nhận từ các khung giờ lớn.",
        "📚 Dòng tiền đang tập trung vào các mã có câu chuyện riêng.", "💎 Sự tăng trưởng thanh khoản đi kèm với chất lượng dòng vốn.", "🎮 Dòng tiền đang kiểm soát hoàn toàn diễn biến giá.", "🔓 Sự bứt phá của dòng tiền khỏi vùng trung lập.", "🏔️ Dòng tiền đang hướng tới các đỉnh cao mới của năm.", "🧹 Lực mua chủ động đang quét sạch các lệnh bán treo.", "🏃 Dòng tiền đang thể hiện sự bền bỉ trong từng nhịp tăng.", "📣 Sự hưng phấn của dòng tiền đang lan rộng toàn sàn.", "💡 Dòng tiền đang tìm thấy động lực tăng trưởng mới.", "🐣 Sự đột phá về khối lượng từ các vùng giá đáy.",
        "🪜 Dòng tiền đang xác lập một nền tảng giá cao hơn.", "🏋️ Sức mạnh của dòng tiền đang được thử thách và khẳng định.", "📉 Dòng tiền đang tận dụng các nhịp giảm để gia tăng vị thế.", "🤝 Sự nhất quán của dòng vốn trong các quyết định mua.", "🌅 Dòng tiền đang mở ra những triển vọng tươi sáng.", "🌋 Lực cầu đang bùng nổ tại các điểm xoay chiều.", "🎨 Dòng tiền đang định hình lại xu hướng của thị trường.", "💂 Sự trỗi dậy mạnh mẽ của dòng tiền từ các quỹ chỉ số.", "🌗 Dòng tiền đang tạo ra sự khác biệt lớn về hiệu suất.", "⭐ Sự tập trung dòng vốn vào các mã có dòng tiền tốt.",
        "🧨 Dòng tiền đang tạo đà cho một cú breakout lịch sử.", "🌇 Lực mua đang gia tăng mạnh mẽ vào cuối phiên.", "🌃 Dòng tiền đang duy trì sự hưng phấn cho đến khi đóng cửa.", "🏅 Sự xuất sắc của dòng tiền trong việc giữ nhịp thị trường.", "🎁 Dòng tiền đang tạo ra những cơ hội vàng cho người nắm giữ.", "🔥 Sự quyết đoán của dòng vốn trong việc đẩy giá bứt phá.", "🌠 Dòng tiền lớn đang tìm cách phá vỡ các kỷ lục cũ.", "🧩 Sự phối hợp của các dòng vốn đang rất nhịp nhàng.", "🔗 Mối liên kết giữa dòng tiền và giá đang rất chặtẽ.", "🥇 Dẫn đầu xu hướng với sự hậu thuẫn của dòng tiền cực lớn."
    ],
    P2: [
        "📐 Về kỹ thuật giá đã bứt phá khỏi kênh giảm giá.", "🪄 Đường EMA đang thực hiện cú cắt vàng báo hiệu tăng.", "🌊 RSI đang tiến vào vùng mạnh mẽ nhưng chưa quá mua.", "🕯️ Mô hình nến nhấn chìm đã xác nhận xu hướng tăng.", "🎈 Bollinger Band mở rộng cho thấy biến động lớn.", "🛤️ Giá đang nằm trên các đường MA quan trọng.", "🧱 Kháng cự cũ đã trở thành hỗ trợ mới vững chắc.", "🏹 Phân kỳ dương H1 hỗ trợ đà tăng bền vững.", "🏔️ Cấu trúc đỉnh sau cao hơn đỉnh trước duy trì.", "☁️ Ichimoku cho thấy mây xanh nâng đỡ rất tốt.",
        "🔓 Giá đã vượt qua vùng mây Kumo dày đặc.", "📉 MACD đã chính thức giao cắt lên trên đường tín hiệu.", "💥 Khối lượng xác nhận cú bứt phá khỏi vùng tích lũy.", "☕ Mô hình cốc tay cầm đang dần hoàn thiện.", "🔭 Giá đang test lại vùng đỉnh cũ với lực cầu tốt.", "🛡️ Vùng hỗ trợ tâm lý đang được bảo vệ nghiêm ngặt.", "🔄 Stochastic đang quay trở lại vùng tăng trưởng.", "🌊 Cấu trúc sóng Elliott đang đi vào sóng 3 đẩy.", "🌅 Giá đã thoát khỏi vùng quá bán trên khung D1.", "🧬 Sự hội tụ của các chỉ báo kỹ thuật quan trọng.",
        "🔺 Mô hình tam giác tăng đã bị phá vỡ hướng lên.", "🛤️ Giá đang duy trì trên đường trendline tăng dài hạn.", "🌬️ Cú điều chỉnh vừa qua chỉ là nhịp retest kỹ thuật.", "🍃 Áp lực bán suy giảm rõ rệt trên biểu đồ nến.", "🧱 Sự bùng nổ từ mô hình nền giá phẳng dài ngày.", "💎 Tín hiệu đảo chiều mạnh mẽ từ vùng hỗ trợ cứng.", "🗼 Dải lăng trụ đang hướng lên cho thấy lực cầu mạnh.", "📏 Giá đang chinh phục các mốc Fibonacci quan trọng.", "⚡ ADX cho thấy xu hướng đang mạnh dần lên.", "🤝 Sự đồng thuận tuyệt vời giữa giá và khối lượng.",
        "🚩 Mô hình cờ tăng đang tích lũy tại vùng giá cao.", "🎯 Giá đã phá vỡ ngưỡng cản Fib 0.618 thần thánh.", "🧨 Tín hiệu Breakout đi kèm với volume cực đại.", "🐂 Cấu trúc nến cho thấy phe bò đang làm chủ.", "⚖️ Sự ổn định tại vùng giá cân bằng mới.", "📊 Volume Profile cho thấy sự tích lũy rất lớn.", "🌅 Mô hình nến Morning Star báo hiệu đảo chiều.", "🚀 Giá đã vượt qua kháng cự dải siêu xu hướng.", "🏗️ Market Structure đang chuyển dịch sang tăng.", "📽️ Tín hiệu xác nhận từ khung thời gian lớn hơn.",
        "🌪️ Vùng cung đã bị hấp thụ hoàn toàn bởi lực mua.", "🏁 Giá đang tiến sát mục tiêu chốt lời đầu tiên.", "📦 Sự bứt phá khỏi vùng tích lũy hình hộp Darvas.", "🏎️ Chỉ báo CCI đang tăng vọt lên vùng tích cực.", "💂 Mô hình 3 chàng lính trắng đang hình thành.", "⚓ Giá đã tìm thấy điểm tựa tại đường MA200.", "🤏 Sự thu hẹp của độ biến động trước cú bứt phá.", "👻 Tín hiệu phân kỳ ẩn báo hiệu tiếp diễn xu hướng.", "🏔️ Giá đang hình thành mô hình đáy sau cao hơn.", "🧬 Sự hội tụ của các đường trung bình động ngắn.",
        "🚥 Chỉ báo Parabolic SAR đã nhảy xuống dưới giá.", "🎭 Mô hình vai đầu vai ngược đã chính thức xác nhận.", "🌬️ Áp lực cung cạn kiệt tại vùng biên dưới dải băng.", "🎢 Giá đang chạy trong một kênh tăng giá hoàn hảo.", "🚀 Sự đột phá về giá khỏi vùng giá trị quan trọng.", "⛲ Chỉ báo MFI cho thấy dòng tiền nạp vào mạnh.", "📐 Mô hình cái nêm giảm đã bị phá vỡ hướng lên.", "🧪 Giá đang test lại đường cổ của mô hình đảo chiều.", "🟢 Cấu trúc nến Heikin Ashi đã chuyển sang màu xanh.", "🕳️ Sự ổn định của giá phía trên vùng gap tăng.",
        "🪜 Chỉ báo Keltner Channel đang bị đẩy lên phía trên.", "📅 Giá đã vượt qua mốc cao nhất của tuần trước.", "📍 Tín hiệu tăng trưởng mạnh mẽ từ vùng pivot.", "⛸️ Mô hình 2 đáy đã hoàn thành nhịp kiểm định.", "📢 Sự cộng hưởng của nhiều khung thời gian cùng tăng.", "🧱 Giá đang giữ vững trên ngưỡng hỗ trợ Fib 0.5.", "📈 Chỉ báo OBV đang tăng vọt cùng với đường giá.", "📌 Mô hình nến Pin bar từ chối giảm tại hỗ trợ.", "🌊 Giá đang chuẩn bị cho một nhịp sóng đẩy mới.", "🔨 Sự bứt phá khỏi vùng cản kỹ thuật cứng nhất.",
        "📡 Tín hiệu mua từ hệ thống giao dịch theo xu hướng.", "🏔️ Giá đang tiệm cận vùng kháng cự quan trọng.", "🤏 Sự thu hẹp biên độ nến tại vùng giá đỉnh.", "🌑 Mô hình nến Marubozu xác nhận lực mua áp đảo.", "🔓 Giá đã thoát khỏi trạng thái tích lũy đi ngang.", "🚀 Chỉ báo Trix cho thấy đà tăng đang đẩy mạnh.", "🌊 Cấu trúc sóng tăng đang được mở rộng liên tục.", "🧱 Sự ổn định của giá tại các ngưỡng chặn kỹ thuật.", "🏁 Tín hiệu xác nhận xu hướng từ chỉ báo Donchian.", "🎯 Giá đang hướng về vùng mục tiêu của mô hình.",
        "🤝 Sự bứt phá của giá đi kèm với sự đồng thuận.", "📈 Chỉ báo Aroon Up đang nằm trên ngưỡng 70.", "📦 Mô hình nến Inside bar breakout theo hướng tăng.", "☁️ Giá đã vượt qua vùng cản mây trên khung H4.", "⚓ Sự vững chắc của nền tảng giá hiện tại.", "🔄 Tín hiệu đảo chiều từ các chỉ báo động lượng.", "🚀 Giá đang thực hiện nhịp tăng tốc thoát khỏi nền.", "📈 Sự cải thiện rõ rệt của cấu trúc giá ngắn hạn.", "🎻 Mô hình sóng Harmonic đang hướng tới mục tiêu.", "💥 Giá đã phá vỡ mọi đường kháng cự gần nhất.",
        "💪 Sự tự tin từ biểu đồ kỹ thuật đang rất lớn.", "🧠 Chỉ báo tâm lý kỹ thuật nghiêng hẳn về mua.", "📈 Giá đang duy trì đà tăng trưởng cực kỳ ấn tượng.", "✅ Tín hiệu breakout thành công từ nền giá tốt.", "🎯 Chinh phục các cột mốc kỹ thuật cao hơn.", "🔥 Sức mạnh kỹ thuật đang ở trạng thái tối ưu.", "🧩 Sự phối hợp hoàn hảo của các chỉ báo sớm.", "⚡ Tốc độ thay đổi giá đang ở mức báo động tăng.", "🏰 Xây dựng cấu trúc tăng giá vững như bàn thạch.", "👑 Vị thế kỹ thuật dẫn đầu thị trường lúc này."
    ],
    P3: [
        "📝 Kế hoạch tối ưu là kiên nhẫn chờ điểm vào lệnh đẹp.", "🛡️ Quản trị rủi ro bằng cách đặt dừng lỗ tuyệt đối.", "🎯 Chiến lược mua khi điều chỉnh vẫn tỏ ra hiệu quả.", "🛑 Đừng FOMO tại vùng giá này, hãy đợi nhịp test lại.", "💰 Chia vốn ra vào lệnh để tối ưu hóa giá vị thế.", "🧊 Luôn giữ cái đầu lạnh trước những biến động.", "🎁 Mục tiêu chốt lời ngắn hạn đã được xác định rõ.", "🎢 Gồng lãi là nghệ thuật, hãy nâng trailing stop.", "🔒 Bảo vệ lợi nhuận luôn là ưu tiên hàng đầu.", "📏 Hãy tuân thủ kỷ luật giao dịch để đi đường dài.",
        "🔑 Kỷ luật là chìa khóa để tồn tại trên thị trường.", "🚪 Luôn có kế hoạch thoát lệnh trước khi tham gia.", "🧺 Đừng đặt tất cả trứng vào một giỏ duy nhất.", "⏳ Kiên nhận là đức tính quý giá nhất của trader.", "💸 Hãy giao dịch với số vốn bạn có thể mất.", "🛡️ Không có gì chắc chắn, hãy luôn phòng vệ.", "📅 Theo dõi sát sao các tin tức quan trọng.", "🤕 Học cách chấp nhận thua lỗ như một phần cuộc chơi.", "🧘 Đừng để cảm xúc chi phối các quyết định.", "📔 Luôn ghi lại nhật ký để rút kinh nghiệm.",
        "🤝 Tin tưởng vào hệ thống và phương pháp của mình.", "🧨 Sự chuẩn bị kỹ lưỡng sẽ giảm bớt sự sợ hãi.", "✅ Chỉ vào lệnh khi các điều kiện đã hội tụ đủ.", "👁️ Quan sát phản ứng của giá tại các vùng then chốt.", "🌊 Hãy là người đi theo xu hướng, đừng chặn đầu.", "📉 Lợi nhuận bền vững đến từ sự nhất quán.", "⏲️ Đừng cố giao dịch quá nhiều trong một ngày.", "🪑 Biết khi nào nên đứng ngoài là một kỹ năng.", "🤝 Tôn trọng xu hướng thị trường, xu hướng là bạn.", "📚 Cập nhật kiến thức thường xuyên để thích nghi.",
        "🦁 Tự tin nhưng không được chủ quan trước thị trường.", "⚖️ Xác định tỷ lệ rủi ro/lợi nhuận phù hợp.", "💼 Hãy coi trading là một công việc kinh doanh.", "🛠️ Tận dụng các công cụ hỗ trợ để tăng hiệu quả.", "🙅 Đừng bị ảnh hưởng bởi đám đông xung quanh.", "💎 Tập trung vào chất lượng lệnh thay vì số lượng.", "🛋️ Giữ tâm thế thoải mái nhất khi giữ vị thế.", "🔍 Hiểu rõ đặc tính của từng cặp giao dịch.", "🛡️ Hãy luôn đặt sự an toàn của tài khoản lên trước.", "🎓 Học hỏi từ những người đi trước có kinh nghiệm.",
        "🧊 Sự bình tĩnh giúp bạn nhìn nhận thị trường đúng.", "🥊 Đừng cố gỡ gạc sau một lệnh thua đau.", "🎁 Thị trường luôn có cơ hội, đừng lo bỏ lỡ.", "🏔️ Hãy kiên định với mục tiêu dài hạn đã đề ra.", "⚙️ Tối ưu lợi nhuận bằng cách quản lý lệnh thông minh.", "🔄 Sẵn sàng thay đổi quan điểm nếu giá thay đổi.", "🕹️ Luôn giữ mức đòn bẩy ở mức an toàn nhất.", "🖼️ Phân tích đa khung thời gian để có cái nhìn tổng quát.", "🧘 Cân bằng giữa giao dịch và cuộc sống cá nhân.", "🎈 Đừng kỳ vọng quá cao vào một lệnh duy nhất.",
        "🗣️ Hãy để thị trường trả lời thay vì dự đoán mò.", "📏 Luyện tập thói quen kiểm soát rủi ro hàng ngày.", "🧪 Khám phá các phương pháp mới có chọn lọc.", "🧹 Giữ cho biểu đồ giao dịch sạch sẽ và dễ nhìn.", "⚙️ Hiểu rõ cơ chế hoạt động của sàn giao dịch.", "⚠️ Hãy luôn cảnh giác với các bẫy giá thị trường.", "📝 Tự đánh giá bản thân sau mỗi tuần giao dịch.", "🧠 Nâng cao khả năng chịu đựng tâm lý bản thân.", "🍀 Giao dịch đơn giản thường mang lại hiệu quả cao.", "🍬 Hãy biết hài lòng với những gì mình đạt được.",
        "👂 Lắng nghe phản hồi từ thị trường thay vì ý kiến.", "🔔 Cẩn trọng với biến động trước giờ ra tin mạnh.", "📍 Tìm kiếm những vùng giá có xác suất thắng cao.", "🛡️ Luôn có phương án dự phòng cho mọi tình huống.", "🚫 Đừng bao giờ giao dịch dựa trên sự trả thù.", "⛓️ Sự kỷ luật sẽ mang lại tự do tài chính.", "📜 Hãy tôn trọng những quy tắc do chính mình đặt ra.", "🤏 Kiểm soát lòng tham khi thị trường hưng phấn.", "⚓ Giữ vững niềm tin vào con đường đã chọn.", "🎓 Mỗi sai lầm đều là một bài học vô giá.",
        "🧠 Hãy là một nhà đầu tư thông thái và bình tĩnh.", "🕯️ Học cách đọc hiểu ngôn ngữ của những cây nến.", "✂️ Sẵn sàng cắt lỗ khi phân tích ban đầu đã sai.", "🏗️ Xây dựng hệ thống phù hợp với tính cách mình.", "🐢 Thành công không đến sau một đêm, hãy kiên trì.", "🔍 Sự tinh tế trong việc nhận diện cơ hội.", "🌈 Hãy tận hưởng hành trình trở thành một trader.", "❓ Luôn đặt câu hỏi tại sao trước mỗi quyết định.", "⚖️ Tìm kiếm sự cân bằng giữa kỹ thuật và tâm lý.", "🏃 Trading là marathon, không phải chạy nước rút.",
        "⚡ Sự tỉnh táo là vũ khí mạnh nhất của bạn.", "📚 Hãy luôn học hỏi và không ngừng hoàn thiện.", "🌱 Bắt đầu từ những mục tiêu nhỏ và thực tế.", "📑 Hành động theo kế hoạch, không theo bản năng.", "👨‍🏫 Thị trường là người thầy nghiêm khắc nhất.", "💰 Hãy luôn trân trọng số vốn của mình.", "🎯 Sự tập trung cao độ khi thị trường vào sóng.", "🛡️ Luôn nhớ rằng bảo toàn vốn là trên hết.", "🆙 Hãy trở thành phiên bản tốt hơn của mình.", "👤 Giao dịch có trách nhiệm với bản thân.",
        "🎉 Hạnh phúc với quá trình thay vì chỉ kết quả.", "🧘 Giữ tâm trí tĩnh lặng giữa muôn vàn biến động.", "🗝️ Mở khóa tiềm năng của bạn bằng sự nhẫn nại.", "🔭 Tầm nhìn xa giúp bạn vượt qua những nhịp rung.", "💎 Giá trị của một trader nằm ở sự bền bỉ.", "🌟 Luôn hướng tới sự chuyên nghiệp trong từng lệnh.", "🛡️ Phòng thủ tốt là cách tấn công hiệu quả nhất.", "🛤️ Đi đúng đường quan trọng hơn đi nhanh.", "🏆 Đích đến cuối cùng là sự tự chủ tài chính.", "🌈 Chào mừng bạn đến với thế giới trading kỷ luật."
    ],
    P4: [
        "🍻 Chúc anh em có ngày giao dịch bùng nổ lợi nhuận.", "🍀 Hy vọng may mắn mỉm cười với mọi quyết định.", "🌳 Chúc danh mục của anh em luôn xanh rực rỡ.", "👋 Hẹn gặp lại anh em ở những vùng giá cao hơn.", "🤝 Cùng nhau chinh phục thị trường đầy tiềm năng.", "✨ Tận hưởng niềm vui khi phân tích đúng hướng.", "🏆 Thắng không kiêu bại không nản, chúc thành công.", "🔑 Thị trường luôn có cơ hội cho người chuẩn bị.", "🎖️ Chào thân ái và quyết thắng cho toàn cộng đồng.", "🌈 Chúc anh em gặt hái được nhiều thành quả.",
        "☀️ Hy vọng một ngày giao dịch suôn sẻ và thuận lợi.", "🛶 Chúc anh em vững tay chèo trên con sóng này.", "⏳ Thành công sẽ đến với những người kiên trì nhất.", "🎯 Chúc các vị thế của bạn sớm chạm mục tiêu.", "🚀 Hy vọng danh mục của bạn sẽ thăng hoa hôm nay.", "🧠 Chúc mọi người có những quyết định sáng suốt.", "🎈 Niềm vui từ trading sẽ lan tỏa đến cuộc sống.", "🌙 Chúc anh em có một buổi tối chốt lời rực rỡ.", "📍 Hẹn gặp lại tại những cột mốc thành công mới.", "🌍 Chúc cộng đồng chúng ta ngày càng lớn mạnh.",
        "🎁 Mọi nỗ lực sẽ sớm được đền đáp xứng đáng thôi.", "🧊 Chúc bạn luôn giữ được sự bình tĩnh và tự tin.", "🛡️ Thị trường sẽ trả thưởng cho sự kỷ luật của bạn.", "⚡ Chúc một ngày tràn đầy năng lượng và lợi nhuận.", "🔮 Hy vọng các dự báo của bạn đều trở thành sự thật.", "💎 Chúc anh em tìm thấy những viên ngọc quý.", "🥳 Cùng nhau chia sẻ niềm vui chiến thắng hôm nay.", "🗺️ Chúc bạn có một hành trình trading thú vị.", "🤝 Hy vọng may mắn sẽ là người bạn đồng hành.", "📍 Chúc anh em chốt được lệnh tại điểm đẹp nhất.",
        "🆙 Thành công không chỉ là tiền, đó là sự trưởng thành.", "😊 Chúc mọi người luôn vui vẻ dù thị trường ra sao.", "🔓 Hy vọng bạn sẽ đạt được tự do tài chính sớm.", "🧠 Chúc anh em luôn tỉnh táo trong mọi tình huống.", "🏖️ Hãy tận hưởng ngày nghỉ sau những lệnh thắng.", "📈 Chúc danh mục của bạn tăng trưởng bền vững.", "🟢 Hy vọng bạn sẽ thấy những con số xanh mướt.", "🔥 Chúc anh em luôn giữ được lửa đam mê.", "🏆 Thành công rực rỡ sẽ sớm gọi tên bạn thôi.", "🎬 Chúc bạn có những trải nghiệm tuyệt vời hôm nay.",
        "🪜 Hy vọng mỗi ngày là một bước tiến mới của bạn.", "🛡️ Chúc anh em luôn là những chiến binh dũng cảm.", "🏔️ Hẹn gặp lại ở đỉnh vinh quang của thị trường.", "🛡️ Chúc mọi người có một tinh thần thép khi trade.", "🎓 Hy vọng bạn sẽ gặt hái được nhiều kinh nghiệm.", "🔭 Chúc anh em luôn có cái nhìn sắc bén nhất.", "🥇 Thắng lợi hôm nay là động lực cho ngày mai.", "❤️ Chúc bạn luôn hạnh phúc với lựa chọn của mình.", "💰 Hy vọng tài khoản của bạn sẽ không ngừng tăng.", "⚡ Chúc anh em có những cú breakout thành công.",
        "📊 Cùng nhau tạo nên những kỷ lục mới cho bản thân.", "🧘 Chúc bạn luôn khỏe mạnh để tận hưởng thành quả.", "🤝 Hy vọng thị trường sẽ ưu ái các vị thế của bạn.", "💼 Chúc anh em có một ngày làm việc hiệu quả.", "🔑 Niềm tin vào bản thân là chìa khóa thành công.", "⏳ Chúc mọi người luôn có đủ sự kiên nhẫn.", "🌅 Hy vọng bạn sẽ không bao giờ phải hối tiếc.", "🕊️ Chúc anh em tìm thấy sự bình yên trong tâm hồn.", "🥇 Thành quả xứng đáng đang chờ bạn ở phía trước.", "👑 Chúc bạn luôn là người dẫn đầu trong mọi cuộc chơi.",
        "📚 Hy vọng mỗi lệnh trade đều mang lại bài học.", "🔭 Chúc anh em luôn có một tầm nhìn xa trông rộng.", "🎉 Thắng lợi của bạn là niềm vui của cộng đồng.", "🌈 Chúc bạn luôn giữ được sự lạc quan.", "🚀 Hy vọng một tương lai tươi sáng đang chờ đón.", "👥 Chúc anh em luôn có những đồng đội tuyệt vời.", "🏔️ Cùng nhau hướng tới những mục tiêu cao cả hơn.", "🧱 Chúc bạn luôn biết cách vượt qua giới hạn.", "💰 Hy vọng bạn sẽ có ngày chốt lời không nghỉ tay.", "🧊 Chúc anh em luôn có trái tim nóng và đầu lạnh.",
        "🏆 Thành công sẽ là minh chứng cho sự nỗ lực.", "🛡️ Chúc mọi người luôn bình an trên mọi nẻo đường.", "✍️ Hy vọng bạn sẽ là người viết nên câu chuyện.", "💥 Chúc anh em luôn có những cú trade để đời.", "🔔 Hẹn gặp lại anh em với những tin vui mới.", "🎁 Chúc bạn luôn gặp được những cơ hội tốt nhất.", "🌟 Hy vọng mỗi ngày trôi qua đều có ý nghĩa.", "👑 Chúc anh em luôn giữ vững phong độ đỉnh cao.", "🧗 Thành công đang ở rất gần, đừng bỏ cuộc nhé.", "🎭 Chúc bạn có một đời sống tinh thần phong phú.",
        "🌈 Hy vọng bạn sẽ sớm đạt được những ước mơ lớn.", "💡 Chúc anh em luôn là nguồn cảm hứng cho người khác.", "🎖️ Thị trường sẽ ghi nhận sự đóng góp của bạn.", "✨ Chúc bạn luôn tỏa sáng theo cách của riêng mình.", "🌅 Hy vọng một ngày rực rỡ đang chờ đón tất cả.", "🍀 Chúc anh em luôn gặt hái được những điều tốt đẹp.", "👋 Tạm biệt và chúc mọi người có kết quả tốt nhất.", "🎊 Chúc mừng những nỗ lực không ngừng nghỉ của bạn.", "🦁 Hãy luôn mạnh mẽ như những chú sư tử trên sàn.", "🏁 Hẹn gặp lại ở vạch đích của sự thành công rực rỡ."
    ]
};

let state = {
    isRunning: false,
    isSleeping: false,
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
    console.log(`[${time}] ${msg}`);
}

function checkNewDay() {
    const now = new Date();
    if (now.getHours() === 0 && now.getMinutes() === 0) {
        state.postsToday = 0;
        state.stats = { biendong: 0, day: 0, vol: 0 };
        state.postedTodaySymbols.clear();
        state.isSleeping = false;
        addLog("📅 Bắt đầu ngày mới. Reset chỉ số.");
    }
}

function calculateChange(pArr, min) {
    if (!pArr || pArr.length < 2) return 0;
    const now = Date.now();
    let start = pArr.find(i => i.t >= (now - min * 60000)) || pArr[0]; 
    return parseFloat((((pArr[pArr.length - 1].p - start.p) / start.p) * 100).toFixed(2));
}

function updatePriceLogic(s, p, now, change24h = 0, volume = 0) {
    if (!state.coinData[s]) state.coinData[s] = { symbol: s, prices: [], d1: 0, vol: 0 };
    let d = state.coinData[s];
    d.prices.push({ p, t: now });
    if (d.prices.length > 600) d.prices.shift();
    d.d1 = parseFloat(change24h).toFixed(2);
    d.vol = parseFloat(volume).toFixed(0);

    d.live = {
        c1: calculateChange(d.prices, 1),
        c5: calculateChange(d.prices, 5),
        currentPrice: p
    };

    if (state.isRunning && !state.isSleeping) {
        const hour = new Date().getHours();
        
        // LOẠI 1: Check cả M1 HOẶC M5 (Chỉ cần 1 trong 2 đủ đk)
        if (state.stats.biendong < SETTINGS.TYPE_LIMIT && (Math.abs(d.live.c1) >= SETTINGS.VOL_LIMIT || Math.abs(d.live.c5) >= SETTINGS.VOL_LIMIT)) {
            const maxChange = Math.abs(d.live.c1) > Math.abs(d.live.c5) ? d.live.c1 : d.live.c5;
            postToSquare(s, maxChange, 'biendong');
        } 
        // LOẠI 2: Biến động ngày
        else if (state.stats.day < SETTINGS.TYPE_LIMIT && Math.abs(d.d1) >= SETTINGS.DAY_LIMIT) {
            postToSquare(s, d.d1, 'day');
        }
        // LOẠI 3: Vét máng Vol thấp sau 23h
        else if (hour >= 23 && state.postsToday < SETTINGS.MAX_TOTAL) {
            autoFillVolLowToHigh();
        }
    }
}

async function autoFillVolLowToHigh() {
    const list = Object.values(state.coinData)
        .filter(c => !state.postedTodaySymbols.has(c.symbol))
        .sort((a, b) => a.vol - b.vol); 

    if (list.length > 0) {
        await postToSquare(list[0].symbol, list[0].d1, 'vol');
    }
}

async function postToSquare(symbol, change, type) {
    if (state.postsToday >= SETTINGS.MAX_TOTAL) {
        state.isSleeping = true;
        return;
    }
    if (state.postedTodaySymbols.has(symbol)) return;
    const now = Date.now();
    if (now - state.lastPostTime < SETTINGS.MIN_GAP) return;

    const content = `${BANK.P1[Math.floor(Math.random() * BANK.P1.length)]}\n\n${BANK.P2[Math.floor(Math.random() * BANK.P2.length)]}\n\n${BANK.P3[Math.floor(Math.random() * BANK.P3.length)]}\n\n${BANK.P4[Math.floor(Math.random() * BANK.P4.length)]}\n\n#${symbol} $${symbol}`;

    try {
        await axios.post(SETTINGS.SQUARE_URL, { bodyTextOnly: content }, {
            headers: { "X-Square-OpenAPI-Key": SQUAD_API_KEY, "Content-Type": "application/json" }
        });
        state.postsToday++;
        state.stats[type]++;
        state.lastPostTime = now;
        state.postedTodaySymbols.add(symbol);
        addLog(`✅ [${type.toUpperCase()}] Đăng: ${symbol} (${change}%) - Tổng: ${state.postsToday}`);
    } catch (e) {
        addLog(`❌ Lỗi API: ${e.message}`);
    }
}

async function bootstrapData() {
    try {
        const res = await fetch('https://fapi.binance.com/fapi/v1/ticker/24hr');
        const tickers = await res.json();
        tickers.filter(t => t.symbol.endsWith('USDT')).forEach(t => {
            state.coinData[t.symbol] = { 
                symbol: t.symbol, 
                prices: [{p: parseFloat(t.lastPrice), t: Date.now()}],
                d1: parseFloat(t.priceChangePercent).toFixed(2),
                vol: parseFloat(t.quoteVolume).toFixed(0),
                live: { c1: 0, c5: 0, currentPrice: parseFloat(t.lastPrice) }
            };
        });
        addLog("📊 Khởi tạo dữ liệu xong. Sẵn sàng biến động!");
    } catch (e) { addLog("❌ Lỗi khởi tạo."); }
}

function initWS() {
    const ws = new WebSocket('wss://fstream.binance.com/ws/!ticker@arr');
    ws.on('message', (msg) => {
        checkNewDay();
        const tickers = JSON.parse(msg);
        tickers.forEach(t => { 
            if (t.s.endsWith('USDT')) updatePriceLogic(t.s, parseFloat(t.c), Date.now(), t.P, t.q); 
        });
    });
    ws.on('close', () => setTimeout(initWS, 3000));
}

const app = express();
app.get('/api/status', (req, res) => {
    const table = Object.entries(state.coinData)
        .filter(([_, v]) => v.live)
        .map(([s, v]) => ({ symbol: s, ...v.live, d1: v.d1, vol: parseFloat(v.vol) }))
        .sort((a,b) => a.vol - b.vol)
        .slice(0, 20);
    res.json({ ...state, table });
});

app.get('/api/toggle', (req, res) => { 
    state.isRunning = !state.isRunning; 
    addLog(state.isRunning ? "🚀 START BOT" : "🛑 STOP BOT");
    res.json({ s: state.isRunning }); 
});

app.get('/', (req, res) => {
    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><script src="https://cdn.tailwindcss.com"></script><style>@import url('https://fonts.googleapis.com/css2?family=Orbitron:wght@400;900&display=swap'); .glow { text-shadow: 0 0 10px rgba(234,179,8,0.5); }</style></head>
    <body class="bg-[#0b0e11] text-zinc-300 p-2 font-sans select-none">
        <div class="max-w-md mx-auto">
            <div class="bg-[#1e2329] p-4 rounded-2xl border-b-4 border-yellow-500 shadow-2xl mb-3">
                <div class="flex justify-between items-center mb-4">
                    <div>
                        <h1 style="font-family:'Orbitron'" class="text-xl font-black text-yellow-500 italic glow">LUFFY SQUAD</h1>
                        <div id="status-text" class="text-[10px] text-zinc-500 uppercase">Status: IDLE</div>
                    </div>
                    <button onclick="toggleBot()" id="btn" class="px-6 py-2 rounded-xl font-bold bg-yellow-500 text-black shadow-lg active:scale-95 transition-all text-sm">START</button>
                </div>
                <div class="grid grid-cols-4 gap-1 text-center border-t border-white/5 pt-3">
                    <div class="bg-black/40 p-2 rounded-xl border border-white/5">
                        <div class="text-[8px] text-zinc-500 mb-1">M1 / M5</div>
                        <div id="s1" class="text-xs font-bold text-red-500">0</div>
                    </div>
                    <div class="bg-black/40 p-2 rounded-xl border border-white/5">
                        <div class="text-[8px] text-zinc-500 mb-1">D1 (24H)</div>
                        <div id="s2" class="text-xs font-bold text-yellow-500">0</div>
                    </div>
                    <div class="bg-black/40 p-2 rounded-xl border border-white/5">
                        <div class="text-[8px] text-zinc-500 mb-1">LOẠI 3 (VOL)</div>
                        <div id="s3" class="text-xs font-bold text-green-500">0</div>
                    </div>
                    <div class="bg-black/40 p-2 rounded-xl border border-white/5">
                        <div class="text-[8px] text-zinc-500 mb-1">TỔNG NGÀY</div>
                        <div id="total-stats" class="text-xs font-bold text-blue-500">0</div>
                    </div>
                </div>
            </div>

            <div class="bg-[#1e2329] rounded-2xl border border-white/5 shadow-lg overflow-hidden mb-3">
                <div class="p-3 bg-white/5 text-[10px] font-bold uppercase">Top Vol thấp nhất (Vét máng 23h)</div>
                <div class="overflow-x-auto">
                    <table class="w-full text-[11px] text-left">
                        <thead class="text-zinc-500 bg-black/20">
                            <tr><th class="p-2">COIN</th><th class="text-right p-2">M1%</th><th class="text-right p-2">D1%</th><th class="text-right p-2">VOL</th></tr>
                        </thead>
                        <tbody id="tb"></tbody>
                    </table>
                </div>
            </div>

            <div class="bg-black rounded-2xl border border-white/5 p-3 shadow-inner">
                <div id="lb" class="h-48 overflow-y-auto text-[10px] font-mono text-zinc-400 space-y-1"></div>
            </div>
        </div>
        <script>
            async function toggleBot() { 
                const res = await fetch('/api/toggle'); 
                const d = await res.json(); 
                document.getElementById('btn').innerText = d.s ? "STOP" : "START";
                document.getElementById('status-text').innerText = d.s ? "Status: RUNNING" : "Status: IDLE";
            }
            async function refresh() {
                try {
                    const res = await fetch('/api/status'); 
                    const d = await res.json();
                    document.getElementById('s1').innerText = d.stats.biendong;
                    document.getElementById('s2').innerText = d.stats.day;
                    document.getElementById('s3').innerText = d.stats.vol;
                    document.getElementById('total-stats').innerText = d.postsToday;
                    document.getElementById('lb').innerHTML = d.logs.map(l => \`<div>\${l}</div>\`).join('');
                    document.getElementById('tb').innerHTML = d.table.map(v => \`
                        <tr class="border-b border-white/5">
                            <td class="p-2 font-bold">\${v.symbol.replace('USDT','')}</td>
                            <td class="text-right p-2 \${Math.abs(v.c1)>=7.0?'text-red-500':'text-zinc-400'}">\${v.c1}%</td>
                            <td class="text-right p-2 \${Math.abs(v.d1)>=10.0?'text-yellow-500':'text-zinc-400'}">\${v.d1}%</td>
                            <td class="text-right p-2 text-zinc-500">\${(v.vol/1000).toFixed(0)}K</td>
                        </tr>\`).join('');
                } catch(e) {}
            }
            setInterval(refresh, 2000);
        </script>
    </body></html>`);
});

app.listen(PORT, '0.0.0.0', async () => {
    await bootstrapData();
    initWS();
    console.log(`Luffy Bot Ready: http://localhost:${PORT}`);
});
