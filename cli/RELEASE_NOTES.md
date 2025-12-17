# jrok CLI v1.0.0 - Release Notes

## 🎉 What is jrok?

jrok is a secure reverse proxy CLI tool that exposes your local services (ports, Docker, Kubernetes) to the internet with automatic HTTPS.

Think **ngrok** or **localtunnel**, but self-hosted with support for Docker Swarm and Kubernetes!

## 📦 Download

Choose the binary for your platform:

### Linux (x86_64)
```bash
wget https://github.com/koompi/jrok/releases/download/v1.0.0/jrok-linux-x64
chmod +x jrok-linux-x64
sudo mv jrok-linux-x64 /usr/local/bin/jrok
```

### macOS (x86_64 / Intel)
```bash
curl -L https://github.com/koompi/jrok/releases/download/v1.0.0/jrok-macos-x64 -o jrok
chmod +x jrok
sudo mv jrok /usr/local/bin/jrok
```

### Windows (x86_64)
Download: [jrok-windows-x64.exe](https://github.com/koompi/jrok/releases/download/v1.0.0/jrok-windows-x64.exe)

Add to PATH or run directly

### NPM (All Platforms)
```bash
npm install -g jrok
```

## 🚀 Quick Start

### 1. Expose a Local Port

```bash
# Start your app on localhost:3000
npm run dev

# Expose it to the internet
jrok connect \
  --server https://tunnel.koompi.cloud \
  --domain myapp \
  --port 3000 \
  --auth your-api-key
```

Now accessible at: `https://myapp.tunnel.koompi.cloud`

### 2. Docker Service

```bash
jrok connect \
  --server https://tunnel.koompi.cloud \
  --domain api \
  --docker-service my-service \
  --auth your-api-key
```

### 3. Kubernetes Service

```bash
jrok connect \
  --server https://tunnel.koompi.cloud \
  --domain app \
  --k8s-service web-service:8080 \
  --auth your-api-key
```

## ✨ Features

- ✅ **Zero Installation** - Standalone binaries, no dependencies
- ✅ **TCP Port Forwarding** - Expose any local port
- ✅ **Docker Swarm** - Load-balanced container services
- ✅ **Kubernetes** - Native K8s service integration
- ✅ **Auto-Reconnect** - Resilient connections with retry
- ✅ **HTTPS Automatic** - SSL certificates managed automatically
- ✅ **Cross-Platform** - Linux, macOS, Windows
- ✅ **Lightweight** - Single ~50MB binary

## 📚 Commands

```bash
# Connect and expose
jrok connect --server <url> --domain <name> --port <port> --auth <key>

# List connected services
jrok list --server <url> --auth <key>

# Disconnect
jrok disconnect --server <url> --domain <name> --auth <key>

# Show version
jrok version

# Show help
jrok help
```

## 🔧 Environment Variables

```bash
export JROK_SERVER=https://tunnel.koompi.cloud
export JROK_AUTH=your-api-key
export JROK_DOMAIN=myapp
export JROK_PORT=3000

jrok connect  # Uses env vars
```

## 📖 Use Cases

1. **Local Development** - Share your dev server with colleagues
2. **Webhook Testing** - Test webhooks from GitHub, Stripe, etc.
3. **Client Demos** - Show off your work without deploying
4. **IoT Devices** - Expose devices behind NAT/firewall
5. **Docker Services** - Load-balanced multi-replica services
6. **K8s Apps** - Expose Kubernetes deployments

## 📦 Binary Information

| Platform | File | Size | SHA256 |
|----------|------|------|--------|
| Linux x64 | jrok-linux-x64 | ~50MB | (see checksums.txt) |
| macOS x64 | jrok-macos-x64 | ~50MB | (see checksums.txt) |
| Windows x64 | jrok-windows-x64.exe | ~50MB | (see checksums.txt) |

## 🔐 Security

- Outbound connection only (no inbound ports needed)
- Works behind NAT/firewall
- API token authentication
- HTTPS termination at reverse proxy server

## 📝 Documentation

- [Full Guide](https://github.com/koompi/jrok/blob/main/CLIENT_GUIDE.md)
- [Quick Reference](https://github.com/koompi/jrok/blob/main/CLIENT_QUICK_REFERENCE.md)
- [Docker/K8s Setup](https://github.com/koompi/jrok/blob/main/DOCKER_KUBERNETES_SETUP.md)

## 🐛 Known Issues

None reported yet!

## 🙏 Support

- **Issues:** https://github.com/koompi/jrok/issues
- **Server:** https://tunnel.koompi.cloud
- **Repository:** https://github.com/koompi/jrok

## 📜 License

MIT License - see [LICENSE](https://github.com/koompi/jrok/blob/main/LICENSE) for details

---

**Happy tunneling! 🚀**
