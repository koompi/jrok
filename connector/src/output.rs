//! Everything a tunnel says goes through one writer, so lines never interleave.
//!
//! Control mode (the deploy worker): JSON lines, `{"id":…,"out":"<line>"}`,
//! `{"id":…,"err":"<line>"}`, `{"id":…,"exit":<code>}`. Each `out` line is what
//! the jrok CLI would have printed for that tunnel, including its
//! `@jrok:req` / `@jrok:tcp` events, so the worker parses them unchanged.
//! Run mode (one tunnel, for testing): the lines themselves.

use tokio::sync::mpsc::UnboundedSender;

#[derive(Clone)]
pub struct Output {
    id: Option<String>,
    tx: UnboundedSender<String>,
}

impl Output {
    pub fn new(id: Option<String>, tx: UnboundedSender<String>) -> Output {
        Output { id, tx }
    }

    fn emit(&self, stream: &str, line: &str) {
        let text = match &self.id {
            Some(id) => serde_json::json!({ "id": id, stream: line }).to_string(),
            None => line.to_string(),
        };
        let _ = self.tx.send(text);
    }

    pub fn out(&self, line: impl AsRef<str>) {
        self.emit("out", line.as_ref());
    }

    pub fn err(&self, line: impl AsRef<str>) {
        self.emit("err", line.as_ref());
    }

    /// A structured event, `@jrok:<kind> {json}`, as the CLI prints them.
    pub fn event(&self, kind: &str, payload: serde_json::Value) {
        self.out(format!("@jrok:{kind} {payload}"));
    }

    pub fn exit(&self, code: i32) {
        if let Some(id) = &self.id {
            let _ = self.tx.send(serde_json::json!({ "id": id, "exit": code }).to_string());
        }
    }
}
