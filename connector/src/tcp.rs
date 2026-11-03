//! A customer's TCP connection (database, SSH), relayed to the local service
//! (the CLI's handleTcpConnect / handleTcpData / handleTcpClose).

use crate::tunnel::Conn;
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::mpsc;

pub enum ToLocal {
    Data(Vec<u8>),
    Close,
}

/// Data for the local service waits here in order (an unbounded queue: a
/// chunk must never be dropped or reordered), up to this much; beyond it the
/// connection is closed rather than letting a stalled service grow memory.
const MAX_QUEUED_BYTES: usize = 64 << 20;

#[derive(Clone)]
pub struct Local {
    tx: mpsc::UnboundedSender<ToLocal>,
    queued: Arc<AtomicUsize>,
}

pub fn connect(conn: Arc<Conn>, message: &Value) {
    let Some(id) = message["connectionId"].as_str().map(String::from) else { return };
    let host = message["localHost"].as_str().filter(|h| !h.is_empty()).unwrap_or(&conn.cfg.local_host).to_string();
    let port = message["localPort"].as_u64().map(|p| p as u16).unwrap_or(conn.cfg.local_port);
    let (tx, rx) = mpsc::unbounded_channel::<ToLocal>();
    let queued = Arc::new(AtomicUsize::new(0));
    // Registered first: data the server sends while this connects is kept.
    conn.tcp_conns.lock().unwrap().insert(id.clone(), Local { tx, queued: queued.clone() });
    tokio::spawn(relay(conn, id, host, port, rx, queued));
}

async fn relay(conn: Arc<Conn>, id: String, host: String, port: u16, mut rx: mpsc::UnboundedReceiver<ToLocal>, queued: Arc<AtomicUsize>) {
    let stream = match TcpStream::connect((host.as_str(), port)).await {
        Ok(s) => s,
        Err(e) => {
            conn.out.err(format!("❌ TCP Error: {host}:{port} [{id}]: {e}"));
            conn.tcp_conns.lock().unwrap().remove(&id);
            conn.send_json(json!({ "type": "tcp_error", "connectionId": id, "error": e.to_string() })).await;
            return;
        }
    };
    // Keepalive, so an idle SSH or database session isn't dropped by NAT.
    let keepalive = socket2::TcpKeepalive::new().with_time(Duration::from_secs(60));
    let _ = socket2::SockRef::from(&stream).set_tcp_keepalive(&keepalive);
    let _ = stream.set_nodelay(true);
    conn.send_json(json!({ "type": "tcp_connected", "connectionId": id })).await;

    let (mut reader, mut writer) = stream.into_split();
    let mut buf = vec![0u8; 64 * 1024];
    let mut writing = true;
    loop {
        tokio::select! {
            read = reader.read(&mut buf) => match read {
                Ok(0) => break,
                // The link ended: so does this connection.
                Ok(n) => if !conn.send_json(json!({ "type": "tcp_data_response", "connectionId": id, "data": B64.encode(&buf[..n]) })).await { return },
                Err(e) => {
                    conn.send_json(json!({ "type": "tcp_error", "connectionId": id, "error": e.to_string() })).await;
                    conn.tcp_conns.lock().unwrap().remove(&id);
                    return;
                }
            },
            command = rx.recv(), if writing => match command {
                Some(ToLocal::Data(bytes)) => {
                    queued.fetch_sub(bytes.len(), Ordering::Relaxed);
                    if let Err(e) = writer.write_all(&bytes).await {
                        conn.send_json(json!({ "type": "tcp_error", "connectionId": id, "error": e.to_string() })).await;
                        conn.tcp_conns.lock().unwrap().remove(&id);
                        return;
                    }
                }
                // The customer hung up: stop writing, read what the service still sends.
                Some(ToLocal::Close) | None => {
                    let _ = writer.shutdown().await;
                    writing = false;
                }
            },
            _ = conn.closed.cancelled() => return,
        }
    }
    conn.tcp_conns.lock().unwrap().remove(&id);
    conn.send_json(json!({ "type": "tcp_close_response", "connectionId": id })).await;
}

pub fn data(conn: &Arc<Conn>, message: &Value) {
    let Some(id) = message["connectionId"].as_str() else { return };
    let Some(local) = conn.tcp_conns.lock().unwrap().get(id).cloned() else {
        conn.out.err(format!("⚠️ No active TCP connection for [{id}]"));
        return;
    };
    let bytes = B64.decode(message["data"].as_str().unwrap_or_default()).unwrap_or_default();
    if local.queued.fetch_add(bytes.len(), Ordering::Relaxed) + bytes.len() > MAX_QUEUED_BYTES {
        conn.out.err(format!("⚠️ TCP connection [{id}]: the local service isn't reading; closing it"));
        let _ = local.tx.send(ToLocal::Close);
        conn.tcp_conns.lock().unwrap().remove(id);
        return;
    }
    let _ = local.tx.send(ToLocal::Data(bytes));
}

pub fn close(conn: &Arc<Conn>, message: &Value) {
    let Some(id) = message["connectionId"].as_str() else { return };
    if let Some(local) = conn.tcp_conns.lock().unwrap().get(id).cloned() {
        let _ = local.tx.send(ToLocal::Close);
    }
}
