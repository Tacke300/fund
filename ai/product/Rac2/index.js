const express = require('express');
const puppeteer = require('puppeteer');
const app = express();
const port = 3000;

let botRunning = false;
let browser, page;

app.use(express.static('public'));

app.get('/', (req, res) => {
    res.sendFile(__dirname + '/index.html');
});

app.get('/start', (req, res) => {
    if (!botRunning) {
        startBot();
        botRunning = true;
        res.send('Bot đã được khởi động');
    } else {
        res.send('Bot đã đang chạy');
    }
});

app.get('/stop', (req, res) => {
    if (botRunning) {
        stopBot();
        botRunning = false;
        res.send('Bot đã được dừng');
    } else {
        res.send('Bot chưa được khởi động');
    }
});

async function startBot() {
    browser = await puppeteer.launch({
        headless: false,
    });
    page = await browser.newPage();
    await page.goto('https://www.tiktok.com/login');
    await page.waitForSelector('input[name="username"]');
    await page.type('input[name="username"]', 'tên_tài_khoản_của_bạn');
    await page.type('input[name="password"]', 'mật_khẩu_của_bạn');
    await page.click('button[type="submit"]');
    await page.waitForNavigation();

    while (true) {
        await page.goto('https://www.tiktok.com/');
        await page.waitForSelector('div.video-list');
        const videos = await page.$$eval('div.video-list > div', (videos) => {
            return videos.map((video) => video.querySelector('a').href);
        });
        for (const video of videos) {
            await page.goto(video);
            await page.waitForSelector('button.like-button');
            await page.click('button.like-button');
            await page.type('textarea.comment-input', '❤❤❤');
            await page.click('button.comment-button');
            await new Promise((resolve) => setTimeout(resolve, 1000));
        }
    }
}

async function stopBot() {
    await browser.close();
}

app.listen(port, () => {
    console.log(`Server đang chạy trên port ${port}`);
});


html
<!-- index.html -->

<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>TikTok Bot</title>
</head>
<body>
    <h1>TikTok Bot</h1>
    <button onclick="startBot()">Start</button>
    <button onclick="stopBot()">Stop</button>

    <script>
        async function startBot() {
            const response = await fetch('/start');
            const message = await response.text();
            console.log(message);
        }

        async function stopBot() {
            const response = await fetch('/stop');
            const message = await response.text();
            console.log(message);
        }
    </script>
</body>
</html>