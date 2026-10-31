//! jrok-connector: one process per worker carrying every jrok tunnel on it
//! (plan Phase 5, docs/plans/jrok-scale-out-plan.md).
//!
//! Each tunnel speaks the same agent protocol as the jrok CLI, one WebSocket
//! per tunnel per edge, so jrok servers need no change. What differs is the
//! cost: a CLI agent is a ~62 MB Node process per tunnel per edge; here a
//! tunnel is a few tasks and a connection.
//!
//!   jrok-connector              control mode, for the deploy worker:
//!                               stdin  {"op":"open","id":"t1","args":["--server",…]}
//!                                      {"op":"close","id":"t1"}
//!                               stdout see output.rs; exits when stdin closes
//!   jrok-connector run <args>   one tunnel, CLI arguments, like `jrok`
//!   jrok-connector --version

mod args;
mod frames;
mod http;
mod output;
mod tcp;
mod tunnel;
mod ws;

use std::collections::HashMap;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

pub const VERSION: &str = env!("CARGO_PKG_VERSION");

#[tokio::main]
async fn main() {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let argv: Vec<String> = std::env::args().skip(1).collect();
    if argv.first().map(String::as_str) == Some("--version") {
        println!("jrok-connector {VERSION}");
        return;
    }

    let (tx, mut rx) = mpsc::unbounded_channel::<String>();
    let writer = tokio::spawn(async move {
        let mut stdout = tokio::io::stdout();
        while let Some(line) = rx.recv().await {
            if stdout.write_all(line.as_bytes()).await.is_err() || stdout.write_all(b"\n").await.is_err() {
                break;
            }
            let _ = stdout.flush().await;
        }
    });

    if argv.first().map(String::as_str) == Some("run") {
        let out = output::Output::new(None, tx.clone());
        match args::TunnelConfig::from_args(&argv[1..]) {
            Ok(cfg) => tunnel::run(cfg, out, CancellationToken::new()).await,
            Err(e) => {
                eprintln!("jrok-connector: {e}");
                std::process::exit(2);
            }
        }
        return;
    }

    control(tx).await;
    // Nobody reads what is left: don't wait on a tunnel still winding down.
    let _ = tokio::time::timeout(std::time::Duration::from_secs(1), writer).await;
    std::process::exit(0);
}

/// Open and close tunnels as the worker asks; stop them all when it goes away.
async fn control(tx: mpsc::UnboundedSender<String>) {
    let _ = tx.send(serde_json::json!({ "ready": true, "version": VERSION }).to_string());
    let mut tunnels: HashMap<String, CancellationToken> = HashMap::new();
    let mut lines = BufReader::new(tokio::io::stdin()).lines();

    while let Ok(Some(line)) = lines.next_line().await {
        let Ok(cmd) = serde_json::from_str::<serde_json::Value>(&line) else {
            eprintln!("jrok-connector: not JSON: {line}");
            continue;
        };
        let id = cmd["id"].as_str().unwrap_or_default().to_string();
        match cmd["op"].as_str() {
            Some("open") if !id.is_empty() => {
                let out = output::Output::new(Some(id.clone()), tx.clone());
                let argv: Vec<String> = cmd["args"]
                    .as_array()
                    .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
                    .unwrap_or_default();
                match args::TunnelConfig::from_args(&argv) {
                    Ok(cfg) => {
                        let stop = CancellationToken::new();
                        if let Some(old) = tunnels.insert(id.clone(), stop.clone()) {
                            old.cancel();
                        }
                        // A panic (a bug) ends only this tunnel, and is reported
                        // as an exit so the worker opens it again.
                        tokio::spawn(async move {
                            let code = match tokio::spawn(tunnel::run(cfg, out.clone(), stop)).await {
                                Ok(()) => 0,
                                Err(e) => {
                                    out.err(format!("jrok-connector: tunnel failed: {e}"));
                                    1
                                }
                            };
                            out.exit(code);
                        });
                    }
                    Err(e) => {
                        out.err(format!("jrok-connector: {e}"));
                        out.exit(2);
                    }
                }
            }
            Some("close") => {
                if let Some(stop) = tunnels.remove(&id) {
                    stop.cancel();
                }
            }
            _ => eprintln!("jrok-connector: unknown command: {line}"),
        }
    }

    // The worker went away: so do its tunnels.
    for stop in tunnels.values() {
        stop.cancel();
    }
    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    drop(tx);
}
