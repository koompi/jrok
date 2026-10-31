//! Binary frames to the server (jrok docs/protocol/tunnel-frames.md):
//! kind, request id length, request id, payload. Sent only when the server
//! advertised "binchunk".

pub const FRAME_RESPONSE_CHUNK: u8 = 0x01;

pub fn response_chunk(request_id: &str, payload: &[u8]) -> Vec<u8> {
    let id = request_id.as_bytes();
    let mut frame = Vec::with_capacity(2 + id.len() + payload.len());
    frame.push(FRAME_RESPONSE_CHUNK);
    frame.push(id.len().min(255) as u8);
    frame.extend_from_slice(&id[..id.len().min(255)]);
    frame.extend_from_slice(payload);
    frame
}

#[cfg(test)]
mod tests {
    #[test]
    fn layout_matches_the_server_decoder() {
        let f = super::response_chunk("req-1", &[0, 255, 7]);
        assert_eq!(f, vec![0x01, 5, b'r', b'e', b'q', b'-', b'1', 0, 255, 7]);
    }
}
