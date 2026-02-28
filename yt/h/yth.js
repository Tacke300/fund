// Biến tạm để điều khiển trang login
let loginPage = null;

app.get('/login', async (req, res) => {
    if (!loginPage) {
        const browser = await puppeteer.launch({ 
            headless: "new", // Chạy ngầm trên VPS nhưng ta sẽ lấy ảnh
            args: ['--no-sandbox', '--window-size=1280,720'] 
        });
        loginPage = await browser.newPage();
        await loginPage.goto('https://accounts.google.com/ServiceLogin?service=youtube');
    }

    // Nếu ông gửi lệnh bấm/nhập từ URL (ví dụ: /login?click=x,y hoặc /login?type=abc)
    const { clickX, clickY, text } = req.query;
    if (clickX && clickY) await loginPage.mouse.click(parseInt(clickX), parseInt(clickY));
    if (text) await loginPage.keyboard.type(text);

    // Chụp ảnh màn hình hiện tại của trang login
    const screenshot = await loginPage.screenshot({ encoding: 'base64' });
    
    res.send(`
        <body style="background:#000; color:#fff; text-align:center">
            <h2>ĐĂNG NHẬP YOUTUBE TRỰC TUYẾN</h2>
            <div style="position:relative; display:inline-block">
                <img id="screen" src="data:image/png;base64,${screenshot}" style="border:2px solid #58a6ff; cursor:crosshair" onclick="clickScreen(event)">
            </div>
            <div style="margin-top:20px">
                <input type="text" id="kb" placeholder="Nhập chữ vào đây...">
                <button onclick="sendText()">GỬI CHỮ</button>
                <button onclick="saveCK()" style="background:green; color:white">LƯU COOKIE & ĐÓNG</button>
            </div>
            <script>
                function clickScreen(e) {
                    const rect = e.target.getBoundingClientRect();
                    const x = e.clientX - rect.left;
                    const y = e.clientY - rect.top;
                    location.href = \`/login?clickX=\${x}&clickY=\${y}\`;
                }
                function sendText() {
                    const txt = document.getElementById('kb').value;
                    location.href = \`/login?text=\${encodeURIComponent(txt)}\`;
                }
                function saveCK() { location.href = '/save-cookie'; }
            </script>
            <p>Mẹo: Bấm chuột vào ảnh để Click, nhập chữ vào ô rồi bấm Gửi để điền Email/Pass.</p>
        </body>
    `);
});

// Route lưu lại sau khi ông xong việc
app.get('/save-cookie', async (req, res) => {
    if (loginPage) {
        const cookies = await loginPage.cookies();
        await fs.writeJson(COOKIE_FILE, cookies);
        await loginPage.browser().close();
        loginPage = null;
        res.send("<h1>✅ ĐÃ LƯU COOKIE! Bot sẽ tự dùng từ luồng sau.</h1><a href='/'>Quay lại Dashboard</a>");
    }
});
