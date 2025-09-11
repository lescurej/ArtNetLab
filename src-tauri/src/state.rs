use std::sync::{Arc, Mutex};

use anyhow::Result;
use tokio::{
    sync::mpsc,
    task::JoinHandle,
    time::{sleep, Duration, Instant},
};

use crate::artnet::{self, ReceiverConfig, SenderConfig};
use tauri::Emitter;

#[derive(Clone)]
pub struct AppState {
    inner: Arc<Mutex<Inner>>,
}

struct Inner {
    // Receiver
    recv_cfg: ReceiverConfig,
    recv_task: Option<JoinHandle<()>>,
    // Sender
    send_cfg: SenderConfig,
    send_task: Option<JoinHandle<()>>,
    channels: [u8; 512],
    sequence: u8,
    // Recording
    record_tx: Option<mpsc::UnboundedSender<crate::artnet::DmxFrame>>,
    record_task: Option<JoinHandle<()>>,
    // Playback
    play_task: Option<JoinHandle<()>>,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            inner: Arc::new(Mutex::new(Inner {
                recv_cfg: ReceiverConfig::default(),
                recv_task: None,
                send_cfg: SenderConfig::default(),
                send_task: None,
                channels: [0; 512],
                sequence: 0,
                record_tx: None,
                record_task: None,
                play_task: None,
            })),
        }
    }
}

impl AppState {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn get_receiver_config(&self) -> ReceiverConfig {
        self.inner.lock().unwrap().recv_cfg.clone()
    }
    pub fn set_receiver_config(&self, cfg: ReceiverConfig) {
        self.inner.lock().unwrap().recv_cfg = cfg;
    }

    pub fn get_sender_config(&self) -> SenderConfig {
        self.inner.lock().unwrap().send_cfg.clone()
    }
    pub fn set_sender_config(&self, cfg: SenderConfig) {
        self.inner.lock().unwrap().send_cfg = cfg;
    }

    pub fn channels_snapshot(&self) -> [u8; 512] {
        self.inner.lock().unwrap().channels
    }
    pub fn set_channel(&self, index: usize, value: u8) {
        self.inner.lock().unwrap().channels[index] = value;
    }
    pub fn set_channels(&self, values: &[u8]) {
        self.inner.lock().unwrap().channels.copy_from_slice(values);
    }

    pub fn next_sequence(&self) -> u8 {
        let mut g = self.inner.lock().unwrap();
        g.sequence = g.sequence.wrapping_add(1);
        g.sequence
    }

    pub fn stop_receiver(&self) {
        if let Some(handle) = self.inner.lock().unwrap().recv_task.take() {
            handle.abort();
        }
    }

    pub fn stop_sender(&self) {
        if let Some(handle) = self.inner.lock().unwrap().send_task.take() {
            handle.abort();
        }
    }

    pub fn set_receiver_task(&self, task: JoinHandle<()>) {
        self.inner.lock().unwrap().recv_task = Some(task);
    }
    pub fn set_sender_task(&self, task: JoinHandle<()>) {
        self.inner.lock().unwrap().send_task = Some(task);
    }

    // Recording controls
    pub fn set_recording(
        &self,
        tx: mpsc::UnboundedSender<crate::artnet::DmxFrame>,
        task: JoinHandle<()>,
    ) {
        let mut g = self.inner.lock().unwrap();
        g.record_tx = Some(tx);
        g.record_task = Some(task);
    }
    pub fn stop_recording(&self) {
        let mut g = self.inner.lock().unwrap();
        g.record_tx = None;
        if let Some(h) = g.record_task.take() {
            h.abort();
        }
    }

    // Playback controls
    pub fn set_play_task(&self, task: JoinHandle<()>) {
        self.inner.lock().unwrap().play_task = Some(task);
    }
    pub fn stop_playback(&self) {
        if let Some(h) = self.inner.lock().unwrap().play_task.take() {
            h.abort();
        }
    }
}

pub async fn run_receiver_task(
    cfg: artnet::ReceiverConfig,
    window: tauri::AppHandle,
    app_state: AppState,
) -> Result<()> {
    let sock = artnet::bind_receiver_socket(&cfg).await?;
    let mut buf = [0u8; 2048];

    loop {
        let (n, _from) = sock.recv_from(&mut buf).await?;

        if let Ok(frame) = artnet::parse_artdmx(&buf[..n]) {
            let _ = window.emit("artnet:dmx", &frame);
            // Forward to recorder if active
            if let Some(tx) = app_state.inner.lock().unwrap().record_tx.clone() {
                let _ = tx.send(frame);
            }
        }
    }
}

pub async fn run_sender_task(cfg: SenderConfig, app_state: AppState) -> Result<()> {
    let sock = artnet::sender_socket().await?;
    let mut interval = tokio::time::interval(Duration::from_millis(
        ((1000.0f32 / cfg.fps.max(1) as f32).round() as u64).max(1),
    ));
    loop {
        interval.tick().await;
        let last = app_state.channels_snapshot();
        let seq = app_state.next_sequence();
        let _ = artnet::send_artdmx(&sock, &cfg, &last, seq).await;
    }
}

// Recorder: writes JSON Lines
pub async fn run_record_task(
    path: String,
    mut rx: mpsc::UnboundedReceiver<crate::artnet::DmxFrame>,
) -> Result<()> {
    use std::io::Write;
    let mut file = std::fs::File::create(path)?;
    let header = serde_json::json!({"format":"artnet-jsonl","version":1});
    writeln!(file, "{}", serde_json::to_string(&header)?)?;
    let start = Instant::now();
    while let Some(frame) = rx.recv().await {
        let t_ms = start.elapsed().as_millis() as u64;
        #[derive(serde::Serialize)]
        struct Line<'a> {
            t_ms: u64,
            net: u8,
            subnet: u8,
            universe: u8,
            length: u16,
            values: &'a [u8],
        }
        let line = Line {
            t_ms,
            net: frame.net,
            subnet: frame.subnet,
            universe: frame.universe,
            length: frame.length,
            values: &frame.values,
        };
        writeln!(file, "{}", serde_json::to_string(&line)?)?;
    }
    Ok(())
}

pub async fn run_play_task(path: String, cfg: SenderConfig) -> Result<()> {
    use std::io::{BufRead, BufReader};
    let sock = artnet::sender_socket().await?;
    let file = std::fs::File::open(&path)?;
    let mut lines = BufReader::new(file).lines();
    // skip header if present
    let mut first = true;
    let mut last_t: Option<u64> = None;
    while let Some(line) = lines.next() {
        let line = line?;
        if first {
            first = false;
            // If header, continue; else try to parse as frame
            if let Ok(val) = serde_json::from_str::<serde_json::Value>(&line) {
                if val.get("format").is_some() {
                    continue;
                }
            }
        }
        #[derive(serde::Deserialize)]
        struct Line {
            t_ms: u64,
            net: u8,
            subnet: u8,
            universe: u8,
            length: u16,
            values: Vec<u8>,
        }
        let rec: Line = serde_json::from_str(&line)?;
        if let Some(prev) = last_t {
            let delta = rec.t_ms.saturating_sub(prev);
            if delta > 0 {
                sleep(Duration::from_millis(delta)).await;
            }
        }
        last_t = Some(rec.t_ms);
        // Use rec addressing for subuni/net
        let mut send_cfg = cfg.clone();
        send_cfg.net = rec.net;
        send_cfg.subnet = rec.subnet;
        send_cfg.universe = rec.universe;
        let mut arr = [0u8; 512];
        let len = rec.length.min(512);
        arr[..len as usize].copy_from_slice(&rec.values[..len as usize]);
        let _ = crate::artnet::send_artdmx(&sock, &send_cfg, &arr, 0).await;
    }
    Ok(())
}
