//! A customer's TCP connection (database, SSH), relayed to the local service
//! (the CLI's handleTcpConnect / handleTcpData / handleTcpClose).
//!
//! Data for the service waits in order: a chunk is never dropped or
//! reordered. When the edge can hold a customer back (it says
//! "tcp_pushback" in its welcome), the tunnel pushes back instead of cutting
//! anyone off: past 8 MB waiting for its services, it stops reading its link
//! (tunnel.rs), and the edge pauses the customer's socket, so a restore slows
//! down while the database stalls (a checkpoint), as through the CLI. A
//! service that holds the link back for longer (30 s) is cut off, so it can't
//! hold up the tunnel's other connections for good.
//!
//! An edge that can't hold a customer back keeps sending whether the link is
//! read or not, and drops what it can't buffer (Bun, past 16 MB), which would
//! leave a hole in the customer's stream. Its link is always read, and a
//! connection whose service falls 64 MB behind is closed, as before push-back.

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
use tokio_tungstenite::tungstenite::Message;
use tokio_util::sync::CancellationToken;

/// The edge's word for "I pause a customer's socket while your link is
/// backed up". Only then may a tunnel stop reading its link.
pub const PUSHBACK: &str = "tcp_pushback";
/// Without push-back: what one connection may have waiting for its service.
/// Beyond it the connection is closed rather than grow memory.
const MAX_QUEUED_BYTES: usize = 64 << 20;

pub enum ToLocal {
    Data(Vec<u8>),
    Close,
}

#[derive(Clone)]
pub struct Local {
    tx: mpsc::UnboundedSender<ToLocal>,
    /// Bytes waiting for this connection's service.
    queued: Arc<AtomicUsize>,
    /// Ends the connection at once: its service fell too far behind.
    cut: CancellationToken,
}

/// `bytes` left a connection's queue: written, or never will be.
fn dequeued(conn: &Conn, queued: &AtomicUsize, bytes: usize) {
    queued.fetch_sub(bytes, Ordering::SeqCst);
    conn.tcp_written(bytes);
}

pub fn connect(conn: Arc<Conn>, message: &Value) {
    let Some(id) = message["connectionId"].as_str().map(String::from) else { return };
    let host = message["localHost"].as_str().filter(|h| !h.is_empty()).unwrap_or(&conn.cfg.local_host).to_string();
    let port = message["localPort"].as_u64().map(|p| p as u16).unwrap_or(conn.cfg.local_port);
    let (tx, mut rx) = mpsc::unbounded_channel::<ToLocal>();
    let local = Local { tx, queued: Arc::new(AtomicUsize::new(0)), cut: CancellationToken::new() };
    let (queued, cut) = (local.queued.clone(), local.cut.clone());
    // Registered first: data the server sends while this connects is kept.
    conn.tcp_conns.lock().unwrap().insert(id.clone(), local);
    tokio::spawn(async move {
        relay(&conn, &id, &host, port, &mut rx, &queued, &cut).await;
        // What still waits will never be written: it no longer holds the link back.
        rx.close();
        while let Ok(command) = rx.try_recv() {
            if let ToLocal::Data(bytes) = command {
                dequeued(&conn, &queued, bytes.len());
            }
        }
    });
}

async fn relay(
    conn: &Arc<Conn>,
    id: &str,
    host: &str,
    port: u16,
    rx: &mut mpsc::UnboundedReceiver<ToLocal>,
    queued: &AtomicUsize,
    cut: &CancellationToken,
) {
    let connecting = tokio::select! {
        connecting = TcpStream::connect((host, port)) => connecting,
        _ = conn.closed.cancelled() => return,
        _ = cut.cancelled() => return,
    };
    let stream = match connecting {
        Ok(s) => s,
        Err(e) => {
            conn.out.err(format!("❌ TCP Error: {host}:{port} [{id}]: {e}"));
            conn.tcp_conns.lock().unwrap().remove(id);
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
    // Both ways at once, so a service slow to read still gets its answers out.
    // The service to the customer, until the service's end (Ok(true)), the
    // link's (Ok(false)) or an error.
    let from_local = async {
        let mut buf = vec![0u8; 64 * 1024];
        loop {
            match reader.read(&mut buf).await {
                Ok(0) => return Ok(true),
                Ok(n) => {
                    if !conn.send_json(json!({ "type": "tcp_data_response", "connectionId": id, "data": B64.encode(&buf[..n]) })).await {
                        return Ok(false);
                    }
                }
                Err(e) => return Err(e),
            }
        }
    };
    // The customer to the service, in order. When the customer hangs up, our
    // writing side shuts and what the service still sends is read on.
    let to_local = async {
        while let Some(command) = rx.recv().await {
            match command {
                ToLocal::Data(bytes) => {
                    // Off the count as it leaves the queue: a write cut short
                    // (the service or the link ended) can't leave it counted.
                    dequeued(conn, queued, bytes.len());
                    writer.write_all(&bytes).await?;
                }
                ToLocal::Close => break,
            }
        }
        let _ = writer.shutdown().await;
        Ok::<(), std::io::Error>(())
    };
    tokio::pin!(from_local, to_local);
    let mut writing = true;
    let ended = loop {
        tokio::select! {
            read = &mut from_local => break read,
            written = &mut to_local, if writing => match written {
                Ok(()) => writing = false,
                Err(e) => break Err(e),
            },
            _ = conn.closed.cancelled() => return,
            // Cut off (the server was told): the service's side goes at once.
            _ = cut.cancelled() => return,
        }
    };
    conn.tcp_conns.lock().unwrap().remove(id);
    match ended {
        Ok(true) => {
            conn.send_json(json!({ "type": "tcp_close_response", "connectionId": id })).await;
        }
        Ok(false) => {}
        Err(e) => {
            conn.send_json(json!({ "type": "tcp_error", "connectionId": id, "error": e.to_string() })).await;
        }
    }
}

pub fn data(conn: &Arc<Conn>, message: &Value) {
    let Some(id) = message["connectionId"].as_str() else { return };
    let Some(local) = conn.tcp_conns.lock().unwrap().get(id).cloned() else {
        conn.out.err(format!("⚠️ No active TCP connection for [{id}]"));
        return;
    };
    let bytes = B64.decode(message["data"].as_str().unwrap_or_default()).unwrap_or_default();
    let len = bytes.len();
    let waiting = local.queued.fetch_add(len, Ordering::SeqCst) + len;
    conn.tcp_queued(len);
    if waiting > MAX_QUEUED_BYTES && !conn.has(PUSHBACK) {
        dequeued(conn, &local.queued, len);
        cut(conn, id, &local, "the local service isn't reading");
        return;
    }
    if local.tx.send(ToLocal::Data(bytes)).is_err() {
        dequeued(conn, &local.queued, len);
    }
}

/// Close a connection whose service fell too far behind, at once: what waits
/// for the service is dropped, and the server is told (tcp_error), so it
/// closes the customer's socket and stops sending for it.
fn cut(conn: &Conn, id: &str, local: &Local, why: &str) {
    conn.out.err(format!("⚠️ TCP connection [{id}]: {why}; closing it"));
    conn.tcp_conns.lock().unwrap().remove(id);
    local.cut.cancel();
    conn.send_now(Message::Text(json!({ "type": "tcp_error", "connectionId": id, "error": why }).to_string()));
}

/// The tunnel's link has been held back `waited` for its TCP services: cut
/// off the connection with the most waiting (its service stopped reading),
/// so it can't hold up the others, new connections and the customers' closes
/// for good. False if no connection has anything waiting.
pub fn cut_slowest(conn: &Conn, waited: Duration) -> bool {
    let slowest = conn
        .tcp_conns
        .lock()
        .unwrap()
        .iter()
        .map(|(id, local)| (local.queued.load(Ordering::SeqCst), id.clone(), local.clone()))
        .filter(|(waiting, _, _)| *waiting > 0)
        .max_by_key(|(waiting, _, _)| *waiting);
    let Some((_, id, local)) = slowest else { return false };
    cut(conn, &id, &local, &format!("the local service stopped reading for {}s", waited.as_secs()));
    true
}

pub fn close(conn: &Arc<Conn>, message: &Value) {
    let Some(id) = message["connectionId"].as_str() else { return };
    if let Some(local) = conn.tcp_conns.lock().unwrap().get(id).cloned() {
        let _ = local.tx.send(ToLocal::Close);
    }
}

#[cfg(test)]
mod tests {
    use crate::tunnel::testing::{self, pattern, stalling_service};
    use base64::engine::general_purpose::STANDARD as B64;
    use base64::Engine;
    use serde_json::json;
    use std::time::Duration;
    use tokio::time::timeout;

    fn tcp_data(chunk: &[u8]) -> serde_json::Value {
        json!({ "connectionId": "c1", "data": B64.encode(chunk) })
    }

    /// The finding's scenario, at the connector: a restore at full speed into a
    /// database that stops reading for a while. Nothing is dropped or cut off.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_service_that_stops_reading_for_a_while_still_gets_everything() {
        let (port, go, done) = stalling_service().await;
        let data = pattern(70 << 20);
        let messages: Vec<_> = data.chunks(64 * 1024).map(tcp_data).collect();
        // An edge that holds the customer back (the tunnel isn't read meanwhile).
        let (conn, _sent, _lines) = testing::conn(port, &[super::PUSHBACK]);
        super::connect(conn.clone(), &json!({ "connectionId": "c1", "localHost": "127.0.0.1", "localPort": port }));
        for message in &messages {
            super::data(&conn, message);
        }
        super::close(&conn, &json!({ "connectionId": "c1" }));
        go.send(()).unwrap();
        let got = timeout(Duration::from_secs(30), done).await.unwrap().unwrap();
        assert_eq!(got.len(), data.len(), "the connection was cut off");
        assert!(got == data, "bytes were reordered or changed");
    }

    /// An edge that can't hold the customer back: its link is read, so a
    /// service that falls 64 MB behind is cut off, as before push-back. The
    /// edge is told (tcp_error), and nothing stays counted.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn without_push_back_a_service_64_mb_behind_is_cut_off() {
        let (port, go, done) = stalling_service().await;
        let (conn, mut sent, _lines) = testing::conn(port, &["stream"]);
        super::connect(conn.clone(), &json!({ "connectionId": "c1", "localHost": "127.0.0.1", "localPort": port }));
        for chunk in pattern(70 << 20).chunks(64 * 1024) {
            super::data(&conn, &tcp_data(chunk));
        }
        assert!(conn.tcp_conns.lock().unwrap().is_empty(), "still open");
        let told = testing::sent_json(&mut sent);
        assert!(told.iter().any(|m| m["type"] == "tcp_error" && m["connectionId"] == "c1"), "{told:?}");
        go.send(()).unwrap();
        let got = timeout(Duration::from_secs(10), done).await.unwrap().unwrap();
        assert!(got.len() < 64 << 20, "the service got {} bytes", got.len());
        for _ in 0..50 {
            if conn.tcp_backlog() == 0 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert_eq!(conn.tcp_backlog(), 0);
    }

    /// A service that hangs up its side without reading what it was sent
    /// (a failed login, say), while our write to it is stuck: when the
    /// connection ends, none of its bytes may still hold the tunnel's link back.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_connection_that_ends_mid_write_leaves_nothing_counted() {
        use tokio::io::AsyncWriteExt;
        let socket = socket2::Socket::new(socket2::Domain::IPV4, socket2::Type::STREAM, None).unwrap();
        socket.set_recv_buffer_size(64 * 1024).unwrap();
        socket.bind(&"127.0.0.1:0".parse::<std::net::SocketAddr>().unwrap().into()).unwrap();
        socket.listen(8).unwrap();
        socket.set_nonblocking(true).unwrap();
        let listener = tokio::net::TcpListener::from_std(socket.into()).unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            let (mut s, _) = listener.accept().await.unwrap();
            tokio::time::sleep(Duration::from_millis(300)).await;
            let _ = s.shutdown().await;
            tokio::time::sleep(Duration::from_secs(5)).await;
        });
        let (conn, _sent, _lines) = testing::conn(port, &[]);
        super::connect(conn.clone(), &json!({ "connectionId": "c1", "localHost": "127.0.0.1", "localPort": port }));
        for chunk in pattern(6 << 20).chunks(64 * 1024) {
            super::data(&conn, &tcp_data(chunk));
        }
        for _ in 0..100 {
            if conn.tcp_conns.lock().unwrap().is_empty() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert!(conn.tcp_conns.lock().unwrap().is_empty(), "the connection didn't end");
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert_eq!(conn.tcp_backlog(), 0);
    }
}

