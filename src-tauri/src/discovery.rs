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
    relay_holder: &mut Option<tokio::sync::mpsc::Receiver<(SocketAddr, Vec<u8>)>>,
) -> Result<Vec<ArtNetDiscoveredNode>> {
    let sock = UdpSocket::bind(SocketAddr::new(IpAddr::V4(Ipv4Addr::UNSPECIFIED), 0)).await?;
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
        if let Ok(ArtCommand::PollReply(reply)) = ArtCommand::from_buffer(data) {
            let reply = *reply;
            let key = (reply.address, reply.mac);
            if !dedup.insert(key) {
                return;
            }
            out.push(ArtNetDiscoveredNode {
                udp_source: udp_src.to_string(),
                ip: reply.address.to_string(),
                artnet_port: reply.port,
                short_name: cstr_trim(&reply.short_name),
                long_name: cstr_trim(&reply.long_name),
                node_report: cstr_trim(&reply.node_report),
                net_switch: reply.port_address[0],
                sub_switch: reply.port_address[1],
                firmware: format!("{}.{}", reply.version[1], reply.version[0]),
                oem_hex: format!("{:02x}{:02x}", reply.oem[0], reply.oem[1]),
                esta_code: reply.esta_code,
                mac: format_mac(&reply.mac),
                bind_ip: Ipv4Addr::new(
                    reply.bind_ip[0],
                    reply.bind_ip[1],
                    reply.bind_ip[2],
                    reply.bind_ip[3],
                )
                .to_string(),
                bind_index: reply.bind_index,
                style: reply.style,
                num_ports: reply.num_ports,
                port_types_hex: reply
                    .port_types
                    .iter()
                    .map(|b| format!("{:02x}", b))
                    .collect::<Vec<_>>()
                    .join(" "),
                swin_hex: reply
                    .swin
                    .iter()
                    .map(|b| format!("{:02x}", b))
                    .collect::<Vec<_>>()
                    .join(" "),
                swout_hex: reply
                    .swout
                    .iter()
                    .map(|b| format!("{:02x}", b))
                    .collect::<Vec<_>>()
                    .join(" "),
            });
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
