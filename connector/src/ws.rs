//! A visitor's WebSocket, relayed to the local app (the CLI's handleWsConnect /
//! handleWsMessage / handleWsClose). Text stays text and binary stays binary.
//!
//! What the visitor sends waits for the app in order, before the app's side
//! opens and after, up to 16 MB (the edge's burst). Beyond that the visitor's
//! socket is closed with 1013 rather than a message dropped: the CLI never
//! drops one once connected, and an upload or graphql-ws can't survive a gap.
//! The app has 30 s to answer the upgrade; a visitor who leaves meanwhile,
//! or the end of the link, ends the attempt.

use crate::tunnel::Conn;
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::borrow::Cow;
use std::collections::VecDeque;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::net::TcpStream;
use tokio::sync::mpsc;
use tokio::time::{sleep, timeout};
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::error::{Error as TungsteniteError, ProtocolError, SubProtocolError, UrlError};
use tokio_tungstenite::tungstenite::handshake::client::Request;
use tokio_tungstenite::tungstenite::http::HeaderName;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use tokio_tungstenite::tungstenite::protocol::CloseFrame;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};
use tokio_util::sync::CancellationToken;

/// What a visitor's socket may have waiting for the app, in bytes: the edge's
/// burst (utils/wsFlowControl.ts), so a visitor within the edge's limits only
/// meets it when the app has stopped reading.
const MAX_QUEUED_BYTES: usize = 16 << 20;
/// How long the app has to answer the upgrade.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(30);

pub enum ToLocal {
    Text(String),
    Binary(Vec<u8>),
    Close(u16, String),
}

impl ToLocal {
    fn len(&self) -> usize {
        match self {
            ToLocal::Text(t) => t.len(),
            ToLocal::Binary(b) => b.len(),
            ToLocal::Close(..) => 0,
        }
    }
}

/// A visitor's socket, as the server's messages find it.
#[derive(Clone)]
pub struct Entry {
    tx: mpsc::UnboundedSender<ToLocal>,
    /// Bytes waiting for the app.
    queued: Arc<AtomicUsize>,
    /// Drops the app's side at once (the visitor was closed for flooding).
    abort: CancellationToken,
}

/// 1005, 1006 and 1015 only report; anything we may not send becomes 1000.
fn sendable(code: u64) -> u16 {
    match code {
        1000..=1003 | 1007..=1014 | 3000..=4999 => code as u16,
        _ => 1000,
    }
}

pub fn connect(conn: Arc<Conn>, message: &Value) {
    connect_within(conn, message, CONNECT_TIMEOUT)
}

fn connect_within(conn: Arc<Conn>, message: &Value, limit: Duration) {
    let Some(ws_id) = message["wsId"].as_str().map(String::from) else { return };
    let path = message["path"].as_str().filter(|p| !p.is_empty()).unwrap_or("/").to_string();
    let headers = message["headers"].clone();
    let (tx, rx) = mpsc::unbounded_channel();
    let entry = Entry { tx, queued: Arc::new(AtomicUsize::new(0)), abort: CancellationToken::new() };
    let (queued, abort) = (entry.queued.clone(), entry.abort.clone());
    // Registered before connecting, so what the visitor sends meanwhile is queued.
    conn.ws_conns.lock().unwrap().insert(ws_id.clone(), entry);
    tokio::spawn(relay(conn, ws_id, path, headers, rx, queued, abort, limit));
}

/// A path for the log: the query (tokens, often, on a WebSocket) left out.
fn without_query(path: &str) -> &str {
    path.split('?').next().unwrap_or(path)
}

/// Forget a visitor's socket, if the entry is still this one.
fn forget(conn: &Conn, ws_id: &str, queued: &Arc<AtomicUsize>) {
    let mut sockets = conn.ws_conns.lock().unwrap();
    if sockets.get(ws_id).is_some_and(|e| Arc::ptr_eq(&e.queued, queued)) {
        sockets.remove(ws_id);
    }
}

/// The handshake to the app: the visitor's headers, and the subprotocol the
/// server already told the visitor (its first choice, P32) when `offer`.
/// Host is the visitor's too, as the CLI sends it: apps that only accept a
/// same-origin WebSocket (gorilla/websocket, Rails' Action Cable, Spring)
/// compare Origin with it, and refused every browser when it was the
/// container's address.
fn local_request(url: &str, headers: &Value, offer: Option<&str>) -> Result<Request, String> {
    let mut req = url.into_client_request().map_err(|e| e.to_string())?;
    if let Some(map) = headers.as_object() {
        for (name, value) in map {
            let lower = name.to_ascii_lowercase();
            if lower == "upgrade" || lower == "connection" || lower == "content-length" || lower.starts_with("sec-websocket-") {
                continue;
            }
            let Some(v) = value.as_str() else { continue };
            // tungstenite writes only visible ASCII in a handshake and fails
            // the whole upgrade on anything else (a cookie with Khmer text):
            // such a header is left out instead.
            if !v.bytes().all(|b| b == b'\t' || (0x20..0x7f).contains(&b)) {
                continue;
            }
            if let (Ok(n), Ok(v)) = (HeaderName::from_bytes(lower.as_bytes()), v.parse()) {
                req.headers_mut().insert(n, v);
            }
        }
    }
    if let Some(protocol) = offer {
        let value = protocol.parse().map_err(|_| format!("invalid subprotocol {protocol}"))?;
        req.headers_mut().insert("sec-websocket-protocol", value);
    }
    Ok(req)
}

type LocalSocket = WebSocketStream<MaybeTlsStream<TcpStream>>;

/// The app's side: offered the visitor's subprotocol; an app that ignores
/// subprotocols answers with none, which the handshake refuses, so connect
/// again without offering one.
async fn open_local(conn: &Conn, ws_id: &str, path: &str, headers: &Value) -> Result<LocalSocket, TungsteniteError> {
    let url = format!("ws://{}:{}{}", conn.cfg.local_host, conn.cfg.local_port, path);
    let offered = headers["sec-websocket-protocol"]
        .as_str()
        .and_then(|h| h.split(',').next())
        .map(str::trim)
        .filter(|p| !p.is_empty())
        .map(String::from);
    let open = |offer: Option<&str>| {
        let request = local_request(&url, headers, offer);
        async move {
            match request {
                Ok(req) => tokio_tungstenite::connect_async(req).await.map(|(ws, _)| ws),
                Err(e) => Err(TungsteniteError::Url(UrlError::UnableToConnect(e))),
            }
        }
    };
    let local = open(offered.as_deref()).await;
    if offered.is_some() && matches!(local, Err(TungsteniteError::Protocol(ProtocolError::SecWebSocketSubProtocolError(SubProtocolError::NoSubProtocol)))) {
        conn.out.out(format!("🔁 WS {} [{ws_id}]: the app ignores subprotocols; connecting again without one", without_query(path)));
        return open(None).await;
    }
    local
}

#[allow(clippy::too_many_arguments)]
async fn relay(
    conn: Arc<Conn>,
    ws_id: String,
    path: String,
    headers: Value,
    mut rx: mpsc::UnboundedReceiver<ToLocal>,
    queued: Arc<AtomicUsize>,
    abort: CancellationToken,
    limit: Duration,
) {
    // The app's side. What the visitor sends meanwhile waits here, in order.
    // If the visitor leaves first, nothing reaches the app (as with the CLI).
    let mut waiting: VecDeque<ToLocal> = VecDeque::new();
    let opened = {
        let opening = open_local(&conn, &ws_id, &path, &headers);
        let deadline = sleep(limit);
        tokio::pin!(opening, deadline);
        loop {
            tokio::select! {
                opened = &mut opening => break Some(opened.map_err(|e| e.to_string())),
                command = rx.recv() => match command {
                    Some(ToLocal::Close(..)) | None => break None,
                    Some(waits) => waiting.push_back(waits),
                },
                _ = &mut deadline => break Some(Err(format!("the app did not answer the WebSocket upgrade within {}s", limit.as_secs_f32()))),
                _ = abort.cancelled() => break None,
                _ = conn.closed.cancelled() => break None,
            }
        }
    };
    let local = match opened {
        Some(Ok(ws)) => ws,
        Some(Err(error)) => {
            conn.out.err(format!("❌ WS Error: {} [{ws_id}]: {error}", without_query(&path)));
            forget(&conn, &ws_id, &queued);
            conn.send_json(json!({ "type": "ws_error", "wsId": ws_id, "error": error })).await;
            return;
        }
        None => {
            forget(&conn, &ws_id, &queued);
            return;
        }
    };
    let (mut sink, mut stream) = local.split();

    // Both ways at once, so an app slow to read never holds up what it sends.
    let app_ended = {
        let to_app = async {
            loop {
                let command = match waiting.pop_front() {
                    Some(waited) => Some(waited),
                    None => rx.recv().await,
                };
                let message = match command {
                    Some(ToLocal::Close(code, reason)) => {
                        let _ = sink.send(Message::Close(Some(CloseFrame { code: CloseCode::from(code), reason: Cow::Owned(reason) }))).await;
                        return;
                    }
                    Some(ToLocal::Text(t)) => {
                        queued.fetch_sub(t.len(), Ordering::Relaxed);
                        Message::Text(t)
                    }
                    Some(ToLocal::Binary(b)) => {
                        queued.fetch_sub(b.len(), Ordering::Relaxed);
                        Message::Binary(b)
                    }
                    // Forgotten: the link ended, or the visitor was closed for flooding.
                    None => return,
                };
                if sink.send(message).await.is_err() {
                    return;
                }
            }
        };
        // True when the app ended it (the server was told).
        let from_app = async {
            loop {
                let reply = match stream.next().await {
                    Some(Ok(Message::Text(t))) => json!({ "type": "ws_message_response", "wsId": ws_id, "data": t, "isBinary": false }),
                    Some(Ok(Message::Binary(b))) => json!({ "type": "ws_message_response", "wsId": ws_id, "data": B64.encode(&b), "isBinary": true }),
                    Some(Ok(Message::Close(frame))) => {
                        let (code, reason) = frame.map(|f| (u16::from(f.code), f.reason.to_string())).unwrap_or((1005, String::new()));
                        conn.send_json(json!({ "type": "ws_close_response", "wsId": ws_id, "code": code, "reason": reason })).await;
                        return true;
                    }
                    Some(Ok(_)) => continue,
                    Some(Err(e)) => {
                        conn.send_json(json!({ "type": "ws_error", "wsId": ws_id, "error": e.to_string() })).await;
                        return true;
                    }
                    None => {
                        conn.send_json(json!({ "type": "ws_close_response", "wsId": ws_id, "code": 1006, "reason": "" })).await;
                        return true;
                    }
                };
                if !conn.send_json(reply).await {
                    return false;
                }
            }
        };
        tokio::select! {
            _ = to_app => false,
            app = from_app => app,
            _ = abort.cancelled() => false,
            _ = conn.closed.cancelled() => false,
        }
    };
    // The link went away: tell the app, as the CLI does.
    if conn.closed.is_cancelled() && !app_ended {
        let goodbye = Message::Close(Some(CloseFrame { code: CloseCode::from(1001), reason: Cow::Borrowed("Server disconnected") }));
        let _ = timeout(Duration::from_secs(1), sink.send(goodbye)).await;
    }
    forget(&conn, &ws_id, &queued);
}

pub fn message(conn: &Arc<Conn>, message: &Value) {
    let Some(ws_id) = message["wsId"].as_str() else { return };
    let Some(entry) = conn.ws_conns.lock().unwrap().get(ws_id).cloned() else {
        conn.out.err(format!("⚠️ No active WebSocket for [{ws_id}]"));
        return;
    };
    let data = message["data"].as_str().unwrap_or_default();
    let payload = if message["isBinary"].as_bool() == Some(true) {
        ToLocal::Binary(B64.decode(data).unwrap_or_default())
    } else {
        ToLocal::Text(data.to_string())
    };
    let bytes = payload.len();
    if entry.queued.fetch_add(bytes, Ordering::Relaxed) + bytes > MAX_QUEUED_BYTES {
        // Closed, never a gap: the app can't have missed a message.
        conn.out.err(format!("⚠️ WS [{ws_id}]: the app isn't keeping up ({} MB waiting); closing the visitor's socket (1013)", MAX_QUEUED_BYTES >> 20));
        forget(conn, ws_id, &entry.queued);
        entry.abort.cancel();
        conn.send_now(Message::Text(json!({ "type": "ws_close_response", "wsId": ws_id, "code": 1013, "reason": "Tunnel busy" }).to_string()));
        return;
    }
    let _ = entry.tx.send(payload);
}

pub fn close(conn: &Arc<Conn>, message: &Value) {
    let Some(ws_id) = message["wsId"].as_str() else { return };
    if let Some(entry) = conn.ws_conns.lock().unwrap().remove(ws_id) {
        let code = sendable(message["code"].as_u64().unwrap_or(1000));
        let reason = message["reason"].as_str().unwrap_or_default().chars().take(120).collect();
        // After what the visitor sent before it, in order.
        let _ = entry.tx.send(ToLocal::Close(code, reason));
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn logs_leave_the_query_out() {
        assert_eq!(super::without_query("/cable?token=SECRET"), "/cable");
        assert_eq!(super::without_query("/ws"), "/ws");
    }

    #[test]
    fn close_codes() {
        assert_eq!(super::sendable(1000), 1000);
        assert_eq!(super::sendable(1006), 1000);
        assert_eq!(super::sendable(4010), 4010);
        assert_eq!(super::sendable(1015), 1000);
    }
}

#[cfg(test)]
mod subprotocol_tests {
    use serde_json::json;

    #[test]
    fn offers_the_app_only_the_protocol_the_visitor_was_given() {
        let headers = json!({ "sec-websocket-protocol": "graphql-transport-ws", "cookie": "session=abc", "host": "app.example" });
        let req = super::local_request("ws://127.0.0.1:1/", &headers, Some("graphql-transport-ws")).unwrap();
        assert_eq!(req.headers()["sec-websocket-protocol"], "graphql-transport-ws");
        assert_eq!(req.headers()["cookie"], "session=abc");
        assert_eq!(req.headers()["host"], "app.example");

        let again = super::local_request("ws://127.0.0.1:1/", &headers, None).unwrap();
        assert!(again.headers().get("sec-websocket-protocol").is_none());
    }

    /// A header with bytes that aren't visible ASCII (a cookie with Khmer
    /// text): tungstenite can't write it in a handshake and failed the whole
    /// upgrade, so it is left out and the visitor still gets through.
    #[test]
    fn a_header_the_handshake_cant_carry_is_left_out() {
        let khmer: String = "lang=ខ្មែរ".as_bytes().iter().map(|&b| b as char).collect();
        let headers = json!({ "host": "app.example", "cookie": khmer, "x-ok": "plain" });
        let req = super::local_request("ws://127.0.0.1:1/", &headers, None).unwrap();
        assert!(req.headers().get("cookie").is_none());
        let (bytes, _) = tokio_tungstenite::tungstenite::handshake::client::generate_request(req).expect("the handshake can be written");
        assert!(String::from_utf8_lossy(&bytes).contains("\r\nx-ok: plain\r\n"));
    }

    /// What the app reads: the handshake carries the visitor's Host, not the
    /// container's address (same-origin checks compare Origin with it).
    #[test]
    fn the_app_sees_the_visitors_host() {
        let headers = json!({ "host": "app.koompi.app", "origin": "https://app.koompi.app", "x-forwarded-proto": "https" });
        let req = super::local_request("ws://172.18.0.12:3000/cable", &headers, None).unwrap();
        let (bytes, _) = tokio_tungstenite::tungstenite::handshake::client::generate_request(req).unwrap();
        let text = String::from_utf8(bytes).unwrap();
        assert!(text.starts_with("GET /cable HTTP/1.1\r\n"), "{text}");
        assert!(text.contains("\r\nHost: app.koompi.app\r\n"), "{text}");
        assert!(!text.contains("172.18.0.12"), "{text}");
        assert!(text.contains("\r\nOrigin: https://app.koompi.app\r\n"), "{text}");
    }
}

/// The relay against real local apps (the finding's scenarios).
#[cfg(test)]
mod relay_tests {
    use crate::tunnel::testing;
    use base64::engine::general_purpose::STANDARD as B64;
    use base64::Engine;
    use futures_util::StreamExt;
    use serde_json::json;
    use std::time::Duration;
    use tokio::io::AsyncReadExt;
    use tokio::net::TcpListener;
    use tokio::sync::{mpsc, oneshot};
    use tokio::time::timeout;
    use tokio_tungstenite::tungstenite::Message;

    /// An app that takes the connection and never answers the upgrade (a
    /// deadlocked WebSocket route). Says when it was reached and when we left.
    async fn hanging_app() -> (u16, mpsc::UnboundedReceiver<()>, mpsc::UnboundedReceiver<()>) {
        let app = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = app.local_addr().unwrap().port();
        let (reached_tx, reached) = mpsc::unbounded_channel();
        let (left_tx, left) = mpsc::unbounded_channel();
        tokio::spawn(async move {
            while let Ok((mut s, _)) = app.accept().await {
                let _ = reached_tx.send(());
                let left_tx = left_tx.clone();
                tokio::spawn(async move {
                    let mut buf = [0u8; 4096];
                    while matches!(s.read(&mut buf).await, Ok(n) if n > 0) {}
                    let _ = left_tx.send(());
                });
            }
        });
        (port, reached, left)
    }

    #[tokio::test]
    async fn a_visitor_who_leaves_during_the_upgrade_takes_the_attempt_with_them() {
        let (port, mut reached, mut left) = hanging_app().await;
        let (conn, _sent, _lines) = testing::conn(port, &[]);
        super::connect(conn.clone(), &json!({ "wsId": "w1", "path": "/hang", "headers": {} }));
        timeout(Duration::from_secs(2), reached.recv()).await.unwrap().unwrap();
        super::close(&conn, &json!({ "wsId": "w1", "code": 1001 }));
        timeout(Duration::from_secs(1), left.recv()).await.expect("the app's socket was closed when the visitor left").unwrap();
        assert!(conn.ws_conns.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn the_end_of_the_link_ends_an_upgrade_in_progress() {
        let (port, mut reached, mut left) = hanging_app().await;
        let (conn, _sent, _lines) = testing::conn(port, &[]);
        super::connect(conn.clone(), &json!({ "wsId": "w1", "path": "/hang", "headers": {} }));
        timeout(Duration::from_secs(2), reached.recv()).await.unwrap().unwrap();
        conn.closed.cancel();
        timeout(Duration::from_secs(1), left.recv()).await.expect("the app's socket was closed with the link").unwrap();
    }

    /// A WebSocket app that doesn't read until told to (a GC pause, a slow
    /// write), then reports the numbers of the messages it got, in order,
    /// until its socket ends.
    async fn paused_app() -> (u16, oneshot::Receiver<()>, oneshot::Sender<()>, oneshot::Receiver<Vec<u32>>) {
        let app = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = app.local_addr().unwrap().port();
        let (open_tx, open) = oneshot::channel();
        let (go, go_rx) = oneshot::channel::<()>();
        let (done_tx, done) = oneshot::channel();
        tokio::spawn(async move {
            let (s, _) = app.accept().await.unwrap();
            let mut ws = tokio_tungstenite::accept_async(s).await.unwrap();
            let _ = open_tx.send(());
            let _ = go_rx.await;
            let mut got = Vec::new();
            while let Ok(Some(Ok(m))) = timeout(Duration::from_secs(3), ws.next()).await {
                match m {
                    Message::Binary(b) => got.push(u32::from_be_bytes([b[0], b[1], b[2], b[3]])),
                    Message::Close(_) => break,
                    _ => {}
                }
            }
            let _ = done_tx.send(got);
        });
        (port, open, go, done)
    }

    /// The finding's scenario: a visitor sends steadily (an upload) while the
    /// app pauses. Either every message arrives, or the visitor's socket ends
    /// with 1013; never a gap.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_visitor_too_fast_for_the_app_is_closed_never_given_a_gap() {
        let (port, open, go, done) = paused_app().await;
        let (conn, mut sent, _lines) = testing::conn(port, &[]);
        super::connect(conn.clone(), &json!({ "wsId": "w1", "path": "/", "headers": {} }));
        timeout(Duration::from_secs(2), open).await.unwrap().unwrap();
        let count = 2_560u32; // 40 MB in 16 KB messages
        for i in 0..count {
            let mut payload = vec![0u8; 16 * 1024];
            payload[..4].copy_from_slice(&i.to_be_bytes());
            super::message(&conn, &json!({ "wsId": "w1", "data": B64.encode(&payload), "isBinary": true }));
        }
        go.send(()).unwrap();
        let got = timeout(Duration::from_secs(20), done).await.unwrap().unwrap();
        let in_order = got.iter().enumerate().all(|(i, &n)| n == i as u32);
        assert!(in_order, "a gap: got {} messages, first wrong at {:?}", got.len(), got.iter().enumerate().find(|(i, &n)| n != *i as u32));
        let busy = testing::sent_json(&mut sent).iter().any(|m| m["type"] == "ws_close_response" && m["wsId"] == "w1" && m["code"] == 1013);
        assert!(got.len() == count as usize || busy, "got {} of {count} and the visitor wasn't closed", got.len());
    }

    #[tokio::test]
    async fn an_app_that_never_answers_the_upgrade_is_given_up_on() {
        let (port, mut reached, mut left) = hanging_app().await;
        let (conn, mut sent, _lines) = testing::conn(port, &[]);
        super::connect_within(conn.clone(), &json!({ "wsId": "w1", "path": "/hang", "headers": {} }), Duration::from_millis(300));
        timeout(Duration::from_secs(2), reached.recv()).await.unwrap().unwrap();
        timeout(Duration::from_secs(2), left.recv()).await.expect("the app's socket was closed at the deadline").unwrap();
        tokio::time::sleep(Duration::from_millis(50)).await;
        let sent = testing::sent_json(&mut sent);
        assert!(sent.iter().any(|m| m["type"] == "ws_error" && m["wsId"] == "w1"), "{sent:?}");
        assert!(conn.ws_conns.lock().unwrap().is_empty());
    }

    /// A WebSocket app that answers the upgrade after `delay`, then records
    /// every message (text, or the number in a binary one) until its socket ends.
    async fn recording_app(delay: Duration) -> (u16, oneshot::Receiver<(Vec<String>, Option<u16>)>) {
        let app = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = app.local_addr().unwrap().port();
        let (done_tx, done) = oneshot::channel();
        tokio::spawn(async move {
            let (s, _) = app.accept().await.unwrap();
            tokio::time::sleep(delay).await;
            let mut ws = tokio_tungstenite::accept_async(s).await.unwrap();
            let (mut got, mut close) = (Vec::new(), None);
            while let Ok(Some(Ok(m))) = timeout(Duration::from_secs(3), ws.next()).await {
                match m {
                    Message::Text(t) => got.push(t),
                    Message::Close(frame) => {
                        close = frame.map(|f| u16::from(f.code));
                        break;
                    }
                    _ => {}
                }
            }
            let _ = done_tx.send((got, close));
        });
        (port, done)
    }

    #[tokio::test]
    async fn what_the_visitor_sends_before_the_app_answers_arrives_in_order_then_their_close() {
        let (port, done) = recording_app(Duration::from_millis(300)).await;
        let (conn, _sent, _lines) = testing::conn(port, &[]);
        super::connect(conn.clone(), &json!({ "wsId": "w1", "path": "/", "headers": {} }));
        for text in ["login", "subscribe", "hello"] {
            super::message(&conn, &json!({ "wsId": "w1", "data": text, "isBinary": false }));
        }
        tokio::time::sleep(Duration::from_millis(600)).await;
        super::message(&conn, &json!({ "wsId": "w1", "data": "after", "isBinary": false }));
        super::close(&conn, &json!({ "wsId": "w1", "code": 4000, "reason": "bye" }));
        let (got, close) = timeout(Duration::from_secs(5), done).await.unwrap().unwrap();
        assert_eq!(got, ["login", "subscribe", "hello", "after"]);
        assert_eq!(close, Some(4000));
    }

    #[tokio::test]
    async fn the_same_rule_holds_before_the_app_answers() {
        let (port, _done) = recording_app(Duration::from_secs(2)).await;
        let (conn, mut sent, _lines) = testing::conn(port, &[]);
        super::connect(conn.clone(), &json!({ "wsId": "w1", "path": "/", "headers": {} }));
        let chunk = B64.encode(vec![7u8; 1 << 20]);
        for _ in 0..17 {
            super::message(&conn, &json!({ "wsId": "w1", "data": chunk, "isBinary": true }));
        }
        let sent = testing::sent_json(&mut sent);
        assert!(sent.iter().any(|m| m["type"] == "ws_close_response" && m["wsId"] == "w1" && m["code"] == 1013), "{sent:?}");
        assert!(conn.ws_conns.lock().unwrap().is_empty());
    }

    /// An app that sends while it isn't reading: what it sends must still
    /// reach the visitor while the visitor's messages wait for it.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn an_app_slow_to_read_still_gets_its_messages_to_the_visitor() {
        let app = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = app.local_addr().unwrap().port();
        let (speak_tx, speak) = oneshot::channel::<()>();
        tokio::spawn(async move {
            let (s, _) = app.accept().await.unwrap();
            let mut ws = tokio_tungstenite::accept_async(s).await.unwrap();
            let _ = speak.await;
            use futures_util::SinkExt;
            let _ = ws.send(Message::Text("hello from the app".into())).await;
            tokio::time::sleep(Duration::from_secs(10)).await;
        });
        let (conn, mut sent, _lines) = testing::conn(port, &[]);
        super::connect(conn.clone(), &json!({ "wsId": "w1", "path": "/", "headers": {} }));
        tokio::time::sleep(Duration::from_millis(200)).await;
        // 12 MB the app doesn't read: more than the sockets between us hold.
        let chunk = B64.encode(vec![7u8; 16 * 1024]);
        for _ in 0..768 {
            super::message(&conn, &json!({ "wsId": "w1", "data": chunk, "isBinary": true }));
        }
        tokio::time::sleep(Duration::from_millis(300)).await;
        speak_tx.send(()).unwrap();
        let mut heard = false;
        for _ in 0..40 {
            tokio::time::sleep(Duration::from_millis(50)).await;
            if testing::sent_json(&mut sent).iter().any(|m| m["type"] == "ws_message_response" && m["data"] == "hello from the app") {
                heard = true;
                break;
            }
        }
        assert!(heard, "the app's message never reached the visitor");
    }
}
