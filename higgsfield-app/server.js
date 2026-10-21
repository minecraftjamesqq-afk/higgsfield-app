const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

// 1. 原生讀取並解析 .env 檔案
function loadEnv() {
  const envPath = path.join(__dirname, '.env');
  if (fs.existsSync(envPath)) {
    const envContent = fs.readFileSync(envPath, 'utf8');
    envContent.split('\n').forEach(line => {
      const match = line.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/);
      if (match) {
        const key = match[1];
        let value = match[2] || '';
        if (value.length > 0 && value.startsWith('"') && value.endsWith('"')) {
          value = value.slice(1, -1);
        }
        process.env[key] = value.trim();
      }
    });
  }
}
loadEnv();

const PORT = process.env.PORT || 3000;
const HF_KEY_ID = process.env.HF_API_KEY_ID;
const HF_KEY_SECRET = process.env.HF_API_KEY_SECRET;

// 2. 原生 HTTP Request 封裝
function httpRequest(options, bodyData) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve({ statusCode: res.statusCode, headers: res.headers, data: parsed });
        } catch (e) {
          resolve({ statusCode: res.statusCode, headers: res.headers, data: data });
        }
      });
    });
    req.on('error', reject);
    if (bodyData) {
      req.write(typeof bodyData === 'string' ? bodyData : JSON.stringify(bodyData));
    }
    req.end();
  });
}

// 3. 原生 Multipart Form Data 解析器
function parseMultipart(buffer, boundary) {
  const parts = [];
  const boundaryBuffer = Buffer.from('--' + boundary);
  let start = 0;

  while (start < buffer.length) {
    let index = buffer.indexOf(boundaryBuffer, start);
    if (index === -1) break;

    let end = buffer.indexOf(boundaryBuffer, index + boundaryBuffer.length);
    if (end === -1) break;

    const partBuffer = buffer.slice(index + boundaryBuffer.length + 2, end - 2);
    const headerEnd = partBuffer.indexOf('\r\n\r\n');
    if (headerEnd !== -1) {
      const headerStr = partBuffer.slice(0, headerEnd).toString('utf8');
      const body = partBuffer.slice(headerEnd + 4);

      const filenameMatch = headerStr.match(/filename="([^"]+)"/);
      const nameMatch = headerStr.match(/name="([^"]+)"/);
      const contentTypeMatch = headerStr.match(/Content-Type:\s*([^\r\n]+)/i);

      parts.push({
        name: nameMatch ? nameMatch[1] : null,
        filename: filenameMatch ? filenameMatch[1] : null,
        contentType: contentTypeMatch ? contentTypeMatch[1] : 'text/plain',
        data: body
      });
    }
    start = end;
  }
  return parts;
}

// 4. Node.js 主 HTTP 伺服器
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  // 提供靜態網頁 (index.html)
  if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
    const filePath = path.join(__dirname, 'public', 'index.html');
    fs.readFile(filePath, (err, content) => {
      if (err) {
        res.writeHead(500);
        return res.end('Server Error');
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(content);
    });
    return;
  }

  // 處理 Motion Transfer 生成請求
  if (req.method === 'POST' && req.url === '/api/generate') {
    const contentType = req.headers['content-type'] || '';
    if (!contentType.includes('multipart/form-data')) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Must be multipart/form-data' }));
    }

    const boundary = contentType.split('boundary=')[1];
    const chunks = [];

    req.on('data', chunk => chunks.push(chunk));
    req.on('end', async () => {
      try {
        const bodyBuffer = Buffer.concat(chunks);
        const files = parseMultipart(bodyBuffer, boundary);

        const videoFile = files.find(f => f.name === 'video');
        const imageFiles = files.filter(f => f.name === 'images');

        if (!videoFile || imageFiles.length === 0) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: '請提供 1 部影片與至少 1 張圖片' }));
        }

        if (imageFiles.length > 4) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: '圖片數量不能超過 4 張' }));
        }

        const videoDataUrl = `data:${videoFile.contentType};base64,${videoFile.data.toString('base64')}`;
        const imageUrls = imageFiles.map(img => `data:${img.contentType};base64,${img.data.toString('base64')}`);

        const apiAuthHeader = `Key ${HF_KEY_ID}:${HF_KEY_SECRET}`;
        const postData = JSON.stringify({
          video_url: videoDataUrl,
          image_urls: imageUrls
        });

        const initResponse = await httpRequest({
          hostname: 'api.higgsfield.ai',
          path: '/higgsfield/genjutsu/motion-transfer/v1.0',
          method: 'POST',
          headers: {
            'Authorization': apiAuthHeader,
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(postData)
          }
        }, postData);

        if (initResponse.statusCode !== 200 && initResponse.statusCode !== 202) {
          res.writeHead(initResponse.statusCode, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'Higgsfield API Error', details: initResponse.data }));
        }

        const requestId = initResponse.data.request_id;
        let status = initResponse.data.status;
        let finalResult = initResponse.data;

        while (status === 'queued' || status === 'processing' || status === 'in_progress') {
          await new Promise(resolve => setTimeout(resolve, 3000));

          const pollResponse = await httpRequest({
            hostname: 'api.higgsfield.ai',
            path: `/requests/${requestId}/status`,
            method: 'GET',
            headers: {
              'Authorization': apiAuthHeader,
              'Content-Type': 'application/json'
            }
          });

          finalResult = pollResponse.data;
          status = finalResult.status;

          if (status === 'failed' || status === 'cancelled') {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: '生成失敗', details: finalResult }));
          }
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          video_url: finalResult.video_url || (finalResult.output && finalResult.output.video_url) || finalResult.result
        }));

      } catch (err) {
        console.error('Processing error:', err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: '內部伺服器錯誤', details: err.message }));
      }
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not Found');
});

server.listen(PORT, () => {
  console.log(`🚀 伺服器已啟動: http://localhost:${PORT}`);
});