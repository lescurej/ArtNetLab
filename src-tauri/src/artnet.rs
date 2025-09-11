use std::net::{IpAddr, Ipv4Addr, SocketAddr};
#[cfg(unix)]
use std::os::unix::io::AsRawFd;

use anyhow::{anyhow, Result};
use tokio::net::UdpSocket;

pub const ARTNET_PORT: u16 = 6454;
const ARTNET_ID: &[u8; 8] = b"Art-Net\0"; // Zero-terminated string
const OP_OUTPUT: u16 = 0x5000; // ArtDMX
const PROT_VER: u16 = 14; // As per spec

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ReceiverConfig {
    pub bind_ip: String, // e.g., "0.0.0.0"
    pub port: u16,       // usually 6454
}

impl Default for ReceiverConfig {
    fn default() -> Self {
        Self {
            bind_ip: "0.0.0.0".into(),
            port: ARTNET_PORT,
        }
    }
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct SenderConfig {
    pub target_ip: String, // e.g., broadcast 255.255.255.255
    pub port: u16,         // usually 6454
    pub net: u8,           // 0..=127
    pub subnet: u8,        // 0..=15
    pub universe: u8,      // 0..=15
    pub fps: u32,          // sending frequency
}

impl Default for SenderConfig {
    fn default() -> Self {
        Self {
            target_ip: "255.255.255.255".into(),
            port: ARTNET_PORT,
            net: 0,
            subnet: 0,
            universe: 0,
            fps: 44,
        }
    }
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct DmxFrame {
    pub net: u8,
    pub subnet: u8,
    pub universe: u8,
    pub length: u16,
    pub sequence: u8,
    pub physical: u8,
    pub values: Vec<u8>, // length elements
}

fn compute_dmx_length(data: &[u8; 512]) -> u16 {
    // Per Art-Net specification: DMX length is 2..=512 bytes and should be even.
    // We trim trailing zeros to reduce packet size while staying compliant.
    // However, if all values are 0, we send a full 512-byte frame for "All 0" functionality.
    let mut last = 0usize;
    for (i, v) in data.iter().enumerate() {
        if *v != 0 {
            last = i + 1;
        }
    }
    let mut len = if last == 0 {
        512
    } else if last < 2 {
        2
    } else {
        last as u16
    };
    if len % 2 == 1 {
        len += 1;
    } // ensure even length
    if len > 512 {
        512
    } else {
        len
    }
}

pub fn encode_artdmx(cfg: &SenderConfig, data: &[u8; 512], sequence: u8) -> Vec<u8> {
    let length = compute_dmx_length(data);
    let mut pkt = Vec::with_capacity(18 + length as usize);
    pkt.extend_from_slice(ARTNET_ID);
    pkt.extend_from_slice(&OP_OUTPUT.to_le_bytes());
    pkt.extend_from_slice(&PROT_VER.to_be_bytes());
    pkt.push(sequence); // Sequence
    pkt.push(0); // Physical port (not used)
    let sub = cfg.subnet & 0x0f;
    let uni = cfg.universe & 0x0f;
    let subuni = (sub << 4) | uni; // SubUni: hi-nibble SubNet, lo-nibble Universe
    pkt.push(subuni); // SubUni (lo)
    pkt.push(cfg.net & 0x7f); // Net (hi)
    pkt.extend_from_slice(&length.to_be_bytes()); // Length hi, lo (big-endian)
    pkt.extend_from_slice(&data[..length as usize]);
    pkt
}

pub fn parse_artdmx(buf: &[u8]) -> Result<DmxFrame> {
    if buf.len() < 18 {
        return Err(anyhow!("Packet too short"));
    }
    if &buf[0..8] != ARTNET_ID {
        return Err(anyhow!("Not Art-Net"));
    }
    let op = u16::from_le_bytes([buf[8], buf[9]]);
    if op != OP_OUTPUT {
        return Err(anyhow!("Unsupported OpCode"));
    }
    let _prot = u16::from_be_bytes([buf[10], buf[11]]);
    let sequence = buf[12];
    let physical = buf[13];
    let subuni = buf[14];
    let net = buf[15];
    let len = u16::from_be_bytes([buf[16], buf[17]]);
    if buf.len() < 18 + len as usize {
        return Err(anyhow!("Length mismatch"));
    }
    let values = buf[18..18 + len as usize].to_vec();
    Ok(DmxFrame {
        net,
        subnet: (subuni >> 4) & 0x0f,
        universe: subuni & 0x0f,
        length: len,
        sequence,
        physical,
        values,
    })
}

pub async fn bind_receiver_socket(cfg: &ReceiverConfig) -> Result<UdpSocket> {
    use socket2::{Domain, Protocol, Socket, Type};
    use std::net::SocketAddr as StdSocketAddr;

    let ip: IpAddr = cfg.bind_ip.parse()?;
    let addr = SocketAddr::new(ip, cfg.port);
    let std_addr: StdSocketAddr = addr.into();

    // Create socket with SO_REUSEADDR to allow port sharing
    let domain = match addr {
        SocketAddr::V4(_) => Domain::IPV4,
        SocketAddr::V6(_) => Domain::IPV6,
    };
    let socket = Socket::new(domain, Type::DGRAM, Some(Protocol::UDP))?;
    // Allow multiple processes to bind the same UDP port (best-effort)
    socket.set_reuse_address(true)?;
    #[cfg(unix)]
    {
        // Try to enable SO_REUSEPORT via libc when available.
        // This may fail on platforms that don't support it; ignore errors.
        let fd = socket.as_raw_fd();
        unsafe {
            let optval: libc::c_int = 1;
            let _ = libc::setsockopt(
                fd,
                libc::SOL_SOCKET,
                libc::SO_REUSEPORT,
                &optval as *const _ as *const libc::c_void,
                std::mem::size_of_val(&optval) as libc::socklen_t,
            );
        }
    }
    socket.bind(&std_addr.into())?;

    // Convert to async socket properly
    let std_sock: std::net::UdpSocket = socket.into();
    std_sock.set_nonblocking(true)?; // Make it non-blocking
    let tokio_sock = UdpSocket::from_std(std_sock)?;

    Ok(tokio_sock)
}

pub async fn sender_socket() -> Result<UdpSocket> {
    // Bind to ephemeral local port to allow broadcast
    let sock = UdpSocket::bind(SocketAddr::new(IpAddr::V4(Ipv4Addr::UNSPECIFIED), 0)).await?;
    sock.set_broadcast(true)?;
    Ok(sock)
}

pub async fn send_artdmx(
    sock: &UdpSocket,
    cfg: &SenderConfig,
    data: &[u8; 512],
    sequence: u8,
) -> Result<()> {
    let pkt = encode_artdmx(cfg, data, sequence);
    let target: SocketAddr = format!("{}:{}", cfg.target_ip, cfg.port).parse()?;
    sock.send_to(&pkt, target).await?;
    Ok(())
}
