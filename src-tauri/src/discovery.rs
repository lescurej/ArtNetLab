use std::{
    collections::HashSet,
    net::{IpAddr, Ipv4Addr, SocketAddr},
    time::{Duration, Instant},
};

use anyhow::{anyhow, Result};
use artnet_protocol::{ArtCommand, Poll};
use tokio::net::UdpSocket;

#[derive(Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtNetDiscoveredNode {
    pub udp_source: String,
    pub ip: String,
    pub artnet_port: u16,
    pub short_name: String,
    pub long_name: String,
    pub node_report: String,
    pub net_switch: u8,
    pub sub_switch: u8,
    pub firmware: String,
    pub oem_hex: String,
    pub esta_code: u16,
    pub mac: String,
    pub bind_ip: String,
    pub bind_index: u8,
    pub style: u8,
    pub num_ports: [u8; 2],
    pub port_types_hex: String,
    pub swin_hex: String,
    pub swout_hex: String,
}

fn cstr_trim(bytes: &[u8]) -> String {
    let end = bytes.iter().position(|&b| b == 0).unwrap_or(bytes.len());
    String::from_utf8_lossy(&bytes[..end]).trim().to_string()
}

fn format_mac(m: &[u8; 6]) -> String {
    m.iter()
        .map(|b| format!("{:02x}", b))
        .collect::<Vec<_>>()
        .join(":")
}

pub fn subnet_broadcast_addrs() -> Vec<String> {
    let mut addrs = Vec::new();
    if let Ok(ifaces) = if_addrs::get_if_addrs() {
        for iface in ifaces {
            if iface.is_loopback() {
                continue;
            }
            if let if_addrs::IfAddr::V4(v4) = iface.addr {
                let broadcast = match v4.broadcast {
                    Some(b) => b,
                    None => ipv4_broadcast_from_netmask(v4.ip, v4.netmask),
                };
                let o = broadcast.octets();
                if o[0] == 127 {
                    continue;
                }
                addrs.push(broadcast.to_string());
            }
        }
    }
    addrs.sort();
    addrs.dedup();
    addrs
}

fn ipv4_broadcast_from_netmask(ip: Ipv4Addr, mask: Ipv4Addr) -> Ipv4Addr {
    if mask.is_broadcast() || mask.is_unspecified() {
        return Ipv4Addr::BROADCAST;
    }
    Ipv4Addr::from(u32::from(ip) | !u32::from(mask))
}

fn same_subnet(local: Ipv4Addr, mask: Ipv4Addr, peer: Ipv4Addr) -> bool {
    if mask.is_unspecified() {
        return false;
    }
    (u32::from(local) & u32::from(mask)) == (u32::from(peer) & u32::from(mask))
}

pub fn local_ipv4_for_peer(peer: Ipv4Addr) -> Option<Ipv4Addr> {
    if peer.is_unspecified() || peer.is_broadcast() {
        return None;
    }
    let mut best: Option<(Ipv4Addr, Ipv4Addr)> = None;
    if let Ok(ifaces) = if_addrs::get_if_addrs() {
        for iface in ifaces {
            if iface.is_loopback() {
                continue;
            }
            if let if_addrs::IfAddr::V4(v4) = iface.addr {
                if same_subnet(v4.ip, v4.netmask, peer) {
                    best = Some((v4.ip, v4.netmask));
                    break;
                }
            }
        }
    }
    best.map(|(ip, _)| ip)
}

fn pick_local_bind_ip(targets: &[String]) -> Ipv4Addr {
    for host in targets {
        let t = host.trim();
        if t.is_empty() {
            continue;
        }
        if let Ok(ip) = t.parse::<Ipv4Addr>() {
            if ip.is_unspecified() || ip.is_broadcast() {
                continue;
            }
            if let Some(local) = local_ipv4_for_peer(ip) {
                return local;
            }
        }
    }
    Ipv4Addr::UNSPECIFIED
}

fn embedded_ip_valid(ip: Ipv4Addr) -> bool {
    let o = ip.octets();
    !ip.is_unspecified()
        && !ip.is_broadcast()
        && o[0] != 0
        && !(o[0] == 0 && o[1] <= 20)
}

fn resolve_node_ip(embedded: Ipv4Addr, udp_src: SocketAddr) -> Ipv4Addr {
    if embedded_ip_valid(embedded) {
        return embedded;
    }
    if let IpAddr::V4(v4) = udp_src.ip() {
        if !v4.is_unspecified() && !v4.is_broadcast() {
            return v4;
        }
    }
    embedded
}

fn try_parse_poll_reply_at(
    data: &[u8],
    ip_off: usize,
    udp_src: SocketAddr,
) -> Option<ArtNetDiscoveredNode> {
    if data.len() < ip_off + 164 {
        return None;
    }
    let embedded = Ipv4Addr::new(
        data[ip_off],
        data[ip_off + 1],
        data[ip_off + 2],
        data[ip_off + 3],
    );
    let port = u16::from_be_bytes([data[ip_off + 4], data[ip_off + 5]]);
    let version = [data[ip_off + 6], data[ip_off + 7]];
    let net_switch = data[ip_off + 8];
    let sub_switch = data[ip_off + 9];
    let oem = [data[ip_off + 10], data[ip_off + 11]];
    let esta_code = u16::from_le_bytes([data[ip_off + 14], data[ip_off + 15]]);
    let short_name = cstr_trim(&data[ip_off + 16..ip_off + 34]);
    let long_name = cstr_trim(&data[ip_off + 34..ip_off + 98]);
    let node_report = cstr_trim(&data[ip_off + 98..ip_off + 162]);
    let num_ports = [data[ip_off + 162], data[ip_off + 163]];
    let style = data.get(ip_off + 190).copied().unwrap_or(0);
    let mut mac = [0u8; 6];
    if data.len() >= ip_off + 197 {
        mac.copy_from_slice(&data[ip_off + 191..ip_off + 197]);
    }
    let bind_ip = if data.len() >= ip_off + 201 {
        Ipv4Addr::new(
            data[ip_off + 197],
            data[ip_off + 198],
            data[ip_off + 199],
            data[ip_off + 200],
        )
    } else {
        Ipv4Addr::UNSPECIFIED
    };
    let bind_index = data.get(ip_off + 201).copied().unwrap_or(0);
    let ip = resolve_node_ip(embedded, udp_src);
    Some(ArtNetDiscoveredNode {
        udp_source: udp_src.to_string(),
        ip: ip.to_string(),
        artnet_port: port,
        short_name,
        long_name,
        node_report,
        net_switch,
        sub_switch,
        firmware: format!("{}.{}", version[1], version[0]),
        oem_hex: format!("{:02x}{:02x}", oem[0], oem[1]),
        esta_code,
        mac: format_mac(&mac),
        bind_ip: bind_ip.to_string(),
        bind_index,
        style,
        num_ports,
        port_types_hex: String::new(),
        swin_hex: String::new(),
        swout_hex: String::new(),
    })
}

fn parse_poll_reply_score(node: &ArtNetDiscoveredNode) -> i32 {
    let mut score = 0;
    if node.artnet_port == 6454 {
        score += 40;
    }
    if !node.short_name.is_empty() && node.short_name.len() <= 17 {
        score += 15;
    }
    if !node.long_name.is_empty() && node.long_name.len() <= 63 {
        score += 15;
    }
    if node.long_name.chars().all(|c| c.is_ascii() && (c.is_ascii_graphic() || c == ' ')) {
        score += 20;
    }
    if node.ip.parse::<Ipv4Addr>().ok().is_some_and(embedded_ip_valid) {
        score += 10;
    }
    score
}

fn parse_poll_reply(data: &[u8], udp_src: SocketAddr) -> Option<ArtNetDiscoveredNode> {
    if data.len() < 176 || &data[..8] != b"Art-Net\0" {
        return None;
    }
    if u16::from_le_bytes([data[8], data[9]]) != 0x2100 {
        return None;
    }
    let mut best: Option<ArtNetDiscoveredNode> = None;
    let mut best_score = i32::MIN;
    for ip_off in [12usize, 14] {
        if let Some(node) = try_parse_poll_reply_at(data, ip_off, udp_src) {
            let score = parse_poll_reply_score(&node);
            if score > best_score {
                best_score = score;
                best = Some(node);
            }
        }
    }
    best
}

fn push_node(
    node: ArtNetDiscoveredNode,
    udp_src: SocketAddr,
    dedup: &mut HashSet<(Ipv4Addr, [u8; 6])>,
    out: &mut Vec<ArtNetDiscoveredNode>,
) {
    let ip: Ipv4Addr = node.ip.parse().unwrap_or(Ipv4Addr::UNSPECIFIED);
    let mut mac = [0u8; 6];
    for (i, part) in node.mac.split(':').take(6).enumerate() {
        if let Ok(b) = u8::from_str_radix(part, 16) {
            mac[i] = b;
        }
    }
    let key = (ip, mac);
    if !dedup.insert(key) {
        return;
    }
    let mut row = node;
    row.udp_source = udp_src.to_string();
    out.push(row);
}

async fn send_poll_all(
    sock: &UdpSocket,
    broadcast_hosts: &[String],
    port: u16,
    poll_buf: &[u8],
) -> Result<()> {
    for host in broadcast_hosts {
        let host_trim = host.trim();
        if host_trim.is_empty() {
            continue;
        }
        let addr: SocketAddr = format!("{}:{}", host_trim, port)
            .parse()
            .map_err(|_| anyhow!("invalid broadcast address: {}", host_trim))?;
        sock.send_to(poll_buf, addr).await?;
    }
    Ok(())
}

pub async fn scan_artnet(
    broadcast_hosts: &[String],
    port: u16,
    timeout_ms: u64,
    relay_holder: &mut Option<tokio::sync::mpsc::UnboundedReceiver<(SocketAddr, Vec<u8>)>>,
) -> Result<Vec<ArtNetDiscoveredNode>> {
    let local_ip = pick_local_bind_ip(broadcast_hosts);
    let bind_addr = SocketAddr::new(IpAddr::V4(local_ip), 0);
    let sock = UdpSocket::bind(bind_addr).await?;
    sock.set_broadcast(true)?;

    let poll_buf = ArtCommand::Poll(Poll::default()).write_to_buffer()?;

    if let Err(ref e) = send_poll_all(&sock, broadcast_hosts, port, &poll_buf).await {
        return Err(anyhow!("{}", e));
    }
    tokio::time::sleep(Duration::from_millis(120)).await;
    if let Err(ref e) = send_poll_all(&sock, broadcast_hosts, port, &poll_buf).await {
        return Err(anyhow!("{}", e));
    }

    enum Combo {
        Udp(std::io::Result<(usize, SocketAddr)>),
        Relay(SocketAddr, Vec<u8>),
        RelayClosed,
    }

    let deadline = Instant::now() + Duration::from_millis(timeout_ms.max(500));
    let mut buf = [0u8; 2048];
    let mut dedup = HashSet::new();
    let mut out = Vec::new();
    let mut last_poll = Instant::now();

    let ingest_packet = |data: &[u8],
                         udp_src: SocketAddr,
                         dedup: &mut HashSet<(Ipv4Addr, [u8; 6])>,
                         out: &mut Vec<ArtNetDiscoveredNode>| {
        if let Some(node) = parse_poll_reply(data, udp_src) {
            push_node(node, udp_src, dedup, out);
        }
    };

    while Instant::now() < deadline {
        if last_poll.elapsed() >= Duration::from_millis(450) {
            let _ = send_poll_all(&sock, broadcast_hosts, port, &poll_buf).await;
            last_poll = Instant::now();
        }

        let remaining = deadline.saturating_duration_since(Instant::now());
        let slice = Duration::from_millis(200)
            .min(remaining)
            .max(Duration::from_millis(1));

        let combo = async {
            if let Some(rx) = relay_holder.as_mut() {
                tokio::select! {
                    r = sock.recv_from(&mut buf) => Combo::Udp(r),
                    opt = rx.recv() => match opt {
                        Some((relay_src, v)) => Combo::Relay(relay_src, v),
                        None => Combo::RelayClosed,
                    },
                }
            } else {
                Combo::Udp(sock.recv_from(&mut buf).await)
            }
        };

        match tokio::time::timeout(slice, combo).await {
            Ok(Combo::Udp(Ok((n, udp_src)))) => {
                ingest_packet(&buf[..n], udp_src, &mut dedup, &mut out);
            }
            Ok(Combo::Udp(Err(_))) => continue,
            Ok(Combo::Relay(src, pkt)) => {
                ingest_packet(&pkt, src, &mut dedup, &mut out);
            }
            Ok(Combo::RelayClosed) => {}
            Err(_) => {}
        }
    }

    Ok(out)
}
