//! BACnet MS/TP frame codec — the master-slave/token-passing framing used on
//! RS-485 serial trunks, which is the most common BACnet field bus integrators
//! wire up. This module is the pure, portable, fully-tested core: frame
//! encode/decode plus the two standard CRCs (header CRC-8 and data CRC-16 from
//! ANSI/ASHRAE 135 clause 9).
//!
//! Serial I/O (opening a COM port, token timing) is deliberately NOT here — it
//! needs a serialport dependency and real hardware to validate. Keeping the
//! codec separate means the protocol logic is provable in CI today, and the
//! serial transport drops in behind it later (mirroring how `bacnet_codec` is
//! split from the `bacnet` UDP transport).
//!
//! The serial transport that consumes this codec is not wired yet, so the
//! public encode/decode surface is exercised by unit tests only; allow dead_code
//! module-wide until the COM-port driver lands.
#![allow(dead_code)]

const PREAMBLE_1: u8 = 0x55;
const PREAMBLE_2: u8 = 0xFF;

/// MS/TP frame types (135 clause 9.3).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FrameType {
    Token,
    PollForMaster,
    ReplyToPollForMaster,
    TestRequest,
    TestResponse,
    DataExpectingReply,
    DataNotExpectingReply,
    ReplyPostponed,
    Other(u8),
}

impl FrameType {
    fn to_byte(self) -> u8 {
        match self {
            FrameType::Token => 0,
            FrameType::PollForMaster => 1,
            FrameType::ReplyToPollForMaster => 2,
            FrameType::TestRequest => 3,
            FrameType::TestResponse => 4,
            FrameType::DataExpectingReply => 5,
            FrameType::DataNotExpectingReply => 6,
            FrameType::ReplyPostponed => 7,
            FrameType::Other(b) => b,
        }
    }

    fn from_byte(b: u8) -> Self {
        match b {
            0 => FrameType::Token,
            1 => FrameType::PollForMaster,
            2 => FrameType::ReplyToPollForMaster,
            3 => FrameType::TestRequest,
            4 => FrameType::TestResponse,
            5 => FrameType::DataExpectingReply,
            6 => FrameType::DataNotExpectingReply,
            7 => FrameType::ReplyPostponed,
            other => FrameType::Other(other),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MstpFrame {
    pub frame_type: FrameType,
    pub destination: u8,
    pub source: u8,
    pub data: Vec<u8>,
}

/// One accumulation step of the MS/TP header CRC (135 clause 9.5.1).
fn header_crc_step(data: u8, crc: u8) -> u8 {
    let mut c: u16 = crc as u16 ^ data as u16;
    c = c ^ (c << 1) ^ (c << 2) ^ (c << 3) ^ (c << 4) ^ (c << 5) ^ (c << 6) ^ (c << 7);
    ((c & 0xfe) ^ ((c >> 8) & 1)) as u8
}

/// Transmitted header CRC: accumulate over the 5 header bytes from 0xFF, then
/// send the one's complement.
fn header_crc(header: &[u8]) -> u8 {
    let mut crc: u8 = 0xFF;
    for &b in header {
        crc = header_crc_step(b, crc);
    }
    !crc
}

/// One accumulation step of the MS/TP data CRC-16 (135 clause 9.5.2).
fn data_crc_step(data: u8, crc: u16) -> u16 {
    let crc_low = (crc & 0xff) ^ data as u16;
    (crc >> 8)
        ^ (crc_low << 8)
        ^ (crc_low << 3)
        ^ (crc_low << 12)
        ^ (crc_low >> 4)
        ^ (crc_low & 0x0f)
        ^ ((crc_low & 0x0f) << 7)
}

/// Transmitted data CRC: accumulate from 0xFFFF, send the one's complement.
fn data_crc(data: &[u8]) -> u16 {
    let mut crc: u16 = 0xFFFF;
    for &b in data {
        crc = data_crc_step(b, crc);
    }
    !crc & 0xFFFF
}

/// Encode a complete MS/TP frame ready for the wire (preamble + header + header
/// CRC + optional data + data CRC).
pub fn encode_frame(frame: &MstpFrame) -> Vec<u8> {
    let len = frame.data.len() as u16;
    let header = [
        frame.frame_type.to_byte(),
        frame.destination,
        frame.source,
        (len >> 8) as u8,
        (len & 0xff) as u8,
    ];
    let mut out = Vec::with_capacity(8 + frame.data.len() + 2);
    out.push(PREAMBLE_1);
    out.push(PREAMBLE_2);
    out.extend_from_slice(&header);
    out.push(header_crc(&header));
    if !frame.data.is_empty() {
        out.extend_from_slice(&frame.data);
        let dcrc = data_crc(&frame.data);
        // Data CRC is transmitted least-significant byte first.
        out.push((dcrc & 0xff) as u8);
        out.push((dcrc >> 8) as u8);
    }
    out
}

/// Decode and validate an MS/TP frame, checking both preamble bytes and CRCs.
pub fn decode_frame(bytes: &[u8]) -> Result<MstpFrame, String> {
    if bytes.len() < 8 {
        return Err(format!("short MS/TP frame ({} bytes)", bytes.len()));
    }
    if bytes[0] != PREAMBLE_1 || bytes[1] != PREAMBLE_2 {
        return Err("bad MS/TP preamble".into());
    }
    let header = &bytes[2..7];
    if bytes[7] != header_crc(header) {
        return Err("MS/TP header CRC mismatch".into());
    }
    let frame_type = FrameType::from_byte(header[0]);
    let destination = header[1];
    let source = header[2];
    let length = ((header[3] as usize) << 8) | header[4] as usize;

    if length == 0 {
        return Ok(MstpFrame { frame_type, destination, source, data: Vec::new() });
    }
    let data_start = 8;
    let data_end = data_start + length;
    let data = bytes
        .get(data_start..data_end)
        .ok_or("MS/TP data field truncated")?;
    let crc_bytes = bytes
        .get(data_end..data_end + 2)
        .ok_or("MS/TP data CRC truncated")?;
    let rx_crc = (crc_bytes[0] as u16) | ((crc_bytes[1] as u16) << 8);
    if data_crc(data) != rx_crc {
        return Err("MS/TP data CRC mismatch".into());
    }
    Ok(MstpFrame { frame_type, destination, source, data: data.to_vec() })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn header_only_frame_roundtrips() {
        let frame = MstpFrame {
            frame_type: FrameType::PollForMaster,
            destination: 0x7F,
            source: 0x01,
            data: Vec::new(),
        };
        let wire = encode_frame(&frame);
        assert_eq!(wire[0], 0x55);
        assert_eq!(wire[1], 0xFF);
        assert_eq!(wire.len(), 8); // preamble(2)+header(5)+hcrc(1)
        assert_eq!(decode_frame(&wire).unwrap(), frame);
    }

    #[test]
    fn data_frame_roundtrips() {
        let frame = MstpFrame {
            frame_type: FrameType::DataExpectingReply,
            destination: 0x05,
            source: 0x0A,
            data: vec![0x01, 0x02, 0x03, 0x04],
        };
        let wire = encode_frame(&frame);
        // preamble(2)+header(5)+hcrc(1)+data(4)+dcrc(2)
        assert_eq!(wire.len(), 14);
        assert_eq!(decode_frame(&wire).unwrap(), frame);
    }

    #[test]
    fn corrupted_header_fails_crc() {
        let frame = MstpFrame {
            frame_type: FrameType::Token,
            destination: 0x02,
            source: 0x01,
            data: Vec::new(),
        };
        let mut wire = encode_frame(&frame);
        wire[3] ^= 0xFF; // flip the destination byte
        assert!(decode_frame(&wire).is_err());
    }

    #[test]
    fn corrupted_data_fails_crc() {
        let frame = MstpFrame {
            frame_type: FrameType::DataNotExpectingReply,
            destination: 0x03,
            source: 0x01,
            data: vec![0xDE, 0xAD, 0xBE, 0xEF],
        };
        let mut wire = encode_frame(&frame);
        let n = wire.len();
        wire[n - 3] ^= 0x01; // flip a data byte
        assert!(decode_frame(&wire).is_err());
    }

    #[test]
    fn bad_preamble_is_rejected() {
        let wire = [0x00, 0x00, 0, 0, 0, 0, 0, 0];
        assert!(decode_frame(&wire).is_err());
    }
}
