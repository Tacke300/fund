Chào bạn,

Tôi đã thực hiện các thay đổi theo yêu cầu của bạn vào cả mã HTML và Node.js:

Ghi Log dữ liệu từ server trả về: Tôi đã thêm một dòng safeLog('debug', '[SERVER_DATA_FETCHED]', data); vào hàm fetchDataFromServer() trong file Node.js. Khi bot khởi chạy và fetch dữ liệu từ server, bạn sẽ thấy thông tin chi tiết về dữ liệu trả về trong console của Node.js (hoặc file log nếu bạn cấu hình safeLog ghi ra file).

Thêm nút "Test Mở Lệnh" trên HTML:

Thêm một nút mới có ID testOrderBtn vào phần controls trong HTML.

Thêm CSS cơ bản cho nút này.

Trong JavaScript (frontend), tôi đã thêm một trình lắng nghe sự kiện click cho nút này. Khi nhấn, nó sẽ gửi một yêu cầu POST đến endpoint mới /bot-api/test-trade trên server Node.js.

Quan trọng: Tôi đã thêm một cửa sổ confirm để xác nhận với người dùng rằng thao tác này sẽ mở lệnh thật và tốn phí giao dịch.

Trên server Node.js (backend), tôi đã tạo một route mới để xử lý yêu cầu /bot-api/test-trade. Route này sẽ lấy percentageToUse từ request, sau đó sử dụng bestPotentialOpportunityForDisplay (cơ hội tốt nhất đang được hiển thị trên UI) để gọi hàm executeTrades ngay lập tức.

Hàm executeTrades đã được kiểm tra để đảm bảo nó có đủ thông tin cần thiết từ bestPotentialOpportunityForDisplay để thực hiện lệnh.

Cách sử dụng và lưu ý quan trọng:

Kiểm tra Log: Sau khi bạn chạy bot Node.js, hãy quan sát cửa sổ console/terminal nơi bạn chạy file Node.js. Bạn sẽ thấy các log chi tiết về dữ liệu mà server trả về cho bot.

Nút "Test Mở Lệnh" sử dụng TIỀN THẬT: Hãy cực kỳ cẩn thận khi sử dụng nút này. Nó không phải là một mô phỏng. Khi bạn nhấn nút, bot sẽ cố gắng mở lệnh thật trên các sàn giao dịch với số vốn và cơ hội mà nó đang hiển thị. Hãy đảm bảo bạn hiểu rõ rủi ro.

Thời điểm nhấn nút Test: Để nút "Test Mở Lệnh" hoạt động hiệu quả, bot cần đã fetch được dữ liệu cơ hội từ server (có nghĩa là đã có "Cơ hội Arbitrage Tốt nhất (Dự kiến)" hiển thị trên UI). Nếu không có dữ liệu, lệnh test sẽ báo lỗi.

Trạng thái bot: Bạn có thể nhấn nút "Test Mở Lệnh" bất kể bot đang "RUNNING" hay "STOPPED" trên UI. Tuy nhiên, nếu bot đang ở giữa một chu kỳ giao dịch tự động (ví dụ: đang đóng lệnh), việc nhấn test có thể gây ra hành vi không mong muốn. Tốt nhất nên test khi bot đang ở trạng thái "STOPPED" hoặc "RUNNING" nhưng không có lệnh nào đang mở.

Dưới đây là mã nguồn đã được cập nhật:

1. File HTML (index.html):

code
Html
download
content_copy
expand_less

<!DOCTYPE html>
<html lang="vi">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Bot Arbitrage UI - Dark Theme</title>
    <style>
        /* Global Styles */
        body {
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            background-color: #1a1a2e; /* Very dark blue-purple for background */
            color: #e0e0e0; /* Light grey for main text */
            margin: 0;
            padding: 20px;
            line-height: 1.6;
            display: flex;
            justify-content: center;
            align-items: flex-start;
            min-height: 100vh;
        }

        .container {
            max-width: 900px; /* Giảm max-width để trông gọn hơn theo chiều dọc */
            width: 100%;
            margin: 20px auto;
            background-color: #2e304b; /* Slightly lighter dark blue-purple for main container */
            border-radius: 12px;
            box-shadow: 0 8px 30px rgba(0, 0, 0, 0.5);
            padding: 30px 40px;
            box-sizing: border-box;
        }

        h1, h2 {
            color: #9a67ea; /* Primary purple for headings */
            text-align: center;
            margin-bottom: 30px;
            font-weight: 600;
            font-size: 2.2em; /* Kích thước chữ h1 */
        }
        h2 {
            font-size: 1.8em; /* Kích thước chữ h2 */
        }
        h3 {
            font-size: 1.5em; /* Kích thước chữ h3 (tiêu đề card) */
            color: #9a67ea;
            margin-top: 0;
            border-bottom: 1px solid rgba(154, 103, 234, 0.2);
            padding-bottom: 12px;
            margin-bottom: 20px;
            font-weight: 500;
        }


        /* Control Buttons and Input */
        .controls {
            text-align: center;
            margin-bottom: 40px;
            display: flex;
            flex-wrap: wrap;
            justify-content: center;
            align-items: center;
            gap: 20px; /* Space between items */
        }

        .controls label {
            font-size: 1.1em; /* Kích thước chữ label */
            color: #e0e0e0;
            margin-right: 10px;
        }

        .controls input[type="number"] {
            padding: 10px 15px;
            font-size: 1em; /* Kích thước chữ input */
            border: 1px solid #5a5d7e;
            border-radius: 8px;
            background-color: #3e405e;
            color: #e0e0e0;
            width: 80px;
            text-align: center;
            -moz-appearance: textfield; /* Hide arrows for Firefox */
        }
        .controls input[type="number"]::-webkit-outer-spin-button,
        .controls input[type="number"]::-webkit-inner-spin-button {
            -webkit-appearance: none;
            margin: 0;
        }

        .controls button {
            padding: 14px 30px;
            font-size: 1.1em; /* Kích thước chữ button */
            font-weight: bold;
            border: none;
            border-radius: 8px;
            cursor: pointer;
            transition: background-color 0.3s ease, transform 0.2s ease, box-shadow 0.3s ease;
            margin: 0 5px; /* Adjust margin for buttons */
            color: #fff;
            text-transform: uppercase;
            letter-spacing: 0.5px;
        }

        #startBotBtn {
            background-color: #9a67ea; /* Purple for Start */
            box-shadow: 0 4px 10px rgba(154, 103, 234, 0.4);
        }
        #startBotBtn:hover {
            background-color: #7d4fd9;
            transform: translateY(-3px);
            box-shadow: 0 6px 15px rgba(154, 103, 234, 0.6);
        }

        #stopBotBtn {
            background-color: #ef5350; /* Red for Stop */
            box-shadow: 0 4px 10px rgba(239, 83, 80, 0.4);
        }
        #stopBotBtn:hover {
            background-color: #d32f2f;
            transform: translateY(-3px);
            box-shadow: 0 6px 15px rgba(239, 83, 80, 0.6);
        }

        /* NEW: Style for Test Order Button */
        #testOrderBtn {
            background-color: #50bfa4; /* A teal/green color */
            box-shadow: 0 4px 10px rgba(80, 191, 164, 0.4);
        }
        #testOrderBtn:hover {
            background-color: #3aa08a;
            transform: translateY(-3px);
            box-shadow: 0 6px 15px rgba(80, 191, 164, 0.6);
        }


        /* Status Cards Layout (stacked vertically) */
        .status-cards {
            display: flex; /* Thay đổi từ grid sang flex */
            flex-direction: column; /* Xếp theo hàng dọc */
            gap: 25px; /* Khoảng cách giữa các card */
            margin-bottom: 40px;
        }

        .card {
            background-color: #3e405e; /* Lighter dark blue-purple for cards */
            border-radius: 10px;
            padding: 25px;
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
            border: 1px solid rgba(154, 103, 234, 0.3); /* Purple tinted border */
            transition: transform 0.2s ease, box-shadow 0.2s ease;
        }
        .card:hover {
            transform: translateY(-5px);
            box-shadow: 0 6px 18px rgba(0, 0, 0, 0.4);
        }

        .card p {
            margin: 10px 0;
            color: #abb2bf; /* Grey text for card content */
            font-size: 1em; /* Kích thước chữ p trong card */
        }

        .card strong {
            color: #e0e0e0; /* Brighter grey for strong text */
        }

        .card pre {
            background-color: #282c34; /* Darker background for code/JSON blocks */
            padding: 15px;
            border-radius: 8px;
            overflow-x: auto;
            font-size: 0.9em; /* Kích thước chữ pre */
            color: #c0c5d2;
            word-wrap: break-word; /* Ensure long lines wrap */
            white-space: pre-wrap; /* Ensure preformatted text wraps */
        }

        /* Styling for the new "Best Potential Opportunity" display */
        .opportunity-details p {
            margin: 5px 0;
            font-size: 0.95em; /* Kích thước chữ trong opportunity details */
            display: flex; /* For horizontal layout */
            justify-content: space-between; /* Space out label and value */
            align-items: center;
            border-bottom: 1px dashed rgba(154, 103, 234, 0.1); /* Subtle separator */
            padding-bottom: 5px;
        }
        .opportunity-details p:last-child {
            border-bottom: none;
            padding-bottom: 0;
        }

        .opportunity-details strong {
            flex: 0 0 160px; /* Fixed width for labels */
            margin-right: 10px;
            color: #e0e0e0;
            text-align: left;
        }
        .opportunity-details span {
            flex: 1; /* Take remaining space */
            color: #abb2bf;
            text-align: right;
        }


        /* Trade History Table */
        .trade-history h2 {
            margin-bottom: 20px;
        }

        .trade-history table {
            width: 100%;
            border-collapse: separate; /* Use separate for rounded corners on rows */
            border-spacing: 0;
            margin-top: 20px;
            background-color: #3e405e; /* Same as card background */
            border-radius: 10px;
            overflow: hidden; /* Ensures rounded corners are visible */
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
        }

        .trade-history th, .trade-history td {
            padding: 15px 20px;
            text-align: left;
            border-bottom: 1px solid rgba(154, 103, 234, 0.2);
            color: #abb2bf;
        }

        .trade-history th {
            background-color: #4a4c6a; /* Darker grey-purple for table headers */
            color: #e0e0e0;
            font-weight: bold;
            text-transform: uppercase;
            font-size: 0.9em; /* Kích thước chữ header table */
            letter-spacing: 0.5px;
        }
        .trade-history td {
            font-size: 0.9em; /* Kích thước chữ cell table */
        }

        .trade-history tbody tr:last-child td {
            border-bottom: none; /* No border for the last row */
        }

        .trade-history tbody tr:hover {
            background-color: #4a4c6a; /* Hover effect for table rows */
            cursor: pointer;
        }

        /* Utility Classes for Text Colors */
        .text-green { color: #50fa7b; } /* Bright green for positive values/running status */
        .text-red { color: #ff5555; } /* Red for negative values/stopped status */
        .text-yellow { color: #f1fa8c; } /* Yellow for warnings/pending status */
        .text-purple { color: #bd93f9; } /* Lighter purple for specific highlights */

        /* Responsive adjustments */
        @media (max-width: 768px) {
            .container {
                padding: 20px;
                max-width: 100%; /* Dùng toàn bộ chiều rộng trên mobile */
            }
            h1 { font-size: 1.8em; }
            h2 { font-size: 1.5em; }
            h3 { font-size: 1.2em; }

            .controls {
                flex-direction: column;
                gap: 15px;
            }
            .controls button {
                margin: 0; /* Remove horizontal margin */
                width: 100%; /* Full width buttons */
                padding: 12px 20px; /* Giảm padding cho mobile */
                font-size: 1em; /* Giảm font-size cho mobile */
            }
            .controls input[type="number"] {
                width: 100%;
                padding: 12px 15px; /* Giảm padding cho mobile */
                font-size: 1em; /* Giảm font-size cho mobile */
            }
            /* status-cards đã là column rồi, không cần điều chỉnh thêm */
            .opportunity-details strong {
                flex: 0 0 120px;
            }
            .trade-history th, .trade-history td {
                padding: 10px 15px;
                font-size: 0.8em; /* Giảm font-size cho table trên mobile */
            }
        }
    </style>
</head>
<body>
    <div class="container">
        <header>
            <h1>📈 Bot Arbitrage Trading</h1>
        </header>

        <main>
            <section class="controls">
                <div>
                    <label for="percentageToUse">Phần trăm vốn mở lệnh (%):</label>
                    <input type="number" id="percentageToUse" value="50" min="1" max="100">
                </div>
                <button id="startBotBtn">▶️ Start Bot</button>
                <button id="stopBotBtn">⏸️ Stop Bot</button>
                <button id="testOrderBtn">⚡ Test Mở Lệnh</button> <!-- NEW BUTTON ADDED HERE -->
            </section>

            <section class="status-cards">
                <!-- Bot State Card -->
                <div class="card" id="botStateCard">
                    <h3>Trạng thái Bot</h3>
                    <p>Hiện tại: <strong id="botStateDisplay">Đang tải...</strong></p>
                </div>

                <!-- Balances Card -->
                <div class="card">
                    <h3>Số dư Tài khoản</h3>
                    <div id="balancesDisplay">
                        <p>Đang tải số dư...</p>
                    </div>
                </div>

                <!-- Cumulative PnL Card -->
                <div class="card">
                    <h3>PnL Tổng hợp</h3>
                    <p>Tổng PnL từ khi chạy: <strong id="cumulativePnlDisplay" class="text-yellow">Đang tải...</strong></p>
                </div>

                <!-- Current Selected Opportunity Card (for display) -->
                <div class="card">
                    <h3>Cơ hội Arbitrage Tốt nhất (Dự kiến)</h3>
                    <div id="bestPotentialOpportunityDisplay" class="opportunity-details">
                        <p>Không có cơ hội nào khả dụng.</p>
                    </div>
                </div>

            </section>

            <section class="trade-history">
                <h2>Lịch sử Giao dịch</h2>
                <table>
                    <thead>
                        <tr>
                            <th>Thời gian</th>
                            <th>Coin</th>
                            <th>Sàn giao dịch</th>
                            <th>Funding Diff</th>
                            <th>PnL ước tính</th>
                            <th>PnL thực tế</th>
                        </tr>
                    </thead>
                    <tbody id="tradeHistoryBody">
                        <tr>
                            <td colspan="6" style="text-align: center; font-style: italic;">Đang tải lịch sử giao dịch...</td>
                        </tr>
                    </tbody>
                </table>
            </section>
        </main>
    </div>

    <script>
        // Các biến và hằng số liên quan đến chuyển tiền đã bị loại bỏ
        // const SUPPORTED_EXCHANGES = ['binanceusdm', 'bingx', 'okx', 'bitget'];
        // const FUND_TRANSFER_MIN_AMOUNT_FRONTEND = 10; 

        // Hàm để lấy và cập nhật trạng thái bot từ server
        async function updateBotStatus() {
            try {
                const response = await fetch('/bot-api/status');
                if (!response.ok) {
                    throw new Error(`HTTP error! status: ${response.status}`);
                }
                const data = await response.json();
                // console.log('Bot status data received:', data); // Giữ lại để debug nếu cần

                // Cập nhật trạng thái Bot
                const botStateDisplay = document.getElementById('botStateDisplay');
                botStateDisplay.textContent = data.botState;
                botStateDisplay.className = ''; // Reset classes
                if (data.botState === 'RUNNING') {
                    botStateDisplay.classList.add('text-green');
                } else if (data.botState === 'STOPPED') {
                    botStateDisplay.classList.add('text-red');
                } else {
                    botStateDisplay.classList.add('text-yellow');
                }

                // Cập nhật số dư tài khoản
                let balancesHtml = '';
                if (data.balances) {
                    for (const exchangeId in data.balances) {
                        if (exchangeId === 'totalOverall') continue; 
                        const bal = data.balances[exchangeId];
                        // Màu đỏ nếu tổng balance âm
                        const totalBalanceColorClass = bal.total < 0 ? 'text-red' : ''; 
                        // available cũng có thể âm nếu PnL chưa thực hiện bị lỗ
                        const availableBalanceColorClass = bal.available < 0 ? 'text-red' : ''; 

                        balancesHtml += `<p><strong>${exchangeId.toUpperCase()}:</strong> Tổng <span class="${totalBalanceColorClass}">${bal.total.toFixed(2)} USDT</span>, Khả dụng <span class="${availableBalanceColorClass}">${bal.available.toFixed(2)} USDT</span></p>`;
                    }
                    const totalOverallColorClass = data.balances.totalOverall < 0 ? 'text-red' : '';
                    balancesHtml += `<p><strong>Tổng số dư khả dụng (Tất cả sàn, bao gồm cả âm):</strong> <span class="${totalOverallColorClass}">${data.balances.totalOverall.toFixed(2)} USDT</span></p>`;
                } else {
                    balancesHtml += '<p>Không có dữ liệu số dư.</p>';
                }
                balancesHtml += `<p><strong>Số dư ban đầu của phiên:</strong> ${data.initialTotalBalance.toFixed(2)} USDT</p>`;
                document.getElementById('balancesDisplay').innerHTML = balancesHtml;

                // Cập nhật PnL tổng hợp
                const cumulativePnlElement = document.getElementById('cumulativePnlDisplay');
                cumulativePnlElement.textContent = data.cumulativePnl.toFixed(2) + ' USDT';
                cumulativePnlElement.className = ''; // Reset classes
                if (data.cumulativePnl >= 0) {
                    cumulativePnlElement.classList.add('text-green');
                } else {
                    cumulativePnlElement.classList.add('text-red');
                }

                // Cập nhật cơ hội arbitrage tốt nhất (dự kiến)
                const bestPotentialOpportunityDisplayDiv = document.getElementById('bestPotentialOpportunityDisplay');
                if (data.currentSelectedOpportunity) { // Đây là bestPotentialOpportunityForDisplay từ bot.js
                    // Chuyển đổi timestamp sang giờ địa phương
                    const nextFundingDate = new Date(data.currentSelectedOpportunity.nextFundingTime);
                    const fundingTimeFormatted = nextFundingDate.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', hour12: false });
                    const fundingDateFormatted = nextFundingDate.toLocaleDateString('vi-VN');

                    // Lấy Short/Long Exchange dựa trên funding rates
                    let longExchangeName = data.currentSelectedOpportunity.details.longExchange || 'N/A';
                    let shortExchangeName = data.currentSelectedOpportunity.details.shortExchange || 'N/A';

                    // Cần kiểm tra nếu các trường này có tồn tại và hợp lệ
                    const shortFr = data.currentSelectedOpportunity.details.shortFundingRate;
                    const longFr = data.currentSelectedOpportunity.details.longFundingRate;
                    const fundingDiff = data.currentSelectedOpportunity.fundingDiff;

                    // Logic xác định Short/Long từ funding rates (nếu có dữ liệu)
                    // Dùng logic đã sửa: Long FR thấp, Short FR cao
                    if (typeof shortFr === 'number' && typeof longFr === 'number' && fundingDiff !== 'N/A') {
                        if (shortFr > longFr) { // Short FR cao hơn Long FR
                            shortExchangeName = data.currentSelectedOpportunity.details.shortExchange;
                            longExchangeName = data.currentSelectedOpportunity.details.longExchange;
                        } else if (longFr > shortFr) { // Long FR cao hơn Short FR (trường hợp hiếm trong arbitrage funding)
                            // Đảo vai trò nếu logic arbitrage ngược lại
                            shortExchangeName = data.currentSelectedOpportunity.details.longExchange;
                            longExchangeName = data.currentSelectedOpportunity.details.shortExchange; // Đã sửa lỗi ở đây, đáng lẽ phải là shortExchange
                        } else { // Funding rates bằng nhau
                            shortExchangeName = data.currentSelectedOpportunity.details.shortExchange; // Vẫn giữ mặc định từ server
                            longExchangeName = data.currentSelectedOpportunity.details.longExchange;
                        }
                    }


                    bestPotentialOpportunityDisplayDiv.innerHTML = `
                        <p><strong>Coin:</strong> <span>${data.currentSelectedOpportunity.coin}</span></p>
                        <p><strong>Sàn:</strong> <span>${data.currentSelectedOpportunity.exchanges}</span></p>
                        <p><strong>PnL ước tính:</strong> <span>${data.currentSelectedOpportunity.estimatedPnl?.toFixed(2) || 'N/A'}%</span></p>
                        <p><strong>Tới giờ funding:</strong> <span>${fundingTimeFormatted} ngày ${fundingDateFormatted}</span></p>
                        <p><strong>Vốn dự kiến:</strong> <span>${data.currentSelectedOpportunity.estimatedTradeCollateral || 'N/A'} USDT</span></p>
                        <p><strong>Max Lev sẽ mở:</strong> <span>${data.currentSelectedOpportunity.commonLeverage || 'N/A'}x</span></p>
                        <p><strong>Long Sàn:</strong> <span>${longExchangeName} (${typeof longFr === 'number' ? longFr.toFixed(4) : 'N/A'}%)</span></p>
                        <p><strong>Short Sàn:</strong> <span>${shortExchangeName} (${typeof shortFr === 'number' ? shortFr.toFixed(4) : 'N/A'}%)</span></p>
                        <p><strong>Chênh lệch Funding:</strong> <span>${typeof fundingDiff === 'number' ? fundingDiff.toFixed(4) : 'N/A'}%</span></p>
                    `;
                } else {
                    bestPotentialOpportunityDisplayDiv.textContent = 'Không có cơ hội nào khả dụng.';
                }

                // Cập nhật lịch sử giao dịch
                const tradeHistoryBody = document.getElementById('tradeHistoryBody');
                tradeHistoryBody.innerHTML = ''; 
                if (data.tradeHistory && data.tradeHistory.length > 0) {
                    data.tradeHistory.forEach(trade => {
                        const row = tradeHistoryBody.insertRow();
                        row.insertCell().textContent = new Date(trade.timestamp).toLocaleString('vi-VN'); 
                        row.insertCell().textContent = trade.coin;
                        row.insertCell().textContent = trade.exchanges;
                        row.insertCell().textContent = trade.fundingDiff ? trade.fundingDiff.toFixed(2) + '%' : 'N/A';
                        row.insertCell().textContent = trade.estimatedPnl ? trade.estimatedPnl.toFixed(2) + '%' : 'N/A';
                        const actualPnlCell = row.insertCell();
                        actualPnlCell.textContent = trade.actualPnl ? trade.actualPnl.toFixed(2) + ' USDT' : 'N/A';
                        if (trade.actualPnl !== undefined && trade.actualPnl !== null) {
                            actualPnlCell.classList.add(trade.actualPnl >= 0 ? 'text-green' : 'text-red');
                        }
                    });
                } else {
                    const row = tradeHistoryBody.insertRow();
                    const cell = row.insertCell();
                    cell.colSpan = 6;
                    cell.textContent = 'Chưa có lịch sử giao dịch nào.';
                    cell.style.textAlign = 'center';
                    cell.style.fontStyle = 'italic';
                    cell.style.padding = '20px';
                }

            } catch (error) {
                console.error('Lỗi khi lấy trạng thái bot:', error);
                document.getElementById('botStateDisplay').textContent = 'LỖI KẾT NỐI';
                document.getElementById('botStateDisplay').classList.add('text-red');
            }
        }

        // Các hàm liên quan đến dropdown chuyển tiền đã bị loại bỏ
        // function populateExchangeDropdowns() { ... }
        // Hàm xử lý chuyển tiền thủ công đã bị loại bỏ
        // async function handleManualTransfer() { ... }

        // Event Listeners cho nút Start và Stop
        document.getElementById('startBotBtn').addEventListener('click', async () => {
            const percentageToUse = document.getElementById('percentageToUse').value;
            if (percentageToUse < 1 || percentageToUse > 100) {
                alert('Phần trăm vốn mở lệnh phải từ 1 đến 100.');
                return;
            }
            try {
                const response = await fetch('/bot-api/start', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ percentageToUse: parseFloat(percentageToUse) }) 
                });
                const data = await response.json();
                console.log('Phản hồi Start Bot:', data);
                alert(data.message);
                if (data.success) {
                    updateBotStatus(); 
                }
            } catch (error) {
                console.error('Lỗi khi khởi động bot:', error);
                alert('Lỗi khi khởi động bot: ' + error.message);
            }
        });

        document.getElementById('stopBotBtn').addEventListener('click', async () => {
            try {
                const response = await fetch('/bot-api/stop', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({}) 
                });
                const data = await response.json();
                console.log('Phản hồi Stop Bot:', data);
                alert(data.message);
                if (data.success) {
                    updateBotStatus(); 
                }
            } catch (error) {
                console.error('Lỗi khi dừng bot:', error);
                alert('Lỗi khi dừng bot: ' + error.message);
            }
        });

        // NEW: Event Listener for Test Order Button
        document.getElementById('testOrderBtn').addEventListener('click', async () => {
            const percentageToUse = document.getElementById('percentageToUse').value;
            if (percentageToUse < 1 || percentageToUse > 100) {
                alert('Phần trăm vốn mở lệnh phải từ 1 đến 100.');
                return;
            }

            // IMPORTANT WARNING FOR USER
            if (!confirm('Bạn có chắc chắn muốn mở lệnh TEST ngay lập tức với thông tin dự kiến không? Việc này sẽ tốn phí giao dịch thật!')) {
                return;
            }

            try {
                const response = await fetch('/bot-api/test-trade', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ percentageToUse: parseFloat(percentageToUse) })
                });
                const data = await response.json();
                console.log('Phản hồi Test Lệnh:', data);
                alert(data.message);
                if (data.success) {
                    updateBotStatus(); // Refresh UI after test
                }
            } catch (error) {
                console.error('Lỗi khi thực hiện lệnh test:', error);
                alert('Lỗi khi thực hiện lệnh test: ' + error.message);
            }
        });

        // Event Listener cho nút chuyển tiền thủ công đã bị loại bỏ
        // document.getElementById('manualTransferBtn').addEventListener('click', handleManualTransfer);


        // Tải trạng thái ban đầu khi trang được load
        document.addEventListener('DOMContentLoaded', () => {
            // populateExchangeDropdowns(); // Đã loại bỏ
            updateBotStatus();
            // Thiết lập interval để tự động cập nhật trạng thái mỗi 5 giây
            setInterval(updateBotStatus, 5000); 
        });
    </script>
</body>
</html>

2. File Node.js (ví dụ: bot.js nếu file này chứa server chính):

code
JavaScript
download
content_copy
expand_less
IGNORE_WHEN_COPYING_START
IGNORE_WHEN_COPYING_END
const http = require('http');
const fs = require('fs');
const path = require('path');
const ccxt = require('ccxt');
const { URLSearchParams } = require('url');

const safeLog = (type, ...args) => {
    try {
        const now = new Date();
        const hours = now.getHours().toString().padStart(2, '0');
        const minutes = now.getMinutes().toString().padStart(2, '0');
        const timestamp = `${hours}:${minutes}`;
        if (typeof console === 'object' && typeof console[type] === 'function') {
            console[type](`[${timestamp} ${type.toUpperCase()}]`, ...args);
        } else {
            const message = `[${timestamp} ${type.toUpperCase()}] ${args.map(arg => typeof arg === 'object' ? JSON.stringify(arg) : arg).join(' ')}\n`;
            if (type === 'error' || type === 'warn') {
                process.stderr.write(message);
            } else {
                process.stdout.write(message);
            }
        }
    } catch (e) {
        process.stderr.write(`FATAL LOG ERROR (safeLog itself failed): ${e.message} - Original log: [${type.toUpperCase()}] ${args.join(' ')}\n`);
    }
};

const {
    binanceApiKey, binanceApiSecret,
    bingxApiKey, bingxApiSecret,
    okxApiKey, okxApiSecret, okxPassword,
    bitgetApiKey, bitgetApiSecret, bitgetApiPassword
} = require('../config.js');

// const { usdtDepositAddressesByNetwork } = require('./balance.js'); // <<-- ĐÃ LOẠI BỎ

const BOT_PORT = 5008;
const SERVER_DATA_URL = 'http://localhost:5005/api/data';

const MIN_PNL_PERCENTAGE = 1;
const MAX_MINUTES_UNTIL_FUNDING = 30;
const MIN_MINUTES_FOR_EXECUTION = 15;

// Cập nhật số tiền chuyển tối thiểu theo yêu cầu (KHÔNG CÒN ĐƯỢC DÙNG)
// const FUND_TRANSFER_MIN_AMOUNT_BINANCE = 10; // <<-- ĐÃ LOẠI BỎ
// const FUND_TRANSFER_MIN_AMOUNT_BINGX = 5; // <<-- ĐÃ LOẠI BỎ
// const FUND_TRANSFER_MIN_AMOUNT_OKX = 1; // <<-- ĐÃ LOẠI BỎ

const DATA_FETCH_INTERVAL_SECONDS = 5;
const HOURLY_FETCH_TIME_MINUTE = 45;

const SL_PERCENT_OF_COLLATERAL = 700;
const TP_PERCENT_OF_COLLATERAL = 8386;

const DISABLED_EXCHANGES = ['bitget'];

const ALL_POSSIBLE_EXCHANGE_IDS = ['binanceusdm', 'bingx', 'okx', 'bitget'];

const activeExchangeIds = ALL_POSSIBLE_EXCHANGE_IDS.filter(id => !DISABLED_EXCHANGES.includes(id));

let botState = 'STOPPED';
let botLoopIntervalId = null;

const exchanges = {};
activeExchangeIds.forEach(id => {
    const exchangeClass = ccxt[id];
    const config = {
        'options': { 'defaultType': 'swap' },
        'enableRateLimit': true,
        'headers': {
            'User-Agent': 'Mozilla/5.0 (compatible; ccxt/1.0;)',
        }
    };

    if (id === 'binanceusdm') { config.apiKey = binanceApiKey; config.secret = binanceApiSecret; }
    else if (id === 'bingx') { config.apiKey = bingxApiKey; config.secret = bingxApiSecret; }
    else if (id === 'okx') { config.apiKey = okxApiKey; config.secret = okxApiSecret; if(okxPassword) config.password = okxPassword; }
    else if (id === 'bitget') { config.apiKey = bitgetApiKey; config.secret = bitgetApiSecret; if(bitgetApiPassword) config.password = bitgetApiPassword; }

    if ((config.apiKey && config.secret) || (id === 'okx' && config.password) || (id === 'bitget' && config.password && config.apiKey && config.secret)) {
        exchanges[id] = new exchangeClass(config);
    } else {
        safeLog('warn', `[INIT] Bỏ qua khởi tạo ${id.toUpperCase()} vì thiếu API Key/Secret/Password hoặc không hợp lệ.`);
    }
});

let balances = {};
activeExchangeIds.forEach(id => {
    balances[id] = { total: 0, available: 0, originalSymbol: {} };
});
balances.totalOverall = 0;

let initialTotalBalance = 0;
let cumulativePnl = 0;
let tradeHistory = [];

let currentSelectedOpportunityForExecution = null;
let bestPotentialOpportunityForDisplay = null;
let allCurrentOpportunities = [];

const LAST_ACTION_TIMESTAMP = {
    dataFetch: 0,
    selectionTime: 0,
    tradeExecution: 0,
    closeTrade: 0,
};

let currentTradeDetails = null;

let currentPercentageToUse = 50;

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

// <<-- getMinTransferAmount ĐÃ LOẠI BỎ -->>
// function getMinTransferAmount(fromExchangeId) { ... }

// <<-- getTargetDepositInfo ĐÃ LOẠI BỎ -->>
// function getTargetDepositInfo(fromExchangeId, toExchangeId) { ... }

// <<-- pollForBalance ĐÃ LOẠI BỎ -->>

async function fetchDataFromServer() {
    try {
        const response = await fetch(SERVER_DATA_URL);
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        const data = await response.json();
        safeLog('debug', '[SERVER_DATA_FETCHED]', data); // NEW: Log data returned from server
        return data;
    } catch (error) {
        safeLog('error', `[BOT] ❌ Lỗi khi lấy dữ liệu từ server: ${error.message}`, error);
        return null;
    }
}

async function updateBalances() {
    safeLog('log', '[BOT] 🔄 Cập nhật số dư từ các sàn...');
    let currentTotalOverall = 0;
    for (const id of activeExchangeIds) {
        if (!exchanges[id]) {
            safeLog('warn', `[BOT] ${id.toUpperCase()} không được khởi tạo (có thể do thiếu API Key/Secret). Bỏ qua cập nhật số dư.`);
            continue;
        }
        try {
            const exchange = exchanges[id];
            await exchange.loadMarkets(true);

            // Fetch futures balance for trading
            const accountBalance = await exchange.fetchBalance({ 'type': 'future' });
            const usdtFreeBalance = accountBalance.free?.USDT || 0;
            const usdtTotalBalance = accountBalance.total?.USDT || 0;

            balances[id].available = usdtFreeBalance;
            balances[id].total = usdtTotalBalance;

            balances[id].originalSymbol = {};

            currentTotalOverall += balances[id].available;

            safeLog('log', `[BOT] ✅ ${id.toUpperCase()} Balance: Total ${usdtTotalBalance.toFixed(2)} USDT, Available ${balances[id].available.toFixed(2)} USDT.`);
        } catch (e) {
            safeLog('error', `[BOT] ❌ Lỗi khi lấy số dư ${id.toUpperCase()}: ${e.message}`, e);
        }
    }
    balances.totalOverall = currentTotalOverall;
    safeLog('log', `[BOT] Tổng số dư khả dụng trên tất cả các sàn (có thể bao gồm âm): ${currentTotalOverall.toFixed(2)} USDT.`);
    if (initialTotalBalance === 0) {
        initialTotalBalance = currentTotalOverall;
    }
}

async function processServerData(serverData) {
    if (!serverData || !serverData.arbitrageData) {
        safeLog('warn', '[BOT] Dữ liệu từ server không hợp lệ hoặc thiếu arbitrageData.');
        bestPotentialOpportunityForDisplay = null;
        allCurrentOpportunities = [];
        return;
    }

    const now = Date.now();
    let bestForDisplay = null;
    const tempAllOpportunities = [];

    serverData.arbitrageData.forEach(op => {
        const minutesUntilFunding = (op.nextFundingTime - now) / (1000 * 60);

        const shortExIdNormalized = op.details.shortExchange.toLowerCase() === 'binance' ? 'binanceusdm' : op.details.shortExchange.toLowerCase();
        const longExIdNormalized = op.details.longExchange.toLowerCase() === 'binance' ? 'binanceusdm' : op.details.longExchange.toLowerCase();

        if (DISABLED_EXCHANGES.includes(shortExIdNormalized) || DISABLED_EXCHANGES.includes(longExIdNormalized) ||
            !exchanges[shortExIdNormalized] || !exchanges[longExIdNormalized]) {
            return;
        }

        if (op.estimatedPnl > 0 && minutesUntilFunding > 0) {
            op.details.minutesUntilFunding = minutesUntilFunding;

            op.details.shortFundingRate = op.details.shortRate !== undefined ? op.details.shortRate : 'N/A';
            op.details.longFundingRate = op.details.longRate !== undefined ? op.details.longRate : 'N/A';
            op.fundingDiff = op.fundingDiff !== undefined ? op.fundingDiff : 'N/A';
            op.commonLeverage = op.commonLeverage !== undefined ? op.commonLeverage : 'N/A';

            let shortExId = op.details.shortExchange;
            let longExId = op.details.longExchange;

            if (typeof op.details.shortFundingRate === 'number' && typeof op.details.longFundingRate === 'number') {
                if (op.details.shortFundingRate < op.details.longFundingRate) {
                    shortExId = op.details.longExchange;
                    longExId = op.details.shortExchange;
                }
            }
            op.details.shortExchange = shortExId;
            op.details.longExchange = longExId;

            tempAllOpportunities.push(op);

            if (!bestForDisplay ||
                minutesUntilFunding < bestForDisplay.details.minutesUntilFunding ||
                (minutesUntilFunding === bestForDisplay.details.minutesUntilFunding && op.estimatedPnl > bestForDisplay.estimatedPnl)
            ) {
                bestForDisplay = op;
            }
        }
    });

    allCurrentOpportunities = tempAllOpportunities;

    if (bestForDisplay) {
        bestPotentialOpportunityForDisplay = bestForDisplay;
        // Cập nhật hiển thị vốn ước tính theo cách tính mới
        const shortExId = bestForDisplay.exchanges.split(' / ')[0].toLowerCase() === 'binance' ? 'binanceusdm' : bestForDisplay.exchanges.split(' / ')[0].toLowerCase();
        const longExId = bestForDisplay.exchanges.split(' / ')[1].toLowerCase() === 'binance' ? 'binanceusdm' : bestForDisplay.exchanges.split(' / ')[1].toLowerCase();
        const minAvailableBalance = Math.min(balances[shortExId]?.available || 0, balances[longExId]?.available || 0);
        bestPotentialOpportunityForDisplay.estimatedTradeCollateral = (minAvailableBalance * (currentPercentageToUse / 100)).toFixed(2);
    } else {
        bestPotentialOpportunityForDisplay = null;
    }
}

// Hàm giúp tìm symbol đầy đủ của sàn từ tên coin "gọn"
function findExchangeSymbol(exchangeId, baseCoin, quoteCoin, rawRates) {
    const exchangeRates = rawRates[exchangeId]?.rates;
    if (!exchangeRates) {
        safeLog('warn', `[HELPER] Không tìm thấy dữ liệu rates cho sàn ${exchangeId.toUpperCase()}.`);
        return null;
    }

    const commonFormats = [
        `${baseCoin}/${quoteCoin}`,         // Ví dụ: BTC/USDT (Binance, BingX)
        `${baseCoin}-${quoteCoin}-SWAP`,    // Ví dụ: BTC-USDT-SWAP (OKX)
        `${baseCoin}${quoteCoin}`,          // Ví dụ: BTCUSDT (một số định dạng khác)
        `${baseCoin}_${quoteCoin}`,         // Ví dụ: BTC_USDT (một số sàn khác)
    ];

    for (const format of commonFormats) {
        if (exchangeRates[format] && exchangeRates[format].originalSymbol) {
            safeLog('log', `[HELPER] Tìm thấy symbol khớp (${format}) cho ${baseCoin}/${quoteCoin} trên ${exchangeId.toUpperCase()}.`);
            return exchangeRates[format].originalSymbol;
        }
    }

    for (const symbolKey in exchangeRates) {
        const symbolData = exchangeRates[symbolKey];
        if (symbolData.originalSymbol && symbolData.base === baseCoin && symbolData.quote === quoteCoin) {
            safeLog('log', `[HELPER] Tìm thấy symbol khớp (${symbolKey}) qua thuộc tính base/quote cho ${baseCoin}/${quoteCoin} trên ${exchangeId.toUpperCase()}.`);
            return symbolData.originalSymbol;
        }
    }

    safeLog('warn', `[HELPER] Không tìm thấy symbol hợp lệ cho cặp ${baseCoin}/${quoteCoin} trên sàn ${exchangeId.toUpperCase()}.`);
    return null;
}

// <<-- LOẠI BỎ TOÀN BỘ PHẦN BINGX CUSTOM TRANSFER LOGIC Ở ĐÂY (TRƯỚC ĐÂY TÔI ĐÃ ĐẶT Ở ĐÂY) -->>

// <<-- LOẠI BỎ TOÀN BỘ HÀM manageFundsAndTransfer Ở ĐÂY -->>

async function executeTrades(opportunity, percentageToUse) {
    if (!opportunity || percentageToUse <= 0) {
        safeLog('warn', '[BOT_TRADE] Không có cơ hội hoặc phần trăm sử dụng không hợp lệ.');
        return false;
    }

    const rawRatesData = serverDataGlobal?.rawRates;
    if (!rawRatesData) {
        safeLog('error', '[BOT_TRADE] Dữ liệu giá thô từ server không có sẵn. Không thể mở lệnh.');
        return false;
    }

    // Ensure opportunity.details exists and contains shortExchange/longExchange
    if (!opportunity.details || !opportunity.details.shortExchange || !opportunity.details.longExchange) {
        safeLog('error', '[BOT_TRADE] Thông tin chi tiết cơ hội thiếu trường shortExchange hoặc longExchange. Hủy bỏ lệnh.');
        return false;
    }

    const shortExchangeId = opportunity.details.shortExchange.toLowerCase() === 'binance' ? 'binanceusdm' : opportunity.details.shortExchange.toLowerCase(); // Đảm bảo ID được chuẩn hóa
    const longExchangeId = opportunity.details.longExchange.toLowerCase() === 'binance' ? 'binanceusdm' : opportunity.details.longExchange.toLowerCase(); // Đảm bảo ID được chuẩn hóa

    if (DISABLED_EXCHANGES.includes(shortExchangeId) || DISABLED_EXCHANGES.includes(longExchangeId) ||
        !exchanges[shortExchangeId] || !exchanges[longExchangeId]) {
        safeLog('error', `[BOT_TRADE] Bỏ qua thực hiện lệnh vì sàn ${shortExchangeId} hoặc ${longExchangeId} bị tắt hoặc chưa được khởi tạo.`);
        return false;
    }

    const quoteAsset = 'USDT';
    const cleanedCoin = opportunity.coin;
    const shortOriginalSymbol = findExchangeSymbol(shortExchangeId, cleanedCoin, quoteAsset, rawRatesData);
    const longOriginalSymbol = findExchangeSymbol(longExchangeId, cleanedCoin, quoteAsset, rawRatesData);

    if (!shortOriginalSymbol) {
        safeLog('error', `[BOT_TRADE] ❌ Không thể xác định symbol đầy đủ cho ${cleanedCoin} trên sàn SHORT ${shortExchangeId}. Vui lòng kiểm tra dữ liệu từ server và cấu trúc rawRates.`);
        return false;
    }
    if (!longOriginalSymbol) {
        safeLog('error', `[BOT_TRADE] ❌ Không thể xác định symbol đầy đủ cho ${cleanedCoin} trên sàn LONG ${longExchangeId}. Vui lòng kiểm tra dữ liệu từ server và cấu trúc rawRates.`);
        return false;
    }

    const shortExchange = exchanges[shortExchangeId];
    const longExchange = exchanges[longExchangeId];

    // <<-- ĐIỀU CHỈNH CÁCH TÍNH TOÁN SỐ TIỀN MỞ LỆNH: LẤY SỐ DƯ CỦA SÀN THẤP NHẤT TRONG CẶP SÀN -->>
    const minAvailableBalanceInPair = Math.min(balances[shortExchangeId]?.available || 0, balances[longExchangeId]?.available || 0);
    const baseCollateralPerSide = minAvailableBalanceInPair * (currentPercentageToUse / 100);
    // <<-- KẾT THÚC ĐIỀU CHỈNH -->>

    const shortCollateral = baseCollateralPerSide;
    const longCollateral = baseCollateralPerSide;

    if (shortCollateral <= 0 || longCollateral <= 0) {
        safeLog('error', '[BOT_TRADE] Số tiền mở lệnh (collateral) không hợp lệ (cần dương). Hủy bỏ lệnh.');
        return false;
    }
    if (balances[shortExchangeId]?.available < shortCollateral || balances[longExchangeId]?.available < longCollateral) {
        safeLog('error', `[BOT_TRADE] Số dư khả dụng không đủ để mở lệnh với vốn ${baseCollateralPerSide.toFixed(2)} USDT mỗi bên. ${shortExchangeId}: ${balances[shortExchangeId]?.available.toFixed(2)}, ${longExchangeId}: ${balances[longExchangeId]?.available.toFixed(2)}. Hủy bỏ lệnh.`);
        return false;
    }

    safeLog('log', `[BOT_TRADE] Chuẩn bị mở lệnh cho ${cleanedCoin}:`);
    safeLog('log', `  SHORT ${shortExchangeId} (${shortOriginalSymbol}): ${shortCollateral.toFixed(2)} USDT collateral`);
    safeLog('log', `  LONG ${longExchangeId} (${longOriginalSymbol}): ${longCollateral.toFixed(2)} USDT collateral`);

    let tradeSuccess = true;
    let shortOrder = null, longOrder = null;

    try {
        const tickerShort = await shortExchange.fetchTicker(shortOriginalSymbol);
        const tickerLong = await longExchange.fetchTicker(longOriginalSymbol);

        const shortEntryPrice = tickerShort.last;
        const longEntryPrice = tickerLong.last;

        if (!shortEntryPrice || !longEntryPrice) {
            safeLog('error', `[BOT_TRADE] Không lấy được giá thị trường hiện tại cho ${cleanedCoin}.`);
            return false;
        }

        const commonLeverage = opportunity.commonLeverage || 1;

        const shortAmount = (shortCollateral * commonLeverage) / shortEntryPrice;
        const longAmount = (longCollateral * commonLeverage) / longEntryPrice;

        if (shortAmount <= 0 || longAmount <= 0) {
            safeLog('error', '[BOT_TRADE] Lượng hợp đồng tính toán không hợp lệ (cần dương). Hủy bỏ lệnh.');
            return false;
        }

        const shortAmountFormatted = shortExchangeId === 'okx' ? shortAmount.toFixed(0) : shortAmount.toFixed(3);
        safeLog('log', `[BOT_TRADE] Mở SHORT ${shortAmountFormatted} ${cleanedCoin} trên ${shortExchangeId} với giá ${shortEntryPrice.toFixed(4)}...`);
        shortOrder = await shortExchange.createMarketSellOrder(shortOriginalSymbol, parseFloat(shortAmountFormatted));
        safeLog('log', `[BOT_TRADE] ✅ Lệnh SHORT ${shortExchangeId} khớp: ID ${shortOrder.id}, Amount ${shortOrder.amount}, Price ${shortOrder.price}`);

        const longAmountFormatted = longExchangeId === 'okx' ? longAmount.toFixed(0) : longAmount.toFixed(3);
        safeLog('log', `[BOT_TRADE] Mở LONG ${longAmountFormatted} ${cleanedCoin} trên ${longExchangeId} với giá ${longEntryPrice.toFixed(4)}...`);
        longOrder = await longExchange.createMarketBuyOrder(longOriginalSymbol, parseFloat(longAmountFormatted));
        safeLog('log', `[BOT_TRADE] ✅ Lệnh LONG ${longExchangeId} khớp: ID ${longOrder.id}, Amount ${longOrder.amount}, Price ${longOrder.price}`);

        safeLog('log', `[BOT_TRADE] Setting currentTradeDetails for ${cleanedCoin} on ${shortExchangeId}/${longExchangeId}`);
        currentTradeDetails = {
            coin: cleanedCoin,
            shortExchange: shortExchangeId,
            longExchange: longExchangeId,
            shortOriginalSymbol: shortOriginalSymbol,
            longOriginalSymbol: longOriginalSymbol,
            shortOrderId: shortOrder.id,
            longOrderId: longOrder.id,
            shortOrderAmount: shortOrder.amount,
            longOrderAmount: longOrder.amount,
            shortEntryPrice: shortEntryPrice,
            longEntryPrice: longEntryPrice,
            shortCollateral: shortCollateral,
            longCollateral: longCollateral,
            commonLeverage: commonLeverage,
            status: 'OPEN',
            openTime: Date.now()
        };
        safeLog('log', `[BOT_TRADE] currentTradeDetails set successfully.`);

        safeLog('log', '[BOT_TRADE] Đợi 2 giây để gửi lệnh TP/SL...');
        await sleep(2000);

        const shortTpPrice = shortEntryPrice * (1 - (TP_PERCENT_OF_COLLATERAL / (commonLeverage * 100)));
        const shortSlPrice = shortEntryPrice * (1 + (SL_PERCENT_OF_COLLATERAL / (commonLeverage * 100)));

        const longTpPrice = longEntryPrice * (1 + (TP_PERCENT_OF_COLLATERAL / (commonLeverage * 100)));
        const longSlPrice = longEntryPrice * (1 - (SL_PERCENT_OF_COLLATERAL / (commonLeverage * 100)));

        safeLog('log', `[BOT_TRADE] Tính toán TP/SL cho ${cleanedCoin}:`);
        safeLog('log', `  Short Entry: ${shortEntryPrice.toFixed(4)}, SL: ${shortSlPrice.toFixed(4)}, TP: ${shortTpPrice.toFixed(4)}`);
        safeLog('log', `  Long Entry: ${longEntryPrice.toFixed(4)}, SL: ${longSlPrice.toFixed(4)}, TP: ${longTpPrice.toFixed(4)}`);

        currentTradeDetails.shortSlPrice = shortSlPrice;
        currentTradeDetails.shortTpPrice = shortTpPrice;
        currentTradeDetails.longSlPrice = longSlPrice;
        currentTradeDetails.longTpPrice = longTpPrice;

        try {
            await shortExchange.createOrder(
                shortOriginalSymbol,
                'STOP_MARKET',
                'buy',
                shortOrder.amount,
                undefined,
                { 'stopPrice': shortSlPrice }
            );
            safeLog('log', `[BOT_TRADE] ✅ Đặt SL cho SHORT ${shortExchangeId} thành công.`);
        } catch (slShortError) {
            safeLog('error', `[BOT_TRADE] ❌ Lỗi đặt SL cho SHORT ${shortExchangeId}: ${slShortError.message}`, slShortError);
        }

        try {
            await shortExchange.createOrder(
                shortOriginalSymbol,
                'TAKE_PROFIT_MARKET',
                'buy',
                shortOrder.amount,
                undefined,
                { 'stopPrice': shortTpPrice }
            );
            safeLog('log', `[BOT_TRADE] ✅ Đặt TP cho SHORT ${shortExchangeId} thành công.`);
        } catch (tpShortError) {
            safeLog('error', `[BOT_TRADE] ❌ Lỗi đặt TP cho SHORT ${shortExchangeId}: ${tpShortError.message}`, tpShortError);
        }

        try {
            await longExchange.createOrder(
                longOriginalSymbol,
                'STOP_MARKET',
                'sell',
                longOrder.amount,
                undefined,
                { 'stopPrice': longSlPrice }
            );
            safeLog('log', `[BOT_TRADE] ✅ Đặt SL cho LONG ${longExchangeId} thành công.`);
        } catch (slLongError) {
            safeLog('error', `[BOT_TRADE] ❌ Lỗi đặt SL cho LONG ${longExchangeId}: ${slLongError.message}`, slLongError);
        }

        try {
            await longExchange.createOrder(
                longOriginalSymbol,
                'TAKE_PROFIT_MARKET',
                'sell',
                longOrder.amount,
                undefined,
                { 'stopPrice': longTpPrice }
            );
            safeLog('log', `[BOT_TRADE] ✅ Đặt TP cho LONG ${longExchangeId} thành công.`);
        } catch (tpLongError) {
            safeLog('error', `[BOT_TRADE] ❌ Lỗi đặt TP cho LONG ${longExchangeId}: ${tpLongError.message}`, tpLongError);
        }

    } catch (e) {
        safeLog('error', `[BOT_TRADE] ❌ Lỗi khi thực hiện giao dịch (hoặc đặt TP/SL): ${e.message}`, e);
        tradeSuccess = false;
        if (shortOrder?.id) {
            try { await exchanges[shortExchangeId].cancelOrder(shortOrder.id, shortOriginalSymbol); safeLog('log', `[BOT_TRADE] Đã hủy lệnh SHORT ${shortExchangeId}: ${shortOrder.id}`); } catch (ce) { safeLog('error', `[BOT_TRADE] Lỗi hủy lệnh SHORT: ${ce.message}`, ce); }
        }
        if (longOrder?.id) {
            try { await exchanges[longExchangeId].cancelOrder(longOrder.id, longOriginalSymbol); safeLog('log', `[BOT_TRADE] Đã hủy lệnh LONG ${longExchangeId}: ${longOrder.id}`); } catch (ce) { safeLog('error', `[BOT_TRADE] Lỗi hủy lệnh LONG: ${ce.message}`, ce); }
        }
        safeLog('log', `[BOT] currentTradeDetails being reset to null due to trade failure.`);
        currentTradeDetails = null;
    }
    return tradeSuccess;
}

async function closeTradesAndCalculatePnL() {
    if (!currentTradeDetails || currentTradeDetails.status !== 'OPEN') {
        safeLog('log', '[BOT_PNL] Không có giao dịch nào đang mở để đóng.');
        return;
    }

    safeLog('log', '[BOT_PNL] 🔄 Đang đóng các vị thế và tính toán PnL...');
    const { coin, shortExchange, longExchange, shortOriginalSymbol, longOriginalSymbol, shortOrderAmount, longOrderAmount, shortCollateral, longCollateral } = currentTradeDetails;

    try {
        safeLog('log', '[BOT_PNL] Hủy các lệnh TP/SL còn chờ (nếu có)...');
        try {
            const shortOpenOrders = await exchanges[shortExchange].fetchOpenOrders(shortOriginalSymbol);
            for (const order of shortOpenOrders) {
                if (order.type === 'stop' || order.type === 'take_profit' || order.type === 'stop_market' || order.type === 'take_profit_market') {
                    await exchanges[shortExchange].cancelOrder(order.id, shortOriginalSymbol);
                    safeLog('log', `[BOT_PNL] Đã hủy lệnh chờ ${order.type} ${order.id} trên ${shortExchange}.`);
                }
            }
        } catch (e) { safeLog('warn', `[BOT_PNL] Lỗi khi hủy lệnh chờ trên ${shortExchange}: ${e.message}`, e); }
        try {
            const longOpenOrders = await exchanges[longExchange].fetchOpenOrders(longOriginalSymbol);
            for (const order of longOpenOrders) {
                if (order.type === 'stop' || order.type === 'take_profit' || order.type === 'stop_market' || order.type === 'take_profit_market') {
                    await exchanges[longExchange].cancelOrder(order.id, longOriginalSymbol);
                    safeLog('log', `[BOT_PNL] Đã hủy lệnh chờ ${order.type} ${order.id} trên ${longExchange}.`);
                }
            }
        } catch (e) { safeLog('warn', `[BOT_PNL] Lỗi khi hủy lệnh chờ trên ${longExchange}: ${e.message}`, e); }

        safeLog('log', `[BOT_PNL] Đóng vị thế SHORT ${coin} trên ${shortExchange} (amount: ${shortOrderAmount})...`);
        const closeShortOrder = await exchanges[shortExchange].createMarketBuyOrder(shortOriginalSymbol, shortOrderAmount);
        safeLog('log', `[BOT_PNL] ✅ Vị thế SHORT trên ${shortExchange} đã đóng. Order ID: ${closeShortOrder.id}`);

        safeLog('log', `[BOT_PNL] Đóng vị thế LONG ${coin} trên ${longExchange} (amount: ${longOrderAmount})...`);
        const closeLongOrder = await exchanges[longExchange].createMarketSellOrder(longOriginalSymbol, longOrderAmount);
        safeLog('log', `[BOT_PNL] ✅ Vị thế LONG trên ${longExchange} đã đóng. Order ID: ${closeLongOrder.id}`);

        await sleep(15000); // Wait a bit for balances to settle on exchanges

        await updateBalances();

        // Calculate PnL based on collateral used and current available balance
        // This assumes that the entire initial collateral is what we are measuring against.
        // And the "available" balance correctly reflects the realized PnL from closing.
        const currentShortAvailable = balances[shortExchange]?.available;
        const currentLongAvailable = balances[longExchange]?.available;
        const cyclePnl = (currentShortAvailable - currentTradeDetails.shortCollateral) + (currentLongAvailable - currentTradeDetails.longCollateral);

        cumulativePnl += cyclePnl;

        tradeHistory.unshift({
            id: Date.now(),
            coin: coin,
            exchanges: `${shortExchange}/${longExchange}`,
            fundingDiff: currentSelectedOpportunityForExecution?.fundingDiff,
            estimatedPnl: currentSelectedOpportunityForExecution?.estimatedPnl,
            actualPnl: parseFloat(cyclePnl.toFixed(2)),
            timestamp: new Date().toISOString()
        });

        if (tradeHistory.length > 50) {
            tradeHistory.pop();
        }

        safeLog('log', `[BOT_PNL] ✅ Chu kỳ giao dịch cho ${coin} hoàn tất. PnL chu kỳ: ${cyclePnl.toFixed(2)} USDT. Tổng PnL: ${cumulativePnl.toFixed(2)} USDT.`);

    } catch (e) {
        safeLog('error', `[BOT_PNL] ❌ Lỗi khi đóng vị thế hoặc tính toán PnL: ${e.message}`, e);
    } finally {
        currentSelectedOpportunityForExecution = null; // Clear selected opportunity for next cycle
        safeLog('log', `[BOT] currentTradeDetails being reset to null.`);
        currentTradeDetails = null; // Clear current trade details
        safeLog('log', '[BOT_PNL] Dọn dẹp lệnh chờ và vị thế đã đóng (nếu có).');
    }
}

let serverDataGlobal = null;

async function mainBotLoop() {
    if (botLoopIntervalId) clearTimeout(botLoopIntervalId);

    // Đã loại bỏ các trạng thái TRANSFERRING_FUNDS khỏi điều kiện dừng chung
    if (botState !== 'RUNNING') {
        safeLog('log', '[BOT_LOOP] Bot không ở trạng thái RUNNING. Dừng vòng lặp.');
        return;
    }

    const now = new Date();
    const currentMinute = now.getUTCMinutes();
    const currentSecond = now.getUTCSeconds();

    const minuteAligned = Math.floor(now.getTime() / (60 * 1000));

    if (currentSecond % DATA_FETCH_INTERVAL_SECONDS === 0 && LAST_ACTION_TIMESTAMP.dataFetch !== currentSecond) {
        LAST_ACTION_TIMESTAMP.dataFetch = currentSecond;

        const fetchedData = await fetchDataFromServer();
        if (fetchedData) {
            serverDataGlobal = fetchedData;
            await processServerData(serverDataGlobal);
        }
    }

    if (currentMinute === 50 && currentSecond >= 0 && currentSecond < 5 && botState === 'RUNNING' && !currentTradeDetails && !currentSelectedOpportunityForExecution) {
        if (LAST_ACTION_TIMESTAMP.selectionTime !== minuteAligned) {
            LAST_ACTION_TIMESTAMP.selectionTime = minuteAligned;

            safeLog('log', `[BOT_LOOP] 🌟 Kích hoạt lựa chọn cơ hội để THỰC HIỆN tại phút ${currentMinute}:${currentSecond} giây.`);

            let bestOpportunityFoundForExecution = null;
            for (const op of allCurrentOpportunities) {
                const minutesUntilFunding = op.details.minutesUntilFunding;

                if (op.estimatedPnl >= MIN_PNL_PERCENTAGE &&
                    minutesUntilFunding > 0 &&
                    minutesUntilFunding < MIN_MINUTES_FOR_EXECUTION &&
                    minutesUntilFunding <= MAX_MINUTES_UNTIL_FUNDING) {

                    if (!bestOpportunityFoundForExecution ||
                        minutesUntilFunding < bestOpportunityFoundForExecution.details.minutesUntilFunding ||
                        (minutesUntilFunding === bestOpportunityFoundForExecution.details.minutesUntilFunding && op.estimatedPnl > bestOpportunityFoundForExecution.estimatedPnl)
                    ) {
                        bestOpportunityFoundForExecution = op;
                    }
                }
            }

            if (bestOpportunityFoundForExecution) {
                currentSelectedOpportunityForExecution = bestOpportunityFoundForExecution;
                safeLog('log', `[BOT_LOOP] ✅ Bot đã chọn cơ hội: ${currentSelectedOpportunityForExecution.coin} trên ${currentSelectedOpportunityForExecution.exchanges} để THỰC HIỆN.`);
                safeLog('log', `  Thông tin chi tiết: PnL ước tính: ${currentSelectedOpportunityForExecution.estimatedPnl.toFixed(2)}%, Funding trong: ${currentSelectedOpportunityForExecution.details.minutesUntilFunding.toFixed(1)} phút.`);
                safeLog('log', `  Sàn Short: ${currentSelectedOpportunityForExecution.details.shortExchange}, Sàn Long: ${currentSelectedOpportunityForExecution.details.longExchange}`);
                
                // Cập nhật hiển thị vốn dự kiến theo cách tính mới
                const shortExId = currentSelectedOpportunityForExecution.exchanges.split(' / ')[0].toLowerCase() === 'binance' ? 'binanceusdm' : currentSelectedOpportunityForExecution.exchanges.split(' / ')[0].toLowerCase();
                const longExId = currentSelectedOpportunityForExecution.exchanges.split(' / ')[1].toLowerCase() === 'binance' ? 'binanceusdm' : currentSelectedOpportunityForExecution.exchanges.split(' / ')[1].toLowerCase();
                const minAvailableBalanceForDisplay = Math.min(balances[shortExId]?.available || 0, balances[longExId]?.available || 0);
                bestPotentialOpportunityForDisplay.estimatedTradeCollateral = (minAvailableBalanceForDisplay * (currentPercentageToUse / 100)).toFixed(2);
                safeLog('log', `  Vốn dự kiến: ${bestPotentialOpportunityForDisplay.estimatedTradeCollateral} USDT`);

                // <<-- ĐÃ LOẠI BỎ LOGIC VÀ TRẠNG THÁI CHUYỂN TIỀN Ở ĐÂY -->>
                safeLog('log', '[BOT_LOOP] Bỏ qua bước chuyển tiền. Tiền phải có sẵn trên các sàn.');
                // Kế tiếp là sẽ chờ đến thời điểm mở lệnh (phút 59)

            } else {
                safeLog('log', `[BOT_LOOP] 🔍 Không tìm thấy cơ hội nào đủ điều kiện để THỰC HIỆN tại phút ${currentMinute}.`);
                currentSelectedOpportunityForExecution = null;
            }
        }
    }

    if (currentMinute === 59 && currentSecond >= 55 && currentSecond < 59 && botState === 'RUNNING' && currentSelectedOpportunityForExecution && !currentTradeDetails) {
        if (LAST_ACTION_TIMESTAMP.tradeExecution !== minuteAligned) {
            LAST_ACTION_TIMESTAMP.tradeExecution = minuteAligned;

            safeLog('log', `[BOT_LOOP] ⚡ Kích hoạt mở lệnh cho cơ hội ${currentSelectedOpportunityForExecution.coin} vào phút 59:55.`);
            botState = 'EXECUTING_TRADES'; // Vẫn giữ trạng thái này để UI cập nhật và theo dõi
            const tradeSuccess = await executeTrades(currentSelectedOpportunityForExecution, currentPercentageToUse);
            if (tradeSuccess) {
                safeLog('log', '[BOT_LOOP] ✅ Mở lệnh hoàn tất.');
            } else {
                safeLog('error', '[BOT_LOOP] ❌ Lỗi mở lệnh. Hủy chu kỳ này.');
                currentSelectedOpportunityForExecution = null;
                currentTradeDetails = null;
            }
            botState = 'RUNNING'; // Trả về RUNNING sau khi thực hiện xong
        }
    }

    if (currentMinute === 0 && currentSecond >= 5 && currentSecond < 10 && botState === 'RUNNING' && currentTradeDetails?.status === 'OPEN') {
        if (LAST_ACTION_TIMESTAMP.closeTrade !== minuteAligned) {
            LAST_ACTION_TIMESTAMP.closeTrade = minuteAligned;

            safeLog('log', '[BOT_LOOP] 🛑 Kích hoạt đóng lệnh và tính PnL vào phút 00:05.');
            botState = 'CLOSING_TRADES'; // Vẫn giữ trạng thái này để UI cập nhật và theo dõi
            await closeTradesAndCalculatePnL();
            botState = 'RUNNING'; // Trả về RUNNING sau khi thực hiện xong
        }
    }

    botLoopIntervalId = setTimeout(mainBotLoop, 1000);
}

function startBot() {
    if (botState === 'STOPPED') {
        safeLog('log', '[BOT] ▶️ Khởi động Bot...');
        botState = 'RUNNING';

        updateBalances().then(() => {
            safeLog('log', '[BOT] Đã cập nhật số dư ban đầu. Bắt đầu vòng lặp bot.');
            mainBotLoop();
        }).catch(err => {
            safeLog('error', `[BOT] Lỗi khi khởi tạo số dư ban đầu: ${err.message}`, err);
            botState = 'STOPPED';
        });
        return true;
    }
    safeLog('warn', '[BOT] Bot đã chạy hoặc đang trong quá trình chuyển trạng thái.');
    return false;
}

function stopBot() {
    // Điều chỉnh trạng thái có thể dừng để phù hợp với việc loại bỏ các bước chuyển tiền
    if (botState === 'RUNNING' || botState === 'FETCHING_DATA' || botState === 'PROCESSING_DATA' || botState === 'EXECUTING_TRADES' || botState === 'CLOSING_TRADES') {
        safeLog('log', '[BOT] ⏸️ Dừng Bot...');
        if (botLoopIntervalId) {
            clearTimeout(botLoopIntervalId);
            botLoopIntervalId = null;
        }
        botState = 'STOPPED';
        safeLog('log', '[BOT] Bot đã dừng thành công.');
        return true;
    }
    safeLog('warn', '[BOT] Bot không hoạt động hoặc không thể dừng.');
    return false;
}

const botServer = http.createServer((req, res) => {
    if (req.url === '/' && req.method === 'GET') {
        fs.readFile(path.join(__dirname, 'index.html'), (err, content) => {
            if (err) {
                safeLog('error', '[BOT_SERVER] ❌ Lỗi khi đọc index.html:', err.message, err);
                res.writeHead(500);
                res.end('Lỗi khi đọc index.html');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8'});
            res.end(content);
        });
    } else if (req.url === '/bot-api/status' && req.method === 'GET') {
        let displayCurrentTradeDetails = null;
        try {
            if (currentTradeDetails && typeof currentTradeDetails === 'object' && currentTradeDetails.status === 'OPEN') {
                displayCurrentTradeDetails = currentTradeDetails;
            } else {
                displayCurrentTradeDetails = null;
            }
        } catch (e) {
            safeLog('error', `[BOT_SERVER] CRITICAL EXCEPTION accessing currentTradeDetails for status API: ${e.message}. Setting to null.`, e);
            displayCurrentTradeDetails = null;
        }

        const statusData = {
            botState: botState,
            balances: Object.fromEntries(Object.entries(balances).filter(([id]) => activeExchangeIds.includes(id) || id === 'totalOverall')),
            initialTotalBalance: initialTotalBalance,
            cumulativePnl: cumulativePnl,
            tradeHistory: tradeHistory,
            currentSelectedOpportunity: bestPotentialOpportunityForDisplay,
            currentTradeDetails: displayCurrentTradeDetails
        };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(statusData));
    } else if (req.url === '/bot-api/start' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk.toString(); });
        req.on('end', () => {
            try {
                const data = body ? JSON.parse(body) : {};
                currentPercentageToUse = parseFloat(data.percentageToUse);
                if (isNaN(currentPercentageToUse) || currentPercentageToUse < 1 || currentPercentageToUse > 100) {
                    currentPercentageToUse = 50;
                    safeLog('warn', `Giá trị phần trăm vốn không hợp lệ từ UI, sử dụng mặc định: ${currentPercentageToUse}%`);
                }

                const started = startBot();
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: started, message: started ? 'Bot đã khởi động.' : 'Bot đã chạy.' }));
            } catch (error) {
                safeLog('error', '[BOT_SERVER] ❌ Lỗi xử lý POST /bot-api/start:', error.message, error);
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, message: 'Dữ liệu yêu cầu không hợp lệ hoặc lỗi server.' }));
            }
        });
    } else if (req.url === '/bot-api/stop' && req.method === 'POST') {
        const stopped = stopBot();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: stopped, message: stopped ? 'Bot đã dừng.' : 'Bot không hoạt động.' }));
    } else if (req.url === '/bot-api/test-trade' && req.method === 'POST') { // NEW: TEST TRADE ENDPOINT
        let body = '';
        req.on('data', chunk => { body += chunk.toString(); });
        req.on('end', async () => { // Make this async to use await
            try {
                const data = body ? JSON.parse(body) : {};
                const testPercentageToUse = parseFloat(data.percentageToUse);

                if (isNaN(testPercentageToUse) || testPercentageToUse < 1 || testPercentageToUse > 100) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, message: 'Phần trăm vốn không hợp lệ (1-100).' }));
                    return;
                }

                // Ensure serverDataGlobal is available before trying to use opportunities
                if (!serverDataGlobal || !serverDataGlobal.arbitrageData || serverDataGlobal.arbitrageData.length === 0) {
                    // Attempt to fetch data if not available or stale for test purposes
                    const fetchedDataForTest = await fetchDataFromServer();
                    if (fetchedDataForTest) {
                        serverDataGlobal = fetchedDataForTest;
                        safeLog('log', '[BOT_SERVER] Đã fetch lại dữ liệu server cho lệnh test.');
                    } else {
                         res.writeHead(500, { 'Content-Type': 'application/json' });
                         res.end(JSON.stringify({ success: false, message: 'Không thể fetch dữ liệu server cho lệnh test.' }));
                         return;
                    }
                }

                let testOpportunity = null;
                // Prefer the best opportunity currently displayed/calculated for display
                if (bestPotentialOpportunityForDisplay) {
                    testOpportunity = { ...bestPotentialOpportunityForDisplay }; // Clone to avoid direct mutation
                    // Ensure 'details' object is present for safety, as executeTrades expects it
                    if (!testOpportunity.details) {
                        testOpportunity.details = {};
                    }
                    // For test, ensure shortExchange and longExchange are set from the 'exchanges' string if 'details' is minimal
                    if (!testOpportunity.details.shortExchange && testOpportunity.exchanges) {
                        const exParts = testOpportunity.exchanges.split(' / ');
                        if (exParts.length === 2) {
                            testOpportunity.details.shortExchange = exParts[0];
                            testOpportunity.details.longExchange = exParts[1];
                        }
                    }
                } else if (allCurrentOpportunities.length > 0) {
                    // Fallback: If bestPotentialOpportunityForDisplay is null, find the one with highest PnL from all current
                    testOpportunity = allCurrentOpportunities.reduce((best, current) => {
                        return (best === null || current.estimatedPnl > best.estimatedPnl) ? current : best;
                    }, null);
                }

                if (!testOpportunity) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, message: 'Không tìm thấy cơ hội arbitrage nào đủ điều kiện để test. Vui lòng đảm bảo có cơ hội được hiển thị trên UI.' }));
                    return;
                }

                safeLog('log', `[BOT_SERVER] ⚡ Yêu cầu TEST MỞ LỆNH: ${testOpportunity.coin} trên ${testOpportunity.exchanges} với ${testPercentageToUse}% vốn.`);
                safeLog('log', '[BOT_SERVER] Thông tin cơ hội Test:', testOpportunity);

                // Temporarily set currentSelectedOpportunityForExecution for executeTrades function
                // It's crucial to restore this later to avoid interfering with the main bot loop's selection.
                const originalCurrentSelectedOpportunityForExecution = currentSelectedOpportunityForExecution;
                currentSelectedOpportunityForExecution = testOpportunity; 

                const tradeSuccess = await executeTrades(testOpportunity, testPercentageToUse);

                // Restore previous currentSelectedOpportunityForExecution after test
                currentSelectedOpportunityForExecution = originalCurrentSelectedOpportunityForExecution;

                if (tradeSuccess) {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: true, message: 'Lệnh TEST đã được gửi thành công!' }));
                } else {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, message: 'Có lỗi xảy ra khi gửi lệnh TEST. Vui lòng kiểm tra log bot.' }));
                }

            } catch (error) {
                safeLog('error', '[BOT_SERVER] ❌ Lỗi xử lý POST /bot-api/test-trade:', error.message, error);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, message: 'Lỗi server khi thực hiện lệnh test.' }));
            }
        });
    }
    // <<-- LOẠI BỎ TOÀN BỘ else if (req.url === '/bot-api/transfer-funds' && req.method === 'POST') Ở ĐÂY -->>
    else {
        res.writeHead(404); res.end('Not Found');
    }
});

botServer.listen(BOT_PORT, () => {
    safeLog('log', `✅ Máy chủ UI của Bot đang chạy tại http://localhost:${BOT_PORT}`);
    safeLog('log', 'Bot đang chờ lệnh "Start" từ giao diện HTML.');
});
