#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod artnet;
mod state;

use std::{fs, path::PathBuf};

use anyhow::Result;
use serde::{Deserialize, Serialize};
use state::{AppState, PreviewResponse, RecordData};
use tauri::Manager;
use tokio::sync::mpsc;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct SettingsFile {
    receiver: artnet::ReceiverConfig,
    sender: artnet::SenderConfig,
}

#[derive(Debug, Serialize)]
struct LoadedRecording {
    path: String,
    channels: Vec<u16>,
    frames: usize,
    duration_ms: u64,
    last_address: Option<(u8, u8, u8)>,
    format: String,
}

fn settings_path(app: &tauri::AppHandle) -> PathBuf {
    let mut dir = app
        .path()
        .app_config_dir()
        .unwrap_or_else(|_| app.path().app_data_dir().expect("app data dir"));
    fs::create_dir_all(&dir).ok();
    dir.push("settings.json");
    dir
}

fn write_buffer_as_jsonl(path: &str, data: &RecordData) -> Result<(), String> {
    use std::io::Write;

    let mut file = std::fs::File::create(path).map_err(|e| e.to_string())?;
    let header = serde_json::json!({
        "format": "artnet-jsonl",
        "version": 1,
        "channels": data.channel_numbers(),
    });
    writeln!(file, "{}", header.to_string()).map_err(|e| e.to_string())?;

    let base = data.timestamps.first().copied().unwrap_or(0);

    for idx in 0..data.frame_count() {
        let timestamp = data
            .timestamps
            .get(idx)
            .copied()
            .unwrap_or(base)
            .saturating_sub(base);
        let (net, subnet, universe) = data.addresses.get(idx).copied().unwrap_or((0, 0, 0));
        let values: Vec<u8> = data
            .values
            .iter()
            .map(|channel| channel.get(idx).copied().unwrap_or(0))
            .collect();
        let line = serde_json::json!({
            "t_ms": timestamp,
            "net": net,
            "subnet": subnet,
            "universe": universe,
            "length": values.len(),
            "values": values,
        });
        writeln!(file, "{}", line.to_string()).map_err(|e| e.to_string())?;
    }

    Ok(())
}

fn write_buffer_as_wav(path: &str, data: &RecordData) -> Result<(), String> {
    let frames = data.frame_count();
    if frames == 0 {
        return Err("No recorded frames".to_string());
    }
    let duration = data.duration_ms().max(1);
    let sample_rate = ((frames as u64 * 1000) / duration).max(1) as u32;
    let base = data.timestamps.first().copied().unwrap_or(0);
    let timestamps: Vec<u64> = data
        .timestamps
        .iter()
        .map(|t| t.saturating_sub(base))
        .collect();
    let channels: Vec<Vec<u8>> = data.values.iter().map(|v| v.clone()).collect();
    let wav = WavRecordingData {
        timestamps,
        channels,
    };
    save_wav_recording(path.to_string(), sample_rate, wav)
}

fn parse_jsonl_file(path: &str) -> Result<RecordData, String> {
    let content = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
    let mut timestamps = Vec::new();
    let mut addresses = Vec::new();
    let mut channels: Vec<usize> = (0..512).collect();
    let mut values: Vec<Vec<u8>> = Vec::new();
    let mut first_line = true;

    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        if first_line {
            first_line = false;
            if let Ok(val) = serde_json::from_str::<serde_json::Value>(trimmed) {
                if val.get("format").is_some() {
                    if let Some(arr) = val.get("channels").and_then(|v| v.as_array()) {
                        channels = arr
                            .iter()
                            .filter_map(|n| n.as_u64())
                            .map(|n| n.saturating_sub(1) as usize)
                            .filter(|n| *n < 512)
                            .collect();
                    } else if let Some(ch) = val.get("channel").and_then(|v| v.as_u64()) {
                        let idx = ch.saturating_sub(1) as usize;
                        if idx < 512 {
                            channels = vec![idx];
                        }
                    }
                    values = channels.iter().map(|_| Vec::new()).collect();
                    continue;
                }
            }
        }

        if values.is_empty() {
            values = channels.iter().map(|_| Vec::new()).collect();
        }

        let rec: serde_json::Value = serde_json::from_str(trimmed).map_err(|e| e.to_string())?;
        let t_ms = rec
            .get("t_ms")
            .and_then(|v| v.as_u64())
            .ok_or_else(|| "Missing t_ms field".to_string())?;
        let net = rec.get("net").and_then(|v| v.as_u64()).unwrap_or(0) as u8;
        let subnet = rec.get("subnet").and_then(|v| v.as_u64()).unwrap_or(0) as u8;
        let universe = rec.get("universe").and_then(|v| v.as_u64()).unwrap_or(0) as u8;
        let vals = rec
            .get("values")
            .and_then(|v| v.as_array())
            .ok_or_else(|| "Missing values field".to_string())?;
        timestamps.push(t_ms);
        addresses.push((net, subnet, universe));
        if values.len() < channels.len() {
            values.resize_with(channels.len(), Vec::new);
        }
        for (idx, _ch) in channels.iter().enumerate() {
            let val = vals
                .get(idx)
                .and_then(|v| v.as_u64())
                .map(|v| v as u8)
                .unwrap_or(0);
            values[idx].push(val);
        }
    }

    let mut normalized = Vec::new();
    for ch in channels {
        if ch < 512 && !normalized.contains(&ch) {
            normalized.push(ch);
        }
    }

    Ok(RecordData {
        timestamps,
        addresses,
        channels: normalized,
        values,
    })
}

fn record_data_from_wav(data: WavRecordingData) -> RecordData {
    let channels = data.channels.len();
    RecordData {
        timestamps: data.timestamps,
        addresses: vec![(0, 0, 0); data.timestamps.len()],
        channels: (0..channels).collect(),
        values: data.channels,
    }
}

#[tauri::command]
fn get_receiver_config(state: tauri::State<AppState>) -> artnet::ReceiverConfig {
    state.get_receiver_config()
}

#[tauri::command]
fn set_receiver_config(state: tauri::State<AppState>, cfg: artnet::ReceiverConfig) {
    state.set_receiver_config(cfg);
}

#[tauri::command]
async fn start_receiver(
    window: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    state.stop_receiver();
    let cfg = state.get_receiver_config();
    let st = state.inner().clone();
    let handle = tokio::spawn(async move {
        if let Err(e) = state::run_receiver_task(cfg, window, st).await {
            eprintln!("receiver task error: {e:?}");
        }
    });
    state.set_receiver_task(handle);
    Ok(())
}

#[tauri::command]
fn stop_receiver(state: tauri::State<AppState>) {
    state.stop_receiver();
}

#[tauri::command]
fn get_sender_config(state: tauri::State<AppState>) -> artnet::SenderConfig {
    state.get_sender_config()
}

#[tauri::command]
fn set_sender_config(state: tauri::State<AppState>, cfg: artnet::SenderConfig) {
    state.set_sender_config(cfg)
}

#[tauri::command]
async fn start_sender(state: tauri::State<'_, AppState>) -> Result<(), String> {
    state.stop_sender();
    let cfg = state.get_sender_config();
    let st = state.inner().clone();
    let handle = tokio::spawn(async move {
        if let Err(e) = state::run_sender_task(cfg, st).await {
            eprintln!("sender task error: {e:?}");
        }
    });
    state.set_sender_task(handle);
    Ok(())
}

#[tauri::command]
fn stop_sender(state: tauri::State<AppState>) {
    state.stop_sender();
}

#[tauri::command]
async fn push_frame(state: tauri::State<'_, AppState>) -> Result<(), String> {
    // Send an immediate ArtDMX frame with current channels
    let cfg = state.get_sender_config();
    let data = state.channels_snapshot();
    let seq = state.next_sequence();
    let sock = artnet::sender_socket().await.map_err(|e| e.to_string())?;
    artnet::send_artdmx(&sock, &cfg, &data, seq)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn set_channel(state: tauri::State<AppState>, index: usize, value: u8) {
    if index < 512 {
        state.set_channel(index, value);
    }
}

#[tauri::command]
fn set_channels(state: tauri::State<AppState>, values: Vec<u8>) {
    if values.len() == 512 {
        state.set_channels(&values);
    }
}

#[tauri::command]
fn save_settings(app: tauri::AppHandle, state: tauri::State<AppState>) -> Result<(), String> {
    let settings = SettingsFile {
        receiver: state.get_receiver_config(),
        sender: state.get_sender_config(),
    };
    let path = settings_path(&app);
    let s = serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?;
    fs::write(path, s).map_err(|e| e.to_string())
}

#[tauri::command]
fn load_settings(
    app: tauri::AppHandle,
    state: tauri::State<AppState>,
) -> Result<SettingsFile, String> {
    let path = settings_path(&app);
    println!("Loading settings from: {:?}", path);
    if let Ok(bytes) = fs::read(&path) {
        println!("Read {} bytes from settings file", bytes.len());
        if let Ok(cfg) = serde_json::from_slice::<SettingsFile>(&bytes) {
            println!("Successfully parsed settings: {:?}", cfg);
            state.set_receiver_config(cfg.receiver.clone());
            state.set_sender_config(cfg.sender.clone());
            return Ok(cfg);
        } else {
            println!("Failed to parse settings JSON");
        }
    } else {
        println!("Failed to read settings file");
    }
    let def = SettingsFile::default();
    println!("Returning default settings: {:?}", def);
    Ok(def)
}

#[tauri::command]
fn start_recording(state: tauri::State<AppState>, path: String) -> Result<(), String> {
    // Stop if already running
    stop_recording(state.clone());
    let (tx, rx) = mpsc::unbounded_channel();
    let handle = tokio::spawn(async move {
        if let Err(e) = state::run_record_task(path, rx).await {
            eprintln!("recorder error: {e:?}");
        }
    });
    state.set_recording(tx, handle);
    Ok(())
}

#[tauri::command]
fn stop_recording(state: tauri::State<AppState>) {
    state.stop_recording();
}

#[tauri::command]
fn start_buffered_recording(
    state: tauri::State<AppState>,
    channels: Vec<u16>,
) -> Result<Vec<u16>, String> {
    let normalized = state.start_buffered_recording(
        channels
            .into_iter()
            .map(|c| c.saturating_sub(1) as usize)
            .collect(),
    );
    Ok(normalized.into_iter().map(|c| (c + 1) as u16).collect())
}

#[tauri::command]
fn stop_buffered_recording(state: tauri::State<AppState>) {
    state.stop_buffered_recording();
}

#[tauri::command]
fn clear_record_buffer(state: tauri::State<AppState>) {
    state.clear_record_buffer();
}

#[tauri::command]
fn set_record_channels(
    state: tauri::State<AppState>,
    channels: Vec<u16>,
) -> Result<Vec<u16>, String> {
    let normalized = state.set_record_channels(
        channels
            .into_iter()
            .map(|c| c.saturating_sub(1) as usize)
            .collect(),
    );
    Ok(normalized.into_iter().map(|c| (c + 1) as u16).collect())
}

#[tauri::command]
fn get_recording_preview(
    state: tauri::State<AppState>,
    channel: u16,
    max_points: usize,
) -> Result<PreviewResponse, String> {
    if channel == 0 {
        return Err("Channel must be greater than zero".into());
    }
    let preview = state
        .record_preview(channel.saturating_sub(1) as usize, max_points)
        .unwrap_or(PreviewResponse {
            points: Vec::new(),
            frame_count: 0,
            duration_ms: 0,
        });
    Ok(preview)
}

#[tauri::command]
fn save_buffered_recording_jsonl(
    state: tauri::State<AppState>,
    path: String,
) -> Result<(), String> {
    let data = state
        .record_data_snapshot()
        .ok_or_else(|| "No recording data available".to_string())?;
    write_buffer_as_jsonl(&path, &data)
}

#[tauri::command]
fn save_buffered_recording_wav(state: tauri::State<AppState>, path: String) -> Result<(), String> {
    let data = state
        .record_data_snapshot()
        .ok_or_else(|| "No recording data available".to_string())?;
    write_buffer_as_wav(&path, &data)
}

#[tauri::command]
fn load_recording(state: tauri::State<AppState>, path: String) -> Result<LoadedRecording, String> {
    let lower = path.to_lowercase();
    let (data, format) = if lower.ends_with(".wav") {
        let wav = load_wav_recording(path.clone())?;
        (record_data_from_wav(wav), "wav".to_string())
    } else {
        (parse_jsonl_file(&path)?, "jsonl".to_string())
    };

    let frames = data.frame_count();
    let duration = data.duration_ms();
    let last_address = data.last_address();
    let channels = data.channel_numbers();
    state.load_record_data(data, false);

    Ok(LoadedRecording {
        path,
        channels,
        frames,
        duration_ms: duration,
        last_address,
        format,
    })
}

#[tauri::command]
async fn play_file(state: tauri::State<'_, AppState>, path: String) -> Result<(), String> {
    // Stop prior play
    stop_playback(state.clone());
    let cfg = state.get_sender_config();
    let handle = tokio::spawn(async move {
        if let Err(e) = state::run_play_task(path, cfg).await {
            eprintln!("playback error: {e:?}");
        }
    });
    state.set_play_task(handle);
    Ok(())
}

#[tauri::command]
fn stop_playback(state: tauri::State<AppState>) {
    state.stop_playback();
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct EventFilter {
    net: u8,
    subnet: u8,
    universe: u8,
}

#[tauri::command]
fn set_event_filter(state: tauri::State<AppState>, filter: Option<EventFilter>) {
    let m = filter.map(|f| (f.net, f.subnet, f.universe));
    state.set_event_filter(m);
}

#[tauri::command]
fn write_text_file(path: String, content: String) -> Result<(), String> {
    std::fs::write(path, content).map_err(|e| e.to_string())
}

#[tauri::command]
fn read_text_file(path: String) -> Result<String, String> {
    println!("Reading text file from: {}", path);
    match std::fs::read_to_string(&path) {
        Ok(content) => {
            println!("Successfully read {} characters from file", content.len());
            Ok(content)
        }
        Err(e) => {
            println!("Failed to read file: {}", e);
            Err(e.to_string())
        }
    }
}

#[derive(serde::Serialize, serde::Deserialize)]
pub struct WavRecordingData {
    pub timestamps: Vec<u64>,
    pub channels: Vec<Vec<u8>>,
}

#[tauri::command]
fn save_wav_recording(
    path: String,
    sample_rate: u32,
    data: WavRecordingData,
) -> Result<(), String> {
    use std::io::Write;

    println!(
        "Saving WAV recording to: {} ({} frames, {} Hz)",
        path,
        data.timestamps.len(),
        sample_rate
    );

    let mut file = std::fs::File::create(&path).map_err(|e| e.to_string())?;

    // WAV header
    let num_channels = data.channels.len() as u16;
    let bits_per_sample = 8u16;
    let bytes_per_sample = bits_per_sample / 8;
    let block_align = num_channels * bytes_per_sample;
    let sample_rate = sample_rate as u32;
    let byte_rate = sample_rate * block_align as u32;
    let data_size = (data.timestamps.len() as u32) * block_align as u32;
    let file_size = 36 + data_size;

    // RIFF header
    file.write_all(b"RIFF").map_err(|e| e.to_string())?;
    file.write_all(&file_size.to_le_bytes())
        .map_err(|e| e.to_string())?;
    file.write_all(b"WAVE").map_err(|e| e.to_string())?;

    // fmt chunk
    file.write_all(b"fmt ").map_err(|e| e.to_string())?;
    file.write_all(&16u32.to_le_bytes())
        .map_err(|e| e.to_string())?; // chunk size
    file.write_all(&1u16.to_le_bytes())
        .map_err(|e| e.to_string())?; // PCM format
    file.write_all(&num_channels.to_le_bytes())
        .map_err(|e| e.to_string())?;
    file.write_all(&sample_rate.to_le_bytes())
        .map_err(|e| e.to_string())?;
    file.write_all(&byte_rate.to_le_bytes())
        .map_err(|e| e.to_string())?;
    file.write_all(&block_align.to_le_bytes())
        .map_err(|e| e.to_string())?;
    file.write_all(&bits_per_sample.to_le_bytes())
        .map_err(|e| e.to_string())?;

    // data chunk
    file.write_all(b"data").map_err(|e| e.to_string())?;
    file.write_all(&data_size.to_le_bytes())
        .map_err(|e| e.to_string())?;

    // Write sample data (interleaved channels)
    for frame_idx in 0..data.timestamps.len() {
        for ch in 0..num_channels as usize {
            let value = if ch < data.channels.len() && frame_idx < data.channels[ch].len() {
                data.channels[ch][frame_idx]
            } else {
                0
            };
            file.write_all(&[value]).map_err(|e| e.to_string())?;
        }
    }

    println!(
        "Successfully saved WAV file with {} frames",
        data.timestamps.len()
    );
    Ok(())
}

#[tauri::command]
fn load_wav_recording(path: String) -> Result<WavRecordingData, String> {
    use std::io::Read;

    println!("Loading WAV recording from: {}", path);

    let mut file = std::fs::File::open(&path).map_err(|e| e.to_string())?;
    let mut buffer = Vec::new();
    file.read_to_end(&mut buffer).map_err(|e| e.to_string())?;

    if buffer.len() < 44 {
        return Err("File too small to be a valid WAV file".to_string());
    }

    // Parse WAV header
    let mut pos = 0;

    // Check RIFF header
    if &buffer[pos..pos + 4] != b"RIFF" {
        return Err("Invalid RIFF header".to_string());
    }
    pos += 4;

    let _file_size = u32::from_le_bytes([
        buffer[pos],
        buffer[pos + 1],
        buffer[pos + 2],
        buffer[pos + 3],
    ]);
    pos += 4;

    if &buffer[pos..pos + 4] != b"WAVE" {
        return Err("Invalid WAVE header".to_string());
    }
    pos += 4;

    // Find fmt chunk
    let mut sample_rate = 44100u32; // Default sample rate
    let mut num_channels = 0u16;
    while pos < buffer.len() - 8 {
        let chunk_id = &buffer[pos..pos + 4];
        let chunk_size = u32::from_le_bytes([
            buffer[pos + 4],
            buffer[pos + 5],
            buffer[pos + 6],
            buffer[pos + 7],
        ]);
        pos += 8;

        if chunk_id == b"fmt " {
            if chunk_size < 16 {
                return Err("Invalid fmt chunk size".to_string());
            }

            let _format = u16::from_le_bytes([buffer[pos], buffer[pos + 1]]);
            num_channels = u16::from_le_bytes([buffer[pos + 2], buffer[pos + 3]]);
            sample_rate = u32::from_le_bytes([
                buffer[pos + 4],
                buffer[pos + 5],
                buffer[pos + 6],
                buffer[pos + 7],
            ]);
            let _byte_rate = u32::from_le_bytes([
                buffer[pos + 8],
                buffer[pos + 9],
                buffer[pos + 10],
                buffer[pos + 11],
            ]);
            let _block_align = u16::from_le_bytes([buffer[pos + 12], buffer[pos + 13]]);
            let bits_per_sample = u16::from_le_bytes([buffer[pos + 14], buffer[pos + 15]]);

            if bits_per_sample != 8 {
                return Err(format!(
                    "Expected 8 bits per sample, got {}",
                    bits_per_sample
                ));
            }

            println!(
                "WAV: {} channels, {} Hz, {} bits",
                num_channels, sample_rate, bits_per_sample
            );
            pos += chunk_size as usize;
            break;
        } else {
            pos += chunk_size as usize;
        }
    }

    // Find data chunk
    while pos < buffer.len() - 8 {
        let chunk_id = &buffer[pos..pos + 4];
        let chunk_size = u32::from_le_bytes([
            buffer[pos + 4],
            buffer[pos + 5],
            buffer[pos + 6],
            buffer[pos + 7],
        ]);
        pos += 8;

        if chunk_id == b"data" {
            // Read sample data
            let num_frames = chunk_size as usize / num_channels as usize;
            let mut timestamps = Vec::new();
            let mut channels = vec![Vec::new(); num_channels as usize];

            for frame_idx in 0..num_frames {
                timestamps.push((frame_idx as u64 * 1000) / sample_rate as u64); // Convert to milliseconds

                for ch in 0..num_channels as usize {
                    if pos < buffer.len() {
                        channels[ch].push(buffer[pos]);
                        pos += 1;
                    } else {
                        channels[ch].push(0);
                    }
                }
            }

            println!("Successfully loaded WAV file with {} frames", num_frames);
            return Ok(WavRecordingData {
                timestamps,
                channels,
            });
        } else {
            pos += chunk_size as usize;
        }
    }

    Err("No data chunk found in WAV file".to_string())
}

#[tauri::command]
async fn play_wav_file(state: tauri::State<'_, AppState>, path: String) -> Result<(), String> {
    // Stop prior play
    stop_playback(state.clone());

    // Load WAV data
    let wav_data = load_wav_recording(path)?;
    let cfg = state.get_sender_config();

    let handle = tokio::spawn(async move {
        if let Err(e) = state::run_wav_play_task(wav_data, cfg).await {
            eprintln!("WAV playback error: {e:?}");
        }
    });
    state.set_play_task(handle);
    Ok(())
}

#[tauri::command]
async fn start_animation(
    state: tauri::State<'_, AppState>,
    mode: String,
    frequency: f64,
    master_value: u8,
) -> Result<(), String> {
    // Stop existing animation
    state.stop_animation();

    // Update animation state - use existing methods
    state.set_animation_state(state::AnimationState {
        mode,
        frequency,
        master_value,
        is_running: true,
    });

    // Start new animation task
    let app_state = state.inner().clone();
    let handle = tokio::spawn(async move {
        if let Err(e) = state::run_animation_task(app_state).await {
            eprintln!("Animation task error: {e:?}");
        }
    });

    state.set_animation_task(handle);
    Ok(())
}

#[tauri::command]
fn stop_animation(state: tauri::State<AppState>) {
    state.stop_animation();
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::new())
        .setup(|app| {
            // try to load settings at startup so state is warm
            let path = settings_path(&app.handle());
            if let Ok(bytes) = std::fs::read(path) {
                if let Ok(cfg) = serde_json::from_slice::<SettingsFile>(&bytes) {
                    let state: tauri::State<AppState> = app.state();
                    state.set_receiver_config(cfg.receiver);
                    state.set_sender_config(cfg.sender);
                }
            }
            // Auto-start receiver on app launch (run inline to avoid 'static issues)
            {
                let app_handle = app.handle().clone();
                let state: tauri::State<AppState> = app.state();
                let _ = tauri::async_runtime::block_on(start_receiver(app_handle, state));
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_receiver_config,
            set_receiver_config,
            start_receiver,
            stop_receiver,
            get_sender_config,
            set_sender_config,
            start_sender,
            stop_sender,
            push_frame,
            set_channel,
            set_channels,
            save_settings,
            load_settings,
            start_recording,
            stop_recording,
            start_buffered_recording,
            stop_buffered_recording,
            clear_record_buffer,
            set_record_channels,
            get_recording_preview,
            save_buffered_recording_jsonl,
            save_buffered_recording_wav,
            load_recording,
            play_file,
            stop_playback,
            set_event_filter,
            write_text_file,
            read_text_file,
            start_animation,
            stop_animation,
            save_wav_recording,
            load_wav_recording,
            play_wav_file
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
