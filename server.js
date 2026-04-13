const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = 3000;
const API_BASE = 'https://fehv4ypgzt.us-east-1.awsapprunner.com';

const MIME_TYPES = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function serveStatic(req, res) {
  let filePath = path.join(__dirname, req.url === '/' ? 'index.html' : req.url);
  const ext = path.extname(filePath);

  if (!fs.existsSync(filePath)) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
    return;
  }

  const contentType = MIME_TYPES[ext] || 'application/octet-stream';
  const content = fs.readFileSync(filePath);
  res.writeHead(200, { 'Content-Type': contentType });
  res.end(content);
}

function proxyToApi(req, res) {
  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', () => {
    const targetUrl = `${API_BASE}${req.url}`;
    const parsed = new URL(targetUrl);

    const headers = { ...req.headers, host: parsed.host };
    delete headers['origin'];
    delete headers['referer'];

    const proxyReq = https.request({
      hostname: parsed.hostname,
      port: 443,
      path: parsed.pathname + parsed.search,
      method: req.method,
      headers,
    }, proxyRes => {
      const responseHeaders = { ...proxyRes.headers };
      responseHeaders['access-control-allow-origin'] = '*';
      responseHeaders['access-control-allow-methods'] = 'GET, POST, OPTIONS';
      responseHeaders['access-control-allow-headers'] = 'Content-Type, x-api-key';

      res.writeHead(proxyRes.statusCode, responseHeaders);
      proxyRes.pipe(res);
    });

    proxyReq.on('error', err => {
      console.error('Proxy error:', err.message);
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Proxy error', message: err.message }));
    });

    if (body) proxyReq.write(body);
    proxyReq.end();
  });
}

const server = http.createServer((req, res) => {
  const parsed = url.parse(req.url);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, x-api-key',
    });
    res.end();
    return;
  }

  if (parsed.pathname.startsWith('/v1/') || parsed.pathname.startsWith('/api/')) {
    proxyToApi(req, res);
  } else {
    serveStatic(req, res);
  }
});

server.listen(PORT, () => {
  console.log(`AP Exam Prep running at http://localhost:${PORT}`);
});
