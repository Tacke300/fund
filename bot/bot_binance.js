/***************** CẤU HÌNH CHUNG  *****************/
const express = require('express');
const https = require('https');
const crypto = require('crypto');
const fetch = require('node-fetch');
const path = require('path');
const cron = require('node-cron');

const app = express();
const port = 3000;

// === API KEY & SECRET ===
const apiKey = 'VH1bYvlcOCFNeBy7TOnAidQUkRU9wxbGd3x6zPo6fWQwAteErrv9YG94OQtw2o6A';
const apiSecret = 'ONVCARicwK01xzQA7bCOHiawmU2WuY4buei955zJau9Yvmyf51IWh6wQ9wNI7Xjm';

// === BASE URL CỦA BINANCE FUTURES API ===
const BASE_URL = 'fapi.binance.com';

/***************** HÀM KÝ & GỌI API  *****************/
function getSignature(queryString, secret) {
  return crypto.createHmac('sha256', secret).update(queryString).digest('hex');
}

async function callSignedAPI(endpoint, method = 'GET', params = {}) {
  const timestamp = Date.now();
  const recvWindow = 60000;

  const allParams = {
    timestamp,
    recvWindow,
    ...params
  };

  // Sắp xếp tham số theo thứ tự bảng chữ cái (quan trọng cho signature)
  const sortedKeys = Object.keys(allParams).sort();
  const queryString = sortedKeys
    .map(key => `${key}=${allParams[key]}`)
    .join('&');

  const signature = getSignature(queryString, apiSecret);
  const fullPath = `${endpoint}?${queryString}&signature=${signature}`;

  // *** THÊM CÁC DÒNG LOG DEBUG MỚI ***
  console.log('\n--- DEBUG API CALL ---');
  console.log(`Endpoint: ${endpoint}`);
  console.log(`Method: ${method}`);
  console.log(`Initial Params: ${JSON.stringify(params)}`);
  console.log(`All Params (with timestamp, recvWindow): ${JSON.stringify(allParams)}`);
  console.log(`Sorted Query String (for signature): ${queryString}`);
  console.log(`Generated Signature: ${signature}`);
  console.log(`Full Path (sent to Binance): https://${BASE_URL}${fullPath}`);
  console.log('--- END DEBUG API CALL ---\n');
  // **********************************

  const options = {
    hostname: BASE_URL,
    path: fullPath,
    method,
    headers: {
      'X-MBX-APIKEY': apiKey,
      'Content-Type': 'application/json'
    }
  };

  return new Promise((resolve, reject) => {
    const req = https.request(options, res => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try {
            resolve(JSON.parse(body));
          } catch (e) {
            reject(new Error(`Lỗi parse JSON từ ${endpoint}: ${body}. Chi tiết: ${e.message}`));
          }
        } else {
          let errorMsg = body;
          try {
            const errorJson = JSON.parse(body);
            if (errorJson && errorJson.code && errorJson.msg) {
              errorMsg = `Code: ${errorJson.code}, Msg: ${errorJson.msg}`;
            }
          } catch (parseError) {
            // Không thể parse JSON, giữ nguyên body
          }
          reject(new Error(`API lỗi ${endpoint}: ${res.statusCode} - ${errorMsg}`));
        }
      });
    });
    req.on('error', err => reject(new Error(`Lỗi request đến ${endpoint}: ${err.message}`)));
    req.end();
  });
}

// ... (Các phần còn lại của code của bạn, bao gồm placeShort, cron.schedule, v.v. - giữ nguyên) ...

// Gọi hàm này để kích hoạt API call và xem log
callFuturesAccount();
