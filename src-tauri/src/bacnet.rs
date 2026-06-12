//! BACnet/IP explorer — discover devices, browse their objects, read and write
//! properties. The YABE-style daily-driver subset of a BACnet management tool.
//!
//! Transport: one UDP socket bound to an ephemeral port (so we never fight
//! Niagara or another BACnet stack for 47808), with broadcast enabled for
//! Who-Is. A detached reader thread parses every incoming frame and routes it:
//! I-Am announcements feed the active discovery session, confirmed-service
//! replies complete pending transactions by invoke ID. Timeout/retry follows
//! the bacnet-stack defaults (3 s, 3 attempts).
//!
//! Routed devices (behind a BACnet router, e.g. MS/TP trunks) are addressed
//! with an NPDU destination (DNET/DADR) learned from the SNET/SADR of their
//! I-Am, and all requests go to the router's IP. Devices that can't fit
//! `object-list` in one APDU are read index-by-index; devices without
//! ReadPropertyMultiple fall back to per-property ReadProperty.

use std::collections::{HashMap, HashSet};
use std::net::{IpAddr, SocketAddr, UdpSocket};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use once_cell::sync::OnceCell;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

use crate::bacnet_codec as codec;
use codec::{Apdu, BacnetValue, ObjectId};

/// Confirmed-request timeout per attempt (bacnet-stack default).
const APDU_TIMEOUT: Duration = Duration::from_millis(3000);

/// Send attempts per confirmed request (bacnet-stack default).
const APDU_ATTEMPTS: u32 = 3;

/// Hard cap on object-list size for the index-by-index fallback.
const MAX_OBJECTS: u64 = 5000;

/// Objects per ReadPropertyMultiple chunk when fetching object names.
const NAME_CHUNK: usize = 12;

/// Consecutive unanswered reads before a fallback loop gives up on a device.
const MAX_CONSECUTIVE_TIMEOUTS: u32 = 2;

// ---------------------------------------------------------------------------
// Models (shared with the frontend)
// ---------------------------------------------------------------------------

/// How to reach a device: the B/IP peer we send UDP to (the device itself, or
/// its router), plus the remote network/MAC when the device is routed.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceRef {
    pub address: String,
    #[serde(default)]
    pub network: Option<u16>,
    #[serde(default)]
    pub mac: Option<String>,
}

/// A discovered device. `name`/`vendor_name`/`model_name` are filled by the
/// enrichment pass and are empty in the initial `bacnet:device` events.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BacnetDevice {
    pub key: String,
    pub address: String,
    pub network: Option<u16>,
    pub mac: Option<String>,
    pub instance: u32,
    pub max_apdu: u32,
    pub segmentation: String,
    pub vendor_id: u32,
    pub name: String,
    pub vendor_name: String,
    pub model_name: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BacnetObject {
    pub object_type: u16,
    pub instance: u32,
    pub type_name: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PropertyEntry {
    pub id: u32,
    pub name: String,
    pub display: String,
    pub values: Vec<BacnetValue>,
    pub error: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ObjectsProgress {
    done: usize,
    total: usize,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ObjectName {
    key: String,
    name: String,
}

/// Payload of `bacnet:object_names` — scoped by device key so a slow
/// enrichment pass can't write names into another device's object pane.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ObjectNames {
    device_key: String,
    names: Vec<ObjectName>,
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

/// Outcome of a confirmed transaction, as routed by the reader thread.
#[derive(Debug, Clone)]
enum Outcome {
    Simple,
    Complex { service: u8, payload: Vec<u8> },
    Failed(String),
}

/// An I-Am captured by the reader thread before enrichment.
#[derive(Debug, Clone)]
struct RawDevice {
    address: SocketAddr,
    network: Option<u16>,
    mac: Option<String>,
    iam: codec::IAm,
}

/// What the reader thread feeds into an active discovery session.
enum DiscoveryEvent {
    Device(RawDevice),
    /// An I-Am-Router-To-Network reply: the router's address and the BACnet
    /// network numbers it routes to.
    Routers { router: SocketAddr, networks: Vec<u16> },
}

struct Discovery {
    tx: mpsc::Sender<DiscoveryEvent>,
    seen: HashSet<String>,
}

/// Resolved send target for one device.
#[derive(Debug, Clone)]
struct Target {
    sa: SocketAddr,
    route: Option<(u16, Vec<u8>)>,
}

/// An active COV subscription, keyed by its subscriber-process id. Holds just
/// enough to route incoming notifications back to the right device pane and to
/// keep the subscription alive past its lifetime.
struct CovEntry {
    device_key: String,
    object: ObjectId,
    active: Arc<std::sync::atomic::AtomicBool>,
}

/// Payload of a `bacnet:cov` event — one COV notification, scoped to the
/// device + object so the frontend can update the right property rows.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct CovEvent {
    device_key: String,
    process_id: u32,
    object_type: u16,
    instance: u32,
    values: Vec<PropertyEntry>,
    time_remaining: u32,
}

struct Client {
    socket: UdpSocket,
    /// invoke-id -> (peer we sent to, reply channel). The peer address lets the
    /// reader reject a stale/duplicate reply whose source doesn't match the
    /// request that currently owns this invoke id (the u8 id space is reused).
    pending: Mutex<HashMap<u8, (SocketAddr, mpsc::Sender<Outcome>)>>,
    next_invoke: Mutex<u8>,
    discovery: Mutex<Option<Discovery>>,
    cov: Mutex<HashMap<u32, CovEntry>>,
    next_process: Mutex<u32>,
    /// Bumped each time a device's objects are read; a detached name-enrichment
    /// pass stops early once it's no longer the current generation, so rapidly
    /// switching devices doesn't stack zombie passes hammering the shared socket.
    objects_gen: AtomicUsize,
    /// COV notifications are forwarded as `CovEvent`s through this channel to a
    /// dedicated emitter thread that owns the `AppHandle`. Keeping tauri types
    /// out of `Client` (which lives in a `static`) matters: storing an
    /// `AppHandle` in the static pulls the full Wry/WebView2 runtime into the
    /// reader path and breaks the (headless) unit-test binary at load time.
    cov_tx: Mutex<Option<mpsc::Sender<CovEvent>>>,
}

impl Client {
    /// Binds the request socket (ephemeral port) and starts its reader thread.
    /// `bind` is normally "0.0.0.0:0"; tests bind loopback.
    ///
    /// When bound to the wildcard address, also opens a best-effort **listener**
    /// on port 47808: devices that answer Who-Is with a *broadcast* I-Am (very
    /// common, e.g. anything behind a BACnet router) send it to 47808, which an
    /// ephemeral-port socket would never hear. SO_REUSEADDR keeps us friendly
    /// with any other local BACnet stack sharing the port.
    fn new(bind: &str) -> Result<Arc<Client>, String> {
        let socket = bind_request_socket(bind)?;
        socket
            .set_broadcast(true)
            .map_err(|e| format!("could not enable broadcast: {e}"))?;
        let reader = socket
            .try_clone()
            .map_err(|e| format!("could not clone socket: {e}"))?;
        let client = Arc::new(Client {
            socket,
            pending: Mutex::new(HashMap::new()),
            next_invoke: Mutex::new(1),
            discovery: Mutex::new(None),
            cov: Mutex::new(HashMap::new()),
            next_process: Mutex::new(1),
            objects_gen: AtomicUsize::new(0),
            cov_tx: Mutex::new(None),
        });
        let for_thread = Arc::clone(&client);
        thread::spawn(move || reader_loop(for_thread, reader));
        // Loopback-bound clients (unit tests) skip the listener so stray site
        // traffic on 47808 can't leak into deterministic tests.
        if bind.starts_with("0.0.0.0") {
            if let Some(listener) = bind_bacnet_port_listener() {
                let for_thread = Arc::clone(&client);
                thread::spawn(move || reader_loop(for_thread, listener));
            }
        }
        Ok(client)
    }

    /// Picks an invoke ID not currently in flight.
    fn alloc_invoke(&self) -> u8 {
        let mut next = self.next_invoke.lock().unwrap();
        let pending = self.pending.lock().unwrap();
        for _ in 0..=255u16 {
            let id = *next;
            *next = next.wrapping_add(1);
            if !pending.contains_key(&id) {
                return id;
            }
        }
        *next
    }

    /// Sends a confirmed request and waits for its outcome, retrying on
    /// timeout. `apdu` must already carry `invoke_id`.
    fn request(&self, target: &Target, apdu: &[u8], invoke_id: u8) -> Result<Outcome, String> {
        let npdu = codec::encode_npdu(
            true,
            target.route.as_ref().map(|(net, mac)| (*net, mac.as_slice())),
        );
        let mut payload = npdu;
        payload.extend_from_slice(apdu);
        let frame = codec::bvlc_encode(codec::BVLC_ORIGINAL_UNICAST, &payload);

        let (tx, rx) = mpsc::channel();
        self.pending.lock().unwrap().insert(invoke_id, (target.sa, tx));
        let result = (|| {
            for _ in 0..APDU_ATTEMPTS {
                self.socket
                    .send_to(&frame, target.sa)
                    .map_err(|e| format!("send failed: {e}"))?;
                match rx.recv_timeout(APDU_TIMEOUT) {
                    Ok(Outcome::Failed(e)) => return Err(e),
                    Ok(outcome) => return Ok(outcome),
                    Err(_) => continue, // timeout — retry
                }
            }
            Err(format!(
                "no response from {} after {APDU_ATTEMPTS} attempts",
                target.sa
            ))
        })();
        self.pending.lock().unwrap().remove(&invoke_id);
        result
    }

    /// Delivers a reply to the pending transaction for `invoke_id`, but only if
    /// it came from the peer that transaction is talking to — so a delayed reply
    /// to a finished transaction can't be mismatched to a different device that
    /// has since been handed the same (reused) invoke id. Compared by IP, since
    /// a BACnet device replies from its B/IP port regardless of our source port.
    fn complete(&self, invoke_id: u8, src: SocketAddr, outcome: Outcome) {
        if let Some((peer, tx)) = self.pending.lock().unwrap().get(&invoke_id) {
            if peer.ip() == src.ip() {
                let _ = tx.send(outcome);
            }
        }
    }

    fn note_i_am(&self, raw: RawDevice) {
        let mut guard = self.discovery.lock().unwrap();
        if let Some(d) = guard.as_mut() {
            let key = device_key(
                &raw.address.to_string(),
                raw.network,
                raw.mac.as_deref(),
                raw.iam.device.instance,
            );
            if d.seen.insert(key) {
                let _ = d.tx.send(DiscoveryEvent::Device(raw));
            }
        }
    }

    fn note_routers(&self, router: SocketAddr, networks: Vec<u16>) {
        let guard = self.discovery.lock().unwrap();
        if let Some(d) = guard.as_ref() {
            let _ = d.tx.send(DiscoveryEvent::Routers { router, networks });
        }
    }

    /// Ensures a COV emitter is running: on first call it creates the channel
    /// and spawns a thread that drains `CovEvent`s and emits them via the app.
    /// The `AppHandle` is owned only by that thread, never by `Client` — see the
    /// `cov_tx` field note for why this matters.
    fn ensure_cov_emitter(&self, app: &AppHandle) {
        let mut guard = self.cov_tx.lock().unwrap();
        if guard.is_some() {
            return;
        }
        let (tx, rx) = mpsc::channel::<CovEvent>();
        *guard = Some(tx);
        let app = app.clone();
        thread::spawn(move || {
            while let Ok(ev) = rx.recv() {
                let _ = app.emit("bacnet:cov", ev);
            }
        });
    }

    /// Allocates a subscriber-process id not currently in use.
    fn alloc_process(&self) -> u32 {
        let mut next = self.next_process.lock().unwrap();
        let cov = self.cov.lock().unwrap();
        for _ in 0..u32::MAX {
            let id = *next;
            *next = next.wrapping_add(1).max(1);
            if !cov.contains_key(&id) {
                return id;
            }
        }
        *next
    }

    /// Routes an incoming COV notification to a `bacnet:cov` event. Drops
    /// notifications for an unknown process id, or whose object doesn't match
    /// the subscription (guards against subscriber-process-id reuse).
    fn note_cov(&self, n: codec::CovNotification) {
        let (device_key, tx) = {
            let cov = self.cov.lock().unwrap();
            let Some(entry) = cov.get(&n.process_id) else { return };
            if entry.object != n.monitored_object {
                return;
            }
            (entry.device_key.clone(), self.cov_tx.lock().unwrap().clone())
        };
        let Some(tx) = tx else { return };
        let _ = tx.send(build_cov_event(device_key, n));
    }
}

/// Renders a decoded COV notification into the frontend event payload (pure, so
/// it's unit-testable without an AppHandle).
fn build_cov_event(device_key: String, n: codec::CovNotification) -> CovEvent {
    let object_type = n.monitored_object.object_type;
    let values: Vec<PropertyEntry> = n
        .values
        .into_iter()
        .map(|v| make_entry(object_type, v.property, Some(v.values), None))
        .collect();
    CovEvent {
        device_key,
        process_id: n.process_id,
        object_type,
        instance: n.monitored_object.instance,
        values,
        time_remaining: n.time_remaining,
    }
}

/// Receive-buffer target. A flat BAS network can answer one Who-Is burst with
/// hundreds of I-Am datagrams within a few milliseconds; the default ~64 KB
/// buffer overflows and silently drops devices. 4 MB holds thousands.
const RECV_BUFFER_BYTES: usize = 4 * 1024 * 1024;

/// Binds the request socket with a large receive buffer so I-Am bursts from a
/// large site aren't dropped before the reader thread drains them.
fn bind_request_socket(bind: &str) -> Result<UdpSocket, String> {
    use socket2::{Domain, Protocol, Socket, Type};
    let addr: SocketAddr = bind.parse().map_err(|e| format!("bad bind address {bind}: {e}"))?;
    let sock = Socket::new(Domain::IPV4, Type::DGRAM, Some(Protocol::UDP))
        .map_err(|e| format!("could not create UDP socket: {e}"))?;
    let _ = sock.set_recv_buffer_size(RECV_BUFFER_BYTES);
    sock.bind(&addr.into())
        .map_err(|e| format!("could not bind UDP socket: {e}"))?;
    Ok(sock.into())
}

/// Best-effort shared bind of UDP 47808 for receiving broadcast I-Am /
/// router announcements. Returns None when the port can't be opened.
fn bind_bacnet_port_listener() -> Option<UdpSocket> {
    use socket2::{Domain, Protocol, Socket, Type};
    let sock = Socket::new(Domain::IPV4, Type::DGRAM, Some(Protocol::UDP)).ok()?;
    sock.set_reuse_address(true).ok()?;
    let _ = sock.set_recv_buffer_size(RECV_BUFFER_BYTES);
    let addr: SocketAddr = format!("0.0.0.0:{}", codec::BACNET_PORT).parse().ok()?;
    sock.bind(&addr.into()).ok()?;
    let _ = sock.set_broadcast(true);
    Some(sock.into())
}

/// Parses and routes every incoming frame. Runs for the life of the socket.
fn reader_loop(client: Arc<Client>, socket: UdpSocket) {
    let mut buf = [0u8; 2048];
    loop {
        let (n, src) = match socket.recv_from(&mut buf) {
            Ok(v) => v,
            Err(_) => continue,
        };
        handle_frame(&client, &buf[..n], src);
    }
}

fn handle_frame(client: &Client, frame: &[u8], src: SocketAddr) {
    let Ok(bvlc) = codec::bvlc_decode(frame) else { return };
    match bvlc.function {
        codec::BVLC_ORIGINAL_UNICAST | codec::BVLC_ORIGINAL_BROADCAST | codec::BVLC_FORWARDED_NPDU => {}
        _ => return, // BVLC-Result and BBMD table traffic — nothing pending on them
    }
    // For Forwarded-NPDU (via a BBMD) the real peer is the embedded origin.
    let effective_src = bvlc
        .origin
        .map(|(ip, port)| SocketAddr::new(IpAddr::V4(ip), port))
        .unwrap_or(src);

    let Some(npdu_slice) = frame.get(bvlc.payload_offset..) else { return };
    let Ok(npdu) = codec::decode_npdu(npdu_slice) else { return };
    if npdu.network_message {
        // Routers answering Who-Is-Router-To-Network tell us which BACnet
        // networks exist behind them — discovery uses that to sweep each one.
        if npdu.message_type == Some(codec::NETWORK_MSG_I_AM_ROUTER_TO_NETWORK) {
            if let Some(payload) = npdu_slice.get(npdu.apdu_offset..) {
                let networks = codec::decode_router_networks(payload);
                if !networks.is_empty() {
                    client.note_routers(effective_src, networks);
                }
            }
        }
        return;
    }
    let Some(apdu) = npdu_slice.get(npdu.apdu_offset..) else { return };
    let Ok(parsed) = codec::decode_apdu(apdu) else { return };

    match parsed {
        Apdu::Unconfirmed { service: codec::SERVICE_I_AM, payload_offset } => {
            if let Some(payload) = apdu.get(payload_offset..) {
                if let Ok(iam) = codec::decode_i_am(payload) {
                    let (network, mac) = match &npdu.source {
                        Some((snet, sadr)) => (Some(*snet), Some(hex_upper(sadr))),
                        None => (None, None),
                    };
                    client.note_i_am(RawDevice { address: effective_src, network, mac, iam });
                }
            }
        }
        Apdu::Unconfirmed { service: codec::SERVICE_UNCONFIRMED_COV_NOTIFICATION, payload_offset } => {
            if let Some(payload) = apdu.get(payload_offset..) {
                if let Ok(n) = codec::decode_cov_notification(payload) {
                    client.note_cov(n);
                }
            }
        }
        Apdu::ConfirmedRequest { invoke_id, service: codec::SERVICE_CONFIRMED_COV_NOTIFICATION, payload_offset } => {
            // The device expects a SimpleACK before it considers the notification
            // delivered; ack first (echo any routing back to the source), then route.
            let ack = vec![
                codec::PDU_SIMPLE_ACK,
                invoke_id,
                codec::SERVICE_CONFIRMED_COV_NOTIFICATION,
            ];
            let dest = npdu.source.as_ref().map(|(snet, sadr)| (*snet, sadr.as_slice()));
            let mut reply = codec::encode_npdu(false, dest);
            reply.extend_from_slice(&ack);
            let _ = client
                .socket
                .send_to(&codec::bvlc_encode(codec::BVLC_ORIGINAL_UNICAST, &reply), effective_src);
            if let Some(payload) = apdu.get(payload_offset..) {
                if let Ok(n) = codec::decode_cov_notification(payload) {
                    client.note_cov(n);
                }
            }
        }
        Apdu::SimpleAck { invoke_id, .. } => client.complete(invoke_id, effective_src, Outcome::Simple),
        Apdu::ComplexAck { invoke_id, service, segmented, payload_offset } => {
            let outcome = if segmented {
                // We advertise no segmentation support; treat as a failure so
                // callers fall back to smaller reads.
                Outcome::Failed("device sent a segmented response".into())
            } else {
                Outcome::Complex {
                    service,
                    payload: apdu.get(payload_offset..).unwrap_or_default().to_vec(),
                }
            };
            client.complete(invoke_id, effective_src, outcome);
        }
        Apdu::Error { invoke_id, error_class, error_code, .. } => client.complete(
            invoke_id,
            effective_src,
            Outcome::Failed(format!(
                "device error: {} / {}",
                codec::error_class_name(error_class),
                codec::error_code_name(error_code)
            )),
        ),
        Apdu::Reject { invoke_id, reason } => client.complete(
            invoke_id,
            effective_src,
            Outcome::Failed(format!("request rejected: {}", codec::reject_reason_name(reason))),
        ),
        Apdu::Abort { invoke_id, reason } => client.complete(
            invoke_id,
            effective_src,
            Outcome::Failed(format!("request aborted: {}", codec::abort_reason_name(reason))),
        ),
        _ => {}
    }
}

/// The app-wide client, created on first use.
static CLIENT: OnceCell<Arc<Client>> = OnceCell::new();

fn client() -> Result<Arc<Client>, String> {
    CLIENT.get_or_try_init(|| Client::new("0.0.0.0:0")).cloned()
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

fn hex_upper(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02X}")).collect()
}

fn parse_hex(s: &str) -> Vec<u8> {
    let clean: String = s.chars().filter(|c| c.is_ascii_hexdigit()).collect();
    clean
        .as_bytes()
        .chunks(2)
        .filter(|c| c.len() == 2)
        .map(|c| u8::from_str_radix(std::str::from_utf8(c).unwrap_or("0"), 16).unwrap_or(0))
        .collect()
}

fn device_key(address: &str, network: Option<u16>, mac: Option<&str>, instance: u32) -> String {
    format!(
        "{address}|{}|{}|{instance}",
        network.map(|n| n.to_string()).unwrap_or_default(),
        mac.unwrap_or_default()
    )
}

/// "192.168.1.50" -> 192.168.1.50:47808; full "ip:port" passes through.
fn parse_target(s: &str) -> Result<SocketAddr, String> {
    let t = s.trim();
    if t.is_empty() {
        return Err("address is empty".into());
    }
    if let Ok(sa) = t.parse::<SocketAddr>() {
        return Ok(sa);
    }
    if let Ok(ip) = t.parse::<IpAddr>() {
        return Ok(SocketAddr::new(ip, codec::BACNET_PORT));
    }
    use std::net::ToSocketAddrs;
    let with_port = if t.contains(':') { t.to_string() } else { format!("{t}:{}", codec::BACNET_PORT) };
    with_port
        .to_socket_addrs()
        .map_err(|e| format!("bad address \"{t}\": {e}"))?
        .next()
        .ok_or_else(|| format!("could not resolve \"{t}\""))
}

fn is_broadcast_target(sa: &SocketAddr) -> bool {
    match sa.ip() {
        IpAddr::V4(v4) => v4.is_broadcast() || v4.octets()[3] == 255,
        IpAddr::V6(_) => false,
    }
}

fn resolve_device(d: &DeviceRef) -> Result<Target, String> {
    let sa = parse_target(&d.address)?;
    let route = d
        .network
        .map(|net| (net, d.mac.as_deref().map(parse_hex).unwrap_or_default()));
    Ok(Target { sa, route })
}

// ---------------------------------------------------------------------------
// Service wrappers
// ---------------------------------------------------------------------------

fn read_property(
    client: &Client,
    target: &Target,
    object: ObjectId,
    property: u32,
    array_index: Option<u32>,
) -> Result<Vec<BacnetValue>, String> {
    let invoke = client.alloc_invoke();
    let apdu = codec::encode_read_property(invoke, object, property, array_index);
    match client.request(target, &apdu, invoke)? {
        Outcome::Complex { service: codec::SERVICE_READ_PROPERTY, payload } => {
            let ack = codec::decode_read_property_ack(&payload)?;
            // Guard against a stale reply on a reused invoke id from the same
            // peer: the ACK must describe the object+property we asked for.
            if ack.object != object || ack.property != property {
                return Err(format!(
                    "response mismatch: asked {}:{} prop {property}, got {}:{} prop {}",
                    object.object_type, object.instance, ack.object.object_type, ack.object.instance, ack.property
                ));
            }
            Ok(ack.values)
        }
        Outcome::Complex { service, .. } => Err(format!("unexpected ack for service {service}")),
        Outcome::Simple => Err("unexpected simple ack for ReadProperty".into()),
        Outcome::Failed(e) => Err(e),
    }
}

fn read_property_multiple(
    client: &Client,
    target: &Target,
    specs: &[codec::ReadAccessSpec],
) -> Result<Vec<codec::RpmObject>, String> {
    let invoke = client.alloc_invoke();
    let apdu = codec::encode_read_property_multiple(invoke, specs);
    match client.request(target, &apdu, invoke)? {
        Outcome::Complex { service: codec::SERVICE_READ_PROPERTY_MULTIPLE, payload } => {
            codec::decode_read_property_multiple_ack(&payload)
        }
        Outcome::Complex { service, .. } => Err(format!("unexpected ack for service {service}")),
        Outcome::Simple => Err("unexpected simple ack for ReadPropertyMultiple".into()),
        Outcome::Failed(e) => Err(e),
    }
}

fn write_property_core(
    client: &Client,
    target: &Target,
    object: ObjectId,
    property: u32,
    array_index: Option<u32>,
    values: &[BacnetValue],
    priority: Option<u8>,
) -> Result<(), String> {
    let invoke = client.alloc_invoke();
    let apdu = codec::encode_write_property(invoke, object, property, array_index, values, priority);
    match client.request(target, &apdu, invoke)? {
        Outcome::Simple => Ok(()),
        Outcome::Complex { .. } => Err("unexpected complex ack for WriteProperty".into()),
        Outcome::Failed(e) => Err(e),
    }
}

/// Sends a SubscribeCOV (or, with `lifetime == None`, a cancellation) and waits
/// for the SimpleACK.
fn subscribe_cov_core(
    client: &Client,
    target: &Target,
    process_id: u32,
    object: ObjectId,
    confirmed: bool,
    lifetime: Option<u32>,
) -> Result<(), String> {
    let invoke = client.alloc_invoke();
    let apdu = codec::encode_subscribe_cov(invoke, process_id, object, confirmed, lifetime);
    match client.request(target, &apdu, invoke)? {
        Outcome::Simple => Ok(()),
        Outcome::Complex { .. } => Err("unexpected complex ack for SubscribeCOV".into()),
        Outcome::Failed(e) => Err(e),
    }
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/// Broadcasts (or unicasts) a Who-Is and collects I-Am replies until the
/// window closes. `target` may be a comma/space-separated list — every entry
/// is probed into one shared collection window (useful on flat BAS networks
/// with mixed subnet masks, where each /24 needs its own directed broadcast).
/// `on_device` fires for each unique device as it arrives.
fn discover_core(
    client: &Client,
    target: &str,
    low: Option<u32>,
    high: Option<u32>,
    window: Duration,
    mut on_device: impl FnMut(&BacnetDevice),
) -> Result<Vec<BacnetDevice>, String> {
    let mut targets = Vec::new();
    for part in target.split([',', ';', ' ']) {
        let part = part.trim();
        if !part.is_empty() {
            targets.push(parse_target(part)?);
        }
    }
    if targets.is_empty() {
        return Err("no discovery target given".into());
    }
    let (tx, rx) = mpsc::channel();
    *client.discovery.lock().unwrap() = Some(Discovery { tx, seen: HashSet::new() });

    let result = (|| {
        let whois = codec::encode_who_is(low, high);
        let mut sent = 0usize;
        let mut last_err = String::new();
        for sa in &targets {
            let broadcast = is_broadcast_target(sa);
            let bvlc_fn = if broadcast { codec::BVLC_ORIGINAL_BROADCAST } else { codec::BVLC_ORIGINAL_UNICAST };
            let npdu = if broadcast {
                codec::encode_npdu(false, Some((codec::BROADCAST_NETWORK, &[])))
            } else {
                codec::encode_npdu(false, None)
            };
            let mut payload = npdu;
            payload.extend_from_slice(&whois);
            match client.socket.send_to(&codec::bvlc_encode(bvlc_fn, &payload), sa) {
                Ok(_) => sent += 1,
                Err(e) => last_err = format!("Who-Is to {sa} failed: {e}"),
            }
            // Also ask routers to identify themselves, so devices on networks
            // behind them (MS/TP trunks etc.) get swept too.
            let wirtn = codec::encode_network_message(
                codec::NETWORK_MSG_WHO_IS_ROUTER_TO_NETWORK,
                &[],
                if broadcast { Some((codec::BROADCAST_NETWORK, &[])) } else { None },
            );
            let _ = client.socket.send_to(&codec::bvlc_encode(bvlc_fn, &wirtn), sa);
        }
        if sent == 0 {
            return Err(last_err);
        }

        let mut devices: Vec<BacnetDevice> = Vec::new();
        let mut swept_networks: HashSet<u16> = HashSet::new();
        let deadline = Instant::now() + window;
        loop {
            let now = Instant::now();
            if now >= deadline {
                break;
            }
            match rx.recv_timeout(deadline - now) {
                Ok(DiscoveryEvent::Device(raw)) => {
                    let dev = BacnetDevice {
                        key: device_key(
                            &raw.address.to_string(),
                            raw.network,
                            raw.mac.as_deref(),
                            raw.iam.device.instance,
                        ),
                        address: raw.address.to_string(),
                        network: raw.network,
                        mac: raw.mac,
                        instance: raw.iam.device.instance,
                        max_apdu: raw.iam.max_apdu,
                        segmentation: codec::segmentation_name(raw.iam.segmentation).to_string(),
                        vendor_id: raw.iam.vendor_id,
                        name: String::new(),
                        vendor_name: String::new(),
                        model_name: String::new(),
                    };
                    on_device(&dev);
                    devices.push(dev);
                }
                Ok(DiscoveryEvent::Routers { router, networks }) => {
                    // Sweep each newly-announced network with a remote-broadcast
                    // Who-Is sent via its router.
                    for net in networks {
                        if swept_networks.insert(net) {
                            let mut payload = codec::encode_npdu(false, Some((net, &[])));
                            payload.extend_from_slice(&whois);
                            let frame = codec::bvlc_encode(codec::BVLC_ORIGINAL_UNICAST, &payload);
                            let _ = client.socket.send_to(&frame, router);
                        }
                    }
                }
                Err(_) => break, // window elapsed
            }
        }
        devices.sort_by_key(|d| d.instance);
        Ok(devices)
    })();

    *client.discovery.lock().unwrap() = None;
    result
}

/// Best-effort fill of name / vendor-name / model-name on a discovered device.
fn enrich_device(client: &Client, dev: &mut BacnetDevice) {
    let Ok(target) = resolve_device(&DeviceRef {
        address: dev.address.clone(),
        network: dev.network,
        mac: dev.mac.clone(),
    }) else {
        return;
    };
    let object = ObjectId::new(codec::OBJECT_TYPE_DEVICE, dev.instance);
    let spec = codec::ReadAccessSpec {
        object,
        properties: vec![
            codec::PropertyRef { property: codec::PROP_OBJECT_NAME, array_index: None },
            codec::PropertyRef { property: codec::PROP_VENDOR_NAME, array_index: None },
            codec::PropertyRef { property: codec::PROP_MODEL_NAME, array_index: None },
        ],
    };
    if let Ok(objects) = read_property_multiple(client, &target, &[spec]) {
        for obj in objects {
            for p in obj.properties {
                let text = p
                    .values
                    .as_deref()
                    .and_then(first_string)
                    .unwrap_or_default();
                match p.property {
                    codec::PROP_OBJECT_NAME => dev.name = text,
                    codec::PROP_VENDOR_NAME => dev.vendor_name = text,
                    codec::PROP_MODEL_NAME => dev.model_name = text,
                    _ => {}
                }
            }
        }
        return;
    }
    // No RPM on this device — settle for the object name via plain RP.
    if let Ok(values) = read_property(client, &target, object, codec::PROP_OBJECT_NAME, None) {
        if let Some(s) = first_string(&values) {
            dev.name = s;
        }
    }
}

fn first_string(values: &[BacnetValue]) -> Option<String> {
    values.iter().find_map(|v| match v {
        BacnetValue::CharacterString { value } => Some(value.clone()),
        _ => None,
    })
}

// ---------------------------------------------------------------------------
// Object enumeration
// ---------------------------------------------------------------------------

/// Reads a device's object-list, falling back to index-by-index reads when the
/// whole list doesn't fit in one APDU. Returns the (sorted, name-less) objects;
/// names stream separately via [`enrich_object_names_core`].
fn read_object_ids_core(
    client: &Client,
    target: &Target,
    device_instance: u32,
    mut on_progress: impl FnMut(usize, usize),
) -> Result<Vec<BacnetObject>, String> {
    let dev_obj = ObjectId::new(codec::OBJECT_TYPE_DEVICE, device_instance);

    let ids = match read_property(client, target, dev_obj, codec::PROP_OBJECT_LIST, None) {
        Ok(values) => codec::object_ids_from_values(&values),
        Err(first_err) => {
            // Whole-list read failed (likely segmentation) — walk the array.
            let count_vals = read_property(client, target, dev_obj, codec::PROP_OBJECT_LIST, Some(0))
                .map_err(|e| format!("object-list read failed ({first_err}); count read failed ({e})"))?;
            let count = match count_vals.first() {
                Some(BacnetValue::Unsigned { value }) => *value,
                _ => return Err("object-list[0] did not return a count".into()),
            };
            if count > MAX_OBJECTS {
                return Err(format!("device reports {count} objects — refusing to walk more than {MAX_OBJECTS}"));
            }
            let total = count as usize;
            let mut ids = Vec::with_capacity(total);
            let mut timeouts = 0u32;
            for i in 1..=count {
                match read_property(client, target, dev_obj, codec::PROP_OBJECT_LIST, Some(i as u32)) {
                    Ok(values) => {
                        timeouts = 0;
                        ids.extend(codec::object_ids_from_values(&values));
                    }
                    Err(e) if e.starts_with("no response") => {
                        timeouts += 1;
                        if timeouts >= MAX_CONSECUTIVE_TIMEOUTS {
                            return Err(format!("device stopped responding at object-list[{i}]: {e}"));
                        }
                    }
                    Err(_) => {} // single bad index — skip it
                }
                if i % 8 == 0 || i == count {
                    on_progress(i as usize, total);
                }
            }
            ids
        }
    };

    let mut objects: Vec<BacnetObject> = ids
        .iter()
        .map(|id| BacnetObject {
            object_type: id.object_type,
            instance: id.instance,
            type_name: codec::object_type_name(id.object_type),
            name: String::new(),
        })
        .collect();
    objects.sort_by_key(|o| (o.object_type, o.instance));
    Ok(objects)
}

/// Streams object names for `ids`, best-effort. Tries RPM chunks first,
/// shrinking the chunk when a device's APDU can't fit a full one (MS/TP gear
/// at 480 bytes with long names), and drops to per-object RP when the device
/// lacks RPM entirely. Each resolved batch is handed to `on_names`. Stops early
/// the moment `should_continue` returns false (e.g. the user switched devices).
fn enrich_object_names_core(
    client: &Client,
    target: &Target,
    ids: &[ObjectId],
    should_continue: impl Fn() -> bool,
    mut on_names: impl FnMut(&[(ObjectId, String)]),
) {
    let mut chunk_size = NAME_CHUNK;
    let mut rp_mode = false;
    let mut i = 0usize;
    let mut timeouts = 0u32;
    while i < ids.len() {
        if !should_continue() {
            return;
        }
        if rp_mode {
            let id = ids[i];
            match read_property(client, target, id, codec::PROP_OBJECT_NAME, None) {
                Ok(values) => {
                    timeouts = 0;
                    if let Some(name) = first_string(&values) {
                        on_names(&[(id, name)]);
                    }
                }
                Err(e) if e.starts_with("no response") => {
                    timeouts += 1;
                    if timeouts >= MAX_CONSECUTIVE_TIMEOUTS {
                        return; // names are best-effort — keep what we have
                    }
                }
                Err(_) => {}
            }
            i += 1;
            continue;
        }
        let chunk = &ids[i..(i + chunk_size).min(ids.len())];
        let specs: Vec<codec::ReadAccessSpec> = chunk
            .iter()
            .map(|id| codec::ReadAccessSpec {
                object: *id,
                properties: vec![codec::PropertyRef {
                    property: codec::PROP_OBJECT_NAME,
                    array_index: None,
                }],
            })
            .collect();
        match read_property_multiple(client, target, &specs) {
            Ok(results) => {
                timeouts = 0;
                let mut batch = Vec::new();
                for r in results {
                    for p in r.properties {
                        if let Some(name) = p.values.as_deref().and_then(first_string) {
                            batch.push((r.object, name));
                        }
                    }
                }
                if !batch.is_empty() {
                    on_names(&batch);
                }
                i += chunk.len();
            }
            Err(e) if e.starts_with("no response") => {
                timeouts += 1;
                if timeouts >= MAX_CONSECUTIVE_TIMEOUTS {
                    return;
                }
            }
            Err(_) if chunk_size > 4 => chunk_size = 4, // response too big — retry smaller
            Err(_) if chunk.len() > 1 => rp_mode = true, // RPM is out — go one at a time
            Err(_) => {
                // Even a single-object RPM failed; this object may be gone.
                rp_mode = true;
                i += 1;
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Property reads + display rendering
// ---------------------------------------------------------------------------

/// Properties worth probing when a device has no ReadPropertyMultiple.
const FALLBACK_PROPS_COMMON: &[u32] = &[
    77,  // object-name
    79,  // object-type
    28,  // description
    85,  // present-value
    111, // status-flags
    36,  // event-state
    103, // reliability
    81,  // out-of-service
    117, // units
    74,  // number-of-states
    4,   // active-text
    46,  // inactive-text
    87,  // priority-array
    104, // relinquish-default
    65,  // max-pres-value
    69,  // min-pres-value
    22,  // cov-increment
];

const FALLBACK_PROPS_DEVICE: &[u32] = &[
    121, // vendor-name
    120, // vendor-identifier
    70,  // model-name
    44,  // firmware-revision
    12,  // application-software-version
    98,  // protocol-version
    139, // protocol-revision
    107, // segmentation-supported
    62,  // max-apdu-length-accepted
    112, // system-status
    58,  // location
    155, // database-revision
    11,  // apdu-timeout
    73,  // number-of-apdu-retries
];

/// Reads every property of an object: RPM `all` when the device supports it,
/// otherwise a curated per-property RP sweep.
fn read_all_properties_core(
    client: &Client,
    target: &Target,
    object: ObjectId,
) -> Result<Vec<PropertyEntry>, String> {
    let spec = codec::ReadAccessSpec {
        object,
        properties: vec![codec::PropertyRef { property: codec::PROP_ALL, array_index: None }],
    };
    match read_property_multiple(client, target, &[spec]) {
        Ok(results) => {
            let mut entries = Vec::new();
            for r in results {
                for p in r.properties {
                    entries.push(make_entry(object.object_type, p.property, p.values, p.error));
                }
            }
            entries.sort_by_key(|e| e.id);
            Ok(entries)
        }
        Err(rpm_err) => {
            let mut props: Vec<u32> = FALLBACK_PROPS_COMMON.to_vec();
            if object.object_type == codec::OBJECT_TYPE_DEVICE {
                props.extend_from_slice(FALLBACK_PROPS_DEVICE);
            }
            let mut entries = Vec::new();
            let mut timeouts = 0u32;
            for prop in props {
                match read_property(client, target, object, prop, None) {
                    Ok(values) => {
                        timeouts = 0;
                        entries.push(make_entry(object.object_type, prop, Some(values), None));
                    }
                    Err(e) if e.starts_with("no response") => {
                        timeouts += 1;
                        if timeouts >= MAX_CONSECUTIVE_TIMEOUTS {
                            return Err(format!(
                                "device stopped responding ({e}); RPM also failed ({rpm_err})"
                            ));
                        }
                    }
                    Err(_) => {} // property not supported on this object — fine
                }
            }
            if entries.is_empty() {
                return Err(format!("no readable properties (RPM failed: {rpm_err})"));
            }
            entries.sort_by_key(|e| e.id);
            Ok(entries)
        }
    }
}

fn make_entry(
    object_type: u16,
    property: u32,
    values: Option<Vec<BacnetValue>>,
    error: Option<(u32, u32)>,
) -> PropertyEntry {
    let error_text = error.map(|(class, code)| {
        format!("{} / {}", codec::error_class_name(class), codec::error_code_name(code))
    });
    let values = values.unwrap_or_default();
    let display = if let Some(e) = &error_text {
        format!("({e})")
    } else {
        render_values(object_type, property, &values)
    };
    PropertyEntry {
        id: property,
        name: codec::property_name(property),
        display,
        values,
        error: error_text,
    }
}

fn render_value(v: &BacnetValue) -> String {
    match v {
        BacnetValue::Null => "Null".into(),
        BacnetValue::Boolean { value } => value.to_string(),
        BacnetValue::Unsigned { value } => value.to_string(),
        BacnetValue::Signed { value } => value.to_string(),
        BacnetValue::Real { value } => format!("{value}"),
        BacnetValue::Double { value } => format!("{value}"),
        BacnetValue::OctetString { hex } => format!("0x{hex}"),
        BacnetValue::CharacterString { value } => value.clone(),
        BacnetValue::BitString { bits, .. } => bits.clone(),
        BacnetValue::Enumerated { value } => value.to_string(),
        BacnetValue::Date { year, month, day, .. } => {
            // 0/0xFF in any field is the BACnet "unspecified" wildcard.
            let y = if *year == 0 { "****".to_string() } else { format!("{year:04}") };
            let m = if *month == 0xFF || *month == 0 { "**".to_string() } else { format!("{month:02}") };
            let d = if *day == 0xFF || *day == 0 { "**".to_string() } else { format!("{day:02}") };
            format!("{y}-{m}-{d}")
        }
        BacnetValue::Time { hour, minute, second, .. } => {
            let h = if *hour == 0xFF { "**".to_string() } else { format!("{hour:02}") };
            let mi = if *minute == 0xFF { "**".to_string() } else { format!("{minute:02}") };
            let s = if *second == 0xFF { "**".to_string() } else { format!("{second:02}") };
            format!("{h}:{mi}:{s}")
        }
        BacnetValue::ObjectIdentifier { object_type, instance } => {
            format!("{}:{instance}", codec::object_type_name(*object_type))
        }
        BacnetValue::Unknown { tag, .. } => format!("(constructed [{tag}])"),
    }
}

const STATUS_FLAG_NAMES: [&str; 4] = ["in-alarm", "fault", "overridden", "out-of-service"];

fn is_binary_object(t: u16) -> bool {
    matches!(t, 3 | 4 | 5) // binary-input / binary-output / binary-value
}

/// Property-aware display string for a decoded value set.
fn render_values(object_type: u16, property: u32, values: &[BacnetValue]) -> String {
    if values.is_empty() {
        return String::new();
    }
    match property {
        // status-flags: name the raised bits.
        111 => {
            if let BacnetValue::BitString { bits, .. } = &values[0] {
                let raised: Vec<&str> = bits
                    .chars()
                    .enumerate()
                    .filter(|(_, c)| *c == '1')
                    .filter_map(|(i, _)| STATUS_FLAG_NAMES.get(i).copied())
                    .collect();
                return if raised.is_empty() { "normal".into() } else { raised.join(", ") };
            }
        }
        // units: symbol + raw number.
        117 => {
            if let BacnetValue::Enumerated { value } = &values[0] {
                if let Some(sym) = codec::engineering_unit_name(*value) {
                    return format!("{sym} ({value})");
                }
            }
        }
        // object-type: name it.
        79 => {
            if let BacnetValue::Enumerated { value } = &values[0] {
                return codec::object_type_name(*value as u16);
            }
        }
        // segmentation-supported.
        107 => {
            if let BacnetValue::Enumerated { value } = &values[0] {
                return codec::segmentation_name(*value).into();
            }
        }
        // event-state.
        36 => {
            if let BacnetValue::Enumerated { value } = &values[0] {
                return match value {
                    0 => "normal".into(),
                    1 => "fault".into(),
                    2 => "offnormal".into(),
                    3 => "high-limit".into(),
                    4 => "low-limit".into(),
                    n => format!("event-state-{n}"),
                };
            }
        }
        // system-status (device object).
        112 => {
            if let BacnetValue::Enumerated { value } = &values[0] {
                return match value {
                    0 => "operational".into(),
                    1 => "operational-read-only".into(),
                    2 => "download-required".into(),
                    3 => "download-in-progress".into(),
                    4 => "non-operational".into(),
                    5 => "backup-in-progress".into(),
                    n => format!("system-status-{n}"),
                };
            }
        }
        // object-list: don't dump thousands of IDs into a table cell.
        codec::PROP_OBJECT_LIST => return format!("{} objects", values.len()),
        // priority-array: show only the slots that are set.
        codec::PROP_PRIORITY_ARRAY => {
            let set: Vec<String> = values
                .iter()
                .enumerate()
                .filter(|(_, v)| !matches!(v, BacnetValue::Null))
                .map(|(i, v)| format!("p{}={}", i + 1, render_value(v)))
                .collect();
            return if set.is_empty() {
                format!("all Null ({} slots)", values.len())
            } else {
                set.join(", ")
            };
        }
        // present-value / relinquish-default on binary objects: active/inactive.
        codec::PROP_PRESENT_VALUE | codec::PROP_RELINQUISH_DEFAULT
            if is_binary_object(object_type) => {
            if let BacnetValue::Enumerated { value } = &values[0] {
                return match value {
                    0 => "inactive (0)".into(),
                    1 => "active (1)".into(),
                    n => format!("{n}"),
                };
            }
        }
        _ => {}
    }
    values.iter().map(render_value).collect::<Vec<_>>().join(", ")
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// Broadcasts Who-Is at `target` (default 255.255.255.255) and streams each
/// discovered device as a `bacnet:device` event, then enriches names via
/// `bacnet:device_update` events. Returns the final device list.
#[tauri::command]
pub async fn bacnet_discover(
    app: AppHandle,
    target: Option<String>,
    low_limit: Option<u32>,
    high_limit: Option<u32>,
    duration_ms: Option<u64>,
) -> Result<Vec<BacnetDevice>, String> {
    let client = client()?;
    let target = target.unwrap_or_default();
    let target = if target.trim().is_empty() { "255.255.255.255".to_string() } else { target };
    // 5 s default: router discovery + per-network sweeps need a round trip
    // before routed devices can even start answering.
    let window = Duration::from_millis(duration_ms.unwrap_or(5000).clamp(500, 15000));

    tauri::async_runtime::spawn_blocking(move || {
        let app_for_stream = app.clone();
        let devices = discover_core(&client, &target, low_limit, high_limit, window, |dev| {
            let _ = app_for_stream.emit("bacnet:device", dev);
        })?;
        // Enrich names in parallel — a site with hundreds of devices (or a few
        // that won't answer RPM) would take minutes sequentially.
        let len = devices.len();
        let shared = Arc::new(Mutex::new(devices));
        let next = Arc::new(AtomicUsize::new(0));
        let workers = 8.min(len).max(1);
        let mut handles = Vec::with_capacity(workers);
        for _ in 0..workers {
            let shared = Arc::clone(&shared);
            let next = Arc::clone(&next);
            let client = Arc::clone(&client);
            let app = app.clone();
            handles.push(thread::spawn(move || loop {
                let i = next.fetch_add(1, Ordering::Relaxed);
                if i >= len {
                    break;
                }
                let mut dev = shared.lock().unwrap()[i].clone();
                enrich_device(&client, &mut dev);
                let _ = app.emit("bacnet:device_update", &dev);
                shared.lock().unwrap()[i] = dev;
            }));
        }
        for h in handles {
            let _ = h.join();
        }
        let devices = Arc::try_unwrap(shared)
            .map(|m| m.into_inner().unwrap_or_default())
            .unwrap_or_default();
        Ok(devices)
    })
    .await
    .map_err(|e| format!("discovery task panicked: {e}"))?
}

/// Reads the object list of `device` (instance `device_instance`), streaming
/// `bacnet:objects_progress` during slow index-by-index walks. Returns as soon
/// as the identifiers are known; object names stream in afterwards via
/// detached `bacnet:object_names` events (a 400-object MS/TP controller can
/// take a minute to name — no reason to hold the object pane hostage).
#[tauri::command]
pub async fn bacnet_read_objects(
    app: AppHandle,
    device: DeviceRef,
    device_instance: u32,
) -> Result<Vec<BacnetObject>, String> {
    let client = client()?;
    let target = resolve_device(&device)?;
    // Claim a new objects generation; the enrichment pass below stops once a
    // later read_objects call supersedes it.
    let my_gen = client.objects_gen.fetch_add(1, Ordering::Relaxed) + 1;
    tauri::async_runtime::spawn_blocking(move || {
        let app_progress = app.clone();
        let objects = read_object_ids_core(&client, &target, device_instance, |done, total| {
            let _ = app_progress.emit("bacnet:objects_progress", ObjectsProgress { done, total });
        })?;

        let ids: Vec<ObjectId> = objects
            .iter()
            .map(|o| ObjectId::new(o.object_type, o.instance))
            .collect();
        let dev_key = device_key(&device.address, device.network, device.mac.as_deref(), device_instance);
        let client_bg = Arc::clone(&client);
        let target_bg = target.clone();
        thread::spawn(move || {
            let still_current = || client_bg.objects_gen.load(Ordering::Relaxed) == my_gen;
            enrich_object_names_core(&client_bg, &target_bg, &ids, still_current, |names| {
                let batch = ObjectNames {
                    device_key: dev_key.clone(),
                    names: names
                        .iter()
                        .map(|(id, name)| ObjectName {
                            key: format!("{}:{}", id.object_type, id.instance),
                            name: name.clone(),
                        })
                        .collect(),
                };
                let _ = app.emit("bacnet:object_names", &batch);
            });
        });
        Ok(objects)
    })
    .await
    .map_err(|e| format!("object read task panicked: {e}"))?
}

/// Reads all properties of one object (RPM `all`, falling back to RP sweeps).
#[tauri::command]
pub async fn bacnet_read_properties(
    device: DeviceRef,
    object_type: u16,
    instance: u32,
) -> Result<Vec<PropertyEntry>, String> {
    let client = client()?;
    let target = resolve_device(&device)?;
    tauri::async_runtime::spawn_blocking(move || {
        read_all_properties_core(&client, &target, ObjectId::new(object_type, instance))
    })
    .await
    .map_err(|e| format!("property read task panicked: {e}"))?
}

/// Writes one property value. `priority` 1–16 targets a command-priority slot;
/// writing `{"kind":"null"}` with a priority relinquishes that slot.
#[tauri::command]
pub async fn bacnet_write_property(
    device: DeviceRef,
    object_type: u16,
    instance: u32,
    property: u32,
    value: BacnetValue,
    priority: Option<u8>,
    array_index: Option<u32>,
) -> Result<(), String> {
    if let Some(p) = priority {
        if !(1..=16).contains(&p) {
            return Err("priority must be between 1 and 16".into());
        }
    }
    let client = client()?;
    let target = resolve_device(&device)?;
    tauri::async_runtime::spawn_blocking(move || {
        write_property_core(
            &client,
            &target,
            ObjectId::new(object_type, instance),
            property,
            array_index,
            &[value],
            priority,
        )
    })
    .await
    .map_err(|e| format!("write task panicked: {e}"))?
}

/// Default COV subscription lifetime, and how often to resubscribe (well before
/// expiry). Devices cap lifetime; 300 s with a ~180 s refresh is conservative.
const COV_LIFETIME_SECS: u32 = 300;
const COV_RESUBSCRIBE_SECS: u64 = 180;

/// Consecutive resubscribe failures before the keep-alive gives up and drops the
/// subscription — bounds the thread's life if the device or frontend goes away
/// (e.g. a webview reload that never calls unsubscribe).
const COV_MAX_RESUBSCRIBE_FAILURES: u32 = 2;

/// Subscribes to COV notifications for one object. Returns the subscriber
/// process id; notifications then stream as `bacnet:cov` events until
/// `bacnet_unsubscribe_cov` is called. A background thread resubscribes before
/// the lifetime expires so the stream doesn't lapse; it self-terminates after a
/// few consecutive failures so an orphaned subscription can't loop forever.
#[tauri::command]
pub async fn bacnet_subscribe_cov(
    app: AppHandle,
    device: DeviceRef,
    device_instance: u32,
    object_type: u16,
    instance: u32,
    confirmed: Option<bool>,
) -> Result<u32, String> {
    let client = client()?;
    client.ensure_cov_emitter(&app);
    let target = resolve_device(&device)?;
    let object = ObjectId::new(object_type, instance);
    let confirmed = confirmed.unwrap_or(false);
    // device_key keys on the DEVICE instance (matches discovery / read_objects),
    // not the monitored object's instance.
    let dev_key = device_key(&device.address, device.network, device.mac.as_deref(), device_instance);
    let process_id = client.alloc_process();

    let client_run = Arc::clone(&client);
    tauri::async_runtime::spawn_blocking(move || {
        // Register BEFORE subscribing so the initial COV notification a device
        // emits immediately on SubscribeCOV isn't dropped as an unknown process.
        let active = Arc::new(std::sync::atomic::AtomicBool::new(true));
        client_run.cov.lock().unwrap().insert(
            process_id,
            CovEntry { device_key: dev_key, object, active: Arc::clone(&active) },
        );
        if let Err(e) = subscribe_cov_core(&client_run, &target, process_id, object, confirmed, Some(COV_LIFETIME_SECS)) {
            client_run.cov.lock().unwrap().remove(&process_id);
            return Err(e);
        }

        let client_bg = Arc::clone(&client_run);
        thread::spawn(move || {
            let mut failures = 0u32;
            while active.load(Ordering::Relaxed) {
                // Sleep in short slices so unsubscribe takes effect promptly.
                for _ in 0..(COV_RESUBSCRIBE_SECS * 2) {
                    if !active.load(Ordering::Relaxed) {
                        return;
                    }
                    thread::sleep(Duration::from_millis(500));
                }
                if !active.load(Ordering::Relaxed) {
                    return;
                }
                match subscribe_cov_core(&client_bg, &target, process_id, object, confirmed, Some(COV_LIFETIME_SECS)) {
                    Ok(()) => failures = 0,
                    Err(_) => {
                        failures += 1;
                        if failures >= COV_MAX_RESUBSCRIBE_FAILURES {
                            // Device unreachable or gone — stop and drop the entry.
                            active.store(false, Ordering::Relaxed);
                            client_bg.cov.lock().unwrap().remove(&process_id);
                            return;
                        }
                    }
                }
            }
        });
        Ok(process_id)
    })
    .await
    .map_err(|e| format!("subscribe task panicked: {e}"))?
}

/// Cancels a COV subscription created by [`bacnet_subscribe_cov`].
#[tauri::command]
pub async fn bacnet_unsubscribe_cov(
    device: DeviceRef,
    object_type: u16,
    instance: u32,
    process_id: u32,
) -> Result<(), String> {
    let client = client()?;
    let target = resolve_device(&device)?;
    // Stop the keep-alive and drop the registry entry first, so a late
    // notification can't re-arm anything.
    if let Some(entry) = client.cov.lock().unwrap().remove(&process_id) {
        entry.active.store(false, Ordering::Relaxed);
    }
    let object = ObjectId::new(object_type, instance);
    tauri::async_runtime::spawn_blocking(move || {
        // Best-effort cancellation — the device also drops us at lifetime expiry.
        subscribe_cov_core(&client, &target, process_id, object, false, None)
    })
    .await
    .map_err(|e| format!("unsubscribe task panicked: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    // ---- pure helpers ----

    #[test]
    fn parse_target_variants() {
        assert_eq!(
            parse_target("192.168.1.50").unwrap(),
            "192.168.1.50:47808".parse().unwrap()
        );
        assert_eq!(
            parse_target(" 10.0.0.7:47809 ").unwrap(),
            "10.0.0.7:47809".parse().unwrap()
        );
        assert!(parse_target("").is_err());
        assert!(parse_target("not an address").is_err());
    }

    #[test]
    fn broadcast_detection() {
        assert!(is_broadcast_target(&"255.255.255.255:47808".parse().unwrap()));
        assert!(is_broadcast_target(&"192.168.1.255:47808".parse().unwrap()));
        assert!(!is_broadcast_target(&"192.168.1.50:47808".parse().unwrap()));
    }

    #[test]
    fn parse_hex_tolerates_separators() {
        assert_eq!(parse_hex("0A0B0C"), vec![0x0A, 0x0B, 0x0C]);
        assert_eq!(parse_hex("0a-0b-0c"), vec![0x0A, 0x0B, 0x0C]);
        assert_eq!(parse_hex(""), Vec::<u8>::new());
    }

    #[test]
    fn device_key_distinguishes_routed_devices() {
        let a = device_key("10.0.0.5:47808", None, None, 100);
        let b = device_key("10.0.0.5:47808", Some(2001), Some("0C"), 100);
        let c = device_key("10.0.0.5:47808", Some(2001), Some("0D"), 100);
        assert_ne!(a, b);
        assert_ne!(b, c);
    }

    #[test]
    fn resolve_device_routed() {
        let t = resolve_device(&DeviceRef {
            address: "10.1.2.3".into(),
            network: Some(2001),
            mac: Some("0C".into()),
        })
        .unwrap();
        assert_eq!(t.sa, "10.1.2.3:47808".parse().unwrap());
        assert_eq!(t.route, Some((2001, vec![0x0C])));
    }

    // ---- display rendering ----

    #[test]
    fn render_status_flags() {
        let v = vec![BacnetValue::BitString { unused_bits: 4, bits: "0000".into() }];
        assert_eq!(render_values(0, 111, &v), "normal");
        let v = vec![BacnetValue::BitString { unused_bits: 4, bits: "1010".into() }];
        assert_eq!(render_values(0, 111, &v), "in-alarm, overridden");
    }

    #[test]
    fn render_units_and_binary_pv() {
        let v = vec![BacnetValue::Enumerated { value: 66 }];
        assert_eq!(render_values(0, 117, &v), "°F (66)");
        let v = vec![BacnetValue::Enumerated { value: 1 }];
        assert_eq!(render_values(4, 85, &v), "active (1)");
        // Analog present-value is untouched.
        let v = vec![BacnetValue::Real { value: 72.5 }];
        assert_eq!(render_values(0, 85, &v), "72.5");
    }

    #[test]
    fn render_priority_array() {
        let mut v = vec![BacnetValue::Null; 16];
        assert_eq!(render_values(1, 87, &v), "all Null (16 slots)");
        v[7] = BacnetValue::Real { value: 55.0 };
        assert_eq!(render_values(1, 87, &v), "p8=55");
    }

    #[test]
    fn render_object_list_summarized() {
        let v = vec![
            BacnetValue::ObjectIdentifier { object_type: 0, instance: 1 },
            BacnetValue::ObjectIdentifier { object_type: 0, instance: 2 },
        ];
        assert_eq!(render_values(8, 76, &v), "2 objects");
    }

    #[test]
    fn entry_for_error_property() {
        let e = make_entry(0, 85, None, Some((2, 32)));
        assert_eq!(e.error.as_deref(), Some("property / unknown-property"));
        assert_eq!(e.display, "(property / unknown-property)");
    }

    // ---- loopback integration: a fake device on 127.0.0.1 ----

    /// Reads one frame, returns (full frame, sender). Panics on timeout so a
    /// hung test fails fast instead of stalling the suite.
    fn recv_frame(socket: &UdpSocket) -> (Vec<u8>, SocketAddr) {
        socket.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        let mut buf = [0u8; 2048];
        let (n, src) = socket.recv_from(&mut buf).expect("fake device: no frame");
        (buf[..n].to_vec(), src)
    }

    fn unicast_reply(apdu: &[u8]) -> Vec<u8> {
        let mut payload = codec::encode_npdu(false, None);
        payload.extend_from_slice(apdu);
        codec::bvlc_encode(codec::BVLC_ORIGINAL_UNICAST, &payload)
    }

    #[test]
    fn discover_unicast_finds_fake_device() {
        let fake = UdpSocket::bind("127.0.0.1:0").unwrap();
        let fake_addr = fake.local_addr().unwrap();
        let t = thread::spawn(move || {
            let (frame, src) = recv_frame(&fake);
            let bvlc = codec::bvlc_decode(&frame).unwrap();
            assert_eq!(bvlc.function, codec::BVLC_ORIGINAL_UNICAST);
            let npdu = codec::decode_npdu(&frame[bvlc.payload_offset..]).unwrap();
            let apdu = &frame[bvlc.payload_offset + npdu.apdu_offset..];
            assert_eq!(apdu, codec::encode_who_is(None, None).as_slice());

            // Reply: I-Am device 1234, max-APDU 1476, no segmentation, vendor 999.
            let mut reply = vec![codec::PDU_UNCONFIRMED, codec::SERVICE_I_AM];
            codec::encode_application_value(
                &mut reply,
                &BacnetValue::ObjectIdentifier { object_type: 8, instance: 1234 },
            );
            codec::encode_application_value(&mut reply, &BacnetValue::Unsigned { value: 1476 });
            codec::encode_application_value(&mut reply, &BacnetValue::Enumerated { value: 3 });
            codec::encode_application_value(&mut reply, &BacnetValue::Unsigned { value: 999 });
            fake.send_to(&unicast_reply(&reply), src).unwrap();
        });

        let client = Client::new("127.0.0.1:0").unwrap();
        let mut streamed = 0;
        let devices = discover_core(
            &client,
            &fake_addr.to_string(),
            None,
            None,
            Duration::from_millis(700),
            |_| streamed += 1,
        )
        .unwrap();
        t.join().unwrap();

        assert_eq!(streamed, 1);
        assert_eq!(devices.len(), 1);
        let d = &devices[0];
        assert_eq!(d.instance, 1234);
        assert_eq!(d.max_apdu, 1476);
        assert_eq!(d.vendor_id, 999);
        assert_eq!(d.segmentation, "none");
        assert_eq!(d.network, None);
        assert_eq!(d.address, fake_addr.to_string());
    }

    #[test]
    fn discovery_dedupes_repeated_i_am() {
        let fake = UdpSocket::bind("127.0.0.1:0").unwrap();
        let fake_addr = fake.local_addr().unwrap();
        let t = thread::spawn(move || {
            let (_, src) = recv_frame(&fake);
            let mut reply = vec![codec::PDU_UNCONFIRMED, codec::SERVICE_I_AM];
            codec::encode_application_value(
                &mut reply,
                &BacnetValue::ObjectIdentifier { object_type: 8, instance: 77 },
            );
            codec::encode_application_value(&mut reply, &BacnetValue::Unsigned { value: 480 });
            codec::encode_application_value(&mut reply, &BacnetValue::Enumerated { value: 3 });
            codec::encode_application_value(&mut reply, &BacnetValue::Unsigned { value: 5 });
            let frame = unicast_reply(&reply);
            fake.send_to(&frame, src).unwrap();
            fake.send_to(&frame, src).unwrap(); // duplicate announcement
        });

        let client = Client::new("127.0.0.1:0").unwrap();
        let devices = discover_core(
            &client,
            &fake_addr.to_string(),
            None,
            None,
            Duration::from_millis(700),
            |_| {},
        )
        .unwrap();
        t.join().unwrap();
        assert_eq!(devices.len(), 1);
    }

    #[test]
    fn discovery_sweeps_routed_networks() {
        let fake = UdpSocket::bind("127.0.0.1:0").unwrap();
        let fake_addr = fake.local_addr().unwrap();
        let t = thread::spawn(move || {
            // Discovery sends Who-Is and Who-Is-Router-To-Network up front.
            for _ in 0..2 {
                let (frame, src) = recv_frame(&fake);
                let bvlc = codec::bvlc_decode(&frame).unwrap();
                let npdu = codec::decode_npdu(&frame[bvlc.payload_offset..]).unwrap();
                if npdu.network_message {
                    assert_eq!(
                        npdu.message_type,
                        Some(codec::NETWORK_MSG_WHO_IS_ROUTER_TO_NETWORK)
                    );
                    // We route to network 2001.
                    let reply = codec::encode_network_message(
                        codec::NETWORK_MSG_I_AM_ROUTER_TO_NETWORK,
                        &[0x07, 0xD1],
                        None,
                    );
                    fake.send_to(&codec::bvlc_encode(codec::BVLC_ORIGINAL_UNICAST, &reply), src)
                        .unwrap();
                }
            }
            // The client should now sweep net 2001 through us.
            let (frame, src) = recv_frame(&fake);
            let bvlc = codec::bvlc_decode(&frame).unwrap();
            let npdu = codec::decode_npdu(&frame[bvlc.payload_offset..]).unwrap();
            assert_eq!(npdu.dest, Some((2001, vec![])));
            let apdu = &frame[bvlc.payload_offset + npdu.apdu_offset..];
            assert_eq!(apdu, codec::encode_who_is(None, None).as_slice());

            // Routed I-Am: device 3001, MS/TP MAC 0x0C on net 2001.
            let mut payload = vec![0x01, 0x08, 0x07, 0xD1, 0x01, 0x0C];
            payload.extend_from_slice(&[codec::PDU_UNCONFIRMED, codec::SERVICE_I_AM]);
            codec::encode_application_value(
                &mut payload,
                &BacnetValue::ObjectIdentifier { object_type: 8, instance: 3001 },
            );
            codec::encode_application_value(&mut payload, &BacnetValue::Unsigned { value: 480 });
            codec::encode_application_value(&mut payload, &BacnetValue::Enumerated { value: 3 });
            codec::encode_application_value(&mut payload, &BacnetValue::Unsigned { value: 7 });
            fake.send_to(&codec::bvlc_encode(codec::BVLC_ORIGINAL_UNICAST, &payload), src)
                .unwrap();
        });

        let client = Client::new("127.0.0.1:0").unwrap();
        let devices = discover_core(
            &client,
            &fake_addr.to_string(),
            None,
            None,
            Duration::from_millis(900),
            |_| {},
        )
        .unwrap();
        t.join().unwrap();

        assert_eq!(devices.len(), 1);
        let d = &devices[0];
        assert_eq!(d.instance, 3001);
        assert_eq!(d.network, Some(2001));
        assert_eq!(d.mac.as_deref(), Some("0C"));
        // Routed devices are addressed through their router's IP.
        assert_eq!(d.address, fake_addr.to_string());
    }

    #[test]
    fn read_property_roundtrip_over_loopback() {
        let fake = UdpSocket::bind("127.0.0.1:0").unwrap();
        let fake_addr = fake.local_addr().unwrap();
        let t = thread::spawn(move || {
            let (frame, src) = recv_frame(&fake);
            let bvlc = codec::bvlc_decode(&frame).unwrap();
            let npdu = codec::decode_npdu(&frame[bvlc.payload_offset..]).unwrap();
            let apdu = &frame[bvlc.payload_offset + npdu.apdu_offset..];
            let Apdu::ConfirmedRequest { invoke_id, service, .. } = codec::decode_apdu(apdu).unwrap()
            else {
                panic!("expected confirmed request");
            };
            assert_eq!(service, codec::SERVICE_READ_PROPERTY);

            // ComplexACK: AI-1 present-value = 72.0.
            let mut reply = vec![codec::PDU_COMPLEX_ACK, invoke_id, codec::SERVICE_READ_PROPERTY];
            codec::encode_context_object_id(&mut reply, 0, ObjectId::new(0, 1));
            codec::encode_context_unsigned(&mut reply, 1, codec::PROP_PRESENT_VALUE as u64);
            codec::encode_opening_tag(&mut reply, 3);
            codec::encode_application_value(&mut reply, &BacnetValue::Real { value: 72.0 });
            codec::encode_closing_tag(&mut reply, 3);
            fake.send_to(&unicast_reply(&reply), src).unwrap();
        });

        let client = Client::new("127.0.0.1:0").unwrap();
        let target = Target { sa: fake_addr, route: None };
        let values =
            read_property(&client, &target, ObjectId::new(0, 1), codec::PROP_PRESENT_VALUE, None)
                .unwrap();
        t.join().unwrap();
        assert_eq!(values, vec![BacnetValue::Real { value: 72.0 }]);
    }

    #[test]
    fn read_property_rejects_wrong_object_reply() {
        // A device that answers with a DIFFERENT object than asked (the stale
        // reused-invoke-id case, same peer) must be rejected, not shown as the
        // requested object's value.
        let fake = UdpSocket::bind("127.0.0.1:0").unwrap();
        let fake_addr = fake.local_addr().unwrap();
        let t = thread::spawn(move || {
            let (frame, src) = recv_frame(&fake);
            let bvlc = codec::bvlc_decode(&frame).unwrap();
            let npdu = codec::decode_npdu(&frame[bvlc.payload_offset..]).unwrap();
            let apdu = &frame[bvlc.payload_offset + npdu.apdu_offset..];
            let Apdu::ConfirmedRequest { invoke_id, .. } = codec::decode_apdu(apdu).unwrap() else {
                panic!("expected confirmed request");
            };
            // Reply describes AI-2 though AI-1 was requested.
            let mut reply = vec![codec::PDU_COMPLEX_ACK, invoke_id, codec::SERVICE_READ_PROPERTY];
            codec::encode_context_object_id(&mut reply, 0, ObjectId::new(0, 2));
            codec::encode_context_unsigned(&mut reply, 1, codec::PROP_PRESENT_VALUE as u64);
            codec::encode_opening_tag(&mut reply, 3);
            codec::encode_application_value(&mut reply, &BacnetValue::Real { value: 99.0 });
            codec::encode_closing_tag(&mut reply, 3);
            fake.send_to(&unicast_reply(&reply), src).unwrap();
        });

        let client = Client::new("127.0.0.1:0").unwrap();
        let target = Target { sa: fake_addr, route: None };
        let err =
            read_property(&client, &target, ObjectId::new(0, 1), codec::PROP_PRESENT_VALUE, None)
                .unwrap_err();
        t.join().unwrap();
        assert!(err.contains("response mismatch"), "unexpected error: {err}");
    }

    #[test]
    fn complete_ignores_reply_from_wrong_source() {
        // complete() must only deliver a reply whose source IP matches the peer
        // the transaction is talking to — the cross-device reused-invoke-id case.
        let client = Client::new("127.0.0.1:0").unwrap();
        let (tx, rx) = mpsc::channel();
        let peer: SocketAddr = "10.0.0.5:47808".parse().unwrap();
        client.pending.lock().unwrap().insert(7, (peer, tx));

        // Wrong source IP -> dropped.
        client.complete(7, "10.0.0.9:47808".parse().unwrap(), Outcome::Simple);
        assert!(rx.try_recv().is_err(), "reply from wrong source should be dropped");

        // Correct source IP (any port) -> delivered.
        client.complete(7, "10.0.0.5:12345".parse().unwrap(), Outcome::Simple);
        assert!(matches!(rx.try_recv(), Ok(Outcome::Simple)), "matching-source reply should deliver");
    }

    #[test]
    fn write_property_simple_ack_over_loopback() {
        let fake = UdpSocket::bind("127.0.0.1:0").unwrap();
        let fake_addr = fake.local_addr().unwrap();
        let t = thread::spawn(move || {
            let (frame, src) = recv_frame(&fake);
            let bvlc = codec::bvlc_decode(&frame).unwrap();
            let npdu = codec::decode_npdu(&frame[bvlc.payload_offset..]).unwrap();
            let apdu = &frame[bvlc.payload_offset + npdu.apdu_offset..];
            let Apdu::ConfirmedRequest { invoke_id, service, .. } = codec::decode_apdu(apdu).unwrap()
            else {
                panic!("expected confirmed request");
            };
            assert_eq!(service, codec::SERVICE_WRITE_PROPERTY);
            fake.send_to(
                &unicast_reply(&[codec::PDU_SIMPLE_ACK, invoke_id, codec::SERVICE_WRITE_PROPERTY]),
                src,
            )
            .unwrap();
        });

        let client = Client::new("127.0.0.1:0").unwrap();
        let target = Target { sa: fake_addr, route: None };
        write_property_core(
            &client,
            &target,
            ObjectId::new(2, 1),
            codec::PROP_PRESENT_VALUE,
            None,
            &[BacnetValue::Real { value: 72.0 }],
            Some(8),
        )
        .unwrap();
        t.join().unwrap();
    }

    #[test]
    fn subscribe_cov_simple_ack_over_loopback() {
        let fake = UdpSocket::bind("127.0.0.1:0").unwrap();
        let fake_addr = fake.local_addr().unwrap();
        let t = thread::spawn(move || {
            let (frame, src) = recv_frame(&fake);
            let bvlc = codec::bvlc_decode(&frame).unwrap();
            let npdu = codec::decode_npdu(&frame[bvlc.payload_offset..]).unwrap();
            let apdu = &frame[bvlc.payload_offset + npdu.apdu_offset..];
            let Apdu::ConfirmedRequest { invoke_id, service, .. } = codec::decode_apdu(apdu).unwrap()
            else {
                panic!("expected confirmed request");
            };
            assert_eq!(service, codec::SERVICE_SUBSCRIBE_COV);
            fake.send_to(
                &unicast_reply(&[codec::PDU_SIMPLE_ACK, invoke_id, codec::SERVICE_SUBSCRIBE_COV]),
                src,
            )
            .unwrap();
        });

        let client = Client::new("127.0.0.1:0").unwrap();
        let target = Target { sa: fake_addr, route: None };
        subscribe_cov_core(&client, &target, 7, ObjectId::new(0, 0), false, Some(60)).unwrap();
        t.join().unwrap();
    }

    #[test]
    fn confirmed_cov_notification_is_acked_by_reader() {
        // A device pushing a ConfirmedCOVNotification must get a SimpleACK back
        // from our reader thread, or it stops sending. Drive that end-to-end:
        // the fake sends the notification to the client's socket and waits for
        // the ack.
        let client = Client::new("127.0.0.1:0").unwrap();
        let client_addr = client.socket.local_addr().unwrap();

        let fake = UdpSocket::bind("127.0.0.1:0").unwrap();
        fake.set_read_timeout(Some(Duration::from_secs(5))).unwrap();

        // Build a ConfirmedCOVNotification APDU (invoke 5), AI-0 present-value 42.
        let mut apdu = vec![
            codec::PDU_CONFIRMED,
            codec::MAX_SEGS_MAX_APDU,
            5,
            codec::SERVICE_CONFIRMED_COV_NOTIFICATION,
        ];
        codec::encode_context_unsigned(&mut apdu, 0, 1);
        codec::encode_context_object_id(&mut apdu, 1, ObjectId::new(8, 1234));
        codec::encode_context_object_id(&mut apdu, 2, ObjectId::new(0, 0));
        codec::encode_context_unsigned(&mut apdu, 3, 120);
        codec::encode_opening_tag(&mut apdu, 4);
        codec::encode_cov_property_value(&mut apdu, codec::PROP_PRESENT_VALUE, &BacnetValue::Real { value: 42.0 });
        codec::encode_closing_tag(&mut apdu, 4);
        let mut payload = codec::encode_npdu(false, None);
        payload.extend_from_slice(&apdu);
        fake.send_to(&codec::bvlc_encode(codec::BVLC_ORIGINAL_UNICAST, &payload), client_addr)
            .unwrap();

        // The reader must have sent a SimpleACK for invoke 5 / service 1.
        let mut buf = [0u8; 512];
        let (n, _) = fake.recv_from(&mut buf).expect("no SimpleACK from reader");
        let bvlc = codec::bvlc_decode(&buf[..n]).unwrap();
        let npdu = codec::decode_npdu(&buf[bvlc.payload_offset..]).unwrap();
        let ack = codec::decode_apdu(&buf[bvlc.payload_offset + npdu.apdu_offset..]).unwrap();
        assert_eq!(
            ack,
            Apdu::SimpleAck { invoke_id: 5, service: codec::SERVICE_CONFIRMED_COV_NOTIFICATION }
        );
    }

    #[test]
    fn cov_event_rendering() {
        // build_cov_event renders values like the property grid does.
        let ev = build_cov_event(
            "dev-key".into(),
            codec::CovNotification {
                process_id: 9,
                initiating_device: ObjectId::new(8, 1),
                monitored_object: ObjectId::new(0, 5),
                time_remaining: 100,
                values: vec![
                    codec::CovValue {
                        property: codec::PROP_PRESENT_VALUE,
                        array_index: None,
                        values: vec![BacnetValue::Real { value: 21.5 }],
                    },
                    codec::CovValue {
                        property: 111,
                        array_index: None,
                        values: vec![BacnetValue::BitString { unused_bits: 4, bits: "1000".into() }],
                    },
                ],
            },
        );
        assert_eq!(ev.device_key, "dev-key");
        assert_eq!(ev.object_type, 0);
        assert_eq!(ev.instance, 5);
        assert_eq!(ev.values.len(), 2);
        assert_eq!(ev.values[0].name, "present-value");
        assert_eq!(ev.values[0].display, "21.5");
        assert_eq!(ev.values[1].name, "status-flags");
        assert_eq!(ev.values[1].display, "in-alarm");
    }

    #[test]
    fn cov_routing_guards_object_mismatch() {
        // note_cov with no AppHandle must not panic, and must respect the
        // object-match guard (process-id reuse safety).
        let client = Client::new("127.0.0.1:0").unwrap();
        client.cov.lock().unwrap().insert(
            9,
            CovEntry {
                device_key: "dev".into(),
                object: ObjectId::new(0, 5),
                active: Arc::new(std::sync::atomic::AtomicBool::new(true)),
            },
        );
        client.note_cov(codec::CovNotification {
            process_id: 9,
            initiating_device: ObjectId::new(8, 1),
            monitored_object: ObjectId::new(0, 6), // mismatched -> dropped
            time_remaining: 100,
            values: vec![],
        });
        // Unknown process id -> dropped.
        client.note_cov(codec::CovNotification {
            process_id: 999,
            initiating_device: ObjectId::new(8, 1),
            monitored_object: ObjectId::new(0, 5),
            time_remaining: 100,
            values: vec![],
        });
        assert!(client.cov.lock().unwrap().contains_key(&9));
    }

    #[test]
    fn device_error_is_reported_with_names() {
        let fake = UdpSocket::bind("127.0.0.1:0").unwrap();
        let fake_addr = fake.local_addr().unwrap();
        let t = thread::spawn(move || {
            let (frame, src) = recv_frame(&fake);
            let bvlc = codec::bvlc_decode(&frame).unwrap();
            let npdu = codec::decode_npdu(&frame[bvlc.payload_offset..]).unwrap();
            let apdu = &frame[bvlc.payload_offset + npdu.apdu_offset..];
            let Apdu::ConfirmedRequest { invoke_id, .. } = codec::decode_apdu(apdu).unwrap() else {
                panic!("expected confirmed request");
            };
            // Error: class object (1), code unknown-object (31).
            let reply = vec![
                codec::PDU_ERROR,
                invoke_id,
                codec::SERVICE_READ_PROPERTY,
                0x91,
                0x01,
                0x91,
                0x1F,
            ];
            fake.send_to(&unicast_reply(&reply), src).unwrap();
        });

        let client = Client::new("127.0.0.1:0").unwrap();
        let target = Target { sa: fake_addr, route: None };
        let err = read_property(&client, &target, ObjectId::new(0, 99), 85, None).unwrap_err();
        t.join().unwrap();
        assert!(err.contains("unknown-object"), "unexpected error text: {err}");
    }

    // ---- live-network survey (read-only, ignored by default) ----
    //
    // Runs the whole client stack against every real device that answers a
    // Who-Is on the lab/site network. Strictly read-only — no WriteProperty.
    //
    //   cargo test live_network_survey -- --ignored --nocapture
    //
    // Override the broadcast target with BACNET_TARGET (default 192.168.1.255).

    #[derive(Clone)]
    struct DeviceReport {
        label: String,
        rpm_ok: bool,
        count_indexed: Option<u64>,
        full_list: Result<usize, String>,
        objects_sampled: usize,
        props_read: usize,
        prop_errors: Vec<String>,
        priority_array: Option<Result<String, String>>,
        hard_failures: Vec<String>,
        elapsed_ms: u128,
    }

    impl DeviceReport {
        fn new() -> Self {
            Self {
                label: String::new(),
                rpm_ok: false,
                count_indexed: None,
                full_list: Err("not attempted".into()),
                objects_sampled: 0,
                props_read: 0,
                prop_errors: Vec::new(),
                priority_array: None,
                hard_failures: Vec::new(),
                elapsed_ms: 0,
            }
        }
    }

    fn survey_device(client: &Client, dev: &BacnetDevice) -> DeviceReport {
        let started = Instant::now();
        let mut r = DeviceReport::new();
        r.label = format!(
            "{} @ {}{}",
            dev.instance,
            dev.address,
            dev.network.map(|n| format!(" net{n}/{}", dev.mac.clone().unwrap_or_default())).unwrap_or_default()
        );
        let target = match resolve_device(&DeviceRef {
            address: dev.address.clone(),
            network: dev.network,
            mac: dev.mac.clone(),
        }) {
            Ok(t) => t,
            Err(e) => {
                r.hard_failures.push(format!("resolve: {e}"));
                return r;
            }
        };
        let dev_obj = ObjectId::new(codec::OBJECT_TYPE_DEVICE, dev.instance);

        // 1. RPM enrichment (name / vendor / model).
        let spec = codec::ReadAccessSpec {
            object: dev_obj,
            properties: vec![
                codec::PropertyRef { property: codec::PROP_OBJECT_NAME, array_index: None },
                codec::PropertyRef { property: codec::PROP_VENDOR_NAME, array_index: None },
                codec::PropertyRef { property: codec::PROP_MODEL_NAME, array_index: None },
            ],
        };
        match read_property_multiple(client, &target, &[spec]) {
            Ok(objs) => {
                r.rpm_ok = true;
                for o in objs {
                    for p in o.properties {
                        if p.property == codec::PROP_OBJECT_NAME {
                            if let Some(name) = p.values.as_deref().and_then(first_string) {
                                r.label = format!("{} \"{name}\"", r.label);
                            }
                        }
                    }
                }
            }
            Err(e) => r.hard_failures.push(format!("rpm-enrich: {e}")),
        }

        // 2. object-list[0] (count via array index).
        match read_property(client, &target, dev_obj, codec::PROP_OBJECT_LIST, Some(0)) {
            Ok(values) => {
                if let Some(BacnetValue::Unsigned { value }) = values.first() {
                    r.count_indexed = Some(*value);
                }
            }
            Err(e) => r.hard_failures.push(format!("object-list[0]: {e}")),
        }

        // 3. Full object-list in one RP (expected to fail w/ abort on big devices).
        let ids: Vec<ObjectId> = match read_property(client, &target, dev_obj, codec::PROP_OBJECT_LIST, None) {
            Ok(values) => {
                let ids = codec::object_ids_from_values(&values);
                r.full_list = Ok(ids.len());
                ids
            }
            Err(e) => {
                r.full_list = Err(e);
                // Walk just the first few entries to validate the fallback path.
                let n = r.count_indexed.unwrap_or(0).min(8);
                let mut ids = Vec::new();
                for i in 1..=n {
                    match read_property(client, &target, dev_obj, codec::PROP_OBJECT_LIST, Some(i as u32)) {
                        Ok(values) => ids.extend(codec::object_ids_from_values(&values)),
                        Err(e) => {
                            r.hard_failures.push(format!("object-list[{i}]: {e}"));
                            break;
                        }
                    }
                }
                ids
            }
        };

        // 4. Full property reads on a sample of objects (one per common type).
        let mut sample: Vec<ObjectId> = vec![dev_obj];
        for ty in [0u16, 1, 2, 3, 4, 5, 13, 14, 19, 20, 17] {
            if let Some(id) = ids.iter().find(|id| id.object_type == ty) {
                sample.push(*id);
            }
        }
        sample.truncate(7);
        for obj in &sample {
            match read_all_properties_core(client, &target, *obj) {
                Ok(entries) => {
                    r.objects_sampled += 1;
                    r.props_read += entries.iter().filter(|e| e.error.is_none()).count();
                    for e in entries.iter().filter(|e| e.error.is_some()).take(3) {
                        r.prop_errors.push(format!(
                            "{}:{} {} -> {}",
                            codec::object_type_name(obj.object_type),
                            obj.instance,
                            e.name,
                            e.error.clone().unwrap_or_default()
                        ));
                    }
                }
                Err(e) => r.hard_failures.push(format!(
                    "props {}:{}: {e}",
                    codec::object_type_name(obj.object_type),
                    obj.instance
                )),
            }
        }

        // 5. priority-array on the first commandable object.
        if let Some(cmd) = ids.iter().find(|id| matches!(id.object_type, 1 | 2 | 4 | 5 | 14 | 19)) {
            r.priority_array = Some(
                read_property(client, &target, *cmd, codec::PROP_PRIORITY_ARRAY, None)
                    .map(|v| render_values(cmd.object_type, codec::PROP_PRIORITY_ARRAY, &v)),
            );
        }

        r.elapsed_ms = started.elapsed().as_millis();
        r
    }

    /// Read-only BVLC Read-Broadcast-Distribution-Table probe — tells us
    /// whether a device is a BBMD and which other BACnet/IP subnets it knows.
    fn probe_bdt(addr: &str) -> Result<Vec<String>, String> {
        let sock = UdpSocket::bind("0.0.0.0:0").map_err(|e| e.to_string())?;
        sock.set_read_timeout(Some(Duration::from_millis(800))).ok();
        let sa = parse_target(addr)?;
        sock.send_to(&[0x81, 0x02, 0x00, 0x04], sa).map_err(|e| e.to_string())?;
        let mut buf = [0u8; 1500];
        let (n, _) = sock.recv_from(&mut buf).map_err(|_| "no reply".to_string())?;
        let b = &buf[..n];
        if b.len() >= 4 && b[0] == 0x81 && b[1] == 0x03 {
            let mut out = Vec::new();
            for e in b[4..].chunks(10) {
                if e.len() == 10 {
                    out.push(format!(
                        "{}.{}.{}.{}:{} dist-mask {}.{}.{}.{}",
                        e[0], e[1], e[2], e[3],
                        u16::from_be_bytes([e[4], e[5]]),
                        e[6], e[7], e[8], e[9]
                    ));
                }
            }
            Ok(out)
        } else if let Some(code) = codec::decode_bvlc_result(b) {
            Err(format!("NAK 0x{code:04X}"))
        } else {
            Err("unexpected reply".into())
        }
    }

    #[test]
    fn discovery_probes_multiple_targets() {
        let fake = |instance: u32| {
            let sock = UdpSocket::bind("127.0.0.1:0").unwrap();
            let addr = sock.local_addr().unwrap();
            let t = thread::spawn(move || {
                // Each target receives Who-Is + Who-Is-Router; answer the Who-Is.
                for _ in 0..2 {
                    let (frame, src) = recv_frame(&sock);
                    let bvlc = codec::bvlc_decode(&frame).unwrap();
                    let npdu = codec::decode_npdu(&frame[bvlc.payload_offset..]).unwrap();
                    if npdu.network_message {
                        continue;
                    }
                    let mut reply = vec![codec::PDU_UNCONFIRMED, codec::SERVICE_I_AM];
                    codec::encode_application_value(
                        &mut reply,
                        &BacnetValue::ObjectIdentifier { object_type: 8, instance },
                    );
                    codec::encode_application_value(&mut reply, &BacnetValue::Unsigned { value: 480 });
                    codec::encode_application_value(&mut reply, &BacnetValue::Enumerated { value: 3 });
                    codec::encode_application_value(&mut reply, &BacnetValue::Unsigned { value: 1 });
                    sock.send_to(&unicast_reply(&reply), src).unwrap();
                }
            });
            (addr, t)
        };
        let (a, ta) = fake(11);
        let (b, tb) = fake(22);

        let client = Client::new("127.0.0.1:0").unwrap();
        let devices = discover_core(
            &client,
            &format!("{a}, {b}"),
            None,
            None,
            Duration::from_millis(900),
            |_| {},
        )
        .unwrap();
        ta.join().unwrap();
        tb.join().unwrap();
        let instances: Vec<u32> = devices.iter().map(|d| d.instance).collect();
        assert_eq!(instances, vec![11, 22]);
    }

    /// Deep read of one big routed device: full object-list walk (exercises
    /// the indexed fallback for real), streamed name enrichment with adaptive
    /// RPM chunks, and full property reads on a spread of objects. Defaults to
    /// the 439-object Schneider SE8350 found behind the JACE router at
    /// 192.168.1.117 (net 10018, MAC 02). Read-only.
    ///
    ///   cargo test live_deep_read_routed_device -- --ignored --nocapture
    #[test]
    #[ignore]
    fn live_deep_read_routed_device() {
        let addr = std::env::var("BACNET_DEEP_ADDR").unwrap_or_else(|_| "192.168.1.117".into());
        let net: u16 = std::env::var("BACNET_DEEP_NET").ok().and_then(|s| s.parse().ok()).unwrap_or(10018);
        let mac = std::env::var("BACNET_DEEP_MAC").unwrap_or_else(|_| "02".into());
        let instance: u32 =
            std::env::var("BACNET_DEEP_INSTANCE").ok().and_then(|s| s.parse().ok()).unwrap_or(90200);

        let client = Client::new("0.0.0.0:0").unwrap();
        let target = resolve_device(&DeviceRef {
            address: addr.clone(),
            network: Some(net),
            mac: Some(mac.clone()),
        })
        .unwrap();
        println!("== deep read: device {instance} via {addr} net {net} mac {mac} ==");

        let t0 = Instant::now();
        let objects = read_object_ids_core(&client, &target, instance, |done, total| {
            if done % 50 == 0 || done == total {
                println!("  object-list walk {done}/{total} ({:?})", t0.elapsed());
            }
        })
        .unwrap();
        println!("== {} objects in {:?} ==", objects.len(), t0.elapsed());
        assert!(!objects.is_empty());

        let ids: Vec<ObjectId> = objects
            .iter()
            .map(|o| ObjectId::new(o.object_type, o.instance))
            .collect();
        let t1 = Instant::now();
        let mut named = 0usize;
        enrich_object_names_core(&client, &target, &ids, || true, |batch| {
            let before = named;
            named += batch.len();
            if before / 48 != named / 48 || named == ids.len() {
                println!("  names {named}/{} ({:?})", ids.len(), t1.elapsed());
            }
        });
        println!("== names resolved: {named}/{} in {:?} ==", ids.len(), t1.elapsed());
        assert!(named > 0, "no object names resolved");

        // Full property reads across a spread of objects.
        for id in [ids.first(), ids.get(ids.len() / 2), ids.last()].into_iter().flatten() {
            match read_all_properties_core(&client, &target, *id) {
                Ok(entries) => {
                    let errs = entries.iter().filter(|e| e.error.is_some()).count();
                    println!(
                        "  props {}:{} -> {} entries ({errs} property errors)",
                        codec::object_type_name(id.object_type),
                        id.instance,
                        entries.len()
                    );
                    for e in entries.iter().take(4) {
                        println!("      {} = {}", e.name, e.display);
                    }
                }
                Err(e) => panic!("property read failed on {}:{}: {e}", id.object_type, id.instance),
            }
        }
    }

    /// Live COV check (read-only): discover, find an analog input/value on a
    /// device, subscribe, and watch real Change-of-Value notifications stream in
    /// for ~15 s. SubscribeCOV changes nothing on the device.
    ///
    ///   cargo test live_cov_watch -- --ignored --nocapture
    #[test]
    #[ignore]
    fn live_cov_watch() {
        let target = std::env::var("BACNET_TARGET").unwrap_or_else(|_| "192.168.1.255".into());
        let client = Client::new("0.0.0.0:0").unwrap();

        let devices = discover_core(&client, &target, None, None, Duration::from_secs(5), |_| {}).unwrap();
        println!("discovered {} devices", devices.len());
        assert!(!devices.is_empty(), "no devices found");

        // Find a device that exposes an analog-input or analog-value object.
        let mut chosen: Option<(BacnetDevice, ObjectId)> = None;
        'outer: for dev in &devices {
            let Ok(t) = resolve_device(&DeviceRef {
                address: dev.address.clone(),
                network: dev.network,
                mac: dev.mac.clone(),
            }) else { continue };
            let Ok(objects) = read_object_ids_core(&client, &t, dev.instance, |_, _| {}) else { continue };
            if let Some(o) = objects.iter().find(|o| matches!(o.object_type, 0 | 2)) {
                chosen = Some((dev.clone(), ObjectId::new(o.object_type, o.instance)));
                break 'outer;
            }
        }
        let (dev, object) = chosen.expect("no device with an analog-input/value object");
        let t = resolve_device(&DeviceRef {
            address: dev.address.clone(),
            network: dev.network,
            mac: dev.mac.clone(),
        })
        .unwrap();
        println!(
            "subscribing COV: device {} {}:{} via {}",
            dev.instance, codec::object_type_name(object.object_type), object.instance, dev.address
        );

        // Install a test channel where the app's emitter would be, register the
        // subscription, and subscribe.
        let (tx, rx) = mpsc::channel::<CovEvent>();
        *client.cov_tx.lock().unwrap() = Some(tx);
        let process_id = client.alloc_process();
        client.cov.lock().unwrap().insert(
            process_id,
            CovEntry {
                device_key: "live".into(),
                object,
                active: Arc::new(std::sync::atomic::AtomicBool::new(true)),
            },
        );
        subscribe_cov_core(&client, &t, process_id, object, false, Some(120)).unwrap();
        println!("subscribed (process {process_id}); watching 15 s…");

        let deadline = Instant::now() + Duration::from_secs(15);
        let mut count = 0;
        while Instant::now() < deadline {
            match rx.recv_timeout(Duration::from_millis(500)) {
                Ok(ev) => {
                    count += 1;
                    let summary: Vec<String> =
                        ev.values.iter().map(|v| format!("{}={}", v.name, v.display)).collect();
                    println!("  COV #{count}: {} (t-{}s)", summary.join(", "), ev.time_remaining);
                }
                Err(_) => {}
            }
        }
        let _ = subscribe_cov_core(&client, &t, process_id, object, false, None); // cancel
        println!("== received {count} COV notification(s) ==");
        // The initial notification fires on subscribe regardless of change, so
        // we expect at least one.
        assert!(count >= 1, "no COV notifications received (device may not support COV)");
    }

    #[test]
    #[ignore]
    fn live_network_survey() {
        let target = std::env::var("BACNET_TARGET").unwrap_or_else(|_| "192.168.1.255".into());
        let client = Client::new("0.0.0.0:0").unwrap();

        println!("== discovery: Who-Is -> {target} (6 s window) ==");
        let devices = discover_core(&client, &target, None, None, Duration::from_secs(6), |d| {
            println!(
                "  I-Am: {} @ {}{} vendor {} apdu {} seg {}",
                d.instance,
                d.address,
                d.network.map(|n| format!(" net{n}/{}", d.mac.clone().unwrap_or_default())).unwrap_or_default(),
                d.vendor_id,
                d.max_apdu,
                d.segmentation
            );
        })
        .unwrap();
        println!("== {} devices found ==", devices.len());
        let routed = devices.iter().filter(|d| d.network.is_some()).count();
        println!("   local: {}   routed: {}", devices.len() - routed, routed);
        let mut nets: Vec<u16> = devices.iter().filter_map(|d| d.network).collect();
        nets.sort_unstable();
        nets.dedup();
        if !nets.is_empty() {
            println!("   remote networks: {nets:?}");
        }
        let mut vendors: HashMap<u32, usize> = HashMap::new();
        for d in &devices {
            *vendors.entry(d.vendor_id).or_default() += 1;
        }
        let mut vendors: Vec<_> = vendors.into_iter().collect();
        vendors.sort_by_key(|(_, c)| std::cmp::Reverse(*c));
        println!("   vendors: {vendors:?}");
        if devices.is_empty() {
            panic!("no devices answered — wrong target / not connected?");
        }

        // Survey every device on a bounded worker pool.
        let (tx, rx) = mpsc::channel::<BacnetDevice>();
        for d in devices.clone() {
            tx.send(d).unwrap();
        }
        drop(tx);
        let rx = Arc::new(Mutex::new(rx));
        let reports = Arc::new(Mutex::new(Vec::<DeviceReport>::new()));
        let workers = 12usize.min(devices.len()).max(1);
        let mut handles = Vec::new();
        for _ in 0..workers {
            let rx = Arc::clone(&rx);
            let reports = Arc::clone(&reports);
            let client = Arc::clone(&client);
            handles.push(thread::spawn(move || loop {
                let dev = {
                    let guard = rx.lock().unwrap();
                    guard.recv()
                };
                let Ok(dev) = dev else { break };
                let rep = survey_device(&client, &dev);
                println!(
                    "  [{}] rpm={} count={:?} full={} sampled={} props={} errs={} hard={} {}ms",
                    rep.label,
                    rep.rpm_ok,
                    rep.count_indexed,
                    match &rep.full_list { Ok(n) => format!("ok({n})"), Err(e) => format!("ERR({e})") },
                    rep.objects_sampled,
                    rep.props_read,
                    rep.prop_errors.len(),
                    rep.hard_failures.len(),
                    rep.elapsed_ms
                );
                reports.lock().unwrap().push(rep);
            }));
        }
        for h in handles {
            let _ = h.join();
        }

        // ---- aggregate ----
        let reports = reports.lock().unwrap();
        let n = reports.len();
        let rpm = reports.iter().filter(|r| r.rpm_ok).count();
        let full_ok = reports.iter().filter(|r| r.full_list.is_ok()).count();
        let count_ok = reports.iter().filter(|r| r.count_indexed.is_some()).count();
        let props: usize = reports.iter().map(|r| r.props_read).sum();
        let sampled: usize = reports.iter().map(|r| r.objects_sampled).sum();
        let pa_ok = reports.iter().filter(|r| matches!(r.priority_array, Some(Ok(_)))).count();
        let pa_err = reports.iter().filter(|r| matches!(r.priority_array, Some(Err(_)))).count();
        println!("\n==================== SURVEY SUMMARY ====================");
        println!("devices surveyed:        {n}");
        println!("RPM supported:           {rpm}/{n}");
        println!("object-list[0] (count):  {count_ok}/{n}");
        println!("full object-list one RP: {full_ok}/{n} (rest exercised indexed fallback)");
        println!("objects fully read:      {sampled} ({props} property values)");
        println!("priority-array reads:    {pa_ok} ok / {pa_err} err");

        let mut err_histo: HashMap<String, usize> = HashMap::new();
        for r in reports.iter() {
            for e in r.hard_failures.iter().chain(r.prop_errors.iter()) {
                // Bucket by the error text after the location prefix.
                let key = e.split("-> ").last().unwrap_or(e).split(": ").last().unwrap_or(e);
                *err_histo.entry(key.to_string()).or_default() += 1;
            }
            if let Some(Err(e)) = &r.priority_array {
                *err_histo.entry(e.clone()).or_default() += 1;
            }
        }
        let mut buckets: Vec<_> = err_histo.into_iter().collect();
        buckets.sort_by_key(|(_, c)| std::cmp::Reverse(*c));
        println!("---- error buckets ----");
        for (e, c) in buckets.iter().take(15) {
            println!("  {c:4}  {e}");
        }
        println!("---- hard failures (first 30) ----");
        let mut shown = 0;
        for r in reports.iter() {
            for e in &r.hard_failures {
                if shown >= 30 { break; }
                println!("  [{}] {e}", r.label);
                shown += 1;
            }
        }
        // BBMD reconnaissance: which local devices hold a broadcast
        // distribution table (i.e., know about other BACnet/IP subnets)?
        println!("---- BBMD probe (Read-BDT) ----");
        let mut local_addrs: Vec<String> = devices
            .iter()
            .filter(|d| d.network.is_none())
            .map(|d| d.address.clone())
            .collect();
        local_addrs.sort();
        local_addrs.dedup();
        for addr in local_addrs {
            match probe_bdt(&addr) {
                Ok(entries) if entries.is_empty() => println!("  {addr}: BBMD with empty BDT"),
                Ok(entries) => {
                    println!("  {addr}: BBMD, {} BDT entries", entries.len());
                    for e in entries.iter().take(8) {
                        println!("      {e}");
                    }
                }
                Err(e) => println!("  {addr}: {e}"),
            }
        }
        println!("========================================================");
    }

    #[test]
    fn routed_request_carries_dnet_dadr() {
        let fake = UdpSocket::bind("127.0.0.1:0").unwrap();
        let fake_addr = fake.local_addr().unwrap();
        let t = thread::spawn(move || {
            let (frame, src) = recv_frame(&fake);
            let bvlc = codec::bvlc_decode(&frame).unwrap();
            let npdu = codec::decode_npdu(&frame[bvlc.payload_offset..]).unwrap();
            assert_eq!(npdu.dest, Some((2001, vec![0x0C])));
            let apdu = &frame[bvlc.payload_offset + npdu.apdu_offset..];
            let Apdu::ConfirmedRequest { invoke_id, .. } = codec::decode_apdu(apdu).unwrap() else {
                panic!("expected confirmed request");
            };
            // Router-style reply with a source specifier.
            let mut payload = vec![0x01, 0x08, 0x07, 0xD1, 0x01, 0x0C];
            payload.extend_from_slice(&[codec::PDU_SIMPLE_ACK, invoke_id, codec::SERVICE_WRITE_PROPERTY]);
            fake.send_to(&codec::bvlc_encode(codec::BVLC_ORIGINAL_UNICAST, &payload), src)
                .unwrap();
        });

        let client = Client::new("127.0.0.1:0").unwrap();
        let target = Target { sa: fake_addr, route: Some((2001, vec![0x0C])) };
        write_property_core(
            &client,
            &target,
            ObjectId::new(2, 1),
            codec::PROP_PRESENT_VALUE,
            None,
            &[BacnetValue::Null],
            Some(8),
        )
        .unwrap();
        t.join().unwrap();
    }
}
