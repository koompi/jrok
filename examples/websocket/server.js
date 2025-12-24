const http = require('http');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;

// Create HTTP server
const server = http.createServer((req, res) => {
  // Serve the HTML client
  if (req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`
<!DOCTYPE html>
<html>
<head>
    <title>Jrok WebSocket Test</title>
    <style>
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; max-width: 800px; margin: 0 auto; padding: 20px; line-height: 1.6; }
        .container { background: #f9f9f9; padding: 20px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
        h1 { color: #2c3e50; margin-top: 0; }
        #status { padding: 10px; border-radius: 4px; margin-bottom: 20px; font-weight: bold; text-align: center; }
        .connected { background-color: #d4edda; color: #155724; }
        .disconnected { background-color: #f8d7da; color: #721c24; }
        .connecting { background-color: #fff3cd; color: #856404; }
        #messages { height: 300px; overflow-y: auto; border: 1px solid #ddd; padding: 10px; background: white; margin-bottom: 20px; border-radius: 4px; }
        .message { margin-bottom: 5px; padding: 5px; border-bottom: 1px solid #eee; }
        .message.sent { color: #0056b3; text-align: right; }
        .message.received { color: #28a745; }
        .message.system { color: #6c757d; font-style: italic; text-align: center; font-size: 0.9em; }
        .controls { display: flex; gap: 10px; }
        input[type="text"] { flex-grow: 1; padding: 10px; border: 1px solid #ddd; border-radius: 4px; }
        button { padding: 10px 20px; background-color: #007bff; color: white; border: none; border-radius: 4px; cursor: pointer; }
        button:hover { background-color: #0056b3; }
        button:disabled { background-color: #ccc; cursor: not-allowed; }
    </style>
</head>
<body>
    <div class="container">
        <h1>🔌 Jrok WebSocket Test</h1>
        <p>This example demonstrates WebSocket support in Jrok v2.4.0.</p>
        
        <div id="status" class="disconnected">Disconnected</div>
        
        <div id="messages"></div>
        
        <div class="controls">
            <input type="text" id="messageInput" placeholder="Type a message..." disabled>
            <button id="sendBtn" disabled>Send</button>
        </div>
    </div>

    <script>
        const statusEl = document.getElementById('status');
        const messagesEl = document.getElementById('messages');
        const inputEl = document.getElementById('messageInput');
        const sendBtn = document.getElementById('sendBtn');
        
        let ws;

        function connect() {
            // Determine protocol (ws or wss) based on current page protocol
            const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
            const wsUrl = protocol + '//' + window.location.host;
            
            addMessage('system', 'Connecting to ' + wsUrl + '...');
            statusEl.textContent = 'Connecting...';
            statusEl.className = 'connecting';

            ws = new WebSocket(wsUrl);

            ws.onopen = () => {
                statusEl.textContent = 'Connected';
                statusEl.className = 'connected';
                inputEl.disabled = false;
                sendBtn.disabled = false;
                addMessage('system', 'Connection established!');
                
                // Send a ping
                ws.send(JSON.stringify({ type: 'ping', timestamp: Date.now() }));
            };

            ws.onmessage = async (event) => {
                try {
                    // Handle Blob data if received
                    let messageData = event.data;
                    if (messageData instanceof Blob) {
                        messageData = await messageData.text();
                    }
                    
                    const data = JSON.parse(messageData);
                    if (data.type === 'pong') {
                        const latency = Date.now() - data.timestamp;
                        addMessage('system', 'Pong received! Latency: ' + latency + 'ms');
                    } else if (data.type === 'message') {
                        addMessage('received', 'Server: ' + data.content);
                    } else if (data.type === 'broadcast') {
                        addMessage('received', 'Broadcast: ' + data.content);
                    }
                } catch (e) {
                    console.error('Error parsing message:', e);
                    addMessage('received', String(event.data));
                }
            };

            ws.onclose = () => {
                statusEl.textContent = 'Disconnected';
                statusEl.className = 'disconnected';
                inputEl.disabled = true;
                sendBtn.disabled = true;
                addMessage('system', 'Connection closed. Retrying in 3s...');
                setTimeout(connect, 3000);
            };

            ws.onerror = (error) => {
                console.error('WebSocket error:', error);
                addMessage('system', 'WebSocket error occurred');
            };
        }

        function sendMessage() {
            const content = inputEl.value.trim();
            if (content && ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'message', content }));
                addMessage('sent', 'You: ' + content);
                inputEl.value = '';
            }
        }

        function addMessage(type, text) {
            const div = document.createElement('div');
            div.className = 'message ' + type;
            div.textContent = text;
            messagesEl.appendChild(div);
            messagesEl.scrollTop = messagesEl.scrollHeight;
        }

        sendBtn.addEventListener('click', sendMessage);
        inputEl.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') sendMessage();
        });

        // Start connection
        connect();
    </script>
</body>
</html>
    `);
    return;
  }

  // Health check
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
    return;
  }

  res.writeHead(404);
  res.end();
});

// Create WebSocket server attached to HTTP server
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws, req) => {
  const ip = req.socket.remoteAddress;
  console.log(`New client connected from ${ip}`);

  // Send welcome message
  ws.send(JSON.stringify({ 
    type: 'message', 
    content: 'Welcome to Jrok WebSocket Server! Echo service is active.' 
  }));

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      console.log('Received:', data);

      if (data.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong', timestamp: data.timestamp }));
      } else if (data.type === 'message') {
        // Echo back
        ws.send(JSON.stringify({ 
          type: 'message', 
          content: `Echo: ${data.content}` 
        }));
        
        // Broadcast to others (optional, for demo)
        wss.clients.forEach(client => {
          if (client !== ws && client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({
              type: 'broadcast',
              content: `Someone said: ${data.content}`
            }));
          }
        });
      }
    } catch (e) {
      console.log('Received raw message:', message.toString());
      ws.send(JSON.stringify({ type: 'message', content: `Echo raw: ${message}` }));
    }
  });

  ws.on('close', () => {
    console.log('Client disconnected');
  });
});

server.listen(PORT, () => {
  console.log(`WebSocket example server listening on port ${PORT}`);
});
