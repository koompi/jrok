//! One tunnel: a connection to its edge (or the server's name), kept up with
//! the jrok CLI's rules: a heartbeat every 15 s, a ping every 30 s, a watchdog
//! that drops a link silent for 75 s (half-open), and equal-jitter backoff from
//! 1 s to 30 s between attempts.

use crate::args::TunnelConfig;
use crate::output::Output;
use futures_util::{SinkExt, StreamExt};
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::net::TcpStream;
use tokio::sync::mpsc;
use tokio::time::{interval_at, sleep, timeout};
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};
use tokio_util::sync::CancellationToken;

const HEARTBEAT: Duration = Duration::from_secs(15);
const PING: Duration = Duration::from_secs(30);
const WATCHDOG: Duration = Duration::from_secs(15);
const DEAD_AFTER: Duration = Duration::from_secs(75);
const RECONNECT_BASE_MS: u64 = 1_000;
const RECONNECT_MAX_MS: u64 = 30_000;

/// One live connection to the server, shared by everything serving through it.
pub struct Conn {
    pub cfg: Arc<TunnelConfig>,
    pub out: Output,
    tx: mpsc::Sender<Message>,
    features: Mutex<HashSet<String>>,
    pub http_aborts: Mutex<HashMap<String, CancellationToken>>,
    pub ws_conns: Mutex<HashMap<String, mpsc::Sender<crate::ws::ToLocal>>>,
    pub tcp_conns: Mutex<HashMap<String, crate::tcp::Local>>,
    /// Cancelled when the connection ends: everything relayed through it stops.
    pub closed: CancellationToken,
}

impl Conn {
    pub fn has(&self, feature: &str) -> bool {
        self.features.lock().unwrap().contains(feature)
    }

    /// Queue a message for the server. Waits while the link is backed up
    /// (bounded queue), which is what slows a fast local app down.
    pub async fn send_json(&self, value: serde_json::Value) {
        let _ = self.tx.send(Message::Text(value.to_string())).await;
    }

    pub async fn send_binary(&self, bytes: Vec<u8>) {
        let _ = self.tx.send(Message::Binary(bytes)).await;
    }
}

/// The CLI's delay: half fixed, half random, so a fleet doesn't return together.
fn reconnect_delay(attempt: u32) -> Duration {
    let capped = (RECONNECT_BASE_MS << attempt.saturating_sub(1).min(16)).min(RECONNECT_MAX_MS);
    let half = capped / 2;
    Duration::from_millis(half + rand::random::<u64>() % (half + 1))
}

/// Keep the tunnel up until `stop`.
pub async fn run(cfg: TunnelConfig, out: Output, stop: CancellationToken) {
    let cfg = Arc::new(cfg);
    let mut attempt: u32 = 0;
    // A TCP tunnel's port lives on one edge; the server names it when this
    // connection reached another (tcp_port_elsewhere). Dropped if it can't be
    // reached, so a dead edge can't strand the tunnel.
    let mut edge_hint: Option<String> = None;
    loop {
        if stop.is_cancelled() {
            return;
        }
        let edge = edge_hint.clone().or_else(|| cfg.edge.clone());
        let opened = serve(&cfg, &out, &stop, edge.as_deref(), &mut edge_hint).await;
        if stop.is_cancelled() {
            return;
        }
        if !opened && edge.is_some() && edge == edge_hint {
            edge_hint = None;
        }
        attempt = if opened { 1 } else { attempt + 1 };
        let delay = reconnect_delay(attempt);
        out.out(format!("🔄 Attempting to reconnect in {:.1}s (attempt {attempt})...", delay.as_secs_f64()));
        tokio::select! {
            _ = sleep(delay) => {}
            _ = stop.cancelled() => return,
        }
    }
}

async fn connect(cfg: &TunnelConfig, target: &str) -> Result<WebSocketStream<MaybeTlsStream<TcpStream>>, String> {
    let url = cfg.agent_url();
    let mut request = url.as_str().into_client_request().map_err(|e| e.to_string())?;
    request.headers_mut().insert(
        "authorization",
        format!("Bearer {}", cfg.auth).parse().map_err(|_| "invalid API key".to_string())?,
    );
    // --edge: connect there; TLS (SNI) and Host stay on the server's name.
    let stream = TcpStream::connect(format!("{target}:{}", cfg.server_port))
        .await
        .map_err(|e| format!("{target}: {e}"))?;
    let _ = stream.set_nodelay(true);
    let mut config = WebSocketConfig::default();
    config.max_message_size = Some(256 << 20);
    config.max_frame_size = None;
    config.write_buffer_size = 0;
    let (ws, _) = tokio_tungstenite::client_async_tls_with_config(request, stream, Some(config), None)
        .await
        .map_err(|e| match e {
            tokio_tungstenite::tungstenite::Error::Http(res) => {
                let body = res.body().as_ref().map(|b| String::from_utf8_lossy(b).to_string()).unwrap_or_default();
                format!("Unexpected server response: {} {}", res.status().as_u16(), body.trim())
            }
            other => other.to_string(),
        })?;
    Ok(ws)
}

/// One connection, until it ends. True if it opened.
async fn serve(
    cfg: &Arc<TunnelConfig>,
    out: &Output,
    stop: &CancellationToken,
    edge: Option<&str>,
    edge_hint: &mut Option<String>,
) -> bool {
    let target = edge.unwrap_or(&cfg.server_host).to_string();
    let attempt = tokio::select! {
        _ = stop.cancelled() => return false,
        attempt = timeout(Duration::from_secs(20), connect(cfg, &target)) => attempt,
    };
    let ws = match attempt {
        Ok(Ok(ws)) => ws,
        Ok(Err(e)) => {
            out.err(format!("❌ Connection error: {e}"));
            return false;
        }
        Err(_) => {
            out.err(format!("❌ Connection error: {target}: timed out"));
            return false;
        }
    };
    out.out(format!("✅ Connected to server! ({} via {target})", cfg.domain));

    let (mut sink, mut stream) = ws.split();
    let (tx, mut rx) = mpsc::channel::<Message>(1024);
    let closed = CancellationToken::new();
    let conn = Arc::new(Conn {
        cfg: cfg.clone(),
        out: out.clone(),
        tx,
        features: Mutex::new(HashSet::new()),
        http_aborts: Mutex::new(HashMap::new()),
        ws_conns: Mutex::new(HashMap::new()),
        tcp_conns: Mutex::new(HashMap::new()),
        closed: closed.clone(),
    });

    let writer_closed = closed.clone();
    let writer = tokio::spawn(async move {
        loop {
            tokio::select! {
                message = rx.recv() => match message {
                    Some(m) => if sink.send(m).await.is_err() { break },
                    None => break,
                },
                _ = writer_closed.cancelled() => break,
            }
        }
        let _ = sink.close().await;
    });

    let start = tokio::time::Instant::now();
    let mut heartbeat = interval_at(start + HEARTBEAT, HEARTBEAT);
    let mut ping = interval_at(start + PING, PING);
    let mut watchdog = interval_at(start + WATCHDOG, WATCHDOG);
    let mut last_inbound = Instant::now();

    loop {
        tokio::select! {
            _ = stop.cancelled() => break,
            message = stream.next() => match message {
                Some(Ok(m)) => {
                    last_inbound = Instant::now();
                    match m {
                        Message::Text(text) => dispatch(&conn, &text, edge_hint),
                        Message::Close(_) => break,
                        _ => {}
                    }
                }
                Some(Err(e)) => {
                    out.err(format!("❌ Connection error: {e}"));
                    break;
                }
                None => break,
            },
            _ = heartbeat.tick() => conn.send_json(serde_json::json!({ "type": "heartbeat" })).await,
            _ = ping.tick() => { let _ = conn.tx.send(Message::Ping(Vec::new())).await; }
            _ = watchdog.tick() => {
                if last_inbound.elapsed() > DEAD_AFTER {
                    out.err(format!("⚠️  No response from server for {}s — connection is dead, forcing reconnect", last_inbound.elapsed().as_secs()));
                    break;
                }
            }
        }
    }

    // Everything relayed through this connection ends with it.
    closed.cancel();
    for (_, abort) in conn.http_aborts.lock().unwrap().drain() {
        abort.cancel();
    }
    conn.ws_conns.lock().unwrap().clear();
    conn.tcp_conns.lock().unwrap().clear();
    let _ = timeout(Duration::from_secs(2), writer).await;
    out.out("🔌 Disconnected from server");
    true
}

/// One message from the server. Anything that can take a while runs in its own task.
fn dispatch(conn: &Arc<Conn>, text: &str, edge_hint: &mut Option<String>) {
    let Ok(message) = serde_json::from_str::<serde_json::Value>(text) else {
        conn.out.err(format!("Failed to parse message: {}", text.chars().take(200).collect::<String>()));
        return;
    };
    match message["type"].as_str().unwrap_or_default() {
        "welcome" => welcome(conn, &message),
        "heartbeat_ack" => {}
        "http_request" => {
            let conn = conn.clone();
            tokio::spawn(async move { crate::http::handle(conn, message).await });
        }
        "http_response_abort" => {
            if let Some(id) = message["requestId"].as_str() {
                if let Some(abort) = conn.http_aborts.lock().unwrap().remove(id) {
                    abort.cancel();
                }
            }
        }
        "ws_connect" => crate::ws::connect(conn.clone(), &message),
        "ws_message" => crate::ws::message(conn, &message),
        "ws_close" => crate::ws::close(conn, &message),
        "tcp_connect" => crate::tcp::connect(conn.clone(), &message),
        "tcp_data" => crate::tcp::data(conn, &message),
        "tcp_close" => crate::tcp::close(conn, &message),
        "status" => conn.out.out(format!("📊 Status: {}", message["message"].as_str().unwrap_or_default())),
        "error" if message["code"] == "tcp_port_elsewhere" && message["edge"].is_string() => {
            *edge_hint = message["edge"].as_str().map(String::from);
            conn.out.out(format!("🛰️  {}", message["message"].as_str().unwrap_or_default()));
        }
        _ => conn.out.out(format!("📨 Server message: {message}")),
    }
}

fn welcome(conn: &Arc<Conn>, message: &serde_json::Value) {
    if let Some(features) = message["features"].as_array() {
        let mut set = conn.features.lock().unwrap();
        set.clear();
        set.extend(features.iter().filter_map(|f| f.as_str().map(String::from)));
    }
    if let Some(text) = message["message"].as_str() {
        conn.out.out(format!("✨ {text}"));
    }
    if let Some(agent_id) = message["agentId"].as_str() {
        conn.out.out(format!("🆔 Agent ID: {agent_id}"));
    }
    // TCP: the port this tunnel got, on the host it listens on. The worker
    // records it as the customer's database/SSH address.
    if let Some(port) = message["tcpPort"].as_u64() {
        let host = message["tcpHost"].as_str().unwrap_or(&conn.cfg.server_host).to_string();
        conn.out.event("tcp", serde_json::json!({ "port": port, "host": host }));
        conn.out.out(format!("📡 Connect to: {host}:{port}"));
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn backoff_stays_within_the_cli_bounds() {
        for attempt in 1..20 {
            let d = super::reconnect_delay(attempt).as_millis() as u64;
            let capped = (1_000u64 << (attempt - 1).min(16)).min(30_000);
            assert!(d >= capped / 2 && d <= capped, "attempt {attempt}: {d}");
        }
    }
}
