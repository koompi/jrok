//! A visitor's WebSocket, relayed to the local app (the CLI's handleWsConnect /
//! handleWsMessage / handleWsClose). Text stays text and binary stays binary.

use crate::tunnel::Conn;
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::borrow::Cow;
use std::sync::Arc;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::error::{Error as TungsteniteError, ProtocolError, SubProtocolError, UrlError};
use tokio_tungstenite::tungstenite::handshake::client::Request;
use tokio_tungstenite::tungstenite::http::HeaderName;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use tokio_tungstenite::tungstenite::protocol::CloseFrame;
use tokio_tungstenite::tungstenite::Message;

/// Messages a visitor sends before the local connection opens are queued, up to this.
const MAX_PENDING: usize = 1000;

pub enum ToLocal {
    Text(String),
    Binary(Vec<u8>),
    Close(u16, String),
}

/// 1005, 1006 and 1015 only report; anything we may not send becomes 1000.
fn sendable(code: u64) -> u16 {
    match code {
        1000..=1003 | 1007..=1014 | 3000..=4999 => code as u16,
        _ => 1000,
    }
}

pub fn connect(conn: Arc<Conn>, message: &Value) {
    let Some(ws_id) = message["wsId"].as_str().map(String::from) else { return };
    let path = message["path"].as_str().filter(|p| !p.is_empty()).unwrap_or("/").to_string();
    let headers = message["headers"].clone();
    let (tx, rx) = mpsc::channel::<ToLocal>(MAX_PENDING);
    // Registered before connecting, so what the visitor sends meanwhile is queued.
    conn.ws_conns.lock().unwrap().insert(ws_id.clone(), tx);
    tokio::spawn(relay(conn, ws_id, path, headers, rx));
}

/// The handshake to the app: the visitor's headers, and the subprotocol the
/// server already told the visitor (its first choice, P32) when `offer`.
fn local_request(url: &str, headers: &Value, offer: Option<&str>) -> Result<Request, String> {
    let mut req = url.into_client_request().map_err(|e| e.to_string())?;
    if let Some(map) = headers.as_object() {
        for (name, value) in map {
            let lower = name.to_ascii_lowercase();
            if lower == "host" || lower == "upgrade" || lower == "connection" || lower == "content-length" || lower.starts_with("sec-websocket-") {
                continue;
            }
            if let (Some(v), Ok(n)) = (value.as_str(), HeaderName::from_bytes(lower.as_bytes())) {
                if let Ok(v) = v.parse() {
                    req.headers_mut().insert(n, v);
                }
            }
        }
    }
    if let Some(protocol) = offer {
        let value = protocol.parse().map_err(|_| format!("invalid subprotocol {protocol}"))?;
        req.headers_mut().insert("sec-websocket-protocol", value);
    }
    Ok(req)
}

async fn relay(conn: Arc<Conn>, ws_id: String, path: String, headers: Value, mut rx: mpsc::Receiver<ToLocal>) {
    let url = format!("ws://{}:{}{}", conn.cfg.local_host, conn.cfg.local_port, path);
    let offered = headers["sec-websocket-protocol"]
        .as_str()
        .and_then(|h| h.split(',').next())
        .map(str::trim)
        .filter(|p| !p.is_empty())
        .map(String::from);
    let mut local = match local_request(&url, &headers, offered.as_deref()) {
        Ok(req) => tokio_tungstenite::connect_async(req).await.map(|(ws, _)| ws),
        Err(e) => Err(TungsteniteError::Url(UrlError::UnableToConnect(e))),
    };
    // An app that ignores subprotocols answers with none, which the handshake
    // refuses: connect again without offering one.
    if offered.is_some() && matches!(local, Err(TungsteniteError::Protocol(ProtocolError::SecWebSocketSubProtocolError(SubProtocolError::NoSubProtocol)))) {
        conn.out.out(format!("🔁 WS {path} [{ws_id}]: the app ignores subprotocols; connecting again without one"));
        local = match local_request(&url, &headers, None) {
            Ok(req) => tokio_tungstenite::connect_async(req).await.map(|(ws, _)| ws),
            Err(e) => Err(TungsteniteError::Url(UrlError::UnableToConnect(e))),
        };
    }
    let local = match local {
        Ok(ws) => ws,
        Err(error) => {
            let error = error.to_string();
            conn.out.err(format!("❌ WS Error: {path} [{ws_id}]: {error}"));
            conn.ws_conns.lock().unwrap().remove(&ws_id);
            conn.send_json(json!({ "type": "ws_error", "wsId": ws_id, "error": error })).await;
            return;
        }
    };
    let (mut sink, mut stream) = local.split();

    loop {
        tokio::select! {
            command = rx.recv() => match command {
                Some(ToLocal::Text(t)) => { if sink.send(Message::Text(t)).await.is_err() { break } }
                Some(ToLocal::Binary(b)) => { if sink.send(Message::Binary(b)).await.is_err() { break } }
                Some(ToLocal::Close(code, reason)) => {
                    let _ = sink.send(Message::Close(Some(CloseFrame { code: CloseCode::from(code), reason: Cow::Owned(reason) }))).await;
                    break;
                }
                None => break,
            },
            incoming = stream.next() => match incoming {
                Some(Ok(Message::Text(t))) => conn.send_json(json!({ "type": "ws_message_response", "wsId": ws_id, "data": t, "isBinary": false })).await,
                Some(Ok(Message::Binary(b))) => conn.send_json(json!({ "type": "ws_message_response", "wsId": ws_id, "data": B64.encode(&b), "isBinary": true })).await,
                Some(Ok(Message::Close(frame))) => {
                    let (code, reason) = frame.map(|f| (u16::from(f.code), f.reason.to_string())).unwrap_or((1005, String::new()));
                    conn.send_json(json!({ "type": "ws_close_response", "wsId": ws_id, "code": code, "reason": reason })).await;
                    break;
                }
                Some(Ok(_)) => {}
                Some(Err(e)) => {
                    conn.send_json(json!({ "type": "ws_error", "wsId": ws_id, "error": e.to_string() })).await;
                    break;
                }
                None => {
                    conn.send_json(json!({ "type": "ws_close_response", "wsId": ws_id, "code": 1006, "reason": "" })).await;
                    break;
                }
            },
            _ = conn.closed.cancelled() => {
                let _ = sink.send(Message::Close(Some(CloseFrame { code: CloseCode::from(1001), reason: Cow::Borrowed("Server disconnected") }))).await;
                break;
            }
        }
    }
    conn.ws_conns.lock().unwrap().remove(&ws_id);
}

pub fn message(conn: &Arc<Conn>, message: &Value) {
    let Some(ws_id) = message["wsId"].as_str() else { return };
    let Some(tx) = conn.ws_conns.lock().unwrap().get(ws_id).cloned() else {
        conn.out.err(format!("⚠️ No active WebSocket for [{ws_id}]"));
        return;
    };
    let data = message["data"].as_str().unwrap_or_default();
    let payload = if message["isBinary"].as_bool() == Some(true) {
        ToLocal::Binary(B64.decode(data).unwrap_or_default())
    } else {
        ToLocal::Text(data.to_string())
    };
    if tx.try_send(payload).is_err() {
        conn.out.err(format!("⚠️ Too many messages before [{ws_id}] connected; dropping one"));
    }
}

pub fn close(conn: &Arc<Conn>, message: &Value) {
    let Some(ws_id) = message["wsId"].as_str() else { return };
    if let Some(tx) = conn.ws_conns.lock().unwrap().remove(ws_id) {
        let code = sendable(message["code"].as_u64().unwrap_or(1000));
        let reason = message["reason"].as_str().unwrap_or_default().chars().take(120).collect();
        let _ = tx.try_send(ToLocal::Close(code, reason));
    }
}

#[cfg(test)]
mod tests {
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
        assert_eq!(req.headers()["host"], "127.0.0.1:1");

        let again = super::local_request("ws://127.0.0.1:1/", &headers, None).unwrap();
        assert!(again.headers().get("sec-websocket-protocol").is_none());
    }
}
