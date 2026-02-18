<!DOCTYPE html>
<html lang="vi">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Binance Square Professional Bot</title>
    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
    <style>
        :root {
            --binance-yellow: #FCD535;
            --bg-dark: #0B0E11;
            --card-bg: #1E2329;
            --text-main: #EAECEF;
            --text-muted: #848E9C;
            --green: #0ECB81;
            --red: #F6465D;
        }

        body {
            background-color: var(--bg-dark);
            color: var(--text-main);
            font-family: 'Segoe UI', Roboto, sans-serif;
            margin: 0;
            display: flex;
            justify-content: center;
            padding: 40px 20px;
        }

        .dashboard {
            width: 100%;
            max-width: 1000px;
        }

        .header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 30px;
        }

        .header h1 { color: var(--binance-yellow); margin: 0; font-size: 24px; }

        .stats-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
            gap: 20px;
            margin-bottom: 30px;
        }

        .stat-card {
            background: var(--card-bg);
            padding: 20px;
            border-radius: 12px;
            border: 1px solid #333;
            transition: transform 0.2s;
        }

        .stat-card:hover { transform: translateY(-5px); }
        .stat-label { color: var(--text-muted); font-size: 14px; margin-bottom: 10px; }
        .stat-value { font-size: 28px; font-weight: bold; }

        .main-content {
            display: grid;
            grid-template-columns: 2fr 1fr;
            gap: 20px;
        }

        .card {
            background: var(--card-bg);
            padding: 20px;
            border-radius: 12px;
            border: 1px solid #333;
        }

        .controls {
            display: flex;
            gap: 10px;
            margin-bottom: 20px;
        }

        .btn {
            flex: 1;
            padding: 12px;
            border: none;
            border-radius: 8px;
            font-weight: bold;
            cursor: pointer;
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 8px;
            transition: opacity 0.2s;
        }

        .btn-start { background: var(--green); color: white; }
        .btn-stop { background: var(--red); color: white; }
        .btn:disabled { opacity: 0.5; cursor: not-allowed; }

        table {
            width: 100%;
            border-collapse: collapse;
            margin-top: 10px;
        }

        th { text-align: left; color: var(--text-muted); font-weight: normal; padding: 12px 8px; border-bottom: 1px solid #333; }
        td { padding: 12px 8px; border-bottom: 1px solid #2b3139; font-size: 14px; }

        .badge {
            padding: 4px 8px;
            border-radius: 4px;
            font-size: 12px;
        }
        .badge-success { background: rgba(14, 203, 129, 0.2); color: var(--green); }
        
        .status-dot {
            height: 10px; width: 10px; border-radius: 50%; display: inline-block; margin-right: 5px;
        }
        .online { background-color: var(--green); box-shadow: 0 0 10px var(--green); }
        .offline { background-color: var(--red); }
    </style>
</head>
<body>
    <div class="dashboard">
        <div class="header">
            <h1><i class="fa-solid fa-robot"></i> Binance Square Bot <small style="font-size: 12px; color: var(--text-muted);">v2.0</small></h1>
            <div id="connection-status">
                <span class="status-dot offline"></span> <span style="color: var(--text-muted)">Hệ thống dừng</span>
            </div>
        </div>

        <div class="stats-grid">
            <div class="stat-card">
                <div class="stat-label">Tổng bài đăng</div>
                <div class="stat-value" id="totalPosts">0</div>
            </div>
            <div class="stat-card">
                <div class="stat-label">Thời gian chạy</div>
                <div class="stat-value" id="uptime" style="font-size: 20px;">00:00:00</div>
            </div>
            <div class="stat-card">
                <div class="stat-label">Lượt View (Ước tính)</div>
                <div class="stat-value" style="color: var(--binance-yellow);">N/A</div>
            </div>
        </div>

        <div class="main-content">
            <div class="card">
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px;">
                    <h3 style="margin: 0;">Lịch sử hoạt động</h3>
                    <div class="controls" style="margin: 0;">
                        <button class="btn btn-start" onclick="controlBot('start')"><i class="fa-solid fa-play"></i> START</button>
                        <button class="btn btn-stop" onclick="controlBot('stop')"><i class="fa-solid fa-stop"></i> STOP</button>
                    </div>
                </div>
                <table>
                    <thead>
                        <tr>
                            <th>Coin</th>
                            <th>Thời gian</th>
                            <th>Trạng thái</th>
                        </tr>
                    </thead>
                    <tbody id="logTable">
                        </tbody>
                </table>
            </div>

            <div class="card">
                <h3>Phân bổ Token</h3>
                <canvas id="coinChart"></canvas>
            </div>
        </div>
    </div>

    <script>
        async function controlBot(action) {
            await fetch(`/${action}`);
        }

        function updateStats() {
            fetch('/stats')
                .then(res => res.json())
                .then(data => {
                    document.getElementById('totalPosts').innerText = data.totalPosts;
                    document.getElementById('uptime').innerText = data.lastRun || '--:--';
                    
                    const statusDot = document.querySelector('.status-dot');
                    if(data.isRunning) {
                        statusDot.className = 'status-dot online';
                        statusDot.nextElementSibling.innerText = 'Đang hoạt động';
                    } else {
                        statusDot.className = 'status-dot offline';
                        statusDot.nextElementSibling.innerText = 'Hệ thống dừng';
                    }

                    let html = '';
                    data.history.forEach(log => {
                        html += `<tr>
                            <td><b>$${log.coin}</b></td>
                            <td>${log.time}</td>
                            <td><span class="badge badge-success">${log.status}</span></td>
                        </tr>`;
                    });
                    document.getElementById('logTable').innerHTML = html;
                });
        }

        setInterval(updateStats, 3000);
    </script>
</body>
</html>
