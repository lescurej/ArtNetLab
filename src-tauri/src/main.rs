#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod artnet;
mod state;

use std::{fs, path::PathBuf};

use anyhow::Result;
use serde::{Deserialize, Serialize};
use state::AppState;
use tauri::Manager;
use tokio::sync::mpsc;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct SettingsFile {
    receiver: artnet::ReceiverConfig,
    sender: artnet::SenderConfig,
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
    if let Ok(bytes) = fs::read(path) {
        if let Ok(cfg) = serde_json::from_slice::<SettingsFile>(&bytes) {
            state.set_receiver_config(cfg.receiver.clone());
            state.set_sender_config(cfg.sender.clone());
            return Ok(cfg);
        }
    }
    let def = SettingsFile::default();
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
struct EventFilter { net: u8, subnet: u8, universe: u8 }

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
    std::fs::read_to_string(path).map_err(|e| e.to_string())
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
            play_file,
            stop_playback,
            set_event_filter,
            write_text_file,
            read_text_file
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
