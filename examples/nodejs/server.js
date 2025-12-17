const http = require('http');

const PORT = process.env.PORT || 3000;

const server = http.createServer((req, res) => {
  // Health check endpoint
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'healthy', timestamp: new Date().toISOString() }));
    return;
  }

  // Home page
  if (req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`
      <!DOCTYPE html>
      <html>
        <head>
          <title>Hello World - Jrok test</title>
          <style>
            body { font-family: Arial, sans-serif; max-width: 800px; margin: 50px auto; }
            .container { background: #f0f0f0; padding: 20px; border-radius: 5px; }
            h1 { color: #333; }
            p { color: #666; }
            .info { background: white; padding: 10px; border-left: 4px solid #007bff; margin: 10px 0; }
          </style>
        </head>
        <body>
          <div class="container">
            <h1>🚀 Hello World - jrok Agent Test</h1>
            <p>Your app is working and accessible through the reverse proxy!</p>
            
            <div class="info">
              <strong>Server Info:</strong>
              <ul>
                <li>Port: ${PORT}</li>
                <li>Time: ${new Date().toLocaleString()}</li>
                <li>Node.js: ${process.version}</li>
              </ul>
            </div>

            <div class="info">
              <strong>Available Endpoints:</strong>
              <ul>
                <li><code>GET /</code> - This page</li>
                <li><code>GET /health</code> - Health check (JSON)</li>
                <li><code>GET /api/info</code> - API info</li>
              </ul>
            </div>

            <div class="info">
              <strong>To access this app through jrok:</strong>
              <pre>bun client.ts connect \\
  --server https://tunnel.koompi.cloud \\
  --domain myapp.tunnel.koompi.cloud \\
  --port 3000 \\
  --auth YOUR_API_KEY</pre>
            </div>
          </div>
        </body>
      </html>
    `);
    return;
  }

  // API endpoint
  if (req.url === '/api/info') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      app: 'jrok-test',
      version: '1.0.0',
      port: PORT,
      timestamp: new Date().toISOString(),
      message: 'Hello from jrok agent test!'
    }));
    return;
  }

  // 404
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not Found', path: req.url }));
});

server.listen(PORT, () => {
  console.log(`🚀 Server running at http://localhost:${PORT}`);
  console.log(`📝 Available endpoints:`);
  console.log(`   GET  /           - HTML page`);
  console.log(`   GET  /health     - Health check`);
  console.log(`   GET  /api/info   - API info`);
});
