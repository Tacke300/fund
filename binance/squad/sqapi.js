import { API_KEY, SECRET_KEY } from './config.js';
import WebSocket from 'ws';
import express from 'express';
import fetch from 'node-fetch';
import axios from 'axios';
import cron from 'node-cron';

const PORT = 8888;
const SQUAD_API_KEY = "8d794c11cc794c958c2c65924c54f2dd"; 

const SETTINGS = {
    SQUARE_URL: "https://www.binance.com/bapi/composite/v1/public/pgc/openApi/content/add",
    VOL_LIMIT: 7.0,   
    DAY_LIMIT: 10.0,  
    MAX_POSTS_PER_DAY: 100,
    MIN_GAP: 60000,        
    VOL_INTERVAL: 15 * 60000 
};

const BANK = {
    P1: [
        "Dòng tiền thông minh đang đổ mạnh vào hệ sinh thái này sau chuỗi ngày tích lũy.",
        "Dữ liệu on-chain cho thấy các ví cá voi đang bắt đầu gom hàng số lượng lớn.",
        "Áp lực bán đã cạn kiệt hoàn toàn tại vùng hỗ trợ tâm lý quan trọng này.",
        "Sự dịch chuyển vốn từ các stablecoin sang tài sản này đang diễn ra rất nhanh.",
        "Các tổ chức lớn đang đặt lệnh chờ mua dày đặc tại vùng giá hiện tại.",
        "Hệ thống ghi nhận sự gia tăng đột biến của các địa chỉ ví hoạt động mới.",
        "Tỷ lệ dự trữ trên các sàn giao dịch đang giảm mạnh nhất trong vòng 3 tháng qua.",
        "Chỉ số dòng tiền ròng đang dương mạnh mẽ báo hiệu một nhịp tăng dài hạn.",
        "Thị trường phái sinh đang cho thấy sự ưu thế tuyệt đối của phe mua vị thế.",
        "Cấu trúc dòng tiền hiện tại rất giống với giai đoạn tiền bùng nổ của năm ngoái.",
        "Lượng cung lưu thông đang bị thắt chặt do các hoạt động staking và khóa vốn.",
        "Dòng tiền đang luân chuyển từ các nhóm coin rác sang những tài sản có nền tảng.",
        "Quan sát sổ lệnh cho thấy tường bán phía trên rất mỏng và dễ bị phá vỡ.",
        "Các nhà đầu tư dài hạn đang giữ vị thế rất chắc chắn bất chấp biến động ngắn hạn.",
        "Tín hiệu gom hàng âm thầm từ các quỹ đầu tư lớn đã được hệ thống xác nhận.",
        "Lực cầu chủ động đang gia tăng mạnh mẽ khi giá chạm sát dải hỗ trợ dưới.",
        "Tâm lý thị trường đang chuyển dịch từ sợ hãi sang kỳ vọng tăng trưởng cao.",
        "Sự phân hóa dòng tiền đang tập trung rõ rệt vào danh mục tài sản tiềm năng này.",
        "Chỉ số thanh khoản đang ở mức rất tốt để hỗ trợ cho một đợt đẩy giá mạnh.",
        "Dòng vốn từ thị trường quốc tế đang có dấu hiệu đổ vào thông qua các quỹ ETF.",
        "Dữ liệu lịch sử cho thấy đây là vùng gom hàng tối ưu của các nhà tạo lập.",
        "Mức độ biến động của dòng tiền đang tạo ra những cơ hội đột phá lớn.",
        "Sự kết hợp giữa tin tức cơ bản và dòng tiền đang tạo ra lực đẩy kép.",
        "Lượng stablecoin nạp lên sàn đang đạt đỉnh điểm để chuẩn bị cho đợt mua mới.",
        "Các vị thế bán khống đang bị ép chặt và có nguy cơ cháy hàng loạt.",
        "Dòng tiền từ nhóm nhà đầu tư nhỏ lẻ đang bắt đầu đuổi theo xu hướng chính.",
        "Hệ thống ghi nhận các lệnh mua lô lớn liên tục được thực hiện trong 1 giờ qua.",
        "Sự ổn định của dòng tiền cho thấy niềm tin của thị trường đang hồi phục mạnh.",
        "Vùng giá này đang được bảo vệ bởi những thuật toán giao dịch của các quỹ lớn.",
        "Tốc độ luân chuyển dòng tiền đang đạt mức cao nhất kể từ đầu quý này.",
        "Thị trường đang ở trạng thái khan hiếm hàng giá rẻ do lực mua quá áp đảo.",
        "Chỉ số hưng phấn dòng tiền đang ở mức ổn định để duy trì xu hướng tăng bền.",
        "Dòng tiền đầu tư mạo hiểm đang ưu tiên các dự án có thanh khoản cao như này.",
        "Việc tích lũy tại vùng đáy cũ đã hoàn tất và dòng tiền đang bắt đầu đẩy.",
        "Tín hiệu đảo chiều dòng tiền từ tiêu cực sang tích cực đã rõ ràng hơn bao giờ hết.",
        "Mức độ hấp thụ lực xả tại vùng kháng cự cho thấy sức mạnh của phe mua.",
        "Sự đồng thuận của dòng tiền trên nhiều sàn giao dịch đang là tín hiệu tốt.",
        "Dòng tiền nóng đang tìm kiếm các điểm dừng chân tiềm năng sau khi chốt lời.",
        "Thị trường đang định giá lại tài sản này dựa trên dòng tiền thực tế đổ vào.",
        "Chỉ số áp lực mua đang vượt xa áp lực bán trong 4 phiên giao dịch gần nhất.",
        "Sự dịch chuyển tài sản từ ví cá nhân lên sàn để chốt lời vẫn chưa xuất hiện.",
        "Dòng tiền đang hỗ trợ cho một cấu trúc tăng trưởng lành mạnh và vững chắc.",
        "Các chỉ số về độ rộng thị trường đang nghiêng hẳn về phía các lệnh Long.",
        "Dòng tiền từ các thị trường mới nổi đang bắt đầu quan tâm đến tài sản này.",
        "Sự bùng nổ của dòng tiền có thể diễn ra bất cứ lúc nào trong phiên tới.",
        "Vốn hóa thị trường của đồng coin này đang tăng trưởng tỷ lệ thuận với dòng tiền.",
        "Cấu trúc cung cầu đang ở trạng thái mất cân bằng có lợi cho phe tăng giá.",
        "Dòng tiền đầu cơ đã rút đi nhường chỗ cho dòng tiền đầu tư dài hạn hơn.",
        "Mức độ chấp nhận rủi ro của dòng tiền đang tăng cao trước ngưỡng cửa mới.",
        "Dòng tiền tổng thể đang xác nhận đây là nhịp bắt đầu của một con sóng thần."
    ],
    P2: [
        "Về mặt kỹ thuật giá đã bứt phá ra khỏi kênh giảm giá kéo dài nhiều tuần.",
        "Đường EMA 20 và 50 đang thực hiện cú cắt vàng báo hiệu xu hướng tăng mạnh.",
        "Chỉ báo RSI đang tiến vào vùng mạnh mẽ nhưng vẫn chưa quá mua.",
        "MACD vừa giao cắt phía trên đường 0 xác nhận động lực tăng trưởng bền vững.",
        "Mô hình nến nhấn chìm tăng trưởng vừa xuất hiện ngay tại vùng hỗ trợ cứng.",
        "Giá đang nhận được sự hỗ trợ mạnh mẽ từ đường trung bình động MA 200.",
        "Dải Bollinger Bands đang co thắt cực độ báo hiệu một cú nổ biên độ lớn.",
        "Mô hình hai đáy đã hoàn thiện với khối lượng giao dịch xác nhận cực cao.",
        "Giá đã vượt qua ngưỡng kháng cự Fibonacci 0.618 một cách dứt khoát.",
        "Cấu trúc sóng Elliott cho thấy tài sản này đang nằm trong sóng 3 đẩy mạnh.",
        "Chỉ báo Ichimoku cho thấy giá đã vượt lên trên đám mây Kumo dày đặc.",
        "Sự phân kỳ dương của chỉ báo động lượng báo hiệu đáy đã được xác lập.",
        "Giá đang kiểm tra lại (retest) vùng đỉnh cũ với áp lực bán rất thấp.",
        "Khối lượng giao dịch gia tăng liên tục trong các phiên tăng giá gần nhất.",
        "Mô hình lá cờ tăng đang hình thành báo hiệu mục tiêu giá còn rất xa.",
        "Chỉ số Stochastic đang cho tín hiệu mua mạnh từ vùng quá bán đi lên.",
        "Giá đang bám sát dải băng trên của Bollinger Bands cho thấy lực mua mạnh.",
        "Sự hội tụ của các chỉ báo kỹ thuật đang chỉ về một hướng tăng duy nhất.",
        "Giá đã thoát khỏi vùng đi ngang (sideway) kéo dài trong biên độ hẹp.",
        "Hệ thống kỹ thuật ghi nhận lực mua áp đảo tại các khung thời gian lớn.",
        "Các mức kháng cự ngắn hạn liên tục bị phá vỡ với xung lực cực mạnh.",
        "Giá đang nằm trên tất cả các đường trung bình động quan trọng nhất.",
        "Mô hình nến búa (Hammer) xuất hiện tại đáy cho thấy lực cầu bắt đáy lớn.",
        "Sự gia tăng của Open Interest cho thấy dòng tiền mới đang gia nhập cuộc chơi.",
        "Chỉ báo MFI cho thấy dòng tiền đang đổ vào tài sản này một cách đều đặn.",
        "Giá đang hướng tới vùng mục tiêu cao hơn sau khi tích lũy đủ biên độ.",
        "Khu vực hỗ trợ hiện tại rất khó bị xuyên thủng trong tương lai gần.",
        "Tín hiệu kỹ thuật xác nhận đây là một nhịp tăng trưởng lành mạnh.",
        "Cấu trúc giá sau khi breakout đang cho thấy sự ổn định đáng kinh ngạc.",
        "Các phiên điều chỉnh vừa qua chỉ là nhịp rũ bỏ những nhà đầu tư yếu tâm lý.",
        "Chỉ báo ADX cho thấy xu hướng tăng hiện tại đang rất mạnh mẽ và rõ rệt.",
        "Giá đang phản ứng tích cực với các mốc hỗ trợ kỹ thuật theo đồ thị ngày.",
        "Sự bứt phá của khối lượng giao dịch là bằng chứng thép cho đà tăng.",
        "Giá đang ở vị thế thuận lợi để chinh phục những cột mốc lịch sử mới.",
        "Tín hiệu nến rút chân liên tục xuất hiện cho thấy phe mua đang thắng thế.",
        "Vùng tích lũy hiện tại là nền tảng vững chắc cho những cú nhảy vọt tiếp theo.",
        "Các chỉ báo xu hướng đang đồng nhất ở trạng thái tích cực trên mọi khung hình.",
        "Giá đang thể hiện sức mạnh tương đối (RSI) vượt trội so với Bitcoin.",
        "Sự ổn định của hành động giá đang thu hút thêm các nhà giao dịch kỹ thuật.",
        "Mô hình cốc tay cầm đang ở giai đoạn hoàn thiện phần miệng cốc.",
        "Giá đã lấy lại được các mốc quan trọng sau đợt biến động mạnh vừa rồi.",
        "Sức mạnh của phe bò đang được củng cố qua từng phiên giao dịch.",
        "Các công cụ quét tín hiệu đều đưa ra khuyến nghị mua ở vùng giá hiện tại.",
        "Cấu trúc giá không cho thấy bất kỳ dấu hiệu suy yếu nào trong ngắn hạn.",
        "Nhịp tăng này được hỗ trợ bởi cả yếu tố kỹ thuật và tâm lý thị trường.",
        "Biên độ dao động đang mở rộng theo hướng tích cực cho các vị thế mua.",
        "Mức hỗ trợ động từ EMA đang đẩy giá lên các vùng cao mới một cách bền bỉ.",
        "Sự giao thoa giữa các khung thời gian đang ủng hộ cho một đà tăng kéo dài.",
        "Giá đang cho thấy khả năng phục hồi thần tốc sau mỗi nhịp giảm nhẹ.",
        "Mục tiêu kỹ thuật tiếp theo đang nằm trong tầm tay của các nhà đầu tư."
    ],
    P3: [
        "Kế hoạch giao dịch tối ưu lúc này là kiên nhẫn chờ đợi điểm vào lệnh đẹp.",
        "Quản trị rủi ro bằng cách đặt dừng lỗ tuyệt đối để bảo vệ nguồn vốn.",
        "Hãy cân nhắc giải ngân từng phần thay vì tất tay (all-in) tại một vùng giá.",
        "Chiến lược mua khi điều chỉnh vẫn tỏ ra hiệu quả nhất trong xu hướng này.",
        "Đừng để tâm lý FOMO chi phối quyết định giao dịch của bạn lúc này.",
        "Luôn duy trì tỷ lệ lợi nhuận trên rủi ro ít nhất là 2:1 cho mọi vị thế.",
        "Kiên định với mục tiêu chốt lời đã đề ra và không nên quá tham lam.",
        "Thị trường luôn có cơ hội cho những người biết chờ đợi đúng thời điểm.",
        "Hãy tập trung vào những tài sản có tín hiệu dòng tiền rõ nét nhất.",
        "Việc bảo vệ lợi nhuận cũng quan trọng không kém việc tìm kiếm lợi nhuận.",
        "Sử dụng đòn bẩy hợp lý để tránh những cú quét thanh khoản bất ngờ.",
        "Cập nhật tin tức liên tục nhưng hãy lọc bỏ những tín hiệu nhiễu.",
        "Kỷ luật là chìa khóa duy nhất giúp bạn tồn tại lâu dài trong thị trường.",
        "Hãy chia nhỏ danh mục để tối ưu hóa khả năng sinh lời và giảm rủi ro.",
        "Vùng giá hiện tại rất thích hợp để bắt đầu xây dựng vị thế dài hạn.",
        "Quan sát phản ứng của giá tại các ngưỡng kháng cự để đưa ra quyết định.",
        "Đừng cố gắng chống lại xu hướng chính của thị trường vào lúc này.",
        "Lợi nhuận bền vững đến từ những quyết định có tính toán và kỷ luật.",
        "Hãy chuẩn bị sẵn kịch bản dự phòng cho mọi tình huống biến động mạnh.",
        "Giữ vững tâm lý và không để các biến động nhỏ làm ảnh hưởng đến kế hoạch.",
        "Thành công trong trading là kết quả của sự chuẩn bị kỹ lưỡng mỗi ngày.",
        "Hãy học cách chấp nhận những khoản lỗ nhỏ để đón nhận những con sóng lớn.",
        "Tập trung vào quy trình giao dịch thay vì chỉ nhìn vào con số lợi nhuận.",
        "Luôn ghi nhật ký giao dịch để rút kinh nghiệm từ những sai lầm trong quá khứ.",
        "Sự kiên nhẫn là đức tính quý giá nhất của một nhà giao dịch thành công.",
        "Hãy tận dụng những nhịp điều chỉnh để gia tăng vị thế cho danh mục.",
        "Đừng bao giờ đầu tư số tiền mà bạn không thể chấp nhận mất đi.",
        "Chiến thắng thị trường bắt đầu từ việc chiến thắng bản thân mình.",
        "Hãy luôn đặt câu hỏi tại sao trước khi quyết định bấm nút vào lệnh.",
        "Sức mạnh của lãi kép sẽ phát huy tác dụng nếu bạn giao dịch bền bỉ.",
        "Đừng để cảm xúc cá nhân làm mờ mắt trước những dữ liệu thực tế.",
        "Học cách đứng ngoài thị trường khi không thấy tín hiệu giao dịch rõ ràng.",
        "Sự đơn giản trong chiến lược thường mang lại hiệu quả cao nhất.",
        "Hãy tin tưởng vào hệ thống phân tích của mình và kiên trì theo đuổi.",
        "Giao dịch theo xu hướng là con đường ngắn nhất dẫn đến lợi nhuận.",
        "Mỗi lệnh giao dịch đều là một bài học quý báu về quản trị tâm lý.",
        "Hãy biết đủ và dừng lại đúng lúc để bảo vệ thành quả lao động.",
        "Thị trường tài chính là nơi chuyển tiền từ người thiếu kiên nhẫn sang người kiên nhẫn.",
        "Hãy luôn giữ cho mình một tâm thế học hỏi và cầu thị trước thị trường.",
        "Chiến lược DCA luôn là cứu cánh an toàn cho mọi nhà đầu tư cá nhân.",
        "Sự tỉnh táo trong những lúc thị trường hưng phấn nhất là vô cùng cần thiết.",
        "Hãy chốt lời từng phần để tâm lý luôn ở trạng thái thoải mái nhất.",
        "Mọi phân tích chỉ mang tính chất tham khảo, quyết định cuối cùng thuộc về bạn.",
        "Hãy rèn luyện kỹ năng đọc hiểu biểu đồ mỗi ngày để nâng cao trình độ.",
        "Sự tự tin trong giao dịch đến từ kiến thức và trải nghiệm thực tế.",
        "Luôn có sẵn một khoản dự phòng để nắm bắt những cơ hội vàng.",
        "Đừng nhìn vào túi tiền của người khác mà hãy tập trung vào kế hoạch của mình.",
        "Giao dịch là một cuộc chạy marathon, không phải là một cuộc đua nước rút.",
        "Hãy bảo vệ sức khỏe và tinh thần để có những quyết định sáng suốt nhất.",
        "Kết quả cuối cùng sẽ phản ánh đúng nỗ lực và sự nghiêm túc của bạn."
    ],
    P4: [
        "Chúc anh em có một ngày giao dịch thật sự bùng nổ và lợi nhuận đầy túi.",
        "Hy vọng may mắn sẽ mỉm cười với mọi quyết định vào lệnh của các bạn hôm nay.",
        "Chúc cho các chỉ số tài khoản của anh em luôn ở trạng thái xanh rực rỡ.",
        "Mong rằng sự kiên trì của các bạn sẽ sớm gặt hái được những thành quả lớn.",
        "Chúc anh em chốt lời đúng đỉnh và vào hàng ngay tại vùng đáy tiềm năng.",
        "Gửi những lời chúc tốt đẹp nhất đến cộng đồng nhà đầu tư thông thái.",
        "Chúc cho mọi dự đoán của anh em đều chính xác và mang lại thành công.",
        "Hy vọng các bạn luôn giữ vững được niềm tin và sự lạc quan trên thị trường.",
        "Chúc anh em có những giờ phút giao dịch thoải mái và đầy năng lượng.",
        "Mong may mắn luôn đồng hành cùng các chiến hữu trên mọi nẻo đường trading.",
        "Chúc cho danh mục đầu tư của bạn tăng trưởng vượt bậc trong tuần này.",
        "Hy vọng anh em luôn đưa ra được những quyết định sáng suốt và kịp thời.",
        "Chúc các bạn sớm đạt được tự do tài chính nhờ những bước đi đúng đắn.",
        "Gửi lời chúc thắng lợi đến tất cả anh em đang bám trụ cùng thị trường.",
        "Chúc anh em luôn có một cái đầu lạnh để đưa ra những phân tích chuẩn xác.",
        "Mong rằng mọi nỗ lực nghiên cứu của bạn đều được đền đáp xứng đáng.",
        "Chúc các lệnh Long/Short của anh em đều khớp TP trong thời gian sớm nhất.",
        "Hy vọng bầu không khí giao dịch hôm nay sẽ mang lại nhiều tin vui cho mọi người.",
        "Chúc anh em một ngày làm việc và giao dịch thật sự hiệu quả và vui vẻ.",
        "Mong rằng các bạn sẽ tìm thấy được những siêu phẩm trong ngày hôm nay.",
        "Chúc cho mọi giao dịch của bạn đều mang lại những trải nghiệm tích cực.",
        "Hy vọng anh em luôn duy trì được phong độ ổn định và lợi nhuận đều đặn.",
        "Chúc các bạn có thêm nhiều kiến thức và kinh nghiệm sau mỗi phiên giao dịch.",
        "Gửi lời chúc sức khỏe và thành công đến đại gia đình nhà đầu tư.",
        "Chúc cho con đường đi đến giàu sang của anh em ngày càng ngắn lại.",
        "Hy vọng mọi biến động của thị trường đều nằm trong tầm kiểm soát của bạn.",
        "Chúc anh em chốt lời xong là giá đảo chiều để tối ưu hóa lợi nhuận.",
        "Mong rằng may mắn sẽ luôn là người bạn đồng hành trung thành của anh em.",
        "Chúc cho tài khoản của bạn không bao giờ phải thấy màu đỏ của sự thua lỗ.",
        "Hy vọng hôm nay sẽ là một ngày rực rỡ nhất trong tháng giao dịch này.",
        "Chúc anh em luôn vững tay chèo trước những con sóng lớn của thị trường.",
        "Mong các bạn luôn tìm thấy niềm vui trong công việc giao dịch mỗi ngày.",
        "Chúc cho sự nghiệp trading của bạn ngày càng phát triển và bền vững.",
        "Hy vọng anh em sẽ có một buổi tối ăn mừng thắng lợi cùng gia đình.",
        "Chúc các bạn luôn bình tĩnh để xử lý mọi tình huống khó khăn nhất.",
        "Gửi lời chúc may mắn đến các sĩ tử đang chinh chiến trên sàn giao dịch.",
        "Chúc anh em sớm tìm được công thức giao dịch bất bại cho riêng mình.",
        "Mong rằng mọi giấc mơ tài chính của bạn sẽ sớm trở thành hiện thực.",
        "Chúc cho cộng đồng của chúng ta ngày càng lớn mạnh và giàu có hơn.",
        "Hy vọng anh em sẽ luôn tự hào về những quyết định đầu tư của chính mình.",
        "Chúc các bạn có một tinh thần thép để chiến thắng mọi bẫy giá thị trường.",
        "Mong rằng hôm nay mọi lệnh trade của bạn đều là những lệnh thắng đậm.",
        "Chúc anh em luôn có đủ sự kiên nhẫn để chờ đợi những cơ hội vàng.",
        "Hy vọng sự giàu có và thịnh vượng sẽ luôn tìm đến với các bạn.",
        "Chúc cho mọi ngày giao dịch đều là những ngày lễ hội đối với anh em.",
        "Mong rằng các bạn sẽ luôn là những người dẫn đầu xu hướng thị trường.",
        "Chúc anh em giữ vững được lợi nhuận và không để thị trường lấy lại.",
        "Hy vọng mọi mục tiêu chốt lời của bạn đều được thực hiện một cách dễ dàng.",
        "Chúc các bạn có một hành trình đầu tư đầy thú vị và nhiều hoa hồng.",
        "Gửi lời chúc cuối cùng thật rực rỡ đến tất cả anh em chiến hữu!"
    ]
};

let state = {
    isRunning: false,
    postsToday: 0,
    stats: { biendong: 0, day: 0, vol: 0 },
    lastPostTime: 0,
    lastVolPost: 0,
    postedSymbols: new Set(),
    logs: [],
    marketData: {}
};

const addLog = (m) => {
    const t = new Date().toLocaleTimeString();
    state.logs.unshift(`[${t}] ${m}`);
    if (state.logs.length > 50) state.logs.pop();
};

async function post(symbol, reason, typeKey) {
    if (!state.isRunning) return;
    if (state.postsToday >= SETTINGS.MAX_POSTS_PER_DAY) {
        addLog(`⚠️ Đạt giới hạn 100 bài/ngày. Ngưng đăng.`);
        return;
    }
    if (state.postedSymbols.has(symbol)) return;

    const now = Date.now();
    if (now - state.lastPostTime < SETTINGS.MIN_GAP) {
        addLog(`⏳ Đang chờ giãn cách 60s giữa các bài...`);
        return;
    }

    addLog(`📢 Đang chuẩn bị nội dung bài đăng cho ${symbol} (${reason})...`);

    const content = `${BANK.P1[Math.floor(Math.random() * 50)]}\n\n${BANK.P2[Math.floor(Math.random() * 50)]}\n\n${BANK.P3[Math.floor(Math.random() * 50)]}\n\n${BANK.P4[Math.floor(Math.random() * 50)]}\n\n#${symbol} $${symbol}`;

    try {
        await axios.post(SETTINGS.SQUARE_URL, { bodyTextOnly: content }, {
            headers: { "X-Square-OpenAPI-Key": SQUAD_API_KEY, "Content-Type": "application/json" }
        });
        
        state.postsToday++;
        state.stats[typeKey]++;
        state.lastPostTime = now;
        state.postedSymbols.add(symbol);
        if (typeKey === 'vol') state.lastVolPost = now;
        
        addLog(`✅ ĐĂNG THÀNH CÔNG: ${symbol} (${reason}). Tổng: ${state.postsToday}.`);
    } catch (e) { 
        addLog(`❌ API ERROR (${symbol}): ${e.message}`); 
    }
}

function initWS() {
    addLog("🌐 Đang khởi tạo luồng dữ liệu WebSocket...");
    const ws = new WebSocket('wss://fstream.binance.com/ws/!miniTicker@arr');
    ws.on('message', (msg) => {
        const tickers = JSON.parse(msg);
        const now = Date.now();
        tickers.forEach(t => {
            if (!t.s.endsWith('USDT')) return;
            if (!state.marketData[t.s]) state.marketData[t.s] = { history: [], d1: 0, m1: 0, m5: 0 };
            let d = state.marketData[t.s];
            d.history.push({ p: parseFloat(t.c), t: now });
            if (d.history.length > 900) d.history.shift();

            const getChg = (min) => {
                let targetTime = now - (min * 60000);
                let old = d.history.find(i => i.t >= targetTime) || d.history[0];
                if (!old) return 0;
                return ((parseFloat(t.c) - old.p) / old.p * 100);
            };

            d.m1 = getChg(1);
            d.m5 = getChg(5);

            if (state.isRunning) {
                if (Math.abs(d.m1) >= SETTINGS.VOL_LIMIT || Math.abs(d.m5) >= SETTINGS.VOL_LIMIT) {
                    const maxChg = Math.max(Math.abs(d.m1), Math.abs(d.m5));
                    post(t.s, `BIẾN ĐỘNG ${maxChg.toFixed(2)}%`, 'biendong');
                }
            }
        });
    });
    ws.on('close', () => { addLog("🔴 WebSocket ngắt. Đang thử kết nối lại..."); setTimeout(initWS, 3000); });
}

setInterval(async () => {
    if (!state.isRunning) return;
    try {
        const res = await fetch('https://fapi.binance.com/fapi/v1/ticker/24hr');
        const data = await res.json();
        data.forEach(i => { if(state.marketData[i.symbol]) state.marketData[i.symbol].d1 = i.priceChangePercent; });
        
        const now = Date.now();
        const topDay = data.sort((a,b) => Math.abs(b.priceChangePercent) - Math.abs(a.priceChangePercent))[0];
        if (topDay && Math.abs(topDay.priceChangePercent) >= SETTINGS.DAY_LIMIT) {
            await post(topDay.symbol, `TĂNG TRƯỞNG NGÀY ${topDay.priceChangePercent}%`, 'day');
        }

        if (now - state.lastVolPost >= SETTINGS.VOL_INTERVAL) {
            const topVol = data.sort((a,b) => b.quoteVolume - a.quoteVolume).find(i => !state.postedSymbols.has(i.symbol));
            if (topVol) await post(topVol.symbol, "TOP VOLUME THỊ TRƯỜNG", 'vol');
        }
    } catch (e) { addLog(`❌ Lỗi Fetch Data: ${e.message}`); }
}, 30000);

cron.schedule('0 0 0 * * *', () => { 
    state.postsToday = 0; state.stats = { biendong: 0, day: 0, vol: 0 }; state.postedSymbols.clear(); 
    addLog("📅 Đã sang ngày mới. Reset bộ đếm."); 
});

const app = express();
app.get('/api/status', (req, res) => {
    const table = Object.entries(state.marketData)
        .sort((a,b) => Math.abs(b[1].d1||0) - Math.abs(a[1].d1||0))
        .slice(0, 15);
    res.json({ ...state, table });
});
app.get('/api/toggle', (req, res) => { 
    state.isRunning = !state.isRunning; 
    addLog(state.isRunning ? "▶️ BOT BẮT ĐẦU CHẠY..." : "⏸️ BOT ĐÃ DỪNG LẠI.");
    res.json({ s: state.isRunning }); 
});

app.get('/', (req, res) => {
    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><script src="https://cdn.tailwindcss.com"></script><style>@import url('https://fonts.googleapis.com/css2?family=Orbitron:wght@400;900&display=swap'); .font-neon { font-family: 'Orbitron', sans-serif; }</style></head><body class="bg-[#0b0e11] text-white p-3 font-sans">
        <div class="max-w-md mx-auto">
            <div class="bg-[#1e2329] p-5 rounded-2xl mb-4 border-b-4 border-yellow-500 shadow-2xl">
                <h1 class="text-2xl font-black font-neon italic text-yellow-500 italic">LUFFY MOBILE PRO</h1>
                <div class="grid grid-cols-3 gap-2 mt-4 text-center">
                    <div class="bg-black/40 p-2 rounded-lg border border-zinc-800"><div class="text-[9px] text-zinc-500">BIẾN ĐỘNG</div><div id="sbd" class="text-sm font-bold text-red-500">0</div></div>
                    <div class="bg-black/40 p-2 rounded-lg border border-zinc-800"><div class="text-[9px] text-zinc-500">NGÀY</div><div id="sday" class="text-sm font-bold text-yellow-500">0</div></div>
                    <div class="bg-black/40 p-2 rounded-lg border border-zinc-800"><div class="text-[9px] text-zinc-500">VOLUME</div><div id="svol" class="text-sm font-bold text-blue-500">0</div></div>
                </div>
                <div class="flex justify-between items-center mt-4 pt-4 border-t border-zinc-800">
                    <div class="text-xs font-bold">TỔNG ĐĂNG: <span id="total" class="text-green-500 text-lg">0</span></div>
                    <button onclick="toggleBot()" id="btnPower" class="px-10 py-3 rounded-xl font-black bg-yellow-500 text-black">START</button>
                </div>
            </div>
            <div class="bg-[#1e2329] p-4 rounded-2xl mb-4 border border-zinc-800 overflow-hidden shadow-lg">
                <h3 class="text-[10px] text-zinc-500 mb-3 font-bold uppercase italic">Bảng Theo Dõi Biến Động</h3>
                <table class="w-full text-[11px] text-left">
                    <thead class="text-zinc-600 font-bold border-b border-zinc-800"><tr><th class="pb-2">COIN</th><th class="pb-2 text-right">M1</th><th class="pb-2 text-right">M5</th><th class="pb-2 text-right text-yellow-500">24H</th></tr></thead>
                    <tbody id="tb"></tbody>
                </table>
            </div>
            <div class="bg-black p-4 rounded-2xl border border-zinc-800 h-[250px] overflow-y-auto text-[10px] text-green-400 font-mono shadow-inner" id="lb"></div>
        </div>
        <script>
            async function toggleBot() { const res = await fetch('/api/toggle'); const d = await res.json(); updateBtn(d.s); }
            function updateBtn(r) {
                const b = document.getElementById('btnPower');
                b.innerText = r ? "STOP BOT" : "START BOT";
                b.className = r ? "px-10 py-3 rounded-xl font-black bg-zinc-800 text-red-500" : "px-10 py-3 rounded-xl font-black bg-yellow-500 text-black";
            }
            async function refresh() {
                try {
                    const res = await fetch('/api/status'); const d = await res.json();
                    document.getElementById('total').innerText = d.postsToday;
                    document.getElementById('sbd').innerText = d.stats.biendong;
                    document.getElementById('sday').innerText = d.stats.day;
                    document.getElementById('svol').innerText = d.stats.vol;
                    updateBtn(d.isRunning);
                    document.getElementById('lb').innerHTML = d.logs.map(l => \`<div class="mb-1 border-b border-zinc-900/50 pb-1">\${l}</div>\`).join('');
                    if (d.table && d.table.length > 0) {
                        document.getElementById('tb').innerHTML = d.table.map(([s, v]) => \`
                        <tr class="border-b border-zinc-900"><td class="py-2 font-bold text-zinc-300">\${s.replace('USDT','')}</td>
                        <td class="text-right \${Math.abs(v.m1)>=7 ? 'text-red-500 font-black':'text-zinc-500'}">\${(v.m1||0).toFixed(2)}%</td>
                        <td class="text-right \${Math.abs(v.m5)>=7 ? 'text-orange-500 font-black':'text-zinc-500'}">\${(v.m5||0).toFixed(2)}%</td>
                        <td class="text-right text-yellow-500 font-bold">\${(parseFloat(v.d1)||0).toFixed(2)}%</td></tr>\`).join('');
                    } else {
                        document.getElementById('tb').innerHTML = "<tr><td colspan='4' class='py-4 text-center text-zinc-600 italic'>Đang kết nối dữ liệu sàn...</td></tr>";
                    }
                } catch(e) {}
            }
            setInterval(refresh, 2000); refresh();
        </script>
    </body></html>`);
});

app.listen(PORT, '0.0.0.0', () => { initWS(); console.log('Luffy Server Ready'); });
