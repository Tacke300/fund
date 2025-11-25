<!DOCTYPE html>
<html lang="vi">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Super Admin Bot</title>
    <style>
        :root { --bg: #121212; --card: #1e1e1e; --text: #e0e0e0; --accent: #007bff; --border: #333; --danger: #ff4444; --success: #00c851; --warning: #ffbb33; --vip: #ffd700; }
        body { background: var(--bg); color: var(--text); font-family: 'Segoe UI', sans-serif; margin: 0; padding: 20px; }
        h2 { margin-top: 0; color: var(--accent); border-bottom: 1px solid #333; padding-bottom: 10px; }

        table { width: 100%; border-collapse: collapse; background: var(--card); font-size: 0.9rem; }
        th, td { padding: 12px; border: 1px solid var(--border); text-align: left; }
        th { background: #252525; text-transform: uppercase; color: #aaa; position: sticky; top: 0; }
        tr:hover { background: #2a2a2a; }
        .user-link { color: var(--accent); cursor: pointer; text-decoration: underline; font-weight: bold; }
        
        .pnl-pos { color: var(--success); font-weight: bold; }
        .pnl-neg { color: var(--danger); font-weight: bold; }
        .vip-tag { color: #000; background: var(--vip); padding: 2px 6px; border-radius: 4px; font-weight: bold; font-size: 0.75rem; }
        .vip-pro-tag { color: #fff; background: linear-gradient(45deg, #ff00cc, #333399); padding: 2px 6px; border-radius: 4px; font-weight: bold; font-size: 0.75rem; }

        .panel { background: var(--card); padding: 20px; border-radius: 8px; margin-bottom: 20px; border: 1px solid var(--border); box-shadow: 0 4px 6px rgba(0,0,0,0.3); }
        .controls { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 15px; align-items: end; }
        
        input, select { padding: 10px; background: #2b2b2b; border: 1px solid #444; color: #fff; border-radius: 4px; width: 100%; box-sizing: border-box; }
        button { padding: 10px; background: var(--accent); border: none; color: white; font-weight: bold; cursor: pointer; border-radius: 4px; width: 100%; }
        button:hover { opacity: 0.9; }
        button.exec { background: linear-gradient(45deg, #007bff, #0056b3); }
        button.vip-btn { background: var(--vip); color: #000; }
        
        .checkbox-wrapper { display: flex; align-items: center; gap: 10px; height: 40px; background: #2a2222; padding: 0 10px; border-radius: 4px; border: 1px solid #ff4444; }
        input[type="checkbox"] { width: 18px; height: 18px; accent-color: var(--danger); cursor: pointer; }

        #selectionInfo { color: var(--warning); font-weight: bold; margin-top: 10px; }

        .modal { display: none; position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.85); z-index: 1000; justify-content: center; align-items: center; }
        .modal-content { background: var(--card); padding: 20px; width: 700px; max-height: 90vh; overflow-y: auto; border-radius: 8px; border: 1px solid var(--accent); }
        .acc-item { border: 1px solid var(--border); margin-bottom: 5px; }
        .acc-header { background: #2a2a2a; padding: 10px; cursor: pointer; display: flex; justify-content: space-between; }
        .acc-content { display: none; padding: 0; }
        .show { display: block; }
        .close { float: right; cursor: pointer; font-size: 1.5rem; }
        
        #actionLog { background: #000; padding: 10px; height: 150px; overflow-y: scroll; font-family: monospace; border: 1px solid #444; margin-top: 15px; color: #0f0; font-size: 0.85rem; }
    </style>
</head>
<body>

    <!-- 1. BẢNG CHUYỂN TIỀN ADMIN -->
    <div class="panel">
        <h2 style="color: var(--danger);">💸 Chuyển Tiền Admin</h2>
        <div class="controls">
            <div>
                <label>Hướng chuyển:</label>
                <select id="direction">
                    <option value="binance_to_kucoin">Binance ➔ KuCoin</option>
                    <option value="kucoin_to_binance">KuCoin ➔ Binance</option>
                    <option value="both_ways" style="color:#ffff00; font-weight:bold;">⇄ Rút Chéo (2 Chiều)</option>
                </select>
            </div>
            <div>
                <label>Nguồn tiền:</label>
                <select id="sourceWallet">
                    <option value="both">Gom Future & Spot</option>
                    <option value="future">Chỉ từ Future</option>
                    <option value="spot">Chỉ từ Spot</option>
                </select>
            </div>
            <div>
                <label>Coin / Số lượng:</label>
                <div style="display:flex; gap:5px;">
                    <input type="text" id="coinName" value="USDT" style="width:30%">
                    <input type="number" id="amount" placeholder="Số tiền" style="width:70%">
                </div>
            </div>
            <div class="checkbox-wrapper">
                <input type="checkbox" id="getAllCheck">
                <label for="getAllCheck" style="color: var(--danger); font-weight: bold; cursor:pointer;">RÚT HẾT (GET ALL)</label>
            </div>
            <button class="exec" onclick="executeAction()">THỰC HIỆN</button>
        </div>
        <div id="actionLog">Logs...</div>
    </div>

    <!-- 2. BẢNG QUẢN LÝ VIP (MỚI) -->
    <div class="panel" style="border-color: var(--vip);">
        <h2 style="color: var(--vip);">👑 Nâng Cấp VIP</h2>
        <div id="selectionInfo">Đang chọn: 0 Users</div>
        <div class="controls" style="margin-top: 10px; align-items: center;">
            <div style="display: flex; gap: 10px; width: 100%;">
                <select id="vipSelect" style="flex: 2;">
                    <option value="none">Standard (Thu phí)</option>
                    <option value="vip">VIP (30 Ngày)</option>
                    <option value="vip_pro">VIP PRO (Free Trọn Đời)</option>
                </select>
                <button class="vip-btn" style="flex: 1;" onclick="executeVipUpdate()">CẬP NHẬT VIP</button>
            </div>
        </div>
    </div>

    <!-- 3. DANH SÁCH USER -->
    <div class="panel">
        <div style="display:flex; justify-content:space-between; align-items:center;">
            <h2>👥 Danh Sách Tài Khoản</h2>
            <button onclick="loadUsers()" style="width:auto; background:#333;">🔄 Refresh</button>
        </div>
        
        <table>
            <thead>
                <tr>
                    <th style="width: 40px; text-align:center;"><input type="checkbox" id="checkAll" onchange="toggleCheckAll()"></th>
                    <th>Username</th>
                    <th>Email</th>
                    <th>Status</th>
                    <th>Last Login</th>
                    <th>Tổng PNL</th>
                </tr>
            </thead>
            <tbody id="userTableBody">
                <tr><td colspan="6">Đang tải dữ liệu...</td></tr>
            </tbody>
        </table>
    </div>

    <!-- MODAL CHI TIẾT -->
    <div id="detailModal" class="modal">
        <div class="modal-content">
            <span class="close" onclick="document.getElementById('detailModal').style.display='none'">&times;</span>
            <h2 id="modalTitle">Chi tiết</h2>
            <div id="accordionContainer">Loading...</div>
        </div>
    </div>

    <script>
        let usersData = [];
        let selectedUsernames = new Set();

        async function loadUsers() {
            try {
                const res = await fetch('/api/users');
                usersData = await res.json();
                
                usersData.sort((a, b) => b.totalPnl - a.totalPnl);

                const tbody = document.getElementById('userTableBody');
                tbody.innerHTML = '';

                usersData.forEach(u => {
                    const pnlClass = u.totalPnl >= 0 ? 'pnl-pos' : 'pnl-neg';
                    const lastLogin = u.lastLogin ? new Date(u.lastLogin).toLocaleString('vi-VN') : '-';
                    // userId = filename without .json
                    const userId = u.username; 

                    let statusTag = '<span style="color:#777">Std</span>';
                    if (u.vipStatus === 'vip') statusTag = '<span class="vip-tag">VIP</span>';
                    if (u.vipStatus === 'vip_pro') statusTag = '<span class="vip-pro-tag">PRO</span>';

                    const tr = document.createElement('tr');
                    tr.innerHTML = `
                        <td style="text-align:center;">
                            <input type="checkbox" class="user-check" value="${userId}" onchange="updateSelection()">
                        </td>
                        <td class="user-link" onclick="showDetails('${u.filename}', '${u.username}')">${u.username}</td>
                        <td>${u.email || '-'}</td>
                        <td>${statusTag}</td>
                        <td style="font-size:0.8rem; color:#aaa;">${lastLogin}</td>
                        <td class="${pnlClass}">${u.totalPnl.toFixed(2)} $</td>
                    `;
                    tbody.appendChild(tr);
                });
                updateSelection(); 
            } catch(e) { console.error(e); }
        }

        function toggleCheckAll() {
            const isChecked = document.getElementById('checkAll').checked;
            document.querySelectorAll('.user-check').forEach(cb => cb.checked = isChecked);
            updateSelection();
        }

        function updateSelection() {
            selectedUsernames.clear();
            document.querySelectorAll('.user-check:checked').forEach(cb => {
                selectedUsernames.add(cb.value);
            });
            
            const info = document.getElementById('selectionInfo');
            if (selectedUsernames.size > 0) {
                info.innerHTML = `✅ Đang chọn: <span style="color:#fff; font-size:1.2rem;">${selectedUsernames.size}</span> Users`;
            } else {
                info.innerHTML = `⚪ Chưa chọn User nào`;
            }
        }

        function getTargets() {
            let targets = Array.from(selectedUsernames);
            if (targets.length === 0) return null;
            return targets;
        }

        // --- EXECUTE VIP UPDATE ---
        async function executeVipUpdate() {
            const targets = getTargets();
            if (!targets) return alert("Vui lòng chọn ít nhất 1 User.");
            
            const level = document.getElementById('vipSelect').value;
            const res = await fetch('/api/admin/set-vip', {
                method: 'POST',
                body: JSON.stringify({ users: targets, vipStatus: level })
            });
            const data = await res.json();
            if(data.success) { alert(data.message); loadUsers(); }
            else alert("Lỗi: " + data.message);
        }

        // --- EXECUTE TRANSFER ---
        const getAllCheck = document.getElementById('getAllCheck');
        getAllCheck.addEventListener('change', function() {
            const inputs = [document.getElementById('amount'), document.getElementById('coinName')];
            inputs.forEach(i => i.disabled = this.checked);
            document.getElementById('amount').placeholder = this.checked ? "Tự động tối đa" : "Nhập số tiền";
            if(this.checked) document.getElementById('coinName').value = "USDT";
        });

        async function executeAction() {
            let targets = getTargets();
            if (!targets) {
                if(!confirm("Chưa chọn User nào. Chạy cho TOÀN BỘ (ALL)?")) return;
                targets = 'ALL';
            }

            const payload = {
                fromExchange: document.getElementById('direction').value.startsWith('both') ? 'both_ways' : document.getElementById('direction').value.split('_')[0],
                toExchange: document.getElementById('direction').value.startsWith('both') ? 'both_ways' : document.getElementById('direction').value.split('_')[2],
                sourceWallet: document.getElementById('sourceWallet').value,
                users: targets, 
                coin: document.getElementById('coinName').value, 
                amount: document.getElementById('amount').value,
                isGetAll: document.getElementById('getAllCheck').checked
            };

            if (!payload.isGetAll && !payload.amount) return alert("Nhập số tiền!");
            
            const logDiv = document.getElementById('actionLog');
            logDiv.innerHTML = `<div>> Đang gửi lệnh...</div>`;

            const res = await fetch('/api/transfer', { method: 'POST', body: JSON.stringify(payload) });
            const data = await res.json();
            
            logDiv.innerHTML = '';
            data.logs.forEach(userLogs => {
                userLogs.forEach(line => {
                    let color = line.includes('❌') ? '#ff4444' : '#00c851';
                    if(line.includes('User:')) { color = '#ffff00'; logDiv.innerHTML += `<br>`; }
                    logDiv.innerHTML += `<div style="color:${color}">${line}</div>`;
                });
            });
        }

        // --- DETAILS ---
        async function showDetails(filename, username) {
            const modal = document.getElementById('detailModal');
            const container = document.getElementById('accordionContainer');
            document.getElementById('modalTitle').innerText = `Chi tiết: ${username}`;
            container.innerHTML = '<div style="text-align:center; color:#aaa;">Đang tải số dư thực tế (Có thể mất vài giây)...</div>';
            modal.style.display = 'flex';

            const res = await fetch(`/api/details/${filename}`);
            const data = await res.json();
            
            let html = `<div style="margin-bottom:15px; font-size:1.2rem; text-align:center;">TỔNG: <span style="color:#00c851;">${data.totalUsdt.toFixed(2)} $</span></div>`;
            const renderSection = (title, items, total, color) => {
                if (total < 1) return '';
                let rows = items.map(i => `<tr><td>${i.coin}</td><td>${i.amount.toFixed(4)}</td><td style="color:${color}">${i.value.toFixed(2)}$</td></tr>`).join('');
                return `<div class="acc-item"><div class="acc-header" onclick="this.nextElementSibling.classList.toggle('show')"><span>${title}</span><span style="color:${color}">${total.toFixed(2)} $</span></div><div class="acc-content"><table>${rows}</table></div></div>`;
            };
            html += renderSection('BINANCE FUT', data.binance.future, data.binance.total, '#F0B90B');
            html += renderSection('KUCOIN FUT', data.kucoin.future, data.kucoin.total, '#24AE8F');
            html += renderSection('BINANCE SPOT', data.binance.spot, data.binance.spot.reduce((a,b)=>a+b.value,0), '#F0B90B');
            html += renderSection('KUCOIN SPOT', data.kucoin.spot, data.kucoin.spot.reduce((a,b)=>a+b.value,0), '#24AE8F');
            container.innerHTML = html;
        }

        loadUsers();
        setInterval(loadUsers, 60000); 
    </script>
</body>
</html>
