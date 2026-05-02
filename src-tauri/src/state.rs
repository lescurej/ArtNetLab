use std::net::SocketAddr;
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
    Noise,
}

pub fn anim_kind_from_code(code: u8) -> AnimKind {
    match code {
        1 => AnimKind::Sinusoid,
        2 => AnimKind::Ramp,
        3 => AnimKind::Square,
        4 => AnimKind::Chaser,
        5 => AnimKind::Noise,
        _ => AnimKind::Off,
    }
}

pub fn anim_kind_from_cmd(s: &str) -> AnimKind {
    match s.as_ref() {
        "sinusoid" => AnimKind::Sinusoid,
        "ramp" => AnimKind::Ramp,
        "square" => AnimKind::Square,
        "chaser" => AnimKind::Chaser,
        "noise" => AnimKind::Noise,
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
    pub animation_targets: [bool; 512],
    pub animation_modes: [AnimKind; 512],
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
            animation_targets: [true; 512],
            animation_modes: [AnimKind::Off; 512],
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

pub fn sanitize_animation_targets(channels: Option<Vec<u16>>) -> [bool; 512] {
    let mut targets = [false; 512];
    if let Some(list) = channels {
        for ch in list {
            let idx = ch.saturating_sub(1) as usize;
            if idx < 512 {
                targets[idx] = true;
            }
        }
    }
    if targets.iter().any(|&x| x) {
        targets
    } else {
        [true; 512]
    }
}

pub fn sanitize_animation_modes(
    modes: Option<Vec<u8>>,
    fallback_mode: AnimKind,
    targets: [bool; 512],
) -> [AnimKind; 512] {
    let mut out = [AnimKind::Off; 512];
    if let Some(list) = modes {
        for (idx, code) in list.into_iter().take(512).enumerate() {
            out[idx] = anim_kind_from_code(code);
        }
        return out;
    }
    for idx in 0..512 {
        if targets[idx] {
            out[idx] = fallback_mode;
        }
    }
    out
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
    let mut seen = [false; 512];
    let mut result = Vec::with_capacity(channels.len().min(512));
    for ch in channels {
        if ch < 512 && !seen[ch] {
            seen[ch] = true;
            result.push(ch);
        }
    }
    result
}

#[derive(Clone)]
pub struct AppState {
    inner: Arc<Mutex<Inner>>,
    shared_udp: Arc<tokio::sync::Mutex<Option<Arc<UdpSocket>>>>,
    discovery_poll_tx: Arc<tokio::sync::Mutex<Option<mpsc::Sender<(SocketAddr, Vec<u8>)>>>>,
}

struct Inner {
    // Receiver
    recv_cfg: ReceiverConfig,
    recv_task: Option<JoinHandle<()>>,
    // Sender
    send_cfg: SenderConfig,
    send_task: Option<JoinHandle<()>>,
    discovery_interval_sec: u64,
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
                discovery_interval_sec: 10,
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
            discovery_poll_tx: Arc::new(tokio::sync::Mutex::new(None)),
        }
    }
}

impl AppState {
    pub fn new() -> Self {
        Self::default()
    }

    pub async fn set_discovery_poll_reply_tx(
        &self,
        tx: Option<mpsc::Sender<(SocketAddr, Vec<u8>)>>,
    ) {
        *self.discovery_poll_tx.lock().await = tx;
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

    pub fn get_discovery_interval_sec(&self) -> u64 {
        self.inner.lock().unwrap().discovery_interval_sec
    }

    pub fn set_discovery_interval_sec(&self, sec: u64) {
        self.inner.lock().unwrap().discovery_interval_sec = sec.min(86400);
    }

    pub fn snapshot_channels(&self) -> [u8; 512] {
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
        channels: Option<Vec<u16>>,
        modes: Option<Vec<u8>>,
    ) {
        let mut g = self.inner.lock().unwrap();
        let a = &mut g.animation_state;
        if !a.is_running {
            return;
        }
        a.frequency = frequency.abs().max(1e-3);
        a.master_value = master_value;
        a.animation_targets = sanitize_animation_targets(channels);
        a.animation_modes = sanitize_animation_modes(modes, a.mode, a.animation_targets);
        if a.animation_modes.iter().any(|m| *m == AnimKind::Chaser) {
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

#[inline(always)]
fn splitmix64(mut x: u64) -> u64 {
    x = x.wrapping_add(0x9E3779B97F4A7C15);
    x = (x ^ (x >> 30)).wrapping_mul(0xBF58476D1CE4E5B9);
    x = (x ^ (x >> 27)).wrapping_mul(0x94D049BB133111EB);
    x ^ (x >> 31)
}

#[inline(always)]
fn noise_unit(channel: usize, step: u64) -> f64 {
    let seed = ((channel as u64 + 1) << 32) ^ step;
    let n = splitmix64(seed);
    (n as f64) / (u64::MAX as f64)
}

#[inline(always)]
fn animation_has_active_modes(animation: &AnimationState) -> bool {
    animation
        .animation_modes
        .iter()
        .any(|mode| *mode != AnimKind::Off)
}

fn generate_animation_scaled_frame(
    time_ms: u64,
    animation: AnimationState,
    mut values: [u8; 512],
) -> [u8; 512] {
    if !animation_has_active_modes(&animation) {
        return values;
    }
    let fq = animation.frequency.abs().max(1e-3);
    let period_ms = (1000.0 / fq).max(1.0) as u64;
    let m = animation.master_value;
    let t_frac = ((time_ms % period_ms) as f64 / period_ms as f64).clamp(0.0, 1.0);
    let sinusoid_v = {
        let shape = ((2.0 * std::f64::consts::PI * t_frac).sin() + 1.0) / 2.0;
        (shape * 255.0).round().clamp(0.0, 255.0) as u8
    };
    let ramp_v = (t_frac * 255.0).round().clamp(0.0, 255.0) as u8;
    let square_v = if (2.0 * std::f64::consts::PI * t_frac).sin() > 0.0 {
        255
    } else {
        0
    };
    let period_non_zero = period_ms.max(1);
    let step = time_ms / period_non_zero;
    let frac = ((time_ms % period_non_zero) as f64 / period_non_zero as f64).clamp(0.0, 1.0);
    let mut chaser_targets: Vec<usize> = Vec::new();

    for idx in 0..512 {
        if !animation.animation_targets[idx] {
            continue;
        }
        match animation.animation_modes[idx] {
            AnimKind::Off => {}
            AnimKind::Sinusoid => {
                values[idx] = dmx_apply_master(sinusoid_v, m);
            }
            AnimKind::Ramp => {
                values[idx] = dmx_apply_master(ramp_v, m);
            }
            AnimKind::Square => {
                values[idx] = dmx_apply_master(square_v, m);
            }
            AnimKind::Noise => {
                let a = noise_unit(idx, step);
                let b = noise_unit(idx, step + 1);
                let v = ((a + (b - a) * frac) * 255.0).round().clamp(0.0, 255.0) as u8;
                values[idx] = dmx_apply_master(v, m);
            }
            AnimKind::Chaser => {
                chaser_targets.push(idx);
            }
        }
    }

    if !chaser_targets.is_empty() {
        for idx in &chaser_targets {
            values[*idx] = 0;
        }
        let span = chaser_targets.len().max(1);
        let dwell_ms = period_non_zero;
        let cycle_ms = dwell_ms.saturating_mul(span as u64).max(1);
        let phase = time_ms % cycle_ms;
        let idx = (phase / dwell_ms).min(span as u64 - 1) as usize;
        let target_idx = chaser_targets[idx];
        values[target_idx] = dmx_apply_master(255, m);
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

        if !animation.is_running || !animation_has_active_modes(&animation) {
            prev_frame = None;
            continue;
        }

        let time_ms = t0.elapsed().as_millis() as u64;
        let base = app_state.snapshot_channels();
        let frame = generate_animation_scaled_frame(time_ms, animation, base);
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
        let (n, from) = sock.recv_from(&mut buf).await?;

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
        } else if n >= 10 && &buf[..8] == b"Art-Net\0" {
            let op = u16::from_le_bytes([buf[8], buf[9]]);
            if op == 0x2100 {
                let gate = app_state.discovery_poll_tx.lock().await;
                if let Some(ref tx) = *gate {
                    let _ = tx.try_send((from, buf[..n].to_vec()));
                }
            }
        }
    }
}

pub async fn run_sender_task(cfg: SenderConfig, app_state: AppState) -> Result<()> {
    let sock = app_state.udp_for_send().await?;
    let mut pkt = Vec::with_capacity(530);
    let mut interval = tokio::time::interval(Duration::from_millis(
        ((1000.0f32 / cfg.fps.max(1) as f32).round() as u64).max(1),
    ));
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        interval.tick().await;
        let (last, seq) = app_state.snapshot_channels_tick_seq();
        let _ = artnet::send_artdmx_with_buffer(sock.as_ref(), &cfg, &last, seq, &mut pkt).await;
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

pub async fn run_play_task(
    path: String,
    cfg: SenderConfig,
    start_ms: u64,
    loop_playback: bool,
) -> Result<()> {
    use std::io::{BufRead, BufReader};
    let sock = artnet::sender_socket().await?;
    let mut active_start_ms = start_ms;
    loop {
        let file = std::fs::File::open(&path)?;
        let mut lines = BufReader::new(file).lines();
        let mut first = true;
        let mut channels: Vec<usize> = (1..=512).collect();
        let mut last_t: Option<u64> = None;
        while let Some(line) = lines.next() {
            let line = line?;
            if first {
                first = false;
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
            if rec.t_ms < active_start_ms {
                continue;
            }
            if let Some(prev) = last_t {
                let delta = rec.t_ms.saturating_sub(prev);
                if delta > 0 {
                    sleep(Duration::from_millis(delta)).await;
                }
            }
            last_t = Some(rec.t_ms);
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
        if !loop_playback {
            break;
        }
        active_start_ms = 0;
    }
    Ok(())
}

// WAV playback task
pub async fn run_wav_play_task(
    wav_data: crate::WavRecordingData,
    cfg: SenderConfig,
    start_ms: u64,
    loop_playback: bool,
) -> Result<()> {
    let sock = artnet::sender_socket().await?;
    let mut active_start_ms = start_ms;
    loop {
        let mut last_t: Option<u64> = None;
        for frame_idx in 0..wav_data.timestamps.len() {
            let t_ms = wav_data.timestamps[frame_idx];
            if t_ms < active_start_ms {
                continue;
            }

            if let Some(prev) = last_t {
                let delta = t_ms.saturating_sub(prev);
                if delta > 0 {
                    sleep(Duration::from_millis(delta)).await;
                }
            }
            last_t = Some(t_ms);

            let mut arr = [0u8; 512];
            for ch in 0..512 {
                if ch < wav_data.channels.len() && frame_idx < wav_data.channels[ch].len() {
                    arr[ch] = wav_data.channels[ch][frame_idx];
                }
            }

            let _ = artnet::send_artdmx(&sock, &cfg, &arr, 0).await;
        }
        if !loop_playback {
            break;
        }
        active_start_ms = 0;
    }
    Ok(())
}
