use std::sync::{Arc, Mutex};

use anyhow::Result;
use tokio::{
    net::UdpSocket,
    sync::mpsc,
    task::JoinHandle,
    time::{sleep, Duration, Instant},
};

use crate::artnet::{self, ReceiverConfig, SenderConfig};
use serde::Serialize;
use tauri::{AppHandle, Emitter};

const MAX_RECORD_FRAMES: usize = 200_000;

#[derive(Clone, Copy, Default, PartialEq)]
pub enum AnimKind {
    #[default]
    Off,
    Sinusoid,
    Ramp,
    Square,
    Chaser,
}

pub fn anim_kind_from_cmd(s: &str) -> AnimKind {
    match s.as_ref() {
        "sinusoid" => AnimKind::Sinusoid,
        "ramp" => AnimKind::Ramp,
        "square" => AnimKind::Square,
        "chaser" => AnimKind::Chaser,
        _ => AnimKind::Off,
    }
}

#[derive(Clone, Copy)]
pub struct AnimationState {
    pub mode: AnimKind,
    pub frequency: f64,
    pub master_value: u8,
    pub is_running: bool,
    pub chaser_from: u16,
    pub chaser_to: u16,
}

impl Default for AnimationState {
    fn default() -> Self {
        Self {
            mode: AnimKind::Off,
            frequency: 1.0,
            master_value: 0,
            is_running: false,
            chaser_from: 1,
            chaser_to: 512,
        }
    }
}

pub fn sanitize_chaser_ends(mut a: u16, mut b: u16) -> (u16, u16) {
    a = a.clamp(1, 512);
    b = b.clamp(1, 512);
    if a > b {
        std::mem::swap(&mut a, &mut b);
    }
    (a, b)
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

    fn duration_ms(&self) -> u64 {
        self.timestamps.last().copied().unwrap_or(0)
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
    shared_udp: Arc<tokio::sync::Mutex<Option<Arc<UdpSocket>>>>,
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
            shared_udp: Arc::new(tokio::sync::Mutex::new(None)),
        }
    }
}

impl AppState {
    pub fn new() -> Self {
        Self::default()
    }

    pub async fn udp_for_send(&self) -> Result<Arc<UdpSocket>> {
        let mut g = self.shared_udp.lock().await;
        if g.is_none() {
            *g = Some(Arc::new(artnet::sender_socket().await?));
        }
        Ok(g.as_ref().unwrap().clone())
    }

    pub fn snapshot_channels_tick_seq(&self) -> ([u8; 512], u8) {
        let mut g = self.inner.lock().unwrap();
        let data = g.channels;
        g.sequence = g.sequence.wrapping_add(1);
        (data, g.sequence)
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

    pub fn sender_stream_active(&self) -> bool {
        self.inner
            .lock()
            .unwrap()
            .send_task
            .as_ref()
            .is_some_and(|h| !h.is_finished())
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

    pub fn patch_animation_live(
        &self,
        frequency: f64,
        master_value: u8,
        chaser_from: Option<u16>,
        chaser_to: Option<u16>,
    ) {
        let mut g = self.inner.lock().unwrap();
        let a = &mut g.animation_state;
        if !a.is_running || a.mode == AnimKind::Off {
            return;
        }
        a.frequency = frequency.abs().max(1e-3);
        a.master_value = master_value;
        if a.mode == AnimKind::Chaser {
            if let (Some(cf), Some(ct)) = (chaser_from, chaser_to) {
                let (f, t) = sanitize_chaser_ends(cf, ct);
                a.chaser_from = f;
                a.chaser_to = t;
            }
        }
    }
}

#[inline(always)]
fn dmx_apply_master(value: u8, master: u8) -> u8 {
    ((value as u16 * master as u16) / 255) as u8
}

fn generate_animation_scaled_frame(time_ms: u64, animation: AnimationState) -> [u8; 512] {
    let mut values = [0u8; 512];
    if animation.mode == AnimKind::Off {
        return values;
    }
    let fq = animation.frequency.abs().max(1e-3);
    let period_ms = (1000.0 / fq).max(1.0) as u64;
    let m = animation.master_value;

    match animation.mode {
        AnimKind::Chaser => {
            let (dm_lo, dm_hi) =
                sanitize_chaser_ends(animation.chaser_from, animation.chaser_to);
            let lo = (dm_lo as usize).saturating_sub(1).min(511);
            let hi = (dm_hi as usize).saturating_sub(1).min(511);
            let span = hi.saturating_sub(lo).saturating_add(1).max(1);
            let dwell_ms = period_ms.max(1);
            let cycle_ms = dwell_ms.saturating_mul(span as u64).max(1);
            let phase = time_ms % cycle_ms;
            let idx = (phase / dwell_ms).min(span as u64 - 1) as usize;
            values[lo + idx] = dmx_apply_master(255, m);
        }
        AnimKind::Sinusoid => {
            let t_frac = ((time_ms % period_ms) as f64 / period_ms as f64).clamp(0.0, 1.0);
            let shape = ((2.0 * std::f64::consts::PI * t_frac).sin() + 1.0) / 2.0;
            let v = (shape * 255.0).round().clamp(0.0, 255.0) as u8;
            let s = dmx_apply_master(v, m);
            values.fill(s);
        }
        AnimKind::Ramp => {
            let t_frac = ((time_ms % period_ms) as f64 / period_ms as f64).clamp(0.0, 1.0);
            let v = (t_frac * 255.0).round().clamp(0.0, 255.0) as u8;
            let s = dmx_apply_master(v, m);
            values.fill(s);
        }
        AnimKind::Square => {
            let t_frac = ((time_ms % period_ms) as f64 / period_ms as f64).clamp(0.0, 1.0);
            let v = if (2.0 * std::f64::consts::PI * t_frac).sin() > 0.0 {
                255
            } else {
                0
            };
            let s = dmx_apply_master(v, m);
            values.fill(s);
        }
        AnimKind::Off => {}
    }

    values
}

// Animation task
pub async fn run_animation_task(app_state: AppState, app: AppHandle) -> Result<()> {
    let mut interval = tokio::time::interval(Duration::from_millis(16));
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let t0 = Instant::now();
    let mut prev_frame: Option<[u8; 512]> = None;

    loop {
        interval.tick().await;

        let animation = {
            let inner = app_state.inner.lock().unwrap();
            inner.animation_state
        };

        if !animation.is_running || animation.mode == AnimKind::Off {
            prev_frame = None;
            continue;
        }

        let time_ms = t0.elapsed().as_millis() as u64;
        let frame = generate_animation_scaled_frame(time_ms, animation);
        if prev_frame.as_ref() == Some(&frame) {
            continue;
        }

        prev_frame = Some(frame);
        if let Some(ref f) = prev_frame {
            app_state.set_channels(f);
            let _ = app.emit("sender:preview", f.as_slice());
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

            let (pass, recorder_tx) = {
                let mut g = app_state.inner.lock().unwrap();
                let pass = match g.event_filter {
                    Some((net, sub, uni)) => {
                        frame.net == net && frame.subnet == sub && frame.universe == uni
                    }
                    None => true,
                };
                if pass {
                    if let Some(buffer) = g.record_buffer.as_mut() {
                        buffer.append(&frame);
                    }
                }
                (pass, g.record_tx.clone())
            };

            if pass {
                let _ = window.emit("artnet:dmx_filtered", &frame);
            }
            if let Some(tx) = recorder_tx {
                let _ = tx.send(frame);
            }
        }
    }
}

pub async fn run_sender_task(cfg: SenderConfig, app_state: AppState) -> Result<()> {
    let sock = app_state.udp_for_send().await?;
    let mut interval = tokio::time::interval(Duration::from_millis(
        ((1000.0f32 / cfg.fps.max(1) as f32).round() as u64).max(1),
    ));
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        interval.tick().await;
        let (last, seq) = app_state.snapshot_channels_tick_seq();
        let _ = artnet::send_artdmx(sock.as_ref(), &cfg, &last, seq).await;
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
