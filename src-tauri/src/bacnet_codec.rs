//! BACnet/IP wire-format codec (ASHRAE 135, Annex J).
//!
//! Pure functions over byte slices — no sockets, no global state — so every
//! encoder/decoder is unit-testable against known-good frames. Byte layouts were
//! verified against the bacnet-stack reference implementation (bvlc.h, npdu.c,
//! bacdcode.c, rp.c, wp.c, whois.c, iam.c) and Wireshark's BACnet dissector.
//!
//! Scope: the un-segmented client subset a BACnet explorer needs — Who-Is/I-Am
//! discovery, ReadProperty, ReadPropertyMultiple, WriteProperty — plus BVLC and
//! NPDU framing including routed networks (DNET/SNET) and Forwarded-NPDU.

use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/// Default BACnet/IP UDP port (0xBAC0).
pub const BACNET_PORT: u16 = 47808;

/// BVLL type octet for BACnet/IP (Annex J).
pub const BVLL_TYPE_BACNET_IP: u8 = 0x81;

// BVLC function codes. The foreign-device codes are exercised by tests and
// kept for the BBMD registration path (cross-subnet discovery).
pub const BVLC_RESULT: u8 = 0x00;
pub const BVLC_FORWARDED_NPDU: u8 = 0x04;
#[allow(dead_code)]
pub const BVLC_REGISTER_FOREIGN_DEVICE: u8 = 0x05;
#[allow(dead_code)]
pub const BVLC_DISTRIBUTE_BROADCAST: u8 = 0x09;
pub const BVLC_ORIGINAL_UNICAST: u8 = 0x0A;
pub const BVLC_ORIGINAL_BROADCAST: u8 = 0x0B;

// APDU PDU types (upper nibble of the first APDU octet).
pub const PDU_CONFIRMED: u8 = 0x00;
pub const PDU_UNCONFIRMED: u8 = 0x10;
pub const PDU_SIMPLE_ACK: u8 = 0x20;
pub const PDU_COMPLEX_ACK: u8 = 0x30;
pub const PDU_SEGMENT_ACK: u8 = 0x40;
pub const PDU_ERROR: u8 = 0x50;
pub const PDU_REJECT: u8 = 0x60;
pub const PDU_ABORT: u8 = 0x70;

// Unconfirmed service choices.
pub const SERVICE_I_AM: u8 = 0;
pub const SERVICE_UNCONFIRMED_COV_NOTIFICATION: u8 = 2;
pub const SERVICE_WHO_IS: u8 = 8;

// Confirmed service choices.
pub const SERVICE_CONFIRMED_COV_NOTIFICATION: u8 = 1;
pub const SERVICE_SUBSCRIBE_COV: u8 = 5;
pub const SERVICE_READ_PROPERTY: u8 = 12;
pub const SERVICE_READ_PROPERTY_MULTIPLE: u8 = 14;
pub const SERVICE_WRITE_PROPERTY: u8 = 15;
pub const SERVICE_READ_RANGE: u8 = 26;

// Confirmed-request octet-0 flag bits (clause 20.1.2).
/// SEG — this request is itself segmented (we never send segmented requests).
pub const APDU_FLAG_SEGMENTED: u8 = 0x08;
/// MOR — more segments follow.
pub const APDU_FLAG_MORE: u8 = 0x04;
/// SA — segmented-response-accepted: we can receive a segmented reply.
pub const APDU_FLAG_SA: u8 = 0x02;

/// Octet 1 of a confirmed request: `max-segments-accepted = 16` (code 4) in bits
/// 6-4, `max-APDU-accepted = 1476` (code 5) in bits 3-0. Paired with the SA flag
/// in octet 0, this tells a device it may segment a large reply to us (up to 16
/// segments). Devices that can't fit a reply in one APDU now segment instead of
/// aborting; the index-by-index / RPM-shrink fallbacks remain for ones that still do.
pub const MAX_SEGS_MAX_APDU: u8 = 0x45;

/// NPDU global-broadcast network number.
pub const BROADCAST_NETWORK: u16 = 0xFFFF;

// Network-layer message types (clause 6.4).
pub const NETWORK_MSG_WHO_IS_ROUTER_TO_NETWORK: u8 = 0x00;
pub const NETWORK_MSG_I_AM_ROUTER_TO_NETWORK: u8 = 0x01;

// Well-known property identifiers used by the client.
pub const PROP_ALL: u32 = 8;
pub const PROP_OBJECT_LIST: u32 = 76;
pub const PROP_OBJECT_NAME: u32 = 77;
pub const PROP_PRESENT_VALUE: u32 = 85;
pub const PROP_PRIORITY_ARRAY: u32 = 87;
pub const PROP_RELINQUISH_DEFAULT: u32 = 104;
pub const PROP_VENDOR_NAME: u32 = 121;
pub const PROP_MODEL_NAME: u32 = 70;
pub const PROP_LOG_BUFFER: u32 = 131;
pub const PROP_RECORD_COUNT: u32 = 141;

/// Device object type number.
pub const OBJECT_TYPE_DEVICE: u16 = 8;
/// Trend-log object type number.
pub const OBJECT_TYPE_TREND_LOG: u16 = 20;

// ---------------------------------------------------------------------------
// Object identifier
// ---------------------------------------------------------------------------

/// A BACnetObjectIdentifier: 10-bit object type + 22-bit instance, packed into
/// a big-endian u32 on the wire.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ObjectId {
    pub object_type: u16,
    pub instance: u32,
}

impl ObjectId {
    pub fn new(object_type: u16, instance: u32) -> Self {
        Self { object_type, instance }
    }

    pub fn to_raw(self) -> u32 {
        ((self.object_type as u32 & 0x3FF) << 22) | (self.instance & 0x3F_FFFF)
    }

    pub fn from_raw(raw: u32) -> Self {
        Self {
            object_type: ((raw >> 22) & 0x3FF) as u16,
            instance: raw & 0x3F_FFFF,
        }
    }
}

// ---------------------------------------------------------------------------
// Value model
// ---------------------------------------------------------------------------

/// A decoded BACnet application-tagged value. Serialized for the frontend as
/// `{ "kind": "...", ...fields }`; the frontend builds the same shape for writes.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum BacnetValue {
    Null,
    Boolean { value: bool },
    Unsigned { value: u64 },
    Signed { value: i64 },
    Real { value: f32 },
    Double { value: f64 },
    OctetString { hex: String },
    CharacterString { value: String },
    BitString { unused_bits: u8, bits: String },
    Enumerated { value: u32 },
    Date { year: u16, month: u8, day: u8, weekday: u8 },
    Time { hour: u8, minute: u8, second: u8, hundredths: u8 },
    ObjectIdentifier { object_type: u16, instance: u32 },
    /// Constructed/context-specific or proprietary content we don't model;
    /// kept as raw hex so nothing is silently dropped.
    Unknown { tag: u8, hex: String },
}

// ---------------------------------------------------------------------------
// Tag primitives (clause 20.2)
// ---------------------------------------------------------------------------

/// A decoded initial-tag octet (plus extended tag-number/length octets).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Tag {
    pub number: u8,
    pub context: bool,
    /// Length of the content octets for data tags. For an application Boolean
    /// the value lives here (0/1, no content octets).
    pub lvt: u32,
    pub opening: bool,
    pub closing: bool,
    /// Octets consumed by the tag itself (initial octet + extensions).
    pub header_len: usize,
}

fn err_short() -> String {
    "truncated BACnet frame".to_string()
}

/// Decodes the tag at the start of `buf`.
pub fn decode_tag(buf: &[u8]) -> Result<Tag, String> {
    let first = *buf.first().ok_or_else(err_short)?;
    let context = first & 0x08 != 0;
    let mut at = 1usize;

    let number = if first & 0xF0 == 0xF0 {
        let n = *buf.get(at).ok_or_else(err_short)?;
        at += 1;
        n
    } else {
        first >> 4
    };

    let lvt_bits = first & 0x07;
    let (lvt, opening, closing) = match lvt_bits {
        6 => (0, true, false),
        7 => (0, false, true),
        5 => {
            let ext = *buf.get(at).ok_or_else(err_short)?;
            at += 1;
            let len = match ext {
                254 => {
                    let b = buf.get(at..at + 2).ok_or_else(err_short)?;
                    at += 2;
                    u16::from_be_bytes([b[0], b[1]]) as u32
                }
                255 => {
                    let b = buf.get(at..at + 4).ok_or_else(err_short)?;
                    at += 4;
                    u32::from_be_bytes([b[0], b[1], b[2], b[3]])
                }
                n => n as u32,
            };
            (len, false, false)
        }
        n => (n as u32, false, false),
    };

    Ok(Tag { number, context, lvt, opening, closing, header_len: at })
}

/// Encodes a data tag (application or context) with the given length/value field.
pub fn encode_tag(buf: &mut Vec<u8>, number: u8, context: bool, lvt: u32) {
    let class_bit = if context { 0x08 } else { 0x00 };
    let num_bits = if number <= 14 { number << 4 } else { 0xF0 };
    let lvt_bits = if lvt <= 4 { lvt as u8 } else { 5 };
    buf.push(num_bits | class_bit | lvt_bits);
    if number > 14 {
        buf.push(number);
    }
    if lvt > 4 {
        if lvt <= 253 {
            buf.push(lvt as u8);
        } else if lvt <= 65535 {
            buf.push(254);
            buf.extend_from_slice(&(lvt as u16).to_be_bytes());
        } else {
            buf.push(255);
            buf.extend_from_slice(&lvt.to_be_bytes());
        }
    }
}

pub fn encode_opening_tag(buf: &mut Vec<u8>, number: u8) {
    let num_bits = if number <= 14 { number << 4 } else { 0xF0 };
    buf.push(num_bits | 0x08 | 6);
    if number > 14 {
        buf.push(number);
    }
}

pub fn encode_closing_tag(buf: &mut Vec<u8>, number: u8) {
    let num_bits = if number <= 14 { number << 4 } else { 0xF0 };
    buf.push(num_bits | 0x08 | 7);
    if number > 14 {
        buf.push(number);
    }
}

/// Minimal big-endian content octets for an unsigned value (always >= 1 octet).
fn unsigned_content(v: u64) -> Vec<u8> {
    let bytes = v.to_be_bytes();
    let skip = (v.leading_zeros() / 8).min(7) as usize;
    bytes[skip..].to_vec()
}

/// Minimal big-endian two's-complement content octets for a signed value.
fn signed_content(v: i64) -> Vec<u8> {
    let mut n = 1usize;
    while n < 8 {
        let bits = (n * 8 - 1) as u32;
        if v >= -(1i64 << bits) && v < (1i64 << bits) {
            break;
        }
        n += 1;
    }
    v.to_be_bytes()[8 - n..].to_vec()
}

fn decode_unsigned_content(content: &[u8]) -> Result<u64, String> {
    if content.is_empty() || content.len() > 8 {
        return Err(format!("bad unsigned length {}", content.len()));
    }
    let mut v = 0u64;
    for b in content {
        v = (v << 8) | *b as u64;
    }
    Ok(v)
}

fn decode_signed_content(content: &[u8]) -> Result<i64, String> {
    if content.is_empty() || content.len() > 8 {
        return Err(format!("bad signed length {}", content.len()));
    }
    let mut v: i64 = if content[0] & 0x80 != 0 { -1 } else { 0 };
    for b in content {
        v = (v << 8) | *b as i64;
    }
    Ok(v)
}

fn hex_string(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02X}")).collect()
}

// ---------------------------------------------------------------------------
// Application values
// ---------------------------------------------------------------------------

// Application tag numbers (clause 20.2.1.4).
const TAG_NULL: u8 = 0;
const TAG_BOOLEAN: u8 = 1;
const TAG_UNSIGNED: u8 = 2;
const TAG_SIGNED: u8 = 3;
const TAG_REAL: u8 = 4;
const TAG_DOUBLE: u8 = 5;
const TAG_OCTET_STRING: u8 = 6;
const TAG_CHARACTER_STRING: u8 = 7;
const TAG_BIT_STRING: u8 = 8;
const TAG_ENUMERATED: u8 = 9;
const TAG_DATE: u8 = 10;
const TAG_TIME: u8 = 11;
const TAG_OBJECT_ID: u8 = 12;

/// Encodes one application-tagged value.
pub fn encode_application_value(buf: &mut Vec<u8>, v: &BacnetValue) {
    match v {
        BacnetValue::Null => encode_tag(buf, TAG_NULL, false, 0),
        BacnetValue::Boolean { value } => {
            // Application Boolean carries its value in the LVT field; no content.
            encode_tag(buf, TAG_BOOLEAN, false, if *value { 1 } else { 0 });
        }
        BacnetValue::Unsigned { value } => {
            let c = unsigned_content(*value);
            encode_tag(buf, TAG_UNSIGNED, false, c.len() as u32);
            buf.extend_from_slice(&c);
        }
        BacnetValue::Signed { value } => {
            let c = signed_content(*value);
            encode_tag(buf, TAG_SIGNED, false, c.len() as u32);
            buf.extend_from_slice(&c);
        }
        BacnetValue::Real { value } => {
            encode_tag(buf, TAG_REAL, false, 4);
            buf.extend_from_slice(&value.to_be_bytes());
        }
        BacnetValue::Double { value } => {
            encode_tag(buf, TAG_DOUBLE, false, 8);
            buf.extend_from_slice(&value.to_be_bytes());
        }
        BacnetValue::OctetString { hex } => {
            let bytes = hex_to_bytes(hex);
            encode_tag(buf, TAG_OCTET_STRING, false, bytes.len() as u32);
            buf.extend_from_slice(&bytes);
        }
        BacnetValue::CharacterString { value } => {
            // Charset octet 0 = UTF-8 (ANSI X3.4), then the bytes.
            let bytes = value.as_bytes();
            encode_tag(buf, TAG_CHARACTER_STRING, false, 1 + bytes.len() as u32);
            buf.push(0);
            buf.extend_from_slice(bytes);
        }
        BacnetValue::BitString { unused_bits, bits } => {
            let mut content = vec![*unused_bits];
            let mut acc = 0u8;
            let mut n = 0;
            for c in bits.chars() {
                acc = (acc << 1) | if c == '1' { 1 } else { 0 };
                n += 1;
                if n == 8 {
                    content.push(acc);
                    acc = 0;
                    n = 0;
                }
            }
            if n > 0 {
                content.push(acc << (8 - n));
            }
            encode_tag(buf, TAG_BIT_STRING, false, content.len() as u32);
            buf.extend_from_slice(&content);
        }
        BacnetValue::Enumerated { value } => {
            let c = unsigned_content(*value as u64);
            encode_tag(buf, TAG_ENUMERATED, false, c.len() as u32);
            buf.extend_from_slice(&c);
        }
        BacnetValue::Date { year, month, day, weekday } => {
            encode_tag(buf, TAG_DATE, false, 4);
            let raw_year = if *year >= 1900 { (year - 1900).min(255) as u8 } else { 0xFF };
            buf.extend_from_slice(&[raw_year, *month, *day, *weekday]);
        }
        BacnetValue::Time { hour, minute, second, hundredths } => {
            encode_tag(buf, TAG_TIME, false, 4);
            buf.extend_from_slice(&[*hour, *minute, *second, *hundredths]);
        }
        BacnetValue::ObjectIdentifier { object_type, instance } => {
            encode_tag(buf, TAG_OBJECT_ID, false, 4);
            buf.extend_from_slice(&ObjectId::new(*object_type, *instance).to_raw().to_be_bytes());
        }
        BacnetValue::Unknown { tag: _, hex } => {
            // Re-emit raw bytes verbatim (already includes its own tag header).
            buf.extend_from_slice(&hex_to_bytes(hex));
        }
    }
}

fn hex_to_bytes(hex: &str) -> Vec<u8> {
    let clean: String = hex.chars().filter(|c| c.is_ascii_hexdigit()).collect();
    clean
        .as_bytes()
        .chunks(2)
        .filter(|c| c.len() == 2)
        .map(|c| u8::from_str_radix(std::str::from_utf8(c).unwrap_or("0"), 16).unwrap_or(0))
        .collect()
}

/// Decodes one application-tagged value at the start of `buf`.
/// Returns the value and the total octets consumed (tag header + content).
pub fn decode_application_value(buf: &[u8]) -> Result<(BacnetValue, usize), String> {
    let tag = decode_tag(buf)?;
    if tag.context || tag.opening || tag.closing {
        return Err("expected application tag".into());
    }
    // Application Boolean keeps its value in LVT and has no content octets.
    if tag.number == TAG_BOOLEAN {
        return Ok((BacnetValue::Boolean { value: tag.lvt == 1 }, tag.header_len));
    }
    let len = tag.lvt as usize;
    // checked_add so a hostile/huge length field can't overflow the index math
    // (would only bite a 32-bit usize, but this is untrusted network input).
    let consumed = tag.header_len.checked_add(len).ok_or_else(err_short)?;
    let content = buf.get(tag.header_len..consumed).ok_or_else(err_short)?;

    let value = match tag.number {
        TAG_NULL => BacnetValue::Null,
        TAG_UNSIGNED => BacnetValue::Unsigned { value: decode_unsigned_content(content)? },
        TAG_SIGNED => BacnetValue::Signed { value: decode_signed_content(content)? },
        TAG_REAL => {
            if len != 4 {
                return Err(format!("bad Real length {len}"));
            }
            BacnetValue::Real { value: f32::from_be_bytes([content[0], content[1], content[2], content[3]]) }
        }
        TAG_DOUBLE => {
            if len != 8 {
                return Err(format!("bad Double length {len}"));
            }
            let mut b = [0u8; 8];
            b.copy_from_slice(content);
            BacnetValue::Double { value: f64::from_be_bytes(b) }
        }
        TAG_OCTET_STRING => BacnetValue::OctetString { hex: hex_string(content) },
        TAG_CHARACTER_STRING => {
            if content.is_empty() {
                BacnetValue::CharacterString { value: String::new() }
            } else {
                let charset = content[0];
                let body = &content[1..];
                let s = match charset {
                    0 => String::from_utf8_lossy(body).into_owned(),
                    // UCS-2 big-endian — seen on older gear.
                    3 => body
                        .chunks(2)
                        .filter(|c| c.len() == 2)
                        .map(|c| {
                            char::from_u32(u16::from_be_bytes([c[0], c[1]]) as u32).unwrap_or('\u{FFFD}')
                        })
                        .collect(),
                    _ => String::from_utf8_lossy(body).into_owned(),
                };
                BacnetValue::CharacterString { value: s }
            }
        }
        TAG_BIT_STRING => {
            if content.is_empty() {
                return Err("empty BitString".into());
            }
            let unused = content[0].min(7);
            let total_bits = (content.len() - 1) * 8;
            let usable = total_bits.saturating_sub(unused as usize);
            let mut bits = String::with_capacity(usable);
            for i in 0..usable {
                let byte = content[1 + i / 8];
                let bit = (byte >> (7 - (i % 8))) & 1;
                bits.push(if bit == 1 { '1' } else { '0' });
            }
            BacnetValue::BitString { unused_bits: unused, bits }
        }
        TAG_ENUMERATED => BacnetValue::Enumerated { value: decode_unsigned_content(content)? as u32 },
        TAG_DATE => {
            if len != 4 {
                return Err(format!("bad Date length {len}"));
            }
            // 0xFF is the "unspecified/any" wildcard in each Date octet (common
            // in schedule/calendar date patterns). Surface a wildcard year as 0
            // rather than decoding it to 2155; raw octets are kept for the rest.
            BacnetValue::Date {
                year: if content[0] == 0xFF { 0 } else { 1900 + content[0] as u16 },
                month: content[1],
                day: content[2],
                weekday: content[3],
            }
        }
        TAG_TIME => {
            if len != 4 {
                return Err(format!("bad Time length {len}"));
            }
            BacnetValue::Time {
                hour: content[0],
                minute: content[1],
                second: content[2],
                hundredths: content[3],
            }
        }
        TAG_OBJECT_ID => {
            if len != 4 {
                return Err(format!("bad ObjectIdentifier length {len}"));
            }
            let raw = u32::from_be_bytes([content[0], content[1], content[2], content[3]]);
            let id = ObjectId::from_raw(raw);
            BacnetValue::ObjectIdentifier { object_type: id.object_type, instance: id.instance }
        }
        n => BacnetValue::Unknown {
            tag: n,
            hex: hex_string(&buf[..consumed]),
        },
    };
    Ok((value, consumed))
}

/// Skips a balanced opening..closing construct starting at `buf[0]` (which must
/// be an opening tag). Returns total octets consumed including the closing tag.
fn skip_constructed(buf: &[u8]) -> Result<usize, String> {
    let first = decode_tag(buf)?;
    if !first.opening {
        return Err("expected opening tag".into());
    }
    let mut at = first.header_len;
    let mut depth = 1usize;
    while depth > 0 {
        let t = decode_tag(buf.get(at..).ok_or_else(err_short)?)?;
        if t.opening {
            depth += 1;
            at += t.header_len;
        } else if t.closing {
            depth -= 1;
            at += t.header_len;
        } else if !t.context && t.number == TAG_BOOLEAN {
            at += t.header_len;
        } else {
            at += t.header_len + t.lvt as usize;
        }
        if at > buf.len() {
            return Err(err_short());
        }
    }
    Ok(at)
}

/// Decodes a list of application values that runs until the closing tag
/// `closing_number` at depth 0. `buf` starts right AFTER the opening tag.
/// Context-specific constructs inside are preserved as `Unknown` values.
/// Returns the values and octets consumed INCLUDING the closing tag.
pub fn decode_value_list(buf: &[u8], closing_number: u8) -> Result<(Vec<BacnetValue>, usize), String> {
    let mut values = Vec::new();
    let mut at = 0usize;
    loop {
        let rest = buf.get(at..).ok_or_else(err_short)?;
        let t = decode_tag(rest)?;
        if t.closing && t.context && t.number == closing_number {
            return Ok((values, at + t.header_len));
        }
        if t.opening {
            let n = skip_constructed(rest)?;
            values.push(BacnetValue::Unknown { tag: t.number, hex: hex_string(&rest[..n]) });
            at += n;
        } else if t.context {
            let n = t.header_len + t.lvt as usize;
            if rest.len() < n {
                return Err(err_short());
            }
            values.push(BacnetValue::Unknown { tag: t.number, hex: hex_string(&rest[..n]) });
            at += n;
        } else {
            let (v, n) = decode_application_value(rest)?;
            values.push(v);
            at += n;
        }
    }
}

// Context-tag encode/decode helpers used by the service codecs (pub so the
// client module's loopback tests can assemble fake device replies).

pub fn encode_context_unsigned(buf: &mut Vec<u8>, tag_number: u8, v: u64) {
    let c = unsigned_content(v);
    encode_tag(buf, tag_number, true, c.len() as u32);
    buf.extend_from_slice(&c);
}

pub fn encode_context_object_id(buf: &mut Vec<u8>, tag_number: u8, id: ObjectId) {
    encode_tag(buf, tag_number, true, 4);
    buf.extend_from_slice(&id.to_raw().to_be_bytes());
}

fn decode_context_unsigned(buf: &[u8], expected: u8) -> Result<(u64, usize), String> {
    let t = decode_tag(buf)?;
    if !t.context || t.opening || t.closing || t.number != expected {
        return Err(format!("expected context tag {expected}"));
    }
    let content = buf
        .get(t.header_len..t.header_len + t.lvt as usize)
        .ok_or_else(err_short)?;
    Ok((decode_unsigned_content(content)?, t.header_len + t.lvt as usize))
}

fn decode_context_object_id(buf: &[u8], expected: u8) -> Result<(ObjectId, usize), String> {
    let t = decode_tag(buf)?;
    if !t.context || t.opening || t.closing || t.number != expected || t.lvt != 4 {
        return Err(format!("expected context object-id tag {expected}"));
    }
    let c = buf.get(t.header_len..t.header_len + 4).ok_or_else(err_short)?;
    let raw = u32::from_be_bytes([c[0], c[1], c[2], c[3]]);
    Ok((ObjectId::from_raw(raw), t.header_len + 4))
}

// ---------------------------------------------------------------------------
// BVLC (Annex J)
// ---------------------------------------------------------------------------

/// A parsed BVLC header.
#[derive(Debug, Clone, PartialEq)]
pub struct Bvlc {
    pub function: u8,
    /// Offset of the NPDU (or function payload) within the frame.
    pub payload_offset: usize,
    /// For Forwarded-NPDU: the original sender's B/IP address.
    pub origin: Option<(std::net::Ipv4Addr, u16)>,
}

/// Wraps `payload` (NPDU+APDU) into a BVLC frame with the given function.
pub fn bvlc_encode(function: u8, payload: &[u8]) -> Vec<u8> {
    let total = 4 + payload.len();
    let mut buf = Vec::with_capacity(total);
    buf.push(BVLL_TYPE_BACNET_IP);
    buf.push(function);
    buf.extend_from_slice(&(total as u16).to_be_bytes());
    buf.extend_from_slice(payload);
    buf
}

/// Parses the BVLC header of an incoming frame.
pub fn bvlc_decode(buf: &[u8]) -> Result<Bvlc, String> {
    if buf.len() < 4 {
        return Err(err_short());
    }
    if buf[0] != BVLL_TYPE_BACNET_IP {
        return Err(format!("not a BACnet/IP frame (type 0x{:02X})", buf[0]));
    }
    let function = buf[1];
    let length = u16::from_be_bytes([buf[2], buf[3]]) as usize;
    if length > buf.len() {
        return Err(format!("BVLC length {length} exceeds datagram {}", buf.len()));
    }
    let (payload_offset, origin) = if function == BVLC_FORWARDED_NPDU {
        if buf.len() < 10 {
            return Err(err_short());
        }
        let ip = std::net::Ipv4Addr::new(buf[4], buf[5], buf[6], buf[7]);
        let port = u16::from_be_bytes([buf[8], buf[9]]);
        (10, Some((ip, port)))
    } else {
        (4, None)
    };
    Ok(Bvlc { function, payload_offset, origin })
}

/// Builds a complete Register-Foreign-Device frame (for reaching devices across
/// subnets via a BBMD). Not yet wired to a command; kept with its tests for the
/// foreign-device feature.
#[allow(dead_code)]
pub fn encode_register_foreign_device(ttl_seconds: u16) -> Vec<u8> {
    bvlc_encode(BVLC_REGISTER_FOREIGN_DEVICE, &ttl_seconds.to_be_bytes())
}

/// Extracts the result code from a BVLC-Result frame payload (0x0000 = success).
#[allow(dead_code)]
pub fn decode_bvlc_result(frame: &[u8]) -> Option<u16> {
    if frame.len() >= 6 && frame[0] == BVLL_TYPE_BACNET_IP && frame[1] == BVLC_RESULT {
        Some(u16::from_be_bytes([frame[4], frame[5]]))
    } else {
        None
    }
}

// ---------------------------------------------------------------------------
// NPDU (clause 6)
// ---------------------------------------------------------------------------

/// A parsed NPDU header.
#[derive(Debug, Clone, PartialEq)]
pub struct Npdu {
    /// True when the NSDU is a network-layer message (no APDU follows).
    pub network_message: bool,
    /// The network-layer message type, when `network_message` is set.
    pub message_type: Option<u8>,
    /// (SNET, SADR) when the frame came from a routed device.
    pub source: Option<(u16, Vec<u8>)>,
    /// (DNET, DADR) when the frame carries a destination specifier.
    pub dest: Option<(u16, Vec<u8>)>,
    /// Offset of the APDU (or network-message payload) within the NPDU slice.
    pub apdu_offset: usize,
}

/// Encodes an NPDU header. `dest` carries (DNET, DADR) for routed targets; use
/// `(BROADCAST_NETWORK, &[])` for a global broadcast. Hop count is 255.
pub fn encode_npdu(expecting_reply: bool, dest: Option<(u16, &[u8])>) -> Vec<u8> {
    let mut buf = vec![1u8, 0u8];
    let mut control = 0u8;
    if expecting_reply {
        control |= 0x04;
    }
    if let Some((dnet, dadr)) = dest {
        control |= 0x20;
        buf.extend_from_slice(&dnet.to_be_bytes());
        buf.push(dadr.len() as u8);
        buf.extend_from_slice(dadr);
        buf.push(255); // hop count
    }
    buf[1] = control;
    buf
}

/// Parses the NPDU header at the start of `buf`.
pub fn decode_npdu(buf: &[u8]) -> Result<Npdu, String> {
    if buf.len() < 2 {
        return Err(err_short());
    }
    if buf[0] != 1 {
        return Err(format!("unsupported NPDU version {}", buf[0]));
    }
    let control = buf[1];
    let network_message = control & 0x80 != 0;
    let has_dest = control & 0x20 != 0;
    let has_source = control & 0x08 != 0;
    let mut at = 2usize;

    let dest = if has_dest {
        let dnet = u16::from_be_bytes([
            *buf.get(at).ok_or_else(err_short)?,
            *buf.get(at + 1).ok_or_else(err_short)?,
        ]);
        let dlen = *buf.get(at + 2).ok_or_else(err_short)? as usize;
        at += 3;
        let dadr = buf.get(at..at + dlen).ok_or_else(err_short)?.to_vec();
        at += dlen;
        Some((dnet, dadr))
    } else {
        None
    };

    let source = if has_source {
        let snet = u16::from_be_bytes([
            *buf.get(at).ok_or_else(err_short)?,
            *buf.get(at + 1).ok_or_else(err_short)?,
        ]);
        let slen = *buf.get(at + 2).ok_or_else(err_short)? as usize;
        at += 3;
        let sadr = buf.get(at..at + slen).ok_or_else(err_short)?.to_vec();
        at += slen;
        Some((snet, sadr))
    } else {
        None
    };

    if has_dest {
        // Hop count follows the address fields.
        at += 1;
    }
    let message_type = if network_message {
        let t = *buf.get(at).ok_or_else(err_short)?;
        at += 1;
        if t >= 0x80 {
            at += 2; // vendor ID precedes proprietary message payloads
        }
        Some(t)
    } else {
        None
    };
    if at > buf.len() {
        return Err(err_short());
    }
    Ok(Npdu { network_message, message_type, source, dest, apdu_offset: at })
}

/// Encodes a complete network-layer NPDU (control bit 7 set) carrying
/// `message_type` and its payload. `dest` works as in [`encode_npdu`].
pub fn encode_network_message(message_type: u8, payload: &[u8], dest: Option<(u16, &[u8])>) -> Vec<u8> {
    let mut buf = encode_npdu(false, dest);
    buf[1] |= 0x80;
    buf.push(message_type);
    buf.extend_from_slice(payload);
    buf
}

/// Pulls the network numbers out of an I-Am-Router-To-Network payload
/// (a plain list of big-endian u16s).
pub fn decode_router_networks(payload: &[u8]) -> Vec<u16> {
    payload
        .chunks(2)
        .filter(|c| c.len() == 2)
        .map(|c| u16::from_be_bytes([c[0], c[1]]))
        .collect()
}

// ---------------------------------------------------------------------------
// APDU (clause 20.1)
// ---------------------------------------------------------------------------

/// A parsed incoming APDU, summarized to what a client needs.
#[derive(Debug, Clone, PartialEq)]
pub enum Apdu {
    ConfirmedRequest { invoke_id: u8, service: u8, payload_offset: usize },
    Unconfirmed { service: u8, payload_offset: usize },
    SimpleAck { invoke_id: u8, service: u8 },
    ComplexAck {
        invoke_id: u8,
        service: u8,
        segmented: bool,
        /// More-follows: another segment is coming (only meaningful when segmented).
        more: bool,
        /// Segment sequence number (only meaningful when segmented).
        sequence: u8,
        /// Proposed window size (only meaningful when segmented).
        window: u8,
        payload_offset: usize,
    },
    SegmentAck { invoke_id: u8 },
    Error { invoke_id: u8, service: u8, error_class: u32, error_code: u32 },
    Reject { invoke_id: u8, reason: u8 },
    Abort { invoke_id: u8, reason: u8 },
}

/// Parses the APDU at the start of `buf`.
pub fn decode_apdu(buf: &[u8]) -> Result<Apdu, String> {
    let first = *buf.first().ok_or_else(err_short)?;
    match first & 0xF0 {
        PDU_CONFIRMED => {
            // [0]=type/flags [1]=max-segs/max-apdu [2]=invoke [3..]=seq/window if SEG [n]=service
            let segmented = first & 0x08 != 0;
            let invoke_id = *buf.get(2).ok_or_else(err_short)?;
            let svc_at = if segmented { 5 } else { 3 };
            let service = *buf.get(svc_at).ok_or_else(err_short)?;
            Ok(Apdu::ConfirmedRequest { invoke_id, service, payload_offset: svc_at + 1 })
        }
        PDU_UNCONFIRMED => {
            let service = *buf.get(1).ok_or_else(err_short)?;
            Ok(Apdu::Unconfirmed { service, payload_offset: 2 })
        }
        PDU_SIMPLE_ACK => Ok(Apdu::SimpleAck {
            invoke_id: *buf.get(1).ok_or_else(err_short)?,
            service: *buf.get(2).ok_or_else(err_short)?,
        }),
        PDU_COMPLEX_ACK => {
            // [0]=type/flags [1]=invoke [if SEG: 2=seq 3=window] [n]=service [n+1..]=data
            let segmented = first & APDU_FLAG_SEGMENTED != 0;
            let more = first & APDU_FLAG_MORE != 0;
            let invoke_id = *buf.get(1).ok_or_else(err_short)?;
            let (sequence, window, svc_at) = if segmented {
                (*buf.get(2).ok_or_else(err_short)?, *buf.get(3).ok_or_else(err_short)?, 4)
            } else {
                (0, 0, 2)
            };
            let service = *buf.get(svc_at).ok_or_else(err_short)?;
            Ok(Apdu::ComplexAck {
                invoke_id,
                service,
                segmented,
                more,
                sequence,
                window,
                payload_offset: svc_at + 1,
            })
        }
        PDU_SEGMENT_ACK => Ok(Apdu::SegmentAck { invoke_id: *buf.get(1).ok_or_else(err_short)? }),
        PDU_ERROR => {
            let invoke_id = *buf.get(1).ok_or_else(err_short)?;
            let service = *buf.get(2).ok_or_else(err_short)?;
            // error-class and error-code are application-tagged enumerated values.
            // Some services wrap them in context tags; decode leniently.
            let mut class = 0u32;
            let mut code = 0u32;
            if let Some(rest) = buf.get(3..) {
                let mut at = 0usize;
                let mut found = Vec::new();
                while found.len() < 2 && at < rest.len() {
                    match decode_application_value(&rest[at..]) {
                        Ok((BacnetValue::Enumerated { value }, n)) => {
                            found.push(value);
                            at += n;
                        }
                        Ok((_, n)) => at += n.max(1),
                        Err(_) => at += 1,
                    }
                }
                if found.len() == 2 {
                    class = found[0];
                    code = found[1];
                }
            }
            Ok(Apdu::Error { invoke_id, service, error_class: class, error_code: code })
        }
        PDU_REJECT => Ok(Apdu::Reject {
            invoke_id: *buf.get(1).ok_or_else(err_short)?,
            reason: *buf.get(2).ok_or_else(err_short)?,
        }),
        PDU_ABORT => Ok(Apdu::Abort {
            invoke_id: *buf.get(1).ok_or_else(err_short)?,
            reason: *buf.get(2).ok_or_else(err_short)?,
        }),
        t => Err(format!("unknown PDU type 0x{t:02X}")),
    }
}

fn confirmed_header(invoke_id: u8, service: u8) -> Vec<u8> {
    // SA flag set so the device may segment a large reply back to us.
    vec![PDU_CONFIRMED | APDU_FLAG_SA, MAX_SEGS_MAX_APDU, invoke_id, service]
}

/// Encodes a SegmentACK acknowledging segments up to `sequence`, granting the
/// sender `window` more segments before the next ack. `negative` requests
/// retransmission; `server` is set when we're the segment receiver of a
/// confirmed *request* (always false for our client, which only receives
/// segmented *responses*).
pub fn encode_segment_ack(negative: bool, server: bool, invoke_id: u8, sequence: u8, window: u8) -> Vec<u8> {
    let mut octet0 = PDU_SEGMENT_ACK;
    if negative {
        octet0 |= 0x02; // NAK
    }
    if server {
        octet0 |= 0x01; // SRV
    }
    vec![octet0, invoke_id, sequence, window]
}

// ---------------------------------------------------------------------------
// Services
// ---------------------------------------------------------------------------

/// Encodes a Who-Is APDU, optionally limited to an instance range.
pub fn encode_who_is(low: Option<u32>, high: Option<u32>) -> Vec<u8> {
    let mut buf = vec![PDU_UNCONFIRMED, SERVICE_WHO_IS];
    if let (Some(l), Some(h)) = (low, high) {
        encode_context_unsigned(&mut buf, 0, l as u64);
        encode_context_unsigned(&mut buf, 1, h as u64);
    }
    buf
}

/// A decoded I-Am announcement.
#[derive(Debug, Clone, PartialEq)]
pub struct IAm {
    pub device: ObjectId,
    pub max_apdu: u32,
    /// 0 = both, 1 = transmit, 2 = receive, 3 = none.
    pub segmentation: u32,
    pub vendor_id: u32,
}

/// Decodes an I-Am service payload (the bytes after the service choice).
pub fn decode_i_am(payload: &[u8]) -> Result<IAm, String> {
    let mut at = 0usize;
    let (dev, n) = decode_application_value(&payload[at..])?;
    at += n;
    let device = match dev {
        BacnetValue::ObjectIdentifier { object_type, instance } => ObjectId::new(object_type, instance),
        _ => return Err("I-Am: expected device object-identifier".into()),
    };
    let (max_apdu_v, n) = decode_application_value(payload.get(at..).ok_or_else(err_short)?)?;
    at += n;
    let max_apdu = match max_apdu_v {
        BacnetValue::Unsigned { value } => value as u32,
        _ => return Err("I-Am: expected max-APDU unsigned".into()),
    };
    let (seg_v, n) = decode_application_value(payload.get(at..).ok_or_else(err_short)?)?;
    at += n;
    let segmentation = match seg_v {
        BacnetValue::Enumerated { value } => value,
        _ => return Err("I-Am: expected segmentation enumerated".into()),
    };
    let (vendor_v, _) = decode_application_value(payload.get(at..).ok_or_else(err_short)?)?;
    let vendor_id = match vendor_v {
        BacnetValue::Unsigned { value } => value as u32,
        _ => return Err("I-Am: expected vendor-id unsigned".into()),
    };
    Ok(IAm { device, max_apdu, segmentation, vendor_id })
}

/// Encodes a ReadProperty request APDU.
pub fn encode_read_property(
    invoke_id: u8,
    object: ObjectId,
    property: u32,
    array_index: Option<u32>,
) -> Vec<u8> {
    let mut buf = confirmed_header(invoke_id, SERVICE_READ_PROPERTY);
    encode_context_object_id(&mut buf, 0, object);
    encode_context_unsigned(&mut buf, 1, property as u64);
    if let Some(idx) = array_index {
        encode_context_unsigned(&mut buf, 2, idx as u64);
    }
    buf
}

/// A decoded ReadProperty-ACK.
#[derive(Debug, Clone, PartialEq)]
pub struct ReadPropertyAck {
    pub object: ObjectId,
    pub property: u32,
    pub array_index: Option<u32>,
    pub values: Vec<BacnetValue>,
}

/// Decodes a ReadProperty-ACK service payload (bytes after the service choice).
pub fn decode_read_property_ack(payload: &[u8]) -> Result<ReadPropertyAck, String> {
    let mut at = 0usize;
    let (object, n) = decode_context_object_id(payload, 0)?;
    at += n;
    let (property, n) = decode_context_unsigned(payload.get(at..).ok_or_else(err_short)?, 1)?;
    at += n;
    let mut array_index = None;
    let t = decode_tag(payload.get(at..).ok_or_else(err_short)?)?;
    if t.context && !t.opening && !t.closing && t.number == 2 {
        let (idx, n) = decode_context_unsigned(&payload[at..], 2)?;
        array_index = Some(idx as u32);
        at += n;
    }
    let t = decode_tag(payload.get(at..).ok_or_else(err_short)?)?;
    if !(t.opening && t.context && t.number == 3) {
        return Err("ReadProperty-ACK: expected opening tag 3".into());
    }
    at += t.header_len;
    let (values, _) = decode_value_list(payload.get(at..).ok_or_else(err_short)?, 3)?;
    Ok(ReadPropertyAck { object, property: property as u32, array_index, values })
}

/// One (property, optional array index) to read in an RPM request.
#[derive(Debug, Clone, PartialEq)]
pub struct PropertyRef {
    pub property: u32,
    pub array_index: Option<u32>,
}

/// Per-object spec for a ReadPropertyMultiple request.
#[derive(Debug, Clone, PartialEq)]
pub struct ReadAccessSpec {
    pub object: ObjectId,
    pub properties: Vec<PropertyRef>,
}

/// Encodes a ReadPropertyMultiple request APDU.
pub fn encode_read_property_multiple(invoke_id: u8, specs: &[ReadAccessSpec]) -> Vec<u8> {
    let mut buf = confirmed_header(invoke_id, SERVICE_READ_PROPERTY_MULTIPLE);
    for spec in specs {
        encode_context_object_id(&mut buf, 0, spec.object);
        encode_opening_tag(&mut buf, 1);
        for p in &spec.properties {
            encode_context_unsigned(&mut buf, 0, p.property as u64);
            if let Some(idx) = p.array_index {
                encode_context_unsigned(&mut buf, 1, idx as u64);
            }
        }
        encode_closing_tag(&mut buf, 1);
    }
    buf
}

/// One property result inside an RPM-ACK: either values or a BACnet error.
#[derive(Debug, Clone, PartialEq)]
pub struct RpmProperty {
    pub property: u32,
    pub array_index: Option<u32>,
    pub values: Option<Vec<BacnetValue>>,
    pub error: Option<(u32, u32)>, // (error-class, error-code)
}

/// Per-object results inside an RPM-ACK.
#[derive(Debug, Clone, PartialEq)]
pub struct RpmObject {
    pub object: ObjectId,
    pub properties: Vec<RpmProperty>,
}

/// Decodes a ReadPropertyMultiple-ACK service payload.
pub fn decode_read_property_multiple_ack(payload: &[u8]) -> Result<Vec<RpmObject>, String> {
    let mut at = 0usize;
    let mut objects = Vec::new();
    while at < payload.len() {
        let (object, n) = decode_context_object_id(&payload[at..], 0)?;
        at += n;
        let t = decode_tag(payload.get(at..).ok_or_else(err_short)?)?;
        if !(t.opening && t.context && t.number == 1) {
            return Err("RPM-ACK: expected opening tag 1".into());
        }
        at += t.header_len;

        let mut properties = Vec::new();
        loop {
            let t = decode_tag(payload.get(at..).ok_or_else(err_short)?)?;
            if t.closing && t.context && t.number == 1 {
                at += t.header_len;
                break;
            }
            let (property, n) = decode_context_unsigned(&payload[at..], 2)?;
            at += n;
            let mut array_index = None;
            let t = decode_tag(payload.get(at..).ok_or_else(err_short)?)?;
            if t.context && !t.opening && !t.closing && t.number == 3 {
                let (idx, n) = decode_context_unsigned(&payload[at..], 3)?;
                array_index = Some(idx as u32);
                at += n;
            }
            let t = decode_tag(payload.get(at..).ok_or_else(err_short)?)?;
            if t.opening && t.context && t.number == 4 {
                at += t.header_len;
                let (values, n) = decode_value_list(payload.get(at..).ok_or_else(err_short)?, 4)?;
                at += n;
                properties.push(RpmProperty {
                    property: property as u32,
                    array_index,
                    values: Some(values),
                    error: None,
                });
            } else if t.opening && t.context && t.number == 5 {
                at += t.header_len;
                let (errs, n) = decode_value_list(payload.get(at..).ok_or_else(err_short)?, 5)?;
                at += n;
                let mut class = 0u32;
                let mut code = 0u32;
                let mut enums = errs.iter().filter_map(|v| match v {
                    BacnetValue::Enumerated { value } => Some(*value),
                    _ => None,
                });
                if let Some(c) = enums.next() {
                    class = c;
                }
                if let Some(c) = enums.next() {
                    code = c;
                }
                properties.push(RpmProperty {
                    property: property as u32,
                    array_index,
                    values: None,
                    error: Some((class, code)),
                });
            } else {
                return Err("RPM-ACK: expected opening tag 4 or 5".into());
            }
        }
        objects.push(RpmObject { object, properties });
    }
    Ok(objects)
}

/// Encodes a WriteProperty request APDU. Writing `BacnetValue::Null` with a
/// priority relinquishes that priority slot.
pub fn encode_write_property(
    invoke_id: u8,
    object: ObjectId,
    property: u32,
    array_index: Option<u32>,
    values: &[BacnetValue],
    priority: Option<u8>,
) -> Vec<u8> {
    let mut buf = confirmed_header(invoke_id, SERVICE_WRITE_PROPERTY);
    encode_context_object_id(&mut buf, 0, object);
    encode_context_unsigned(&mut buf, 1, property as u64);
    if let Some(idx) = array_index {
        encode_context_unsigned(&mut buf, 2, idx as u64);
    }
    encode_opening_tag(&mut buf, 3);
    for v in values {
        encode_application_value(&mut buf, v);
    }
    encode_closing_tag(&mut buf, 3);
    if let Some(p) = priority {
        encode_context_unsigned(&mut buf, 4, p as u64);
    }
    buf
}

/// Encodes a SubscribeCOV request APDU. `lifetime_seconds == None` issues a
/// **cancellation** (process id + object only); `Some(secs)` subscribes with
/// confirmed or unconfirmed notifications for that lifetime (0 = no automatic
/// expiry, though many devices cap it).
pub fn encode_subscribe_cov(
    invoke_id: u8,
    subscriber_process_id: u32,
    monitored: ObjectId,
    issue_confirmed: bool,
    lifetime_seconds: Option<u32>,
) -> Vec<u8> {
    let mut buf = confirmed_header(invoke_id, SERVICE_SUBSCRIBE_COV);
    encode_context_unsigned(&mut buf, 0, subscriber_process_id as u64);
    encode_context_object_id(&mut buf, 1, monitored);
    if let Some(lifetime) = lifetime_seconds {
        // context 2 Boolean — note context-tagged booleans carry one content octet.
        encode_tag(&mut buf, 2, true, 1);
        buf.push(if issue_confirmed { 1 } else { 0 });
        encode_context_unsigned(&mut buf, 3, lifetime as u64);
    }
    buf
}

/// One property's value(s) inside a COV notification.
#[derive(Debug, Clone, PartialEq)]
pub struct CovValue {
    pub property: u32,
    pub array_index: Option<u32>,
    pub values: Vec<BacnetValue>,
}

/// A decoded (Un)ConfirmedCOVNotification.
#[derive(Debug, Clone, PartialEq)]
pub struct CovNotification {
    pub process_id: u32,
    pub initiating_device: ObjectId,
    pub monitored_object: ObjectId,
    pub time_remaining: u32,
    pub values: Vec<CovValue>,
}

/// Decodes a COVNotification service payload (bytes after the service choice).
/// Shared by the confirmed (service 1) and unconfirmed (service 2) forms — the
/// request bodies are identical.
pub fn decode_cov_notification(payload: &[u8]) -> Result<CovNotification, String> {
    let mut at = 0usize;
    let (process_id, n) = decode_context_unsigned(payload, 0)?;
    at += n;
    let (initiating_device, n) = decode_context_object_id(payload.get(at..).ok_or_else(err_short)?, 1)?;
    at += n;
    let (monitored_object, n) = decode_context_object_id(payload.get(at..).ok_or_else(err_short)?, 2)?;
    at += n;
    let (time_remaining, n) = decode_context_unsigned(payload.get(at..).ok_or_else(err_short)?, 3)?;
    at += n;

    // listOfValues: opening tag 4 ... closing tag 4.
    let t = decode_tag(payload.get(at..).ok_or_else(err_short)?)?;
    if !(t.opening && t.context && t.number == 4) {
        return Err("COVNotification: expected opening tag 4".into());
    }
    at += t.header_len;

    let mut values = Vec::new();
    loop {
        let rest = payload.get(at..).ok_or_else(err_short)?;
        let t = decode_tag(rest)?;
        if t.closing && t.context && t.number == 4 {
            break;
        }
        // BACnetPropertyValue: context 0 property, [context 1 index],
        // context 2 (opening) value(s) (closing), [context 3 priority].
        let (property, n) = decode_context_unsigned(rest, 0)?;
        at += n;
        let mut array_index = None;
        let t = decode_tag(payload.get(at..).ok_or_else(err_short)?)?;
        if t.context && !t.opening && !t.closing && t.number == 1 {
            let (idx, n) = decode_context_unsigned(&payload[at..], 1)?;
            array_index = Some(idx as u32);
            at += n;
        }
        let t = decode_tag(payload.get(at..).ok_or_else(err_short)?)?;
        if !(t.opening && t.context && t.number == 2) {
            return Err("COVNotification: expected opening tag 2 (value)".into());
        }
        at += t.header_len;
        let (vals, n) = decode_value_list(payload.get(at..).ok_or_else(err_short)?, 2)?;
        at += n;
        // optional context 3 priority — skip it.
        let t = decode_tag(payload.get(at..).ok_or_else(err_short)?)?;
        if t.context && !t.opening && !t.closing && t.number == 3 {
            at += t.header_len + t.lvt as usize;
        }
        values.push(CovValue { property: property as u32, array_index, values: vals });
    }

    Ok(CovNotification {
        process_id: process_id as u32,
        initiating_device,
        monitored_object,
        time_remaining: time_remaining as u32,
        values,
    })
}

/// Encodes the listOfValues body (used by tests and any notifier path) for a
/// single property — opening 2, value, closing 2, wrapped as a BACnetPropertyValue.
/// Kept public for the COV test vectors and a future notifier path.
#[allow(dead_code)]
pub fn encode_cov_property_value(buf: &mut Vec<u8>, property: u32, value: &BacnetValue) {
    encode_context_unsigned(buf, 0, property as u64);
    encode_opening_tag(buf, 2);
    encode_application_value(buf, value);
    encode_closing_tag(buf, 2);
}

// ---------------------------------------------------------------------------
// ReadRange (confirmed service 26) — trend-log history
// ---------------------------------------------------------------------------

/// Encodes a ReadRange request reading `count` items by position. A negative
/// `count` reads backward from `reference_index` (toward record 1), so
/// `reference_index = N, count = -k` returns the k records ending at N — the
/// natural "most recent k" query against a 1-based log buffer.
pub fn encode_read_range_by_position(
    invoke_id: u8,
    object: ObjectId,
    property: u32,
    array_index: Option<u32>,
    reference_index: u32,
    count: i32,
) -> Vec<u8> {
    let mut buf = confirmed_header(invoke_id, SERVICE_READ_RANGE);
    encode_context_object_id(&mut buf, 0, object);
    encode_context_unsigned(&mut buf, 1, property as u64);
    if let Some(idx) = array_index {
        encode_context_unsigned(&mut buf, 2, idx as u64);
    }
    // byPosition [3] SEQUENCE { referenceIndex Unsigned, count INTEGER }
    encode_opening_tag(&mut buf, 3);
    encode_application_value(&mut buf, &BacnetValue::Unsigned { value: reference_index as u64 });
    encode_application_value(&mut buf, &BacnetValue::Signed { value: count as i64 });
    encode_closing_tag(&mut buf, 3);
    buf
}

/// A decoded ReadRange-ACK envelope. `item_data` is the raw bytes between the
/// opening/closing of the itemData list, parsed further by [`decode_log_records`].
#[derive(Debug, Clone, PartialEq)]
pub struct ReadRangeAck {
    pub object: ObjectId,
    pub property: u32,
    pub array_index: Option<u32>,
    pub first_item: bool,
    pub last_item: bool,
    pub more_items: bool,
    pub item_count: u32,
    pub item_data: Vec<u8>,
    pub first_sequence: Option<u32>,
}

/// Finds the offset of the closing tag `closing_number` at depth 0, where `buf`
/// begins immediately AFTER the matching opening tag (nested constructs skipped).
fn find_closing(buf: &[u8], closing_number: u8) -> Result<usize, String> {
    let mut at = 0usize;
    let mut depth = 0usize;
    loop {
        let t = decode_tag(buf.get(at..).ok_or_else(err_short)?)?;
        if t.closing && t.context && depth == 0 && t.number == closing_number {
            return Ok(at);
        }
        if t.opening {
            depth += 1;
            at += t.header_len;
        } else if t.closing {
            depth = depth.checked_sub(1).ok_or_else(|| "unbalanced tags".to_string())?;
            at += t.header_len;
        } else if !t.context && t.number == TAG_BOOLEAN {
            at += t.header_len;
        } else {
            at = at
                .checked_add(t.header_len)
                .and_then(|v| v.checked_add(t.lvt as usize))
                .ok_or_else(err_short)?;
        }
        if at > buf.len() {
            return Err(err_short());
        }
    }
}

/// Decodes a ReadRange-ACK service payload (bytes after the service choice).
pub fn decode_read_range_ack(payload: &[u8]) -> Result<ReadRangeAck, String> {
    let mut at = 0usize;
    let (object, n) = decode_context_object_id(payload, 0)?;
    at += n;
    let (property, n) = decode_context_unsigned(payload.get(at..).ok_or_else(err_short)?, 1)?;
    at += n;

    let mut array_index = None;
    let t = decode_tag(payload.get(at..).ok_or_else(err_short)?)?;
    if t.context && !t.opening && !t.closing && t.number == 2 {
        let (idx, n) = decode_context_unsigned(&payload[at..], 2)?;
        array_index = Some(idx as u32);
        at += n;
    }

    // context 3: result-flags BIT STRING (first-item, last-item, more-items).
    let t = decode_tag(payload.get(at..).ok_or_else(err_short)?)?;
    if !(t.context && !t.opening && !t.closing && t.number == 3) {
        return Err("ReadRange-ACK: expected result-flags tag 3".into());
    }
    let content = payload
        .get(at + t.header_len..at + t.header_len + t.lvt as usize)
        .ok_or_else(err_short)?;
    let bit = |i: usize| content.get(1 + i / 8).map(|b| (b >> (7 - (i % 8))) & 1 == 1).unwrap_or(false);
    let (first_item, last_item, more_items) = (bit(0), bit(1), bit(2));
    at += t.header_len + t.lvt as usize;

    // context 4: item-count Unsigned.
    let (item_count, n) = decode_context_unsigned(payload.get(at..).ok_or_else(err_short)?, 4)?;
    at += n;

    // context 5: itemData (opening .. closing).
    let t = decode_tag(payload.get(at..).ok_or_else(err_short)?)?;
    if !(t.opening && t.context && t.number == 5) {
        return Err("ReadRange-ACK: expected opening tag 5".into());
    }
    at += t.header_len;
    let body = payload.get(at..).ok_or_else(err_short)?;
    let end = find_closing(body, 5)?;
    let item_data = body[..end].to_vec();
    at += end;
    let closing = decode_tag(payload.get(at..).ok_or_else(err_short)?)?;
    at += closing.header_len;

    // optional context 6: first-sequence-number.
    let mut first_sequence = None;
    if let Some(rest) = payload.get(at..) {
        if !rest.is_empty() {
            let t = decode_tag(rest)?;
            if t.context && !t.opening && !t.closing && t.number == 6 {
                let (seq, _) = decode_context_unsigned(rest, 6)?;
                first_sequence = Some(seq as u32);
            }
        }
    }

    Ok(ReadRangeAck {
        object,
        property: property as u32,
        array_index,
        first_item,
        last_item,
        more_items,
        item_count: item_count as u32,
        item_data,
        first_sequence,
    })
}

/// One decoded trend-log record: a timestamp and the logged datum.
#[derive(Debug, Clone, PartialEq)]
pub struct LogRecord {
    pub date: Option<BacnetValue>,
    pub time: Option<BacnetValue>,
    pub datum: BacnetValue,
    /// status-flags as raised bit names, when present.
    pub status: Option<String>,
}

/// Interprets a context-tagged logDatum CHOICE value into a BacnetValue.
/// Tags (clause 21 BACnetLogRecord.logDatum): 0 log-status (bitstring),
/// 1 boolean, 2 real, 3 enumerated, 4 unsigned, 5 signed, 6 bitstring, 7 null.
fn decode_log_datum(number: u8, content: &[u8]) -> BacnetValue {
    match number {
        1 => BacnetValue::Boolean { value: content.first().map(|b| *b != 0).unwrap_or(false) },
        2 if content.len() == 4 => {
            BacnetValue::Real { value: f32::from_be_bytes([content[0], content[1], content[2], content[3]]) }
        }
        3 => BacnetValue::Enumerated { value: decode_unsigned_content(content).unwrap_or(0) as u32 },
        4 => BacnetValue::Unsigned { value: decode_unsigned_content(content).unwrap_or(0) },
        5 => BacnetValue::Signed { value: decode_signed_content(content).unwrap_or(0) },
        0 | 6 if !content.is_empty() => {
            let unused = content[0].min(7);
            let total = (content.len() - 1) * 8;
            let usable = total.saturating_sub(unused as usize);
            let mut bits = String::with_capacity(usable);
            for i in 0..usable {
                bits.push(if (content[1 + i / 8] >> (7 - (i % 8))) & 1 == 1 { '1' } else { '0' });
            }
            BacnetValue::BitString { unused_bits: unused, bits }
        }
        7 => BacnetValue::Null,
        n => BacnetValue::Unknown { tag: n, hex: hex_string(content) },
    }
}

/// Decodes a list of BACnetLogRecords from itemData bytes (best-effort: stops at
/// the first malformed record rather than erroring, so a partial buffer still
/// yields the records it could parse).
pub fn decode_log_records(item_data: &[u8]) -> Vec<LogRecord> {
    let mut records = Vec::new();
    let mut at = 0usize;
    while at < item_data.len() {
        match decode_one_log_record(&item_data[at..]) {
            Ok((rec, n)) if n > 0 => {
                records.push(rec);
                at += n;
            }
            _ => break,
        }
    }
    records
}

fn decode_one_log_record(buf: &[u8]) -> Result<(LogRecord, usize), String> {
    let mut at = 0usize;
    let mut date = None;
    let mut time = None;

    // [0] timestamp = BACnetDateTime { date, time } (constructed).
    let t = decode_tag(buf.get(at..).ok_or_else(err_short)?)?;
    if t.opening && t.context && t.number == 0 {
        at += t.header_len;
        let end = find_closing(buf.get(at..).ok_or_else(err_short)?, 0)?;
        let inner = &buf[at..at + end];
        let mut i = 0usize;
        if let Ok((d, n)) = decode_application_value(&inner[i..]) {
            i += n;
            date = Some(d);
        }
        if i < inner.len() {
            if let Ok((tm, _)) = decode_application_value(&inner[i..]) {
                time = Some(tm);
            }
        }
        at += end;
        at += decode_tag(buf.get(at..).ok_or_else(err_short)?)?.header_len; // closing 0
    }

    // [1] logDatum = CHOICE (constructed wrapper around one context value).
    let t = decode_tag(buf.get(at..).ok_or_else(err_short)?)?;
    if !(t.opening && t.context && t.number == 1) {
        return Err("log record: expected opening tag 1 (logDatum)".into());
    }
    at += t.header_len;
    let datum_tag = decode_tag(buf.get(at..).ok_or_else(err_short)?)?;
    let datum = if datum_tag.opening {
        // any-value (tag 10) wraps an application value.
        let inner_start = at + datum_tag.header_len;
        let (v, _) = decode_application_value(buf.get(inner_start..).ok_or_else(err_short)?)
            .unwrap_or((BacnetValue::Null, 0));
        v
    } else {
        let cstart = at + datum_tag.header_len;
        let content = buf.get(cstart..cstart + datum_tag.lvt as usize).ok_or_else(err_short)?;
        decode_log_datum(datum_tag.number, content)
    };
    // Skip to the closing tag 1.
    let after = find_closing(buf.get(at..).ok_or_else(err_short)?, 1)?;
    at += after;
    at += decode_tag(buf.get(at..).ok_or_else(err_short)?)?.header_len; // closing 1

    // optional [2] statusFlags (primitive bitstring).
    let mut status = None;
    if let Some(rest) = buf.get(at..) {
        if !rest.is_empty() {
            let t = decode_tag(rest)?;
            if t.context && !t.opening && !t.closing && t.number == 2 {
                let content = rest
                    .get(t.header_len..t.header_len + t.lvt as usize)
                    .ok_or_else(err_short)?;
                if let BacnetValue::BitString { bits, .. } = decode_log_datum(6, content) {
                    let names = ["in-alarm", "fault", "overridden", "out-of-service"];
                    let raised: Vec<&str> = bits
                        .chars()
                        .enumerate()
                        .filter(|(_, c)| *c == '1')
                        .filter_map(|(i, _)| names.get(i).copied())
                        .collect();
                    status = Some(if raised.is_empty() { "normal".into() } else { raised.join(", ") });
                }
                at += t.header_len + t.lvt as usize;
            }
        }
    }

    Ok((LogRecord { date, time, datum, status }, at))
}

/// Pulls the object identifiers out of a decoded object-list value set.
pub fn object_ids_from_values(values: &[BacnetValue]) -> Vec<ObjectId> {
    values
        .iter()
        .filter_map(|v| match v {
            BacnetValue::ObjectIdentifier { object_type, instance } => {
                Some(ObjectId::new(*object_type, *instance))
            }
            _ => None,
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Name tables (display helpers)
// ---------------------------------------------------------------------------

/// Human name for a BACnet object type.
pub fn object_type_name(t: u16) -> String {
    match t {
        0 => "analog-input",
        1 => "analog-output",
        2 => "analog-value",
        3 => "binary-input",
        4 => "binary-output",
        5 => "binary-value",
        6 => "calendar",
        7 => "command",
        8 => "device",
        9 => "event-enrollment",
        10 => "file",
        11 => "group",
        12 => "loop",
        13 => "multi-state-input",
        14 => "multi-state-output",
        15 => "notification-class",
        16 => "program",
        17 => "schedule",
        18 => "averaging",
        19 => "multi-state-value",
        20 => "trend-log",
        21 => "life-safety-point",
        22 => "life-safety-zone",
        23 => "accumulator",
        24 => "pulse-converter",
        25 => "event-log",
        26 => "global-group",
        27 => "trend-log-multiple",
        28 => "load-control",
        29 => "structured-view",
        30 => "access-door",
        32 => "access-credential",
        33 => "access-point",
        34 => "access-rights",
        35 => "access-user",
        36 => "access-zone",
        37 => "credential-data-input",
        39 => "bitstring-value",
        40 => "characterstring-value",
        41 => "date-pattern-value",
        42 => "date-value",
        43 => "datetime-pattern-value",
        44 => "datetime-value",
        45 => "integer-value",
        46 => "large-analog-value",
        47 => "octetstring-value",
        48 => "positive-integer-value",
        49 => "time-pattern-value",
        50 => "time-value",
        51 => "notification-forwarder",
        52 => "alert-enrollment",
        53 => "channel",
        54 => "lighting-output",
        _ => return format!("object-type-{t}"),
    }
    .to_string()
}

/// Human name for a BACnet property identifier (common subset).
pub fn property_name(p: u32) -> String {
    match p {
        4 => "active-text",
        8 => "all",
        11 => "apdu-timeout",
        12 => "application-software-version",
        17 => "notification-class",
        22 => "cov-increment",
        25 => "deadband",
        28 => "description",
        30 => "device-address-binding",
        31 => "device-type",
        35 => "event-enable",
        36 => "event-state",
        44 => "firmware-revision",
        46 => "inactive-text",
        52 => "limit-enable",
        56 => "local-date",
        57 => "local-time",
        58 => "location",
        59 => "low-limit",
        45 => "high-limit",
        62 => "max-apdu-length-accepted",
        63 => "max-info-frames",
        64 => "max-master",
        65 => "max-pres-value",
        69 => "min-pres-value",
        70 => "model-name",
        72 => "notify-type",
        73 => "number-of-apdu-retries",
        74 => "number-of-states",
        75 => "object-identifier",
        76 => "object-list",
        77 => "object-name",
        79 => "object-type",
        80 => "optional",
        81 => "out-of-service",
        85 => "present-value",
        87 => "priority-array",
        96 => "protocol-object-types-supported",
        97 => "protocol-services-supported",
        98 => "protocol-version",
        103 => "reliability",
        104 => "relinquish-default",
        105 => "required",
        106 => "resolution",
        107 => "segmentation-supported",
        110 => "state-text",
        111 => "status-flags",
        112 => "system-status",
        113 => "time-delay",
        117 => "units",
        119 => "utc-offset",
        120 => "vendor-identifier",
        121 => "vendor-name",
        139 => "protocol-revision",
        152 => "active-cov-subscriptions",
        155 => "database-revision",
        167 => "max-segments-accepted",
        168 => "profile-name",
        _ => return format!("property-{p}"),
    }
    .to_string()
}

/// Human name for a BACnet engineering unit (common HVAC subset).
pub fn engineering_unit_name(u: u32) -> Option<&'static str> {
    Some(match u {
        2 => "mA",
        3 => "A",
        5 => "V",
        18 => "J",
        19 => "kJ",
        20 => "Wh",
        21 => "kWh",
        22 => "BTU",
        29 => "Hz",
        31 => "%RH",
        32 => "mm",
        33 => "m",
        34 => "in",
        35 => "ft",
        39 => "lux",
        41 => "kg",
        42 => "lb",
        48 => "lb/h",
        49 => "W",
        50 => "kW",
        51 => "MW",
        52 => "BTU/h",
        53 => "hp",
        54 => "tons",
        55 => "Pa",
        56 => "kPa",
        57 => "bar",
        58 => "psi",
        60 => "inH₂O",
        63 => "inHg",
        64 => "°C",
        65 => "K",
        66 => "°F",
        69 => "years",
        70 => "months",
        71 => "weeks",
        72 => "days",
        73 => "hours",
        74 => "min",
        75 => "s",
        76 => "m/s",
        78 => "ft/s",
        79 => "ft/min",
        81 => "ft³",
        82 => "m³",
        84 => "L",
        85 => "gal",
        86 => "CFM",
        89 => "L/s",
        90 => "L/min",
        91 => "GPM",
        92 => "°",
        95 => "°F/h",
        97 => "(none)",
        98 => "ppm",
        99 => "ppb",
        100 => "%",
        102 => "/min",
        103 => "/s",
        106 => "RPM",
        _ => return None,
    })
}

pub fn error_class_name(c: u32) -> String {
    match c {
        0 => "device",
        1 => "object",
        2 => "property",
        3 => "resources",
        4 => "security",
        5 => "services",
        6 => "vt",
        7 => "communication",
        _ => return format!("error-class-{c}"),
    }
    .to_string()
}

pub fn error_code_name(c: u32) -> String {
    match c {
        0 => "other",
        2 => "configuration-in-progress",
        3 => "device-busy",
        9 => "inconsistent-parameters",
        25 => "operational-problem",
        26 => "password-failure",
        27 => "read-access-denied",
        31 => "unknown-object",
        32 => "unknown-property",
        37 => "value-out-of-range",
        40 => "write-access-denied",
        41 => "character-set-not-supported",
        42 => "invalid-array-index",
        44 => "not-cov-property",
        45 => "optional-functionality-not-supported",
        47 => "datatype-not-supported",
        50 => "property-is-not-an-array",
        _ => return format!("error-code-{c}"),
    }
    .to_string()
}

pub fn reject_reason_name(r: u8) -> String {
    match r {
        0 => "other",
        1 => "buffer-overflow",
        2 => "inconsistent-parameters",
        3 => "invalid-parameter-data-type",
        4 => "invalid-tag",
        5 => "missing-required-parameter",
        6 => "parameter-out-of-range",
        7 => "too-many-arguments",
        8 => "undefined-enumeration",
        9 => "unrecognized-service",
        _ => return format!("reject-{r}"),
    }
    .to_string()
}

pub fn abort_reason_name(r: u8) -> String {
    match r {
        0 => "other",
        1 => "buffer-overflow",
        2 => "invalid-apdu-in-this-state",
        3 => "preempted-by-higher-priority-task",
        4 => "segmentation-not-supported",
        5 => "security-error",
        6 => "insufficient-security",
        9 => "out-of-resources",
        10 => "tsm-timeout",
        11 => "apdu-too-long",
        _ => return format!("abort-{r}"),
    }
    .to_string()
}

pub fn segmentation_name(s: u32) -> &'static str {
    match s {
        0 => "both",
        1 => "transmit",
        2 => "receive",
        _ => "none",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ---- tags ----

    #[test]
    fn tag_roundtrip_small_lengths() {
        for lvt in [0u32, 1, 4] {
            let mut buf = Vec::new();
            encode_tag(&mut buf, 2, false, lvt);
            let t = decode_tag(&buf).unwrap();
            assert_eq!((t.number, t.context, t.lvt, t.header_len), (2, false, lvt, 1));
        }
    }

    #[test]
    fn tag_extended_length_u8_and_u16() {
        let mut buf = Vec::new();
        encode_tag(&mut buf, 7, false, 200);
        assert_eq!(buf, vec![0x75, 200]);
        let t = decode_tag(&buf).unwrap();
        assert_eq!((t.lvt, t.header_len), (200, 2));

        let mut buf = Vec::new();
        encode_tag(&mut buf, 7, false, 300);
        assert_eq!(buf, vec![0x75, 254, 0x01, 0x2C]);
        let t = decode_tag(&buf).unwrap();
        assert_eq!((t.lvt, t.header_len), (300, 4));
    }

    #[test]
    fn tag_extended_tag_number() {
        let mut buf = Vec::new();
        encode_tag(&mut buf, 33, true, 1);
        buf.push(0x07);
        // 0xF9 = tag F (extended), context, len 1; next octet = real tag number.
        assert_eq!(buf, vec![0xF9, 33, 0x07]);
        let t = decode_tag(&buf).unwrap();
        assert_eq!((t.number, t.context, t.lvt, t.header_len), (33, true, 1, 2));
    }

    #[test]
    fn opening_closing_tags() {
        let mut buf = Vec::new();
        encode_opening_tag(&mut buf, 3);
        encode_closing_tag(&mut buf, 3);
        assert_eq!(buf, vec![0x3E, 0x3F]);
        let open = decode_tag(&buf).unwrap();
        assert!(open.opening && open.context && open.number == 3);
        let close = decode_tag(&buf[1..]).unwrap();
        assert!(close.closing && close.context && close.number == 3);
    }

    // ---- application values ----

    fn roundtrip(v: BacnetValue) -> BacnetValue {
        let mut buf = Vec::new();
        encode_application_value(&mut buf, &v);
        let (out, n) = decode_application_value(&buf).unwrap();
        assert_eq!(n, buf.len(), "consumed length mismatch for {v:?}");
        out
    }

    #[test]
    fn value_roundtrips() {
        for v in [
            BacnetValue::Null,
            BacnetValue::Boolean { value: true },
            BacnetValue::Boolean { value: false },
            BacnetValue::Unsigned { value: 0 },
            BacnetValue::Unsigned { value: 255 },
            BacnetValue::Unsigned { value: 0x1_0000 },
            BacnetValue::Signed { value: -1 },
            BacnetValue::Signed { value: 130 },
            BacnetValue::Signed { value: -40000 },
            BacnetValue::Real { value: 72.5 },
            BacnetValue::Double { value: -0.125 },
            BacnetValue::OctetString { hex: "DEADBEEF".into() },
            BacnetValue::CharacterString { value: "Zone Temp °F".into() },
            BacnetValue::Enumerated { value: 66 },
            BacnetValue::Date { year: 2026, month: 6, day: 12, weekday: 5 },
            BacnetValue::Time { hour: 13, minute: 45, second: 30, hundredths: 0 },
            BacnetValue::ObjectIdentifier { object_type: 0, instance: 1 },
            BacnetValue::ObjectIdentifier { object_type: 8, instance: 4_194_302 },
        ] {
            assert_eq!(roundtrip(v.clone()), v);
        }
    }

    #[test]
    fn unsigned_minimal_encoding() {
        let mut buf = Vec::new();
        encode_application_value(&mut buf, &BacnetValue::Unsigned { value: 0 });
        assert_eq!(buf, vec![0x21, 0x00]);
        let mut buf = Vec::new();
        encode_application_value(&mut buf, &BacnetValue::Unsigned { value: 1024 });
        assert_eq!(buf, vec![0x22, 0x04, 0x00]);
    }

    #[test]
    fn signed_minimal_encoding() {
        let mut buf = Vec::new();
        encode_application_value(&mut buf, &BacnetValue::Signed { value: -1 });
        assert_eq!(buf, vec![0x31, 0xFF]);
        // 130 doesn't fit in i8, needs two octets.
        let mut buf = Vec::new();
        encode_application_value(&mut buf, &BacnetValue::Signed { value: 130 });
        assert_eq!(buf, vec![0x32, 0x00, 0x82]);
    }

    #[test]
    fn real_encoding_matches_reference() {
        // 72.0f32 = 0x42900000 big-endian (bacnet-stack wp.c example).
        let mut buf = Vec::new();
        encode_application_value(&mut buf, &BacnetValue::Real { value: 72.0 });
        assert_eq!(buf, vec![0x44, 0x42, 0x90, 0x00, 0x00]);
    }

    #[test]
    fn character_string_utf8_charset_octet() {
        let mut buf = Vec::new();
        encode_application_value(&mut buf, &BacnetValue::CharacterString { value: "AB".into() });
        // tag 7, len 3 (charset + 2 bytes), charset 0, 'A', 'B'.
        assert_eq!(buf, vec![0x73, 0x00, 0x41, 0x42]);
    }

    #[test]
    fn bit_string_status_flags() {
        // status-flags: 4-bit bitstring, 4 unused bits, value 1010 (in-alarm + overridden).
        let (v, n) = decode_application_value(&[0x82, 0x04, 0xA0]).unwrap();
        assert_eq!(n, 3);
        assert_eq!(v, BacnetValue::BitString { unused_bits: 4, bits: "1010".into() });
        // And back out again.
        let mut buf = Vec::new();
        encode_application_value(&mut buf, &v);
        assert_eq!(buf, vec![0x82, 0x04, 0xA0]);
    }

    #[test]
    fn object_id_packing() {
        let id = ObjectId::new(8, 15);
        assert_eq!(id.to_raw(), 0x0200_000F);
        assert_eq!(ObjectId::from_raw(0x0200_000F), id);
        // analog-value 1 = (2 << 22) | 1.
        assert_eq!(ObjectId::new(2, 1).to_raw(), 0x0080_0001);
    }

    #[test]
    fn value_list_with_nested_context_construct() {
        // [values...][context-2 constructed][closing 3]
        let mut buf = Vec::new();
        encode_application_value(&mut buf, &BacnetValue::Real { value: 1.0 });
        encode_opening_tag(&mut buf, 2);
        encode_application_value(&mut buf, &BacnetValue::Unsigned { value: 7 });
        encode_closing_tag(&mut buf, 2);
        encode_closing_tag(&mut buf, 3);
        let (values, consumed) = decode_value_list(&buf, 3).unwrap();
        assert_eq!(consumed, buf.len());
        assert_eq!(values.len(), 2);
        assert_eq!(values[0], BacnetValue::Real { value: 1.0 });
        assert!(matches!(values[1], BacnetValue::Unknown { tag: 2, .. }));
    }

    #[test]
    fn priority_array_decode() {
        // 15 Nulls + one Real, closed with tag 3.
        let mut buf = Vec::new();
        for _ in 0..15 {
            encode_application_value(&mut buf, &BacnetValue::Null);
        }
        encode_application_value(&mut buf, &BacnetValue::Real { value: 55.0 });
        encode_closing_tag(&mut buf, 3);
        let (values, _) = decode_value_list(&buf, 3).unwrap();
        assert_eq!(values.len(), 16);
        assert_eq!(values[15], BacnetValue::Real { value: 55.0 });
        assert!(values[..15].iter().all(|v| *v == BacnetValue::Null));
    }

    // ---- BVLC ----

    #[test]
    fn bvlc_whois_broadcast_frame() {
        // Full frame from the bacnet-stack reference: BVLC + global-broadcast NPDU + Who-Is.
        let npdu = encode_npdu(false, Some((BROADCAST_NETWORK, &[])));
        let mut payload = npdu.clone();
        payload.extend_from_slice(&encode_who_is(None, None));
        let frame = bvlc_encode(BVLC_ORIGINAL_BROADCAST, &payload);
        assert_eq!(
            frame,
            vec![0x81, 0x0B, 0x00, 0x0C, 0x01, 0x20, 0xFF, 0xFF, 0x00, 0xFF, 0x10, 0x08]
        );
    }

    #[test]
    fn bvlc_decode_unicast() {
        let frame = bvlc_encode(BVLC_ORIGINAL_UNICAST, &[0x01, 0x00, 0x10, 0x08]);
        let b = bvlc_decode(&frame).unwrap();
        assert_eq!(b.function, BVLC_ORIGINAL_UNICAST);
        assert_eq!(b.payload_offset, 4);
        assert_eq!(b.origin, None);
    }

    #[test]
    fn bvlc_decode_forwarded_npdu() {
        // Forwarded-NPDU carries the 6-byte origin B/IP address before the NPDU.
        let mut payload = vec![192, 168, 1, 50, 0xBA, 0xC0];
        payload.extend_from_slice(&[0x01, 0x00, 0x10, 0x08]);
        let frame = bvlc_encode(BVLC_FORWARDED_NPDU, &payload);
        let b = bvlc_decode(&frame).unwrap();
        assert_eq!(b.function, BVLC_FORWARDED_NPDU);
        assert_eq!(b.payload_offset, 10);
        assert_eq!(b.origin, Some((std::net::Ipv4Addr::new(192, 168, 1, 50), 47808)));
    }

    #[test]
    fn bvlc_register_foreign_device_frame() {
        assert_eq!(
            encode_register_foreign_device(60),
            vec![0x81, 0x05, 0x00, 0x06, 0x00, 0x3C]
        );
    }

    #[test]
    fn bvlc_result_decode() {
        assert_eq!(decode_bvlc_result(&[0x81, 0x00, 0x00, 0x06, 0x00, 0x00]), Some(0));
        assert_eq!(decode_bvlc_result(&[0x81, 0x00, 0x00, 0x06, 0x00, 0x30]), Some(0x30));
        assert_eq!(decode_bvlc_result(&[0x81, 0x0A, 0x00, 0x04]), None);
    }

    #[test]
    fn bvlc_rejects_non_bacnet() {
        assert!(bvlc_decode(&[0x45, 0x0A, 0x00, 0x04]).is_err());
        assert!(bvlc_decode(&[0x81, 0x0A]).is_err());
    }

    // ---- NPDU ----

    #[test]
    fn npdu_local_encodings() {
        assert_eq!(encode_npdu(true, None), vec![0x01, 0x04]);
        assert_eq!(encode_npdu(false, None), vec![0x01, 0x00]);
    }

    #[test]
    fn npdu_global_broadcast() {
        assert_eq!(
            encode_npdu(false, Some((BROADCAST_NETWORK, &[]))),
            vec![0x01, 0x20, 0xFF, 0xFF, 0x00, 0xFF]
        );
    }

    #[test]
    fn npdu_routed_destination() {
        // DNET 2001, DADR = MS/TP MAC 12.
        let npdu = encode_npdu(true, Some((2001, &[12])));
        assert_eq!(npdu, vec![0x01, 0x24, 0x07, 0xD1, 0x01, 0x0C, 0xFF]);
        let d = decode_npdu(&npdu).unwrap();
        assert_eq!(d.dest, Some((2001, vec![12])));
        assert_eq!(d.apdu_offset, npdu.len());
    }

    #[test]
    fn npdu_decode_with_source() {
        // Control 0x08 = source specifier present (typical routed I-Am reply path).
        let buf = vec![0x01, 0x08, 0x07, 0xD1, 0x01, 0x0C, 0x10, 0x00];
        let d = decode_npdu(&buf).unwrap();
        assert!(!d.network_message);
        assert_eq!(d.source, Some((2001, vec![0x0C])));
        assert_eq!(d.apdu_offset, 6);
        assert_eq!(buf[d.apdu_offset], 0x10);
    }

    #[test]
    fn npdu_network_message_flag() {
        let d = decode_npdu(&[0x01, 0x80, 0x00]).unwrap();
        assert!(d.network_message);
        assert_eq!(d.message_type, Some(NETWORK_MSG_WHO_IS_ROUTER_TO_NETWORK));
        assert_eq!(d.apdu_offset, 3);
    }

    #[test]
    fn who_is_router_roundtrip() {
        // Who-Is-Router-To-Network, global broadcast.
        let npdu = encode_network_message(
            NETWORK_MSG_WHO_IS_ROUTER_TO_NETWORK,
            &[],
            Some((BROADCAST_NETWORK, &[])),
        );
        assert_eq!(npdu, vec![0x01, 0xA0, 0xFF, 0xFF, 0x00, 0xFF, 0x00]);
        let d = decode_npdu(&npdu).unwrap();
        assert!(d.network_message);
        assert_eq!(d.message_type, Some(NETWORK_MSG_WHO_IS_ROUTER_TO_NETWORK));

        // I-Am-Router-To-Network reply carrying networks 2001 and 100.
        let reply = encode_network_message(
            NETWORK_MSG_I_AM_ROUTER_TO_NETWORK,
            &[0x07, 0xD1, 0x00, 0x64],
            None,
        );
        let d = decode_npdu(&reply).unwrap();
        assert_eq!(d.message_type, Some(NETWORK_MSG_I_AM_ROUTER_TO_NETWORK));
        assert_eq!(decode_router_networks(&reply[d.apdu_offset..]), vec![2001, 100]);
    }

    #[test]
    fn proprietary_network_message_skips_vendor_id() {
        // Type >= 0x80 carries a 2-byte vendor ID before the payload.
        let d = decode_npdu(&[0x01, 0x80, 0x80, 0x01, 0x04, 0xAA]).unwrap();
        assert_eq!(d.message_type, Some(0x80));
        assert_eq!(d.apdu_offset, 5);
    }

    // ---- APDU + services ----

    #[test]
    fn who_is_no_limits() {
        assert_eq!(encode_who_is(None, None), vec![0x10, 0x08]);
    }

    #[test]
    fn who_is_with_range() {
        assert_eq!(
            encode_who_is(Some(100), Some(200)),
            vec![0x10, 0x08, 0x09, 100, 0x19, 200]
        );
    }

    #[test]
    fn i_am_decode_reference_frame() {
        // From the bacnet-stack iam.c example: device 15, max-APDU 1024,
        // segmentation none (3), vendor 260.
        let apdu = vec![
            0x10, 0x00, 0xC4, 0x02, 0x00, 0x00, 0x0F, 0x22, 0x04, 0x00, 0x91, 0x03, 0x22,
            0x01, 0x04,
        ];
        let parsed = decode_apdu(&apdu).unwrap();
        let Apdu::Unconfirmed { service, payload_offset } = parsed else {
            panic!("expected unconfirmed");
        };
        assert_eq!(service, SERVICE_I_AM);
        let iam = decode_i_am(&apdu[payload_offset..]).unwrap();
        assert_eq!(iam.device, ObjectId::new(8, 15));
        assert_eq!(iam.max_apdu, 1024);
        assert_eq!(iam.segmentation, 3);
        assert_eq!(iam.vendor_id, 260);
    }

    #[test]
    fn read_property_request_reference_frame() {
        // ReadProperty analog-input 1 present-value, invoke 1 (bacnet-stack rp.c
        // body), with our header advertising segmentation acceptance (0x02 SA,
        // 0x45 = 16 segs / max-APDU 1476).
        let apdu = encode_read_property(1, ObjectId::new(0, 1), PROP_PRESENT_VALUE, None);
        assert_eq!(
            apdu,
            vec![0x02, 0x45, 0x01, 0x0C, 0x0C, 0x00, 0x00, 0x00, 0x01, 0x19, 0x55]
        );
    }

    #[test]
    fn read_property_with_array_index() {
        let apdu = encode_read_property(2, ObjectId::new(8, 1), PROP_OBJECT_LIST, Some(0));
        // ...context-2 unsigned 0 at the end.
        assert_eq!(&apdu[apdu.len() - 2..], &[0x29, 0x00]);
    }

    #[test]
    fn read_property_ack_roundtrip() {
        // ComplexACK invoke 1, ReadProperty, AI-1 present-value = 72.0.
        let apdu = vec![
            0x30, 0x01, 0x0C, 0x0C, 0x00, 0x00, 0x00, 0x01, 0x19, 0x55, 0x3E, 0x44, 0x42,
            0x90, 0x00, 0x00, 0x3F,
        ];
        let parsed = decode_apdu(&apdu).unwrap();
        let Apdu::ComplexAck { invoke_id, service, segmented, payload_offset, .. } = parsed else {
            panic!("expected complex ack");
        };
        assert_eq!((invoke_id, service, segmented), (1, SERVICE_READ_PROPERTY, false));
        let ack = decode_read_property_ack(&apdu[payload_offset..]).unwrap();
        assert_eq!(ack.object, ObjectId::new(0, 1));
        assert_eq!(ack.property, PROP_PRESENT_VALUE);
        assert_eq!(ack.array_index, None);
        assert_eq!(ack.values, vec![BacnetValue::Real { value: 72.0 }]);
    }

    #[test]
    fn read_property_ack_with_array_index() {
        // object-list[0] = count 42.
        let mut payload = Vec::new();
        encode_context_object_id(&mut payload, 0, ObjectId::new(8, 100));
        encode_context_unsigned(&mut payload, 1, PROP_OBJECT_LIST as u64);
        encode_context_unsigned(&mut payload, 2, 0);
        encode_opening_tag(&mut payload, 3);
        encode_application_value(&mut payload, &BacnetValue::Unsigned { value: 42 });
        encode_closing_tag(&mut payload, 3);
        let ack = decode_read_property_ack(&payload).unwrap();
        assert_eq!(ack.array_index, Some(0));
        assert_eq!(ack.values, vec![BacnetValue::Unsigned { value: 42 }]);
    }

    #[test]
    fn write_property_request_reference_frame() {
        // Write 72.0 to analog-value 1 present-value at priority 8, invoke 2
        // (byte layout per bacnet-stack wp.c).
        let apdu = encode_write_property(
            2,
            ObjectId::new(2, 1),
            PROP_PRESENT_VALUE,
            None,
            &[BacnetValue::Real { value: 72.0 }],
            Some(8),
        );
        assert_eq!(
            apdu,
            vec![
                0x02, 0x45, 0x02, 0x0F, 0x0C, 0x00, 0x80, 0x00, 0x01, 0x19, 0x55, 0x3E,
                0x44, 0x42, 0x90, 0x00, 0x00, 0x3F, 0x49, 0x08
            ]
        );
    }

    #[test]
    fn write_null_relinquishes() {
        let apdu = encode_write_property(
            3,
            ObjectId::new(1, 5),
            PROP_PRESENT_VALUE,
            None,
            &[BacnetValue::Null],
            Some(8),
        );
        // ...opening 3, Null (0x00), closing 3, priority 8.
        let tail = &apdu[apdu.len() - 5..];
        assert_eq!(tail, &[0x3E, 0x00, 0x3F, 0x49, 0x08]);
    }

    #[test]
    fn simple_ack_decode() {
        let parsed = decode_apdu(&[0x20, 0x02, 0x0F]).unwrap();
        assert_eq!(parsed, Apdu::SimpleAck { invoke_id: 2, service: SERVICE_WRITE_PROPERTY });
    }

    #[test]
    fn error_decode() {
        // Error, invoke 3, ReadProperty, class property (2), code unknown-property (32).
        let parsed = decode_apdu(&[0x50, 0x03, 0x0C, 0x91, 0x02, 0x91, 0x20]).unwrap();
        assert_eq!(
            parsed,
            Apdu::Error { invoke_id: 3, service: 12, error_class: 2, error_code: 32 }
        );
        assert_eq!(error_class_name(2), "property");
        assert_eq!(error_code_name(32), "unknown-property");
    }

    #[test]
    fn reject_and_abort_decode() {
        assert_eq!(decode_apdu(&[0x60, 0x05, 0x04]).unwrap(), Apdu::Reject { invoke_id: 5, reason: 4 });
        assert_eq!(decode_apdu(&[0x70, 0x07, 0x04]).unwrap(), Apdu::Abort { invoke_id: 7, reason: 4 });
        assert_eq!(reject_reason_name(4), "invalid-tag");
        assert_eq!(abort_reason_name(4), "segmentation-not-supported");
    }

    #[test]
    fn segmented_complex_ack_flagged() {
        // SEG+MOR set: [0x3C][invoke][seq=0][window=1][service]...
        let parsed = decode_apdu(&[0x3C, 0x09, 0x00, 0x01, 0x0C, 0xAB]).unwrap();
        let Apdu::ComplexAck { segmented, more, sequence, window, invoke_id, service, payload_offset } = parsed
        else {
            panic!("expected complex ack");
        };
        assert!(segmented && more);
        assert_eq!((invoke_id, service, sequence, window), (9, SERVICE_READ_PROPERTY, 0, 1));
        assert_eq!(payload_offset, 5);
    }

    #[test]
    fn segment_ack_encode() {
        // Ack segments up to seq 2, grant window 8 to a response we're receiving.
        assert_eq!(encode_segment_ack(false, false, 5, 2, 8), vec![0x40, 5, 2, 8]);
        // Negative ack (request retransmit) sets the NAK bit.
        assert_eq!(encode_segment_ack(true, false, 5, 2, 8), vec![0x42, 5, 2, 8]);
    }

    #[test]
    fn rpm_request_and_ack_roundtrip() {
        let specs = vec![
            ReadAccessSpec {
                object: ObjectId::new(0, 1),
                properties: vec![
                    PropertyRef { property: PROP_OBJECT_NAME, array_index: None },
                    PropertyRef { property: PROP_PRESENT_VALUE, array_index: None },
                ],
            },
            ReadAccessSpec {
                object: ObjectId::new(8, 100),
                properties: vec![PropertyRef { property: PROP_OBJECT_LIST, array_index: Some(0) }],
            },
        ];
        let apdu = encode_read_property_multiple(7, &specs);
        assert_eq!(&apdu[..4], &[0x02, 0x45, 0x07, 0x0E]);

        // Build the matching ACK: AI-1 name + value, device object-list[0] error.
        let mut payload = Vec::new();
        encode_context_object_id(&mut payload, 0, ObjectId::new(0, 1));
        encode_opening_tag(&mut payload, 1);
        encode_context_unsigned(&mut payload, 2, PROP_OBJECT_NAME as u64);
        encode_opening_tag(&mut payload, 4);
        encode_application_value(&mut payload, &BacnetValue::CharacterString { value: "Zone Temp".into() });
        encode_closing_tag(&mut payload, 4);
        encode_context_unsigned(&mut payload, 2, PROP_PRESENT_VALUE as u64);
        encode_opening_tag(&mut payload, 4);
        encode_application_value(&mut payload, &BacnetValue::Real { value: 71.5 });
        encode_closing_tag(&mut payload, 4);
        encode_closing_tag(&mut payload, 1);
        encode_context_object_id(&mut payload, 0, ObjectId::new(8, 100));
        encode_opening_tag(&mut payload, 1);
        encode_context_unsigned(&mut payload, 2, PROP_OBJECT_LIST as u64);
        encode_context_unsigned(&mut payload, 3, 0);
        encode_opening_tag(&mut payload, 5);
        encode_application_value(&mut payload, &BacnetValue::Enumerated { value: 2 });
        encode_application_value(&mut payload, &BacnetValue::Enumerated { value: 32 });
        encode_closing_tag(&mut payload, 5);
        encode_closing_tag(&mut payload, 1);

        let objects = decode_read_property_multiple_ack(&payload).unwrap();
        assert_eq!(objects.len(), 2);
        assert_eq!(objects[0].object, ObjectId::new(0, 1));
        assert_eq!(objects[0].properties.len(), 2);
        assert_eq!(
            objects[0].properties[0].values,
            Some(vec![BacnetValue::CharacterString { value: "Zone Temp".into() }])
        );
        assert_eq!(
            objects[0].properties[1].values,
            Some(vec![BacnetValue::Real { value: 71.5 }])
        );
        assert_eq!(objects[1].properties[0].array_index, Some(0));
        assert_eq!(objects[1].properties[0].error, Some((2, 32)));
    }

    #[test]
    fn subscribe_cov_request_frame() {
        // Subscribe process 1 to analog-input 0, confirmed, lifetime 60s, invoke 1.
        let apdu = encode_subscribe_cov(1, 1, ObjectId::new(0, 0), true, Some(60));
        assert_eq!(
            apdu,
            vec![
                0x02, 0x45, 0x01, 0x05, // confirmed+SA, max-seg/apdu, invoke 1, SubscribeCOV
                0x09, 0x01, // context 0 unsigned 1 (process id)
                0x1C, 0x00, 0x00, 0x00, 0x00, // context 1 object-id AI-0
                0x29, 0x01, // context 2 boolean true (confirmed)
                0x39, 0x3C, // context 3 unsigned 60 (lifetime)
            ]
        );
    }

    #[test]
    fn subscribe_cov_cancellation_omits_confirmed_and_lifetime() {
        let apdu = encode_subscribe_cov(2, 7, ObjectId::new(2, 5), false, None);
        // process 7, object AV-5, then nothing else.
        assert_eq!(
            apdu,
            vec![0x02, 0x45, 0x02, 0x05, 0x09, 0x07, 0x1C, 0x00, 0x80, 0x00, 0x05]
        );
    }

    #[test]
    fn cov_notification_roundtrip() {
        // Build an UnconfirmedCOVNotification: process 1, from device 1234,
        // AI-0, 55s remaining, present-value 21.5 + status-flags normal.
        let mut payload = Vec::new();
        encode_context_unsigned(&mut payload, 0, 1);
        encode_context_object_id(&mut payload, 1, ObjectId::new(8, 1234));
        encode_context_object_id(&mut payload, 2, ObjectId::new(0, 0));
        encode_context_unsigned(&mut payload, 3, 55);
        encode_opening_tag(&mut payload, 4);
        encode_cov_property_value(&mut payload, PROP_PRESENT_VALUE, &BacnetValue::Real { value: 21.5 });
        encode_cov_property_value(
            &mut payload,
            111,
            &BacnetValue::BitString { unused_bits: 4, bits: "0000".into() },
        );
        encode_closing_tag(&mut payload, 4);

        let n = decode_cov_notification(&payload).unwrap();
        assert_eq!(n.process_id, 1);
        assert_eq!(n.initiating_device, ObjectId::new(8, 1234));
        assert_eq!(n.monitored_object, ObjectId::new(0, 0));
        assert_eq!(n.time_remaining, 55);
        assert_eq!(n.values.len(), 2);
        assert_eq!(n.values[0].property, PROP_PRESENT_VALUE);
        assert_eq!(n.values[0].values, vec![BacnetValue::Real { value: 21.5 }]);
        assert_eq!(n.values[1].property, 111);
        assert_eq!(
            n.values[1].values,
            vec![BacnetValue::BitString { unused_bits: 4, bits: "0000".into() }]
        );
    }

    #[test]
    fn cov_notification_with_array_index_and_priority() {
        // A property value that carries both an array index (context 1) and a
        // trailing priority (context 3) — both must be handled.
        let mut payload = Vec::new();
        encode_context_unsigned(&mut payload, 0, 1);
        encode_context_object_id(&mut payload, 1, ObjectId::new(8, 9));
        encode_context_object_id(&mut payload, 2, ObjectId::new(1, 3));
        encode_context_unsigned(&mut payload, 3, 0);
        encode_opening_tag(&mut payload, 4);
        encode_context_unsigned(&mut payload, 0, PROP_PRESENT_VALUE as u64);
        encode_context_unsigned(&mut payload, 1, 1); // array index 1
        encode_opening_tag(&mut payload, 2);
        encode_application_value(&mut payload, &BacnetValue::Real { value: 9.0 });
        encode_closing_tag(&mut payload, 2);
        encode_context_unsigned(&mut payload, 3, 8); // priority 8
        encode_closing_tag(&mut payload, 4);

        let n = decode_cov_notification(&payload).unwrap();
        assert_eq!(n.values.len(), 1);
        assert_eq!(n.values[0].array_index, Some(1));
        assert_eq!(n.values[0].values, vec![BacnetValue::Real { value: 9.0 }]);
    }

    #[test]
    fn read_range_by_position_request() {
        // Read the 10 most recent records of trend-log 1's log-buffer.
        let apdu = encode_read_range_by_position(
            4,
            ObjectId::new(OBJECT_TYPE_TREND_LOG, 1),
            PROP_LOG_BUFFER,
            None,
            9999,
            -10,
        );
        // header + confirmed ReadRange, object TL-1, property 131, opening-3...
        assert_eq!(&apdu[..4], &[0x02, 0x45, 0x04, 0x1A]);
        // ...context-1 property 131 (0x83) appears; opening tag 3 (0x3E) present.
        assert!(apdu.contains(&0x3E) && apdu.contains(&0x3F));
    }

    #[test]
    fn read_range_ack_and_log_records_roundtrip() {
        // Build a ReadRange-ACK for trend-log 1 with two Real records.
        fn log_record(date: BacnetValue, time: BacnetValue, value: f32, out: &mut Vec<u8>) {
            encode_opening_tag(out, 0); // timestamp
            encode_application_value(out, &date);
            encode_application_value(out, &time);
            encode_closing_tag(out, 0);
            encode_opening_tag(out, 1); // logDatum
            // real-value is context tag 2, 4 content octets.
            encode_tag(out, 2, true, 4);
            out.extend_from_slice(&value.to_be_bytes());
            encode_closing_tag(out, 1);
            // statusFlags (normal).
            encode_tag(out, 2, true, 2);
            out.extend_from_slice(&[0x04, 0x00]);
        }

        let mut item_data = Vec::new();
        log_record(
            BacnetValue::Date { year: 2026, month: 6, day: 12, weekday: 5 },
            BacnetValue::Time { hour: 9, minute: 0, second: 0, hundredths: 0 },
            70.5,
            &mut item_data,
        );
        log_record(
            BacnetValue::Date { year: 2026, month: 6, day: 12, weekday: 5 },
            BacnetValue::Time { hour: 9, minute: 15, second: 0, hundredths: 0 },
            71.0,
            &mut item_data,
        );

        let mut payload = Vec::new();
        encode_context_object_id(&mut payload, 0, ObjectId::new(OBJECT_TYPE_TREND_LOG, 1));
        encode_context_unsigned(&mut payload, 1, PROP_LOG_BUFFER as u64);
        // result-flags: first+last set (context 3 bitstring, 5 unused bits).
        encode_tag(&mut payload, 3, true, 2);
        payload.extend_from_slice(&[0x05, 0b1100_0000]);
        encode_context_unsigned(&mut payload, 4, 2); // item-count
        encode_opening_tag(&mut payload, 5);
        payload.extend_from_slice(&item_data);
        encode_closing_tag(&mut payload, 5);
        encode_context_unsigned(&mut payload, 6, 1); // first-sequence

        let ack = decode_read_range_ack(&payload).unwrap();
        assert_eq!(ack.object, ObjectId::new(OBJECT_TYPE_TREND_LOG, 1));
        assert_eq!(ack.property, PROP_LOG_BUFFER);
        assert!(ack.first_item && ack.last_item && !ack.more_items);
        assert_eq!(ack.item_count, 2);
        assert_eq!(ack.first_sequence, Some(1));

        let records = decode_log_records(&ack.item_data);
        assert_eq!(records.len(), 2);
        assert_eq!(records[0].datum, BacnetValue::Real { value: 70.5 });
        assert_eq!(records[1].datum, BacnetValue::Real { value: 71.0 });
        assert_eq!(records[0].status.as_deref(), Some("normal"));
        assert_eq!(
            records[0].time,
            Some(BacnetValue::Time { hour: 9, minute: 0, second: 0, hundredths: 0 })
        );
    }

    #[test]
    fn log_record_datum_types() {
        // enumerated, unsigned, boolean datums decode by their CHOICE tag.
        let mut buf = Vec::new();
        encode_opening_tag(&mut buf, 0);
        encode_application_value(&mut buf, &BacnetValue::Date { year: 2026, month: 1, day: 1, weekday: 4 });
        encode_application_value(&mut buf, &BacnetValue::Time { hour: 0, minute: 0, second: 0, hundredths: 0 });
        encode_closing_tag(&mut buf, 0);
        encode_opening_tag(&mut buf, 1);
        encode_tag(&mut buf, 4, true, 1); // unsigned-value choice (tag 4)
        buf.push(42);
        encode_closing_tag(&mut buf, 1);

        let records = decode_log_records(&buf);
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].datum, BacnetValue::Unsigned { value: 42 });
        assert_eq!(records[0].status, None);
    }

    #[test]
    fn object_list_extraction() {
        let values = vec![
            BacnetValue::ObjectIdentifier { object_type: 8, instance: 100 },
            BacnetValue::ObjectIdentifier { object_type: 0, instance: 1 },
            BacnetValue::Null, // garbage tolerated
        ];
        let ids = object_ids_from_values(&values);
        assert_eq!(ids, vec![ObjectId::new(8, 100), ObjectId::new(0, 1)]);
    }

    #[test]
    fn date_time_decode() {
        // 2026-06-12 is a Friday (weekday 5). Raw year = 126.
        let (d, _) = decode_application_value(&[0xA4, 126, 6, 12, 5]).unwrap();
        assert_eq!(d, BacnetValue::Date { year: 2026, month: 6, day: 12, weekday: 5 });
        let (t, _) = decode_application_value(&[0xB4, 13, 45, 30, 0]).unwrap();
        assert_eq!(t, BacnetValue::Time { hour: 13, minute: 45, second: 30, hundredths: 0 });
    }

    #[test]
    fn date_wildcard_year_is_zero_not_2155() {
        // A fully-wildcarded Date (all 0xFF) must not decode the year as 2155.
        let (d, _) = decode_application_value(&[0xA4, 0xFF, 0xFF, 0xFF, 0xFF]).unwrap();
        assert_eq!(d, BacnetValue::Date { year: 0, month: 0xFF, day: 0xFF, weekday: 0xFF });
        // A wildcard-year-only pattern (every Tuesday in any year/month).
        let (d, _) = decode_application_value(&[0xA4, 0xFF, 0xFF, 0xFF, 2]).unwrap();
        assert_eq!(d, BacnetValue::Date { year: 0, month: 0xFF, day: 0xFF, weekday: 2 });
    }

    #[test]
    fn name_tables() {
        assert_eq!(object_type_name(0), "analog-input");
        assert_eq!(object_type_name(8), "device");
        assert_eq!(object_type_name(999), "object-type-999");
        assert_eq!(property_name(85), "present-value");
        assert_eq!(property_name(9999), "property-9999");
        assert_eq!(engineering_unit_name(66), Some("°F"));
        assert_eq!(engineering_unit_name(64), Some("°C"));
        assert_eq!(segmentation_name(3), "none");
    }

    #[test]
    fn truncated_inputs_error_cleanly() {
        assert!(decode_apdu(&[]).is_err());
        assert!(decode_apdu(&[0x00, 0x05]).is_err());
        assert!(decode_i_am(&[0xC4, 0x02]).is_err());
        assert!(decode_read_property_ack(&[0x0C, 0x00]).is_err());
        assert!(decode_npdu(&[0x01]).is_err());
        assert!(decode_tag(&[]).is_err());
        // Unbalanced constructed data must not loop or panic.
        let mut buf = Vec::new();
        encode_opening_tag(&mut buf, 2);
        encode_application_value(&mut buf, &BacnetValue::Real { value: 1.0 });
        assert!(decode_value_list(&buf, 3).is_err());
    }
}
