# Jrok WebSocket Example

This example demonstrates the WebSocket support introduced in Jrok v2.4.0. It creates a simple Node.js server that handles both HTTP requests and WebSocket connections on the same port.

## Prerequisites

- Node.js installed
- Jrok CLI installed

## Setup

1. Install dependencies:
   ```bash
   npm install
   ```

2. Start the server:
   ```bash
   npm start
   ```
   The server will start on port 3000 by default.

## Testing with Jrok

1. In a separate terminal, start a Jrok tunnel to your local server:
   ```bash
   jrok http 3000
   ```

2. Open the provided public URL (e.g., `https://your-subdomain.jrok.app`) in your browser.

3. You should see the "Jrok WebSocket Test" interface. The status should automatically change to "Connected".

4. Type a message and click "Send". You should receive an echo response from the server, confirming that WebSocket traffic is being correctly tunneled through Jrok.

## How it works

The `server.js` creates a standard Node.js HTTP server and attaches a `ws` WebSocket server to it. When Jrok tunnels traffic to localhost:3000, it handles the HTTP Upgrade headers required for WebSockets, allowing the connection to be established through the tunnel.

The client-side code automatically detects whether the page is loaded via HTTPS or HTTP and selects the appropriate WebSocket protocol (`wss://` or `ws://`).
