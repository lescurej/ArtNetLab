use std::{
    collections::{HashMap, HashSet},
    net::{IpAddr, Ipv4Addr, SocketAddr},
    time::{Duration, Instant},
};

use anyhow::{anyhow, Result};
use tokio::net::UdpSocket;

use crate::artnet::SenderConfig;

const ARTNET_ID: &[u8; 8] = b"Art-Net\0";
const OP_TOD_REQUEST: u16 = 0x8000;
const OP_TOD_DATA: u16 = 0x8100;
const OP_TOD_CONTROL: u16 = 0x8200;
const OP_RDM: u16 = 0x8300;
const TOD_ACTION_FLUSH: u8 = 0x01;
const AR_PROCESS: u8 = 0x00;
const AR_POLL: u8 = 0x02;
const PROT_VER: u16 = 14;

const SC_RDM: u8 = 0xCC;
const SC_SUB: u8 = 0x01;

const CC_GET: u8 = 0x20;
const CC_GET_RESPONSE: u8 = 0x21;
const CC_SET: u8 = 0x30;
const CC_DISCOVERY: u8 = 0x10;
const CC_DISCOVERY_RESPONSE: u8 = 0x11;

const PID_DEVICE_INFO: u16 = 0x0060;
const PID_DMX_START_ADDRESS: u16 = 0x00f0;
const PID_IDENTIFY_DEVICE: u16 = 0x1000;
const PID_DISC_UNIQUE_BRANCH: u16 = 0x0001;
const PID_DISC_MUTE: u16 = 0x0002;

const BROADCAST_UID: [u8; 6] = [0xff, 0xff, 0xff, 0xff, 0xff, 0xff];
const CTRL_UID: [u8; 6] = [0x7f, 0xff, 0x00, 0x00, 0x00, 0x01];

#[derive(Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RdmFixture {
    pub uid: String,
    pub model_id: u16,
    pub footprint: u16,
    pub dmx_address: u16,
    pub personality: u16,
    pub sub_device_count: u16,
}

fn subuni(cfg: &SenderConfig) -> u8 {
    ((cfg.subnet & 0x0f) << 4) | (cfg.universe & 0x0f)
}

fn universe_candidates(cfg: &SenderConfig, port_index: u8) -> Vec<u8> {
    let mut out = vec![
        cfg.universe,
        0,
        port_index.saturating_add(1),
        port_index,
    ];
    out.sort();
    out.dedup();
    out
}

fn cfg_with_universe(cfg: &SenderConfig, universe: u8) -> SenderConfig {
    let mut c = cfg.clone();
    c.universe = universe & 0x0f;
    c
}

fn uid_to_string(uid: &[u8; 6]) -> String {
    format!(
        "{:02x}{:02x}:{:02x}{:02x}{:02x}{:02x}",
        uid[0], uid[1], uid[2], uid[3], uid[4], uid[5]
    )
}

fn parse_uid_hex(s: &str) -> Result<[u8; 6]> {
    let t = s.trim().replace(':', "");
    if t.len() != 12 {
        return Err(anyhow!("UID must be 6 bytes hex (XXXX:XXXXXXXX)"));
    }
    let mut out = [0u8; 6];
    for i in 0..6 {
        out[i] = u8::from_str_radix(&t[i * 2..i * 2 + 2], 16)
            .map_err(|_| anyhow!("invalid UID hex"))?;
    }
    Ok(out)
}

fn rdm_checksum(body: &[u8]) -> u16 {
    let sum: u16 = body.iter().map(|&b| b as u16).sum();
    ((!sum).wrapping_add(1)) & 0xffff
}

fn build_rdm_packet(
    dest: &[u8; 6],
    src: &[u8; 6],
    tn: u8,
    rdm_port_id: u8,
    cmd_class: u8,
    pid: u16,
    param: &[u8],
) -> Vec<u8> {
    let pdl = param.len().min(231) as u8;
    let msg_len = 20 + pdl as usize;
    let mut pkt = Vec::with_capacity(3 + msg_len + 2);
    pkt.push(SC_RDM);
    pkt.push(SC_SUB);
    pkt.push(msg_len as u8);
    pkt.extend_from_slice(dest);
    pkt.extend_from_slice(src);
    pkt.push(tn);
    pkt.push(rdm_port_id);
    pkt.push(0);
    pkt.push(0);
    pkt.push(cmd_class);
    pkt.extend_from_slice(&pid.to_be_bytes());
    pkt.push(pdl);
    pkt.extend_from_slice(&param[..pdl as usize]);
    let cs = rdm_checksum(&pkt);
    pkt.extend_from_slice(&cs.to_be_bytes());
    pkt
}

fn encode_art_tod_control(cfg: &SenderConfig, port_index: u8) -> Vec<u8> {
    let mut pkt = vec![0u8; 24];
    pkt[..8].copy_from_slice(ARTNET_ID);
    pkt[8..10].copy_from_slice(&OP_TOD_CONTROL.to_le_bytes());
    pkt[10..12].copy_from_slice(&PROT_VER.to_be_bytes());
    pkt[12] = 0;
    pkt[13] = port_index.min(3);
    pkt[20] = cfg.net & 0x7f;
    pkt[21] = subuni(cfg);
    pkt[22] = TOD_ACTION_FLUSH;
    pkt
}

fn encode_art_tod_request(cfg: &SenderConfig, port_index: u8) -> Vec<u8> {
    let mut pkt = vec![0u8; 28];
    pkt[..8].copy_from_slice(ARTNET_ID);
    pkt[8..10].copy_from_slice(&OP_TOD_REQUEST.to_le_bytes());
    pkt[10..12].copy_from_slice(&PROT_VER.to_be_bytes());
    pkt[12] = 0;
    pkt[13] = port_index.min(3);
    pkt[20] = cfg.net & 0x7f;
    pkt[21] = 0;
    pkt[22] = subuni(cfg);
    pkt[27] = 0;
    pkt
}

fn bind_index(port_index: u8) -> u8 {
    port_index.min(3).saturating_add(1)
}

fn rdm_address_candidates(cfg: &SenderConfig, port_index: u8) -> Vec<u8> {
    let bind = bind_index(port_index);
    let pi = port_index.min(3);
    let mut out = vec![bind, subuni(cfg), pi, pi.saturating_add(1)];
    out.sort();
    out.dedup();
    out
}

fn tod_port_candidates(port_index: u8) -> [u8; 2] {
    [port_index.min(3), bind_index(port_index)]
}

fn encode_art_rdm_cmd(
    cfg: &SenderConfig,
    command: u8,
    address: u8,
    rdm: &[u8],
) -> Vec<u8> {
    let mut pkt = Vec::with_capacity(24 + rdm.len());
    pkt.extend_from_slice(ARTNET_ID);
    pkt.extend_from_slice(&OP_RDM.to_le_bytes());
    pkt.extend_from_slice(&PROT_VER.to_be_bytes());
    pkt.push(1);
    pkt.push(0);
    pkt.extend_from_slice(&[0u8; 7]);
    pkt.push(cfg.net & 0x7f);
    pkt.push(command);
    pkt.push(address);
    pkt.extend_from_slice(rdm);
    pkt
}

fn extract_tod_uids(buf: &[u8], uid_count_offset: usize) -> Option<Vec<[u8; 6]>> {
    if buf.len() <= uid_count_offset {
        return None;
    }
    let count = buf[uid_count_offset] as usize;
    if count > 32 {
        return None;
    }
    let uid_start = uid_count_offset + 1;
    let need = uid_start + count * 6;
    if buf.len() < need {
        return None;
    }
    let mut uids = Vec::with_capacity(count);
    for i in 0..count {
        let off = uid_start + i * 6;
        let mut uid = [0u8; 6];
        uid.copy_from_slice(&buf[off..off + 6]);
        if uid != BROADCAST_UID {
            uids.push(uid);
        }
    }
    Some(uids)
}

fn parse_tod_data(
    buf: &[u8],
    expect_subuni: u8,
    expect_net: u8,
    port_index: u8,
) -> Option<Vec<[u8; 6]>> {
    if buf.len() < 28 || &buf[..8] != ARTNET_ID {
        return None;
    }
    if u16::from_le_bytes([buf[8], buf[9]]) != OP_TOD_DATA {
        return None;
    }
    let _ = port_index;
    if buf[20] == expect_net && buf[21] == expect_subuni {
        if let Some(u) = extract_tod_uids(buf, 28) {
            return Some(u);
        }
    }
    if buf[20] == expect_net && buf.len() >= 28 && buf[22] == expect_subuni {
        if let Some(u) = extract_tod_uids(buf, 27) {
            return Some(u);
        }
    }
    extract_tod_uids(buf, 28).or_else(|| extract_tod_uids(buf, 27))
}

#[derive(Clone)]
struct ParsedRdm {
    src_uid: [u8; 6],
    cmd_class: u8,
    pid: u16,
    param: Vec<u8>,
}

fn parse_rdm_in_art(buf: &[u8]) -> Option<ParsedRdm> {
    if buf.len() < 26 || &buf[..8] != ARTNET_ID {
        return None;
    }
    let op = u16::from_le_bytes([buf[8], buf[9]]);
    if op != OP_RDM {
        return None;
    }
    for start in 12..buf.len().saturating_sub(26) {
        if buf[start] == SC_RDM && buf.get(start + 1) == Some(&SC_SUB) {
            if let Some(p) = parse_rdm_message(&buf[start..]) {
                return Some(p);
            }
        }
    }
    parse_rdm_message(&buf[24..])
}

fn parse_rdm_message(rdm: &[u8]) -> Option<ParsedRdm> {
    if rdm.len() < 26 || rdm[0] != SC_RDM || rdm[1] != SC_SUB {
        return None;
    }
    let msg_len = rdm[2] as usize;
    if rdm.len() < 3 + msg_len + 2 {
        return None;
    }
    let mut src = [0u8; 6];
    src.copy_from_slice(&rdm[9..15]);
    Some(ParsedRdm {
        src_uid: src,
        cmd_class: rdm[19],
        pid: u16::from_be_bytes([rdm[20], rdm[21]]),
        param: rdm[23..23 + rdm[22] as usize].to_vec(),
    })
}

fn parse_device_info(param: &[u8]) -> Option<(u16, u16, u16, u16, u16)> {
    if param.len() < 19 {
        return None;
    }
    let model_id = u16::from_be_bytes([param[2], param[3]]);
    let footprint = u16::from_be_bytes([param[10], param[11]]);
    let personality = u16::from_be_bytes([param[12], param[13]]);
    let dmx_address = u16::from_be_bytes([param[14], param[15]]);
    let sub_device_count = u16::from_be_bytes([param[16], param[17]]);
    Some((
        model_id,
        footprint,
        personality,
        dmx_address,
        sub_device_count,
    ))
}

enum RelayCombo {
    Udp(std::io::Result<(usize, SocketAddr)>),
    Relay((), Vec<u8>),
    RelayClosed,
}

async fn recv_combo(
    sock: &UdpSocket,
    buf: &mut [u8],
    relay: &mut Option<tokio::sync::mpsc::UnboundedReceiver<(SocketAddr, Vec<u8>)>>,
) -> RelayCombo {
    if let Some(rx) = relay.as_mut() {
        tokio::select! {
            r = sock.recv_from(buf) => RelayCombo::Udp(r),
            opt = rx.recv() => match opt {
                Some((_, v)) => RelayCombo::Relay((), v),
                None => RelayCombo::RelayClosed,
            },
        }
    } else {
        RelayCombo::Udp(sock.recv_from(buf).await)
    }
}

async fn send_tod_flush(
    sock: &UdpSocket,
    target: SocketAddr,
    cfg: &SenderConfig,
    port_index: u8,
) -> Result<()> {
    let pkt = encode_art_tod_control(cfg, port_index);
    sock.send_to(&pkt, target).await?;
    Ok(())
}

fn rdm_port_id(port_index: u8) -> u8 {
    port_index.saturating_add(1).max(1)
}

async fn send_art_rdm_cmd(
    sock: &UdpSocket,
    target: SocketAddr,
    cfg: &SenderConfig,
    command: u8,
    address: u8,
    rdm: &[u8],
) -> Result<()> {
    let pkt = encode_art_rdm_cmd(cfg, command, address, rdm);
    sock.send_to(&pkt, target).await?;
    Ok(())
}

fn rdm_response_matches(p: &ParsedRdm, dest: &[u8; 6], broadcast: bool) -> bool {
    if broadcast {
        return p.src_uid != BROADCAST_UID && p.src_uid != CTRL_UID;
    }
    p.src_uid == *dest
}

async fn drain_rdm_responses(
    sock: &UdpSocket,
    target: SocketAddr,
    cfg: &SenderConfig,
    address: u8,
    relay: &mut Option<tokio::sync::mpsc::UnboundedReceiver<(SocketAddr, Vec<u8>)>>,
    until: Instant,
    dest: &[u8; 6],
    broadcast: bool,
) -> Option<ParsedRdm> {
    let mut buf = [0u8; 1200];
    while Instant::now() < until {
        let _ = send_art_rdm_cmd(sock, target, cfg, AR_POLL, address, &[]).await;
        let remaining = until.saturating_duration_since(Instant::now());
        let slice = Duration::from_millis(50)
            .min(remaining)
            .max(Duration::from_millis(1));
        match tokio::time::timeout(slice, recv_combo(sock, buf.as_mut(), relay)).await {
            Ok(RelayCombo::Udp(Ok((n, _)))) => {
                if let Some(p) = parse_rdm_in_art(&buf[..n]) {
                    if rdm_response_matches(&p, dest, broadcast) {
                        return Some(p);
                    }
                }
            }
            Ok(RelayCombo::Relay(_, pkt)) => {
                if let Some(p) = parse_rdm_in_art(&pkt) {
                    if rdm_response_matches(&p, dest, broadcast) {
                        return Some(p);
                    }
                }
            }
            _ => {}
        }
    }
    None
}

async fn rdm_transaction(
    sock: &UdpSocket,
    target: SocketAddr,
    cfg: &SenderConfig,
    port_index: u8,
    dest: &[u8; 6],
    tn: u8,
    cmd_class: u8,
    pid: u16,
    param: &[u8],
    relay: &mut Option<tokio::sync::mpsc::UnboundedReceiver<(SocketAddr, Vec<u8>)>>,
    timeout: Duration,
) -> Result<Option<ParsedRdm>> {
    let rdm = build_rdm_packet(
        dest,
        &CTRL_UID,
        tn,
        rdm_port_id(port_index),
        cmd_class,
        pid,
        param,
    );
    let deadline = Instant::now() + timeout;
    let broadcast = dest == &BROADCAST_UID;
    for address in rdm_address_candidates(cfg, port_index) {
        if Instant::now() >= deadline {
            break;
        }
        send_art_rdm_cmd(sock, target, cfg, AR_PROCESS, address, &rdm).await?;
        tokio::time::sleep(Duration::from_millis(30)).await;
        if let Some(p) = drain_rdm_responses(
            sock,
            target,
            cfg,
            address,
            relay,
            deadline,
            dest,
            broadcast,
        )
        .await
        {
            return Ok(Some(p));
        }
    }
    Ok(None)
}

async fn collect_tod_uids(
    sock: &UdpSocket,
    target: SocketAddr,
    cfg: &SenderConfig,
    port_index: u8,
    relay: &mut Option<tokio::sync::mpsc::UnboundedReceiver<(SocketAddr, Vec<u8>)>>,
    deadline: Instant,
) -> Vec<[u8; 6]> {
    let expect_net = cfg.net & 0x7f;
    let expect_sub = subuni(cfg);
    let mut uids = Vec::new();
    let mut seen = HashSet::new();
    let mut buf = [0u8; 1200];
    let _ = send_tod_flush(sock, target, cfg, port_index).await;
    tokio::time::sleep(Duration::from_millis(80)).await;
    while Instant::now() < deadline {
        for tod_port in tod_port_candidates(port_index) {
            let req = encode_art_tod_request(cfg, tod_port);
            sock.send_to(&req, target).await.ok();
        }
        let slice_deadline = (Instant::now() + Duration::from_millis(500)).min(deadline);
        while Instant::now() < slice_deadline {
            let remaining = slice_deadline.saturating_duration_since(Instant::now());
            let slice = Duration::from_millis(80)
                .min(remaining)
                .max(Duration::from_millis(1));
            match tokio::time::timeout(slice, recv_combo(sock, &mut buf, relay)).await {
                Ok(RelayCombo::Udp(Ok((n, _)))) => {
                    if let Some(list) =
                        parse_tod_data(&buf[..n], expect_sub, expect_net, port_index)
                    {
                        for u in list {
                            if seen.insert(u) {
                                uids.push(u);
                            }
                        }
                    }
                }
                Ok(RelayCombo::Relay(_, pkt)) => {
                    if let Some(list) = parse_tod_data(&pkt, expect_sub, expect_net, port_index)
                    {
                        for u in list {
                            if seen.insert(u) {
                                uids.push(u);
                            }
                        }
                    }
                }
                _ => {}
            }
        }
        if !uids.is_empty() {
            break;
        }
    }
    uids
}

async fn discover_branch_uids(
    sock: &UdpSocket,
    target: SocketAddr,
    cfg: &SenderConfig,
    port_index: u8,
    relay: &mut Option<tokio::sync::mpsc::UnboundedReceiver<(SocketAddr, Vec<u8>)>>,
    deadline: Instant,
    tn_start: &mut u8,
) -> Vec<[u8; 6]> {
    let mut found = Vec::new();
    let mut seen = HashSet::new();
    let mut buf = [0u8; 1200];
    for _ in 0..64 {
        if Instant::now() >= deadline {
            break;
        }
        let before = seen.len();
        *tn_start = tn_start.wrapping_add(1);
        let tn = *tn_start;
        let branch = build_rdm_packet(
            &BROADCAST_UID,
            &CTRL_UID,
            tn,
            rdm_port_id(port_index),
            CC_DISCOVERY,
            PID_DISC_UNIQUE_BRANCH,
            &[],
        );
        let mut round_new = Vec::new();
        for address in rdm_address_candidates(cfg, port_index) {
            send_art_rdm_cmd(sock, target, cfg, AR_PROCESS, address, &branch).await.ok();
            tokio::time::sleep(Duration::from_millis(25)).await;
            let slice_end = (Instant::now() + Duration::from_millis(350)).min(deadline);
            while Instant::now() < slice_end {
                let _ = send_art_rdm_cmd(sock, target, cfg, AR_POLL, address, &[]).await;
                let remaining = slice_end.saturating_duration_since(Instant::now());
                let slice = Duration::from_millis(45)
                    .min(remaining)
                    .max(Duration::from_millis(1));
                match tokio::time::timeout(slice, recv_combo(sock, &mut buf, relay)).await {
                    Ok(RelayCombo::Udp(Ok((n, _)))) => {
                        ingest_discovery(&buf[..n], &mut seen, &mut round_new);
                    }
                    Ok(RelayCombo::Relay(_, pkt)) => {
                        ingest_discovery(&pkt, &mut seen, &mut round_new);
                    }
                    _ => {}
                }
            }
            if !round_new.is_empty() {
                break;
            }
        }
        for uid in &round_new {
            found.push(*uid);
            *tn_start = tn_start.wrapping_add(1);
            let mute_tn = *tn_start;
            let _ = rdm_transaction(
                sock,
                target,
                cfg,
                port_index,
                uid,
                mute_tn,
                CC_DISCOVERY,
                PID_DISC_MUTE,
                &[],
                relay,
                Duration::from_millis(250),
            )
            .await;
        }
        if seen.len() == before {
            break;
        }
    }
    found
}

fn ingest_discovery_parsed(
    p: &ParsedRdm,
    seen: &mut HashSet<[u8; 6]>,
    out: &mut Vec<[u8; 6]>,
) {
    if p.src_uid == BROADCAST_UID || p.src_uid == CTRL_UID {
        return;
    }
    if seen.insert(p.src_uid) {
        out.push(p.src_uid);
    }
}

fn ingest_discovery(data: &[u8], seen: &mut HashSet<[u8; 6]>, out: &mut Vec<[u8; 6]>) {
    if let Some(p) = parse_rdm_in_art(data).or_else(|| parse_rdm_message(data)) {
        if p.cmd_class == CC_DISCOVERY_RESPONSE || p.pid == PID_DISC_MUTE {
            ingest_discovery_parsed(&p, seen, out);
        }
    }
    if data.len() >= 8 && &data[..8] == ARTNET_ID {
        if u16::from_le_bytes([data[8], data[9]]) == OP_TOD_DATA {
            if let Some(list) = extract_tod_uids(data, 28).or_else(|| extract_tod_uids(data, 27))
            {
                for u in list {
                    if seen.insert(u) {
                        out.push(u);
                    }
                }
            }
        }
    }
}

pub async fn scan_fixtures(
    cfg: &SenderConfig,
    port_index: u8,
    timeout_ms: u64,
    relay: &mut Option<tokio::sync::mpsc::UnboundedReceiver<(SocketAddr, Vec<u8>)>>,
) -> Result<Vec<RdmFixture>> {
    let target: SocketAddr = format!("{}:{}", cfg.target_ip.trim(), cfg.port.max(1))
        .parse()
        .map_err(|_| anyhow!("invalid target IP"))?;
    if matches!(target.ip(), IpAddr::V4(v4) if v4 == Ipv4Addr::UNSPECIFIED) {
        return Err(anyhow!("set a valid Art-Net node IP in Sender settings"));
    }
    if matches!(
        target.ip(),
        IpAddr::V4(v4) if v4.is_broadcast() || v4 == Ipv4Addr::BROADCAST
    ) {
        return Err(anyhow!(
            "RDM requires a unicast Art-Net node IP in Sender settings, not broadcast"
        ));
    }

    let peer_ip = match target.ip() {
        IpAddr::V4(v4) => v4,
        _ => Ipv4Addr::UNSPECIFIED,
    };
    let bind_ip = crate::discovery::local_ipv4_for_peer(peer_ip).unwrap_or(Ipv4Addr::UNSPECIFIED);
    let sock = UdpSocket::bind(SocketAddr::new(IpAddr::V4(bind_ip), 0)).await?;
    sock.set_broadcast(true)?;

    let deadline = Instant::now() + Duration::from_millis(timeout_ms.max(1500).min(30000));
    let primary = port_index.min(3);
    let mut ports: Vec<u8> = vec![primary];
    for p in 0..4u8 {
        if p != primary {
            ports.push(p);
        }
    }

    let mut uids = Vec::new();
    let mut seen_uid = HashSet::new();
    let mut tn: u8 = 1;

    for pi in ports {
        if Instant::now() >= deadline {
            break;
        }
        let slice_end = (Instant::now() + Duration::from_millis(1400)).min(deadline);
        let port_deadline = slice_end;
        let mut port_uids = Vec::new();
        for uni in universe_candidates(cfg, pi) {
            if Instant::now() >= port_deadline {
                break;
            }
            let cfg_u = cfg_with_universe(cfg, uni);
            let mut found =
                collect_tod_uids(&sock, target, &cfg_u, pi, relay, port_deadline).await;
            if found.is_empty() {
                found = discover_branch_uids(
                    &sock,
                    target,
                    &cfg_u,
                    pi,
                    relay,
                    port_deadline,
                    &mut tn,
                )
                .await;
            }
            for u in found {
                if seen_uid.insert(u) {
                    port_uids.push(u);
                }
            }
            if !port_uids.is_empty() {
                break;
            }
        }
        uids.extend(port_uids);
        if !uids.is_empty() && pi == primary {
            break;
        }
    }

    let mut fixtures = Vec::new();
    let mut by_uid: HashMap<[u8; 6], RdmFixture> = HashMap::new();

    for uid in uids {
        if Instant::now() >= deadline {
            break;
        }
        tn = tn.wrapping_add(1);
        let resp = rdm_transaction(
            &sock,
            target,
            cfg,
            port_index,
            &uid,
            tn,
            CC_GET,
            PID_DEVICE_INFO,
            &[],
            relay,
            Duration::from_millis(600),
        )
        .await?;
        let Some(resp) = resp else { continue };
        if resp.cmd_class != CC_GET_RESPONSE || resp.pid != PID_DEVICE_INFO {
            continue;
        }
        let Some((model_id, footprint, personality, dmx_address, sub_device_count)) =
            parse_device_info(&resp.param)
        else {
            continue;
        };
        let fx = RdmFixture {
            uid: uid_to_string(&uid),
            model_id,
            footprint,
            dmx_address,
            personality,
            sub_device_count,
        };
        by_uid.insert(uid, fx);
    }

    fixtures.extend(by_uid.into_values());
    fixtures.sort_by(|a, b| a.uid.cmp(&b.uid));
    Ok(fixtures)
}

pub async fn set_dmx_address(
    cfg: &SenderConfig,
    port_index: u8,
    uid_hex: &str,
    address: u16,
    relay: &mut Option<tokio::sync::mpsc::UnboundedReceiver<(SocketAddr, Vec<u8>)>>,
) -> Result<u16> {
    if !(1..=512).contains(&address) {
        return Err(anyhow!("DMX address must be 1–512"));
    }
    let uid = parse_uid_hex(uid_hex)?;
    let target: SocketAddr = format!("{}:{}", cfg.target_ip.trim(), cfg.port.max(1))
        .parse()
        .map_err(|_| anyhow!("invalid target IP"))?;
    let sock = UdpSocket::bind(SocketAddr::new(
        IpAddr::V4(Ipv4Addr::UNSPECIFIED),
        0,
    ))
    .await?;
    let param = address.to_be_bytes();
    let resp = rdm_transaction(
        &sock,
        target,
        cfg,
        port_index,
        &uid,
        40,
        CC_SET,
        PID_DMX_START_ADDRESS,
        &param,
        relay,
        Duration::from_millis(800),
    )
    .await?;
    if resp.is_some() {
        return Ok(address);
    }
    Ok(address)
}

pub async fn set_identify(
    cfg: &SenderConfig,
    port_index: u8,
    uid_hex: &str,
    on: bool,
    relay: &mut Option<tokio::sync::mpsc::UnboundedReceiver<(SocketAddr, Vec<u8>)>>,
) -> Result<()> {
    let uid = parse_uid_hex(uid_hex)?;
    let target: SocketAddr = format!("{}:{}", cfg.target_ip.trim(), cfg.port.max(1))
        .parse()
        .map_err(|_| anyhow!("invalid target IP"))?;
    let sock = UdpSocket::bind(SocketAddr::new(
        IpAddr::V4(Ipv4Addr::UNSPECIFIED),
        0,
    ))
    .await?;
    let param = [if on { 1u8 } else { 0 }];
    let _ = rdm_transaction(
        &sock,
        target,
        cfg,
        port_index,
        &uid,
        41,
        CC_SET,
        PID_IDENTIFY_DEVICE,
        &param,
        relay,
        Duration::from_millis(800),
    )
    .await?;
    Ok(())
}
