use std::sync::{Arc, Mutex};

use anyhow::Result;
use tokio::{
    sync::mpsc,
    task::JoinHandle,
    time::{sleep, Duration, Instant},
};

use crate::artnet::{self, ReceiverConfig, SenderConfig};
use serde::Serialize;
use tauri::Emitter;

const MAX_RECORD_FRAMES: usize = 200_000;

// Animation state
#[derive(Clone)]
pub struct AnimationState {
    pub mode: String,
    pub frequency: f64,
    pub master_value: u8,
    pub is_running: bool,
}

impl Default for AnimationState {
    fn default() -> Self {
        Self {
            mode: "off".to_string(),
            frequency: 1.0,
            master_value: 255,
            is_running: false,
        }
    }
}

#[derive(Clone)]
pub struct RecordData {
    pub timestamps: Vec<u64>,
    pub addresses: Vec<(u8, u8, u8)>,
    pub channels: Vec<usize>,
    pub values: Vec<Vec<u8>>,
}

impl RecordData {
    pub fn frame_count(&self) -> usize {
        self.timestamps.len()
    }

    pub fn duration_ms(&self) -> u64 {
        self.timestamps.last().copied().unwrap_or(0)
    }

    pub fn channel_numbers(&self) -> Vec<u16> {
        self.channels.iter().map(|c| (*c + 1) as u16).collect()
    }

    pub fn last_address(&self) -> Option<(u8, u8, u8)> {
        self.addresses.last().copied()
    }
}

#[derive(Clone, Serialize)]
pub struct PreviewPoint {
    pub t_ms: u64,
    pub value: u8,
}

#[derive(Clone, Serialize)]
pub struct PreviewResponse {
    pub points: Vec<PreviewPoint>,
    pub frame_count: usize,
    pub duration_ms: u64,
}

struct RecordBuffer {
    channels: Vec<usize>,
    timestamps: Vec<u64>,
    values: Vec<Vec<u8>>,
    addresses: Vec<(u8, u8, u8)>,
    start: Instant,
    active: bool,
}

impl RecordBuffer {
    fn new(channels: Vec<usize>, active: bool) -> Self {
        let values = channels.iter().map(|_| Vec::new()).collect();
        Self {
            channels,
            timestamps: Vec::new(),
            values,
            addresses: Vec::new(),
            start: Instant::now(),
            active,
        }
    }

    fn from_data(data: RecordData, active: bool) -> Self {
        Self {
            channels: data.channels,
            timestamps: data.timestamps,
            values: data.values,
            addresses: data.addresses,
            start: Instant::now(),
            active,
        }
    }

    fn set_channels(&mut self, channels: Vec<usize>) {
        let frame_count = self.timestamps.len();
        let mut new_values = Vec::with_capacity(channels.len());
        for ch in &channels {
            if let Some(idx) = self.channels.iter().position(|c| c == ch) {
                new_values.push(self.values[idx].clone());
            } else {
                new_values.push(vec![0u8; frame_count]);
            }
        }
        self.channels = channels;
        self.values = new_values;
    }

    fn append(&mut self, frame: &artnet::DmxFrame) {
        if !self.active {
            return;
        }
        let elapsed = self.start.elapsed().as_millis() as u64;
        self.timestamps.push(elapsed);
        self.addresses
            .push((frame.net, frame.subnet, frame.universe));
        for (idx, ch) in self.channels.iter().enumerate() {
            let value = if *ch < frame.values.len() {
                frame.values[*ch]
            } else {
                0
            };
            if let Some(vec) = self.values.get_mut(idx) {
                vec.push(value);
            }
        }
        self.enforce_limit();
    }

    fn preview(&self, channel: usize, max_points: usize) -> Option<PreviewResponse> {
        let idx = self.channels.iter().position(|c| *c == channel)?;
        let values = self.values.get(idx)?;
        let total = values.len();
        let duration = self.duration_ms();
        if total == 0 || max_points == 0 {
            return Some(PreviewResponse {
                points: Vec::new(),
                frame_count: total,
                duration_ms: duration,
            });
        }

        let mut points = Vec::new();
        if total <= max_points {
            points.reserve(total);
            for (i, value) in values.iter().enumerate() {
                if let Some(&t) = self.timestamps.get(i) {
                    points.push(PreviewPoint {
                        t_ms: t,
                        value: *value,
                    });
                }
            }
        } else {
            let step = ((total as f64) / (max_points as f64)).ceil() as usize;
            let mut i = 0;
            while i < total {
                if let Some(&t) = self.timestamps.get(i) {
                    points.push(PreviewPoint {
                        t_ms: t,
                        value: values[i],
                    });
                }
                i += step.max(1);
            }
            if points.last().map(|p| p.t_ms) != self.timestamps.last().copied() {
                if let Some(last_idx) = total.checked_sub(1) {
                    if let Some(&t) = self.timestamps.get(last_idx) {
                        points.push(PreviewPoint {
                            t_ms: t,
                            value: values[last_idx],
                        });
                    }
                }
            }
        }

        Some(PreviewResponse {
            points,
            frame_count: total,
            duration_ms: duration,
        })
    }

    fn to_record_data(&self) -> RecordData {
        RecordData {
            timestamps: self.timestamps.clone(),
            addresses: self.addresses.clone(),
            channels: self.channels.clone(),
            values: self.values.clone(),
        }
    }

    fn frame_count(&self) -> usize {
        self.timestamps.len()
    }

    fn duration_ms(&self) -> u64 {
        self.timestamps.last().copied().unwrap_or(0)
    }

    fn last_address(&self) -> Option<(u8, u8, u8)> {
        self.addresses.last().copied()
    }

    fn enforce_limit(&mut self) {
        if self.timestamps.len() <= MAX_RECORD_FRAMES {
            return;
        }
        let drop = self.timestamps.len() - MAX_RECORD_FRAMES;
        self.timestamps.drain(0..drop);
        self.addresses.drain(0..drop);
        for values in self.values.iter_mut() {
            if values.len() > drop {
                values.drain(0..drop);
            } else {
                values.clear();
            }
        }
    }
}

fn normalize_channels(channels: Vec<usize>) -> Vec<usize> {
    let mut result = Vec::new();
    for ch in channels {
        if ch < 512 && !result.contains(&ch) {
            result.push(ch);
        }
    }
    result
}

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
    record_buffer: Option<RecordBuffer>,
    // Playback
    play_task: Option<JoinHandle<()>>,
    // Animation
    animation_state: AnimationState,
    animation_task: Option<JoinHandle<()>>,
    // Event filter
    event_filter: Option<(u8, u8, u8)>,
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
                record_buffer: None,
                play_task: None,
                animation_state: AnimationState::default(),
                animation_task: None,
                event_filter: None,
            })),
        }
    }
}

impl AppState {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn inner(&self) -> &Arc<Mutex<Inner>> {
        &self.inner
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

    pub fn start_buffered_recording(&self, channels: Vec<usize>) -> Vec<usize> {
        let normalized = normalize_channels(channels);
        let mut guard = self.inner.lock().unwrap();
        guard.record_buffer = Some(RecordBuffer::new(normalized.clone(), true));
        normalized
    }

    pub fn stop_buffered_recording(&self) {
        if let Some(buffer) = self.inner.lock().unwrap().record_buffer.as_mut() {
            buffer.active = false;
        }
    }

    pub fn clear_record_buffer(&self) {
        self.inner.lock().unwrap().record_buffer = None;
    }

    pub fn set_record_channels(&self, channels: Vec<usize>) -> Vec<usize> {
        let normalized = normalize_channels(channels);
        let mut guard = self.inner.lock().unwrap();
        if let Some(buffer) = guard.record_buffer.as_mut() {
            buffer.set_channels(normalized.clone());
        } else {
            guard.record_buffer = Some(RecordBuffer::new(normalized.clone(), false));
        }
        normalized
    }

    pub fn append_record_frame(&self, frame: &artnet::DmxFrame) {
        if let Some(buffer) = self.inner.lock().unwrap().record_buffer.as_mut() {
            buffer.append(frame);
        }
    }

    pub fn record_preview(&self, channel: usize, max_points: usize) -> Option<PreviewResponse> {
        self.inner
            .lock()
            .unwrap()
            .record_buffer
            .as_ref()
            .and_then(|buffer| buffer.preview(channel, max_points))
    }

    pub fn record_data_snapshot(&self) -> Option<RecordData> {
        self.inner
            .lock()
            .unwrap()
            .record_buffer
            .as_ref()
            .map(|buffer| buffer.to_record_data())
    }

    pub fn load_record_data(&self, data: RecordData, active: bool) {
        self.inner.lock().unwrap().record_buffer = Some(RecordBuffer::from_data(data, active));
    }

    pub fn record_channels(&self) -> Vec<usize> {
        self.inner
            .lock()
            .unwrap()
            .record_buffer
            .as_ref()
            .map(|buffer| buffer.channels.clone())
            .unwrap_or_default()
    }

    pub fn record_summary(&self) -> (usize, u64) {
        if let Some(buffer) = self.inner.lock().unwrap().record_buffer.as_ref() {
            (buffer.frame_count(), buffer.duration_ms())
        } else {
            (0, 0)
        }
    }

    pub fn record_last_address(&self) -> Option<(u8, u8, u8)> {
        self.inner
            .lock()
            .unwrap()
            .record_buffer
            .as_ref()
            .and_then(|buffer| buffer.last_address())
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

    pub fn set_event_filter(&self, filter: Option<(u8, u8, u8)>) {
        self.inner.lock().unwrap().event_filter = filter;
    }

    // Animation controls
    pub fn set_animation_task(&self, task: JoinHandle<()>) {
        self.inner.lock().unwrap().animation_task = Some(task);
    }

    pub fn stop_animation(&self) {
        if let Some(handle) = self.inner.lock().unwrap().animation_task.take() {
            handle.abort();
        }
        self.inner.lock().unwrap().animation_state.is_running = false;
    }

    pub fn set_animation_state(&self, state: AnimationState) {
        self.inner.lock().unwrap().animation_state = state;
    }
}

// Animation generation function
fn generate_animation_values(time_ms: u64, mode: &str, freq: f64) -> [u8; 512] {
    let mut values = [0u8; 512];
    let period_ms = (1000.0 / freq) as u64;
    let t = (time_ms % period_ms) as f64 / period_ms as f64;

    let value = match mode {
        "sinusoid" => ((2.0 * std::f64::consts::PI * t).sin() + 1.0) / 2.0,
        "ramp" => t,
        "square" => {
            if (2.0 * std::f64::consts::PI * t).sin() > 0.0 {
                1.0
            } else {
                0.0
            }
        }
        _ => 0.0,
    };

    let dmx_value = (value * 255.0).round() as u8;
    values.fill(dmx_value);
    values
}

fn apply_master_scaling(values: &[u8; 512], master: u8) -> [u8; 512] {
    let mut scaled = [0u8; 512];
    for (i, &value) in values.iter().enumerate() {
        scaled[i] = ((value as u16 * master as u16) / 255) as u8;
    }
    scaled
}

// Animation task
pub async fn run_animation_task(app_state: AppState) -> Result<()> {
    let mut interval = tokio::time::interval(Duration::from_millis(16)); // 60 FPS

    loop {
        interval.tick().await;

        let animation = {
            let inner = app_state.inner.lock().unwrap();
            inner.animation_state.clone()
        };

        if !animation.is_running || animation.mode == "off" {
            continue;
        }

        let current_time = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64;

        let values = generate_animation_values(current_time, &animation.mode, animation.frequency);
        let scaled_values = apply_master_scaling(&values, animation.master_value);

        // Update channels and send
        app_state.set_channels(&scaled_values);
        // Note: push_frame is handled by the sender task, not here
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
            // Optional filtered stream
            let filter = { app_state.inner.lock().unwrap().event_filter };
            let pass = match filter {
                Some((net, sub, uni)) => {
                    frame.net == net && frame.subnet == sub && frame.universe == uni
                }
                None => true,
            };
            if pass {
                let _ = window.emit("artnet:dmx_filtered", &frame);
                app_state.append_record_frame(&frame);
            }
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
    let mut first = true;
    let mut channels: Vec<usize> = (1..=512).collect();
    let mut last_t: Option<u64> = None;
    while let Some(line) = lines.next() {
        let line = line?;
        if first {
            first = false;
            // If header, parse channels mapping and continue
            if let Ok(val) = serde_json::from_str::<serde_json::Value>(&line) {
                if val.get("format").is_some() {
                    if let Some(arr) = val.get("channels").and_then(|v| v.as_array()) {
                        channels = arr
                            .iter()
                            .filter_map(|n| n.as_u64().map(|x| x as usize))
                            .collect();
                    }
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
        for (idx, ch) in channels.iter().enumerate() {
            if idx < rec.values.len() && *ch >= 1 && *ch <= 512 {
                arr[*ch - 1] = rec.values[idx];
            }
        }
        let _ = crate::artnet::send_artdmx(&sock, &send_cfg, &arr, 0).await;
    }
    Ok(())
}

// WAV playback task
pub async fn run_wav_play_task(wav_data: crate::WavRecordingData, cfg: SenderConfig) -> Result<()> {
    let sock = artnet::sender_socket().await?;
    let mut last_t: Option<u64> = None;

    for frame_idx in 0..wav_data.timestamps.len() {
        let t_ms = wav_data.timestamps[frame_idx];

        if let Some(prev) = last_t {
            let delta = t_ms.saturating_sub(prev);
            if delta > 0 {
                sleep(Duration::from_millis(delta)).await;
            }
        }
        last_t = Some(t_ms);

        // Create DMX frame from WAV data
        let mut arr = [0u8; 512];
        for ch in 0..512 {
            if ch < wav_data.channels.len() && frame_idx < wav_data.channels[ch].len() {
                arr[ch] = wav_data.channels[ch][frame_idx];
            }
        }

        let _ = artnet::send_artdmx(&sock, &cfg, &arr, 0).await;
    }
    Ok(())
}
