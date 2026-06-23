//! Modbus/TCP driver — the second field protocol after BACnet, proving the
//! building model is protocol-agnostic. Integrators live in mixed-protocol
//! plants (meters, VFDs, gateways), so Modbus is the highest-value driver to add
//! next.
//!
//! Transport: a short-lived `TcpStream` per request (Modbus/TCP is connectionless
//! at the application layer — one MBAP-framed request, one response). The frame
//! codec is split into pure build/parse functions so it is unit-tested without a
//! socket, mirroring how `bacnet_codec` is tested independently of `bacnet`.

use std::io::{Read, Write};
use std::net::TcpStream;
use std::time::Duration;

use serde::{Deserialize, Serialize};

const PROTOCOL_ID: u16 = 0; // Modbus
const READ_HOLDING: u8 = 0x03;
const READ_INPUT: u8 = 0x04;
const WRITE_SINGLE: u8 = 0x06;
const WRITE_MULTIPLE: u8 = 0x10;
const DEFAULT_TIMEOUT: Duration = Duration::from_millis(3000);
const MAX_REGISTERS: u16 = 125; // Modbus spec cap for a single read

/// Which register bank to read. Holding (0x03, read/write) vs input (0x04,
/// read-only) is the only distinction the codec needs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RegisterKind {
    Holding,
    Input,
}

impl RegisterKind {
    fn function(self) -> u8 {
        match self {
            RegisterKind::Holding => READ_HOLDING,
            RegisterKind::Input => READ_INPUT,
        }
    }

    fn parse(s: &str) -> Result<Self, String> {
        match s.trim().to_ascii_lowercase().as_str() {
            "holding" | "hr" | "4x" => Ok(RegisterKind::Holding),
            "input" | "ir" | "3x" => Ok(RegisterKind::Input),
            other => Err(format!("unknown register kind \"{other}\" (use holding|input)")),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegisterReadResult {
    pub address: u16,
    pub count: u16,
    pub registers: Vec<u16>,
}

// ---- Pure frame codec (unit-tested without a socket) ----

/// Build an MBAP-framed read request for holding/input registers.
fn build_read_request(txid: u16, unit: u8, kind: RegisterKind, address: u16, count: u16) -> Vec<u8> {
    let mut pdu = Vec::with_capacity(5);
    pdu.push(kind.function());
    pdu.extend_from_slice(&address.to_be_bytes());
    pdu.extend_from_slice(&count.to_be_bytes());
    frame_mbap(txid, unit, &pdu)
}

/// Build an MBAP-framed write-single-register request (function 0x06).
fn build_write_single_request(txid: u16, unit: u8, address: u16, value: u16) -> Vec<u8> {
    let mut pdu = Vec::with_capacity(5);
    pdu.push(WRITE_SINGLE);
    pdu.extend_from_slice(&address.to_be_bytes());
    pdu.extend_from_slice(&value.to_be_bytes());
    frame_mbap(txid, unit, &pdu)
}

/// Build an MBAP-framed write-multiple-registers request (function 0x10).
fn build_write_multiple_request(txid: u16, unit: u8, address: u16, values: &[u16]) -> Vec<u8> {
    let mut pdu = Vec::with_capacity(6 + values.len() * 2);
    pdu.push(WRITE_MULTIPLE);
    pdu.extend_from_slice(&address.to_be_bytes());
    pdu.extend_from_slice(&(values.len() as u16).to_be_bytes());
    pdu.push((values.len() * 2) as u8);
    for v in values {
        pdu.extend_from_slice(&v.to_be_bytes());
    }
    frame_mbap(txid, unit, &pdu)
}

/// Wrap a PDU in the 7-byte MBAP header.
fn frame_mbap(txid: u16, unit: u8, pdu: &[u8]) -> Vec<u8> {
    let length = (pdu.len() + 1) as u16; // unit id + pdu
    let mut frame = Vec::with_capacity(7 + pdu.len());
    frame.extend_from_slice(&txid.to_be_bytes());
    frame.extend_from_slice(&PROTOCOL_ID.to_be_bytes());
    frame.extend_from_slice(&length.to_be_bytes());
    frame.push(unit);
    frame.extend_from_slice(pdu);
    frame
}

/// Parse a read-response frame into register words. Validates the MBAP echo,
/// the function code (detecting exception responses), and the byte count.
fn parse_read_response(txid: u16, expected_fn: u8, frame: &[u8]) -> Result<Vec<u16>, String> {
    let pdu = parse_mbap(txid, frame)?;
    check_function(expected_fn, pdu)?;
    let byte_count = *pdu.get(1).ok_or("short response: missing byte count")? as usize;
    let data = pdu.get(2..2 + byte_count).ok_or("short response: truncated register data")?;
    if byte_count % 2 != 0 {
        return Err(format!("odd register byte count {byte_count}"));
    }
    Ok(data
        .chunks_exact(2)
        .map(|c| u16::from_be_bytes([c[0], c[1]]))
        .collect())
}

/// Validate a write response (the device echoes address; we just confirm no
/// exception and the function matches).
fn parse_write_response(txid: u16, expected_fn: u8, frame: &[u8]) -> Result<(), String> {
    let pdu = parse_mbap(txid, frame)?;
    check_function(expected_fn, pdu)?;
    Ok(())
}

/// Strip + validate the MBAP header, returning the PDU slice.
fn parse_mbap(txid: u16, frame: &[u8]) -> Result<&[u8], String> {
    if frame.len() < 8 {
        return Err(format!("short MBAP frame ({} bytes)", frame.len()));
    }
    let rx_txid = u16::from_be_bytes([frame[0], frame[1]]);
    if rx_txid != txid {
        return Err(format!("transaction id mismatch (sent {txid}, got {rx_txid})"));
    }
    let proto = u16::from_be_bytes([frame[2], frame[3]]);
    if proto != PROTOCOL_ID {
        return Err(format!("non-Modbus protocol id {proto}"));
    }
    let length = u16::from_be_bytes([frame[4], frame[5]]) as usize;
    // length counts unit id + pdu; frame is 6 header + length.
    if frame.len() < 6 + length {
        return Err("MBAP length exceeds received bytes".into());
    }
    Ok(&frame[7..6 + length])
}

/// Detect a Modbus exception response (function | 0x80) and surface its code.
fn check_function(expected: u8, pdu: &[u8]) -> Result<(), String> {
    let func = *pdu.first().ok_or("empty PDU")?;
    if func == expected {
        return Ok(());
    }
    if func == expected | 0x80 {
        let code = pdu.get(1).copied().unwrap_or(0);
        return Err(format!("Modbus exception {code} ({})", exception_text(code)));
    }
    Err(format!("unexpected function 0x{func:02x} (expected 0x{expected:02x})"))
}

fn exception_text(code: u8) -> &'static str {
    match code {
        1 => "illegal function",
        2 => "illegal data address",
        3 => "illegal data value",
        4 => "server device failure",
        5 => "acknowledge",
        6 => "server device busy",
        _ => "unknown",
    }
}

// ---- Register decoding helpers (exposed for the frontend via a command) ----

/// Decode two consecutive registers as a 32-bit float. `word_swap` handles the
/// common "Modbus float byte order" ambiguity between gateways. Consumed by the
/// frontend normalization layer / tests; allow until a command exposes it.
#[allow(dead_code)]
pub fn decode_f32(hi: u16, lo: u16, word_swap: bool) -> f32 {
    let (a, b) = if word_swap { (lo, hi) } else { (hi, lo) };
    f32::from_bits(((a as u32) << 16) | (b as u32))
}

// ---- Networking ----

fn transact(host: &str, port: u16, request: &[u8]) -> Result<Vec<u8>, String> {
    use std::net::ToSocketAddrs;
    let addr = format!("{host}:{port}");
    // Bound the connect: a bare TcpStream::connect to an offline host blocks for
    // the OS default (20-30s). connect_timeout caps it at DEFAULT_TIMEOUT.
    let socket_addr = addr
        .to_socket_addrs()
        .map_err(|e| format!("resolve {addr}: {e}"))?
        .next()
        .ok_or_else(|| format!("could not resolve address {addr}"))?;
    let mut stream = TcpStream::connect_timeout(&socket_addr, DEFAULT_TIMEOUT)
        .map_err(|e| format!("connect {addr}: {e}"))?;
    stream
        .set_read_timeout(Some(DEFAULT_TIMEOUT))
        .map_err(|e| e.to_string())?;
    stream
        .set_write_timeout(Some(DEFAULT_TIMEOUT))
        .map_err(|e| e.to_string())?;
    stream.write_all(request).map_err(|e| format!("write: {e}"))?;
    let mut buf = [0u8; 260]; // max Modbus/TCP ADU
    let n = stream.read(&mut buf).map_err(|e| format!("read: {e}"))?;
    if n == 0 {
        return Err("device closed connection without responding".into());
    }
    Ok(buf[..n].to_vec())
}

// ---- Tauri commands ----

// The three command bodies do blocking TCP I/O via `transact`. They are `async`
// and run the blocking work inside `spawn_blocking` so a slow/unreachable Modbus
// host never freezes the main thread (and thus the UI).
#[tauri::command]
pub async fn modbus_read_registers(
    host: String,
    port: Option<u16>,
    unit_id: Option<u8>,
    kind: Option<String>,
    address: u16,
    count: u16,
) -> Result<RegisterReadResult, String> {
    if count == 0 || count > MAX_REGISTERS {
        return Err(format!("count must be 1..={MAX_REGISTERS}"));
    }
    let port = port.unwrap_or(502);
    let unit = unit_id.unwrap_or(1);
    let kind = RegisterKind::parse(kind.as_deref().unwrap_or("holding"))?;
    tauri::async_runtime::spawn_blocking(move || -> Result<RegisterReadResult, String> {
        let txid = 1;
        let req = build_read_request(txid, unit, kind, address, count);
        let resp = transact(&host, port, &req)?;
        let registers = parse_read_response(txid, kind.function(), &resp)?;
        Ok(RegisterReadResult { address, count, registers })
    })
    .await
    .map_err(|e| format!("modbus task panicked: {e}"))?
}

#[tauri::command]
pub async fn modbus_write_register(
    host: String,
    port: Option<u16>,
    unit_id: Option<u8>,
    address: u16,
    value: u16,
) -> Result<(), String> {
    let port = port.unwrap_or(502);
    let unit = unit_id.unwrap_or(1);
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let txid = 1;
        let req = build_write_single_request(txid, unit, address, value);
        let resp = transact(&host, port, &req)?;
        parse_write_response(txid, WRITE_SINGLE, &resp)
    })
    .await
    .map_err(|e| format!("modbus task panicked: {e}"))?
}

#[tauri::command]
pub async fn modbus_write_registers(
    host: String,
    port: Option<u16>,
    unit_id: Option<u8>,
    address: u16,
    values: Vec<u16>,
) -> Result<(), String> {
    if values.is_empty() || values.len() > 123 {
        return Err("values must be 1..=123 registers".into());
    }
    let port = port.unwrap_or(502);
    let unit = unit_id.unwrap_or(1);
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let txid = 1;
        let req = build_write_multiple_request(txid, unit, address, &values);
        let resp = transact(&host, port, &req)?;
        parse_write_response(txid, WRITE_MULTIPLE, &resp)
    })
    .await
    .map_err(|e| format!("modbus task panicked: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn read_request_has_mbap_and_pdu() {
        let req = build_read_request(7, 1, RegisterKind::Holding, 0x0010, 2);
        // txid=7, proto=0, len=6, unit=1, fn=3, addr=0x0010, qty=2
        assert_eq!(req, vec![0, 7, 0, 0, 0, 6, 1, 3, 0, 0x10, 0, 2]);
    }

    #[test]
    fn parse_read_response_extracts_registers() {
        // unit=1 fn=3 bytecount=4 regs=[0x1234,0x5678], txid=7
        let frame = vec![0, 7, 0, 0, 0, 7, 1, 3, 4, 0x12, 0x34, 0x56, 0x78];
        let regs = parse_read_response(7, READ_HOLDING, &frame).unwrap();
        assert_eq!(regs, vec![0x1234, 0x5678]);
    }

    #[test]
    fn exception_response_is_surfaced() {
        // fn 0x83 = exception on read-holding, code 2 (illegal data address)
        let frame = vec![0, 7, 0, 0, 0, 3, 1, 0x83, 2];
        let err = parse_read_response(7, READ_HOLDING, &frame).unwrap_err();
        assert!(err.contains("illegal data address"), "got: {err}");
    }

    #[test]
    fn txid_mismatch_is_rejected() {
        let frame = vec![0, 9, 0, 0, 0, 7, 1, 3, 4, 0, 0, 0, 0];
        assert!(parse_read_response(7, READ_HOLDING, &frame).is_err());
    }

    #[test]
    fn write_single_roundtrip_frame() {
        let req = build_write_single_request(1, 1, 0x0001, 0x00FF);
        assert_eq!(req, vec![0, 1, 0, 0, 0, 6, 1, 6, 0, 1, 0, 0xFF]);
        // Device echoes the request on success.
        assert!(parse_write_response(1, WRITE_SINGLE, &req).is_ok());
    }

    #[test]
    fn float_decode_handles_word_order() {
        // 1.0f32 = 0x3F800000 -> regs [0x3F80, 0x0000]
        assert_eq!(decode_f32(0x3F80, 0x0000, false), 1.0);
        assert_eq!(decode_f32(0x0000, 0x3F80, true), 1.0);
    }

    #[test]
    fn kind_parsing_accepts_aliases() {
        assert_eq!(RegisterKind::parse("holding").unwrap(), RegisterKind::Holding);
        assert_eq!(RegisterKind::parse("3x").unwrap(), RegisterKind::Input);
        assert!(RegisterKind::parse("coil").is_err());
    }
}
