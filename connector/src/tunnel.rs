//! One tunnel: a connection to its edge (or the server's name), kept up with
//! the jrok CLI's rules: a heartbeat every 15 s, a ping every 30 s, a watchdog
//! that drops a link silent for 75 s (half-open), and equal-jitter backoff from
//! 1 s to 30 s between attempts.
//!
//! What waits for the edge is bounded by bytes (8 MB, the CLI's
//! WS_BACKPRESSURE_LIMIT): a relay with more to send waits for room, which is
//! what slows a fast local app down. The control loop never waits for room, so
//! it always sees a stop, the watchdog and the edge's messages. A message the
//! edge doesn't take in 30 s (an edge that stopped reading) ends the
//! connection, and the kernel gives up on a link whose data goes unacknowledged
//! for a minute (TCP_USER_TIMEOUT).
//!
//! The other way, a TCP tunnel pushes back: while more than 8 MB waits for its
//! local services, its link isn't read (until below 4 MB), so the edge's
//! buffer toward us fills and the edge pauses the customer's socket. A pause
//! is ours, not the edge's silence: the watchdog doesn't count it, and
//! heartbeats go on.

use crate::args::TunnelConfig;
use crate::output::Output;
use futures_util::{Sink, SinkExt, StreamExt};
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::net::TcpStream;
use tokio::sync::{mpsc, Notify, OwnedSemaphorePermit, Semaphore};
use tokio::time::{interval_at, sleep, timeout};
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};
use tokio_util::sync::CancellationToken;

/// What may wait for the edge, in bytes (the CLI's WS_BACKPRESSURE_LIMIT).
pub const QUEUE_BYTES: usize = 8 << 20;
/// Data the edge doesn't acknowledge this long ends the connection
/// (TCP_USER_TIMEOUT): it is gone, or stopped reading.
const EDGE_USER_TIMEOUT: Duration = Duration::from_secs(60);
/// Bytes waiting for a tunnel's TCP services above which its link isn't
/// read, and below which it is again.
const TCP_HIGH_WATER: usize = 8 << 20;
const TCP_LOW_WATER: usize = 4 << 20;

/// Across the process, for control mode's stats: tunnels running, tunnels
/// whose link the server welcomed, and bytes waiting for the edges.
pub static RUNNING: AtomicUsize = AtomicUsize::new(0);
pub static CONNECTED: AtomicUsize = AtomicUsize::new(0);
pub static QUEUED_BYTES: AtomicUsize = AtomicUsize::new(0);

/// `n` in a count while held (also when a panic unwinds).
struct Counted(&'static AtomicUsize, usize);

impl Counted {
    fn new(counter: &'static AtomicUsize, n: usize) -> Counted {
        counter.fetch_add(n, Ordering::Relaxed);
        Counted(counter, n)
    }
}

impl Drop for Counted {
    fn drop(&mut self) {
        self.0.fetch_sub(self.1, Ordering::Relaxed);
    }
}

/// How a tunnel paces itself. Tests shorten these.
#[derive(Clone, Copy, Debug)]
pub struct Timing {
    pub heartbeat: Duration,
    pub ping: Duration,
    pub watchdog: Duration,
    /// Nothing from the edge this long: the link is dead (half-open).
    pub dead_after: Duration,
    /// A message the edge doesn't take this long, plus a second per 64 KB of
    /// it: the edge stopped reading.
    pub write_stall: Duration,
    /// Backoff between attempts: from the base, doubling, up to the max.
    pub reconnect_base: Duration,
    pub reconnect_max: Duration,
    /// A link that stayed up this long after its welcome was a good one: the
    /// backoff starts over.
    pub stable_after: Duration,
}

impl Timing {
    pub const DEFAULT: Timing = Timing {
        heartbeat: Duration::from_secs(15),
        ping: Duration::from_secs(30),
        watchdog: Duration::from_secs(15),
        dead_after: Duration::from_secs(75),
        write_stall: Duration::from_secs(30),
        reconnect_base: Duration::from_secs(1),
        reconnect_max: Duration::from_secs(30),
        stable_after: Duration::from_secs(30),
    };

    fn write_limit(&self, bytes: usize) -> Duration {
        self.write_stall + Duration::from_millis(bytes as u64 / 64)
    }
}

/// A message for the edge, holding its room in the queue until it is sent.
pub struct Outbound {
    pub message: Message,
    _room: Option<OwnedSemaphorePermit>,
    _queued: Counted,
}

/// One live connection to the server, shared by everything serving through it.
pub struct Conn {
    pub cfg: Arc<TunnelConfig>,
    pub out: Output,
    tx: mpsc::UnboundedSender<Outbound>,
    /// Room for what waits for the edge, in bytes (QUEUE_BYTES).
    room: Arc<Semaphore>,
    features: Mutex<HashSet<String>>,
    pub http_aborts: Mutex<HashMap<String, CancellationToken>>,
    pub ws_conns: Mutex<HashMap<String, crate::ws::Entry>>,
    pub tcp_conns: Mutex<HashMap<String, crate::tcp::Local>>,
    /// Bytes from the edge waiting for this tunnel's TCP services (tcp.rs).
    tcp_backlog: AtomicUsize,
    /// Told when the backlog falls below TCP_LOW_WATER.
    tcp_drained: Notify,
    /// Cancelled when the connection ends: everything relayed through it stops.
    pub closed: CancellationToken,
}

impl Conn {
    fn new(cfg: Arc<TunnelConfig>, out: Output) -> (Arc<Conn>, mpsc::UnboundedReceiver<Outbound>) {
        let (tx, rx) = mpsc::unbounded_channel();
        let conn = Arc::new(Conn {
            cfg,
            out,
            tx,
            room: Arc::new(Semaphore::new(QUEUE_BYTES)),
            features: Mutex::new(HashSet::new()),
            http_aborts: Mutex::new(HashMap::new()),
            ws_conns: Mutex::new(HashMap::new()),
            tcp_conns: Mutex::new(HashMap::new()),
            tcp_backlog: AtomicUsize::new(0),
            tcp_drained: Notify::new(),
            closed: CancellationToken::new(),
        });
        (conn, rx)
    }

    /// `bytes` more wait for a TCP service. Counted before they can be
    /// written, so the count never goes below zero.
    pub fn tcp_queued(&self, bytes: usize) {
        self.tcp_backlog.fetch_add(bytes, Ordering::SeqCst);
    }

    /// `bytes` left the queue for a TCP service (written, or never will be).
    pub fn tcp_written(&self, bytes: usize) {
        let before = self.tcp_backlog.fetch_sub(bytes, Ordering::SeqCst);
        if before >= TCP_LOW_WATER && before - bytes < TCP_LOW_WATER {
            self.tcp_drained.notify_one();
        }
    }

    pub(crate) fn tcp_backlog(&self) -> usize {
        self.tcp_backlog.load(Ordering::SeqCst)
    }

    pub fn has(&self, feature: &str) -> bool {
        self.features.lock().unwrap().contains(feature)
    }

    /// Queue a message for the server. Waits while the queue is full, which is
    /// what slows a fast local app down. False once the connection is gone.
    pub async fn send_json(&self, value: serde_json::Value) -> bool {
        self.queue(Message::Text(value.to_string())).await
    }

    pub async fn send_binary(&self, bytes: Vec<u8>) -> bool {
        self.queue(Message::Binary(bytes)).await
    }

    /// A small message that must not wait (heartbeat, ping, a close): queued
    /// at once, outside the byte budget.
    pub fn send_now(&self, message: Message) {
        let _queued = Counted::new(&QUEUED_BYTES, message.len());
        let _ = self.tx.send(Outbound { message, _room: None, _queued });
    }

    async fn queue(&self, message: Message) -> bool {
        let len = message.len();
        let bytes = len.clamp(1, QUEUE_BYTES) as u32;
        let room = tokio::select! {
            biased;
            _ = self.closed.cancelled() => return false,
            room = self.room.clone().acquire_many_owned(bytes) => match room {
                Ok(room) => room,
                Err(_) => return false,
            },
        };
        let _queued = Counted::new(&QUEUED_BYTES, len);
        self.tx.send(Outbound { message, _room: Some(room), _queued }).is_ok()
    }
}

/// The CLI's delay: half fixed, half random, so a fleet doesn't return together.
fn reconnect_delay(attempt: u32, timing: &Timing) -> Duration {
    let base = timing.reconnect_base.as_millis() as u64;
    let capped = (base << attempt.saturating_sub(1).min(16)).min(timing.reconnect_max.as_millis() as u64);
    let half = capped / 2;
    Duration::from_millis(half + rand::random::<u64>() % (half + 1))
}

/// Keep the tunnel up until `stop`.
pub async fn run(cfg: TunnelConfig, out: Output, stop: CancellationToken) {
    run_with(cfg, out, stop, Timing::DEFAULT).await
}

pub async fn run_with(cfg: TunnelConfig, out: Output, stop: CancellationToken, timing: Timing) {
    let _running = Counted::new(&RUNNING, 1);
    let cfg = Arc::new(cfg);
    let mut attempt: u32 = 0;
    // A TCP tunnel's port lives on one edge; the server names it when this
    // connection reached another (tcp_port_elsewhere). Dropped if it can't be
    // reached, so a dead edge can't strand the tunnel.
    let mut edge_hint: Option<String> = None;
    let mut redirected_before = false;
    loop {
        if stop.is_cancelled() {
            return;
        }
        let edge = edge_hint.clone().or_else(|| cfg.edge.clone());
        let hint_before = edge_hint.clone();
        let served = serve(&cfg, &out, &stop, edge.as_deref(), &mut edge_hint, &timing).await;
        if stop.is_cancelled() {
            return;
        }
        if !served.opened && edge.is_some() && edge == edge_hint {
            edge_hint = None;
        }
        // The backoff starts over only after a link that held: welcomed, and
        // up a while. An edge that takes the connection and then refuses the
        // tunnel (a registration error) had it back every second otherwise.
        // Sent to the edge holding a TCP port: go at once, unless that was
        // also what happened last time (edges that disagree).
        let redirected = edge_hint.is_some() && edge_hint != hint_before;
        let held = served.welcomed_for.is_some_and(|up| up >= timing.stable_after);
        attempt = if held || (redirected && !redirected_before) { 1 } else { attempt + 1 };
        redirected_before = redirected;
        let delay = reconnect_delay(attempt, &timing);
        out.out(format!("🔄 Attempting to reconnect in {:.1}s (attempt {attempt})...", delay.as_secs_f64()));
        tokio::select! {
            _ = sleep(delay) => {}
            _ = stop.cancelled() => return,
        }
    }
}

/// The link to the edge: no Nagle; keepalive, so a dead link is found even
/// when idle; and TCP_USER_TIMEOUT, so data the edge doesn't acknowledge (it
/// is gone, or stopped reading) ends the connection in a minute, not the
/// kernel's fifteen.
fn tune_edge_socket(stream: &TcpStream) {
    let _ = stream.set_nodelay(true);
    let socket = socket2::SockRef::from(stream);
    let keepalive = socket2::TcpKeepalive::new()
        .with_time(Duration::from_secs(30))
        .with_interval(Duration::from_secs(10));
    let _ = socket.set_tcp_keepalive(&keepalive);
    #[cfg(any(target_os = "linux", target_os = "android"))]
    let _ = socket.set_tcp_user_timeout(Some(EDGE_USER_TIMEOUT));
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
    tune_edge_socket(&stream);
    let config = WebSocketConfig {
        max_message_size: Some(256 << 20),
        max_frame_size: None,
        write_buffer_size: 0,
        ..WebSocketConfig::default()
    };
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

/// Send what is queued for the edge, in order, until the connection ends. A
/// message the edge doesn't take in time means it stopped reading: the
/// connection is closed (`closed`), so the tunnel reconnects instead of
/// waiting on it.
async fn write_to_edge<S>(mut sink: S, mut rx: mpsc::UnboundedReceiver<Outbound>, closed: CancellationToken, timing: Timing, out: Output)
where
    S: Sink<Message> + Unpin,
{
    let mut stalled = false;
    loop {
        let next = tokio::select! {
            next = rx.recv() => next,
            _ = closed.cancelled() => None,
        };
        let Some(Outbound { message, _room, _queued }) = next else { break };
        let limit = timing.write_limit(message.len());
        let sent = tokio::select! {
            sent = timeout(limit, sink.send(message)) => sent,
            _ = closed.cancelled() => break,
        };
        match sent {
            Ok(Ok(())) => {}
            Ok(Err(_)) => break,
            Err(_) => {
                out.err(format!("⚠️  The server stopped reading for {}s — connection is dead, forcing reconnect", limit.as_secs()));
                stalled = true;
                break;
            }
        }
    }
    closed.cancel();
    if !stalled {
        let _ = timeout(Duration::from_secs(2), sink.close()).await;
    }
}

/// How a connection went.
struct Served {
    opened: bool,
    /// How long it stayed up after the server's welcome, if one came.
    welcomed_for: Option<Duration>,
}

const NEVER_OPENED: Served = Served { opened: false, welcomed_for: None };

/// One connection, until it ends.
async fn serve(
    cfg: &Arc<TunnelConfig>,
    out: &Output,
    stop: &CancellationToken,
    edge: Option<&str>,
    edge_hint: &mut Option<String>,
    timing: &Timing,
) -> Served {
    let target = edge.unwrap_or(&cfg.server_host).to_string();
    let attempt = tokio::select! {
        _ = stop.cancelled() => return NEVER_OPENED,
        attempt = timeout(Duration::from_secs(20), connect(cfg, &target)) => attempt,
    };
    let ws = match attempt {
        Ok(Ok(ws)) => ws,
        Ok(Err(e)) => {
            out.err(format!("❌ Connection error: {e}"));
            return NEVER_OPENED;
        }
        Err(_) => {
            out.err(format!("❌ Connection error: {target}: timed out"));
            return NEVER_OPENED;
        }
    };
    out.out(format!("✅ Connected to server! ({} via {target})", cfg.domain));

    let (sink, mut stream) = ws.split();
    let (conn, rx) = Conn::new(cfg.clone(), out.clone());
    let writer = tokio::spawn(write_to_edge(sink, rx, conn.closed.clone(), *timing, out.clone()));

    let start = tokio::time::Instant::now();
    let mut heartbeat = interval_at(start + timing.heartbeat, timing.heartbeat);
    let mut ping = interval_at(start + timing.ping, timing.ping);
    let mut watchdog = interval_at(start + timing.watchdog, timing.watchdog);
    let mut last_inbound = Instant::now();
    let mut welcomed: Option<Instant> = None;
    let mut _connected: Option<Counted> = None;
    // Set while the link isn't read: too much waits for the TCP services.
    let mut paused: Option<Instant> = None;

    loop {
        if paused.is_none() && conn.tcp_backlog() > TCP_HIGH_WATER {
            paused = Some(Instant::now());
        }
        tokio::select! {
            _ = stop.cancelled() => break,
            // The writer gave up on the edge.
            _ = conn.closed.cancelled() => break,
            _ = conn.tcp_drained.notified(), if paused.is_some() => {
                if conn.tcp_backlog() < TCP_LOW_WATER {
                    let waited = paused.take().map(|since| since.elapsed()).unwrap_or_default();
                    // Ours, not the edge's silence.
                    last_inbound = Instant::now();
                    if waited >= Duration::from_secs(1) {
                        out.out(format!("⏸️  TCP: waited {:.1}s for the local service to catch up", waited.as_secs_f64()));
                    }
                }
            }
            message = stream.next(), if paused.is_none() => match message {
                Some(Ok(m)) => {
                    last_inbound = Instant::now();
                    match m {
                        Message::Text(text) => {
                            if dispatch(&conn, &text, edge_hint) && welcomed.is_none() {
                                welcomed = Some(Instant::now());
                                _connected = Some(Counted::new(&CONNECTED, 1));
                            }
                        }
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
            _ = heartbeat.tick() => conn.send_now(Message::Text(serde_json::json!({ "type": "heartbeat" }).to_string())),
            _ = ping.tick() => conn.send_now(Message::Ping(Vec::new())),
            _ = watchdog.tick() => {
                if paused.is_none() && last_inbound.elapsed() > timing.dead_after {
                    out.err(format!("⚠️  No response from server for {}s — connection is dead, forcing reconnect", last_inbound.elapsed().as_secs()));
                    break;
                }
            }
        }
    }

    // Everything relayed through this connection ends with it.
    conn.closed.cancel();
    for (_, abort) in conn.http_aborts.lock().unwrap().drain() {
        abort.cancel();
    }
    conn.ws_conns.lock().unwrap().clear();
    conn.tcp_conns.lock().unwrap().clear();
    // Stopped (the worker closed this tunnel): say so at once; the writer
    // finishes on its own. Otherwise let it close the link before the next one.
    if !stop.is_cancelled() {
        let _ = timeout(Duration::from_secs(2), writer).await;
    }
    out.out("🔌 Disconnected from server");
    Served { opened: true, welcomed_for: welcomed.map(|at| at.elapsed()) }
}

/// One message from the server. Anything that can take a while runs in its
/// own task. True for the server's welcome.
fn dispatch(conn: &Arc<Conn>, text: &str, edge_hint: &mut Option<String>) -> bool {
    let Ok(message) = serde_json::from_str::<serde_json::Value>(text) else {
        conn.out.err(format!("Failed to parse message: {}", text.chars().take(200).collect::<String>()));
        return false;
    };
    let welcomed = message["type"] == "welcome";
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
    welcomed
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

/// For tests in every module: a tunnel with no link to an edge. What it sends
/// to the edge comes out of the first receiver, what it prints out of the second.
#[cfg(test)]
pub mod testing {
    use super::*;

    pub fn config(server: &str, app_port: u16) -> TunnelConfig {
        let args: Vec<String> = ["--server", server, "--port", &app_port.to_string(), "--host", "127.0.0.1", "--domain", "t", "--auth", "k"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        TunnelConfig::from_args(&args).unwrap()
    }

    pub fn output() -> (Output, mpsc::UnboundedReceiver<String>) {
        let (tx, rx) = mpsc::unbounded_channel();
        (Output::new(Some("t1".into()), tx), rx)
    }

    pub fn conn(app_port: u16, features: &[&str]) -> (Arc<Conn>, mpsc::UnboundedReceiver<Outbound>, mpsc::UnboundedReceiver<String>) {
        let (out, lines) = output();
        let (conn, rx) = Conn::new(Arc::new(config("http://127.0.0.1:9", app_port)), out);
        conn.features.lock().unwrap().extend(features.iter().map(|f| f.to_string()));
        (conn, rx, lines)
    }

    /// A database that takes the connection and stops reading (a checkpoint,
    /// an index build) until `go`, then reads everything: what it got, in order.
    pub async fn stalling_service() -> (u16, tokio::sync::oneshot::Sender<()>, tokio::sync::oneshot::Receiver<Vec<u8>>) {
        use tokio::io::AsyncReadExt;
        // A small receive buffer: a stalled database's would be full.
        let socket = socket2::Socket::new(socket2::Domain::IPV4, socket2::Type::STREAM, None).unwrap();
        socket.set_recv_buffer_size(64 * 1024).unwrap();
        socket.bind(&"127.0.0.1:0".parse::<std::net::SocketAddr>().unwrap().into()).unwrap();
        socket.listen(8).unwrap();
        socket.set_nonblocking(true).unwrap();
        let listener = tokio::net::TcpListener::from_std(socket.into()).unwrap();
        let port = listener.local_addr().unwrap().port();
        let (go, go_rx) = tokio::sync::oneshot::channel::<()>();
        let (done_tx, done) = tokio::sync::oneshot::channel();
        tokio::spawn(async move {
            let (mut s, _) = listener.accept().await.unwrap();
            let _ = go_rx.await;
            let mut got = Vec::new();
            let _ = timeout(Duration::from_secs(30), s.read_to_end(&mut got)).await;
            let _ = done_tx.send(got);
        });
        (port, go, done)
    }

    pub fn pattern(len: usize) -> Vec<u8> {
        (0..len).map(|i| (i % 251) as u8).collect()
    }

    /// The JSON messages sent to the edge so far (binary frames skipped).
    pub fn sent_json(rx: &mut mpsc::UnboundedReceiver<Outbound>) -> Vec<serde_json::Value> {
        let mut all = Vec::new();
        while let Ok(o) = rx.try_recv() {
            if let Message::Text(t) = o.message {
                all.push(serde_json::from_str(&t).unwrap());
            }
        }
        all
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    #[test]
    fn backoff_stays_within_the_cli_bounds() {
        for attempt in 1..20 {
            let d = super::reconnect_delay(attempt, &Timing::DEFAULT).as_millis() as u64;
            let capped = (1_000u64 << (attempt - 1).min(16)).min(30_000);
            assert!(d >= capped / 2 && d <= capped, "attempt {attempt}: {d}");
        }
    }

    #[tokio::test]
    async fn the_edge_socket_gives_up_on_unacknowledged_data_in_a_minute() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let stream = TcpStream::connect(listener.local_addr().unwrap()).await.unwrap();
        tune_edge_socket(&stream);
        let socket = socket2::SockRef::from(&stream);
        assert!(socket.keepalive().unwrap());
        assert!(stream.nodelay().unwrap());
        #[cfg(target_os = "linux")]
        assert_eq!(socket.tcp_user_timeout().unwrap(), Some(Duration::from_secs(60)));
    }

    #[tokio::test]
    async fn a_full_queue_makes_senders_wait_and_the_end_of_the_connection_frees_them() {
        let (conn, mut rx, _lines) = testing::conn(1, &[]);
        assert!(conn.send_binary(vec![0; QUEUE_BYTES - 10]).await);
        // No room for this one until the first is sent.
        let waiting = tokio::spawn({
            let conn = conn.clone();
            async move { conn.send_binary(vec![0; 100]).await }
        });
        sleep(Duration::from_millis(50)).await;
        assert!(!waiting.is_finished());
        // Control messages never wait.
        conn.send_now(Message::Ping(Vec::new()));
        // The connection ends: the waiting sender gives up.
        conn.closed.cancel();
        assert!(!timeout(Duration::from_secs(1), waiting).await.unwrap().unwrap());
        assert!(matches!(rx.recv().await.unwrap().message, Message::Binary(_)));
        assert!(matches!(rx.recv().await.unwrap().message, Message::Ping(_)));
    }

    /// A local app with an endless download.
    async fn endless_app() -> u16 {
        let app = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = app.local_addr().unwrap().port();
        tokio::spawn(async move {
            while let Ok((mut s, _)) = app.accept().await {
                tokio::spawn(async move {
                    let mut buf = [0u8; 4096];
                    let _ = s.read(&mut buf).await;
                    let _ = s
                        .write_all(b"HTTP/1.1 200 OK\r\ncontent-type: application/octet-stream\r\ntransfer-encoding: chunked\r\n\r\n")
                        .await;
                    let mut chunk = format!("{:x}\r\n", 64 * 1024).into_bytes();
                    chunk.extend(std::iter::repeat_n(b'x', 64 * 1024));
                    chunk.extend_from_slice(b"\r\n");
                    while s.write_all(&chunk).await.is_ok() {}
                });
            }
        });
        port
    }

    /// The finding's scenario: the edge asks for a download and stops reading
    /// (its jrok hung, or the link went half-open), while it still sends (so
    /// silence alone doesn't give it away). The tunnel must notice, reconnect,
    /// and still end at once when the worker closes it.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn an_edge_that_stops_reading_is_left_and_a_close_still_ends_the_tunnel() {
        let app_port = endless_app().await;
        let edge = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let edge_port = edge.local_addr().unwrap().port();
        let (seen_tx, mut seen) = mpsc::unbounded_channel::<()>();
        tokio::spawn(async move {
            while let Ok((s, _)) = edge.accept().await {
                let seen_tx = seen_tx.clone();
                tokio::spawn(async move {
                    let mut ws = tokio_tungstenite::accept_async(s).await.unwrap();
                    let _ = seen_tx.send(());
                    let welcome = serde_json::json!({ "type": "welcome", "agentId": "a", "features": ["stream", "binchunk"] });
                    let request = serde_json::json!({ "type": "http_request", "requestId": "r1", "method": "GET", "path": "/big", "headers": {} });
                    let _ = ws.send(Message::Text(welcome.to_string())).await;
                    let _ = ws.send(Message::Text(request.to_string())).await;
                    // Never reads again; keeps talking.
                    let status = serde_json::json!({ "type": "heartbeat_ack" }).to_string();
                    while ws.send(Message::Text(status.clone())).await.is_ok() {
                        sleep(Duration::from_millis(100)).await;
                    }
                });
            }
        });

        let timing = Timing {
            heartbeat: Duration::from_millis(50),
            ping: Duration::from_millis(100),
            watchdog: Duration::from_millis(50),
            dead_after: Duration::from_secs(5),
            write_stall: Duration::from_millis(500),
            ..Timing::DEFAULT
        };
        let (out, _lines) = testing::output();
        let stop = CancellationToken::new();
        let tunnel = tokio::spawn(run_with(testing::config(&format!("http://127.0.0.1:{edge_port}"), app_port), out, stop.clone(), timing));

        timeout(Duration::from_secs(5), seen.recv()).await.expect("first connection").unwrap();
        timeout(Duration::from_secs(10), seen.recv()).await.expect("the tunnel left the edge that stopped reading and came back").unwrap();
        // Mid-download again: a close from the worker ends it at once.
        sleep(Duration::from_millis(500)).await;
        let asked = Instant::now();
        stop.cancel();
        timeout(Duration::from_secs(1), tunnel).await.expect("the tunnel ended within a second").unwrap();
        assert!(asked.elapsed() < Duration::from_secs(1));
    }

    /// The TCP finding's scenario, end to end: a restore at full speed into a
    /// database that stalls for longer than the watchdog allows. The tunnel
    /// holds the edge back instead of buffering or cutting it off, keeps
    /// heartbeating, isn't dropped for its own pause, and everything arrives.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_tcp_tunnel_holds_the_edge_back_while_its_service_stalls() {
        use base64::Engine;
        let (port, go, done) = testing::stalling_service().await;
        let data = testing::pattern(70 << 20);
        let messages: Vec<String> = data
            .chunks(64 * 1024)
            .map(|c| serde_json::json!({ "type": "tcp_data", "connectionId": "c1", "data": base64::engine::general_purpose::STANDARD.encode(c) }).to_string())
            .collect();
        let edge = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let edge_port = edge.local_addr().unwrap().port();
        let connections = Arc::new(AtomicUsize::new(0));
        let heartbeats = Arc::new(AtomicUsize::new(0));
        let (pushed_tx, pushed) = tokio::sync::oneshot::channel::<Duration>();
        {
            let (connections, heartbeats) = (connections.clone(), heartbeats.clone());
            tokio::spawn(async move {
                let (s, _) = edge.accept().await.unwrap();
                connections.fetch_add(1, Ordering::SeqCst);
                let (mut sink, mut stream) = tokio_tungstenite::accept_async(s).await.unwrap().split();
                tokio::spawn(async move {
                    while let Some(Ok(m)) = stream.next().await {
                        if matches!(&m, Message::Text(t) if t.contains("\"heartbeat\"")) {
                            heartbeats.fetch_add(1, Ordering::SeqCst);
                        }
                    }
                });
                let welcome = serde_json::json!({ "type": "welcome", "agentId": "a", "features": ["stream"] });
                let connect = serde_json::json!({ "type": "tcp_connect", "connectionId": "c1", "localHost": "127.0.0.1", "localPort": port });
                sink.send(Message::Text(welcome.to_string())).await.unwrap();
                sink.send(Message::Text(connect.to_string())).await.unwrap();
                let started = Instant::now();
                for m in messages {
                    sink.send(Message::Text(m)).await.unwrap();
                }
                sink.send(Message::Text(serde_json::json!({ "type": "tcp_close", "connectionId": "c1" }).to_string())).await.unwrap();
                let _ = pushed_tx.send(started.elapsed());
                // Later connections are counted, never served.
                while edge.accept().await.is_ok() {
                    connections.fetch_add(1, Ordering::SeqCst);
                }
            });
        }
        let timing = Timing {
            heartbeat: Duration::from_millis(100),
            ping: Duration::from_millis(200),
            watchdog: Duration::from_millis(100),
            dead_after: Duration::from_secs(1),
            write_stall: Duration::from_secs(5),
            ..Timing::DEFAULT
        };
        let (out, _lines) = testing::output();
        let stop = CancellationToken::new();
        tokio::spawn(run_with(testing::config(&format!("http://127.0.0.1:{edge_port}"), port), out, stop.clone(), timing));

        let stall = Duration::from_millis(2500);
        sleep(stall).await;
        let heartbeats_before = heartbeats.load(Ordering::SeqCst);
        go.send(()).unwrap();
        let got = timeout(Duration::from_secs(30), done).await.unwrap().unwrap();
        let took = timeout(Duration::from_secs(5), pushed).await.unwrap().unwrap();
        stop.cancel();
        assert_eq!(got.len(), data.len(), "the connection was cut off");
        assert!(got == data, "bytes were reordered or changed");
        assert!(took >= Duration::from_secs(2), "the edge pushed everything in {took:?}: nothing held it back");
        assert!(heartbeats_before >= 10, "only {heartbeats_before} heartbeats while the link was held back");
        assert_eq!(connections.load(Ordering::SeqCst), 1, "the tunnel dropped the link for its own pause");
    }

    /// A fake edge running `script` on every connection; how many it got.
    async fn scripted_edge(script: fn(u32) -> Vec<Message>, hold: Duration) -> (u16, Arc<AtomicUsize>) {
        let edge = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = edge.local_addr().unwrap().port();
        let count = Arc::new(AtomicUsize::new(0));
        let seen = count.clone();
        tokio::spawn(async move {
            while let Ok((s, _)) = edge.accept().await {
                let n = seen.fetch_add(1, Ordering::SeqCst) as u32 + 1;
                tokio::spawn(async move {
                    let Ok(mut ws) = tokio_tungstenite::accept_async(s).await else { return };
                    for m in script(n) {
                        if matches!(m, Message::Close(_)) {
                            sleep(hold).await;
                        }
                        let _ = ws.send(m).await;
                    }
                    // Read on until the agent leaves.
                    while let Some(Ok(_)) = ws.next().await {}
                });
            }
        });
        (port, count)
    }

    fn close(code: u16, reason: &'static str) -> Message {
        use tokio_tungstenite::tungstenite::protocol::{frame::coding::CloseCode, CloseFrame};
        Message::Close(Some(CloseFrame { code: CloseCode::from(code), reason: reason.into() }))
    }

    fn text(value: serde_json::Value) -> Message {
        Message::Text(value.to_string())
    }

    fn fast() -> Timing {
        Timing { reconnect_base: Duration::from_millis(40), reconnect_max: Duration::from_millis(400), stable_after: Duration::from_millis(300), ..Timing::DEFAULT }
    }

    /// The attempt numbers of the first `n` reconnects the tunnel announces.
    async fn attempts(edge_port: u16, timing: Timing, n: usize) -> Vec<u32> {
        let (out, mut lines) = testing::output();
        let stop = CancellationToken::new();
        tokio::spawn(run_with(testing::config(&format!("http://127.0.0.1:{edge_port}"), 1), out, stop.clone(), timing));
        let mut seen = Vec::new();
        while seen.len() < n {
            let line = timeout(Duration::from_secs(10), lines.recv()).await.expect("a reconnect").unwrap();
            let line: serde_json::Value = serde_json::from_str(&line).unwrap();
            if let Some(attempt) = line["out"].as_str().and_then(|l| l.split("(attempt ").nth(1)).and_then(|r| r.trim_end_matches(")...").parse().ok()) {
                seen.push(attempt);
            }
        }
        stop.cancel();
        seen
    }

    /// The finding's scenario: the edge takes the connection, then refuses the
    /// tunnel (a domain of another organization) and closes with 1011.
    #[tokio::test]
    async fn an_edge_that_refuses_the_tunnel_gets_it_back_ever_more_slowly() {
        let (port, _) = scripted_edge(
            |_| vec![text(serde_json::json!({ "type": "error", "message": "Failed to register agent: belongs to a different organization" })), close(1011, "Failed to register agent")],
            Duration::ZERO,
        )
        .await;
        assert_eq!(attempts(port, fast(), 4).await, [1, 2, 3, 4]);
    }

    /// Welcomed, then closed at once: not a link that held either.
    #[tokio::test]
    async fn a_link_closed_right_after_its_welcome_doesnt_reset_the_backoff() {
        let (port, _) = scripted_edge(|_| vec![text(serde_json::json!({ "type": "welcome", "agentId": "a" })), close(1000, "")], Duration::ZERO).await;
        assert_eq!(attempts(port, fast(), 3).await, [1, 2, 3]);
    }

    /// A link that held after its welcome starts the backoff over.
    #[tokio::test]
    async fn a_link_that_held_starts_the_backoff_over() {
        let (port, _) = scripted_edge(|_| vec![text(serde_json::json!({ "type": "welcome", "agentId": "a" })), close(1000, "")], Duration::from_millis(400)).await;
        assert_eq!(attempts(port, fast(), 3).await, [1, 1, 1]);
    }

    /// Sent to the edge holding the TCP port (tcp_port_elsewhere): go there at
    /// once, even after failures, but not again and again if edges disagree.
    #[tokio::test]
    async fn a_tcp_tunnel_sent_to_another_edge_goes_at_once_but_not_round_and_round() {
        fn script(n: u32) -> Vec<Message> {
            if n <= 2 {
                return vec![text(serde_json::json!({ "type": "error", "message": "Failed to register agent" })), close(1011, "Failed to register agent")];
            }
            // Then back and forth between two names for this machine.
            let other = if n % 2 == 1 { "localhost" } else { "127.0.0.1" };
            vec![
                text(serde_json::json!({ "type": "welcome", "agentId": "a" })),
                text(serde_json::json!({ "type": "error", "code": "tcp_port_elsewhere", "edge": other, "message": format!("This TCP tunnel's port is on {other}") })),
                close(4010, "TCP tunnel is on another edge"),
            ]
        }
        let (port, _) = scripted_edge(script, Duration::ZERO).await;
        assert_eq!(attempts(port, fast(), 5).await, [1, 2, 1, 2, 3]);
    }
}

