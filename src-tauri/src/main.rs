#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod library;
mod media;
mod protocol;

use base64::Engine;
use media::{ActiveRecording, Pipeline};
use protocol::{AI_PORT, Caps, VIDEO_PORT, capabilities, parse_host, request};
use serde::Serialize;
use serde_json::{Value, json};
use std::{
    net::Ipv4Addr,
    sync::{Arc, Mutex},
    time::Duration,
};
use tauri::{AppHandle, Emitter, Manager, State, ipc::Response};
use tokio::{
    net::UdpSocket,
    sync::{Mutex as AsyncMutex, mpsc},
};
use tokio_util::sync::CancellationToken;

type Chunks = Arc<AsyncMutex<mpsc::Receiver<Vec<u8>>>>;
type Recording = Arc<Mutex<Option<ActiveRecording>>>;

struct Connection {
    id: u32,
    host: Ipv4Addr,
    caps: Caps,
    cancel: CancellationToken,
    chunks: Chunks,
    recording: Recording,
    task: tokio::task::JoinHandle<()>,
    udp: bool,
    ai: Option<tokio::task::JoinHandle<()>>,
}

impl Connection {
    async fn stop(self) {
        self.cancel.cancel();
        if self.udp {
            let _ = request(self.host, "STOP", 350, 1).await;
        } else if self.ai.is_some() {
            let _ = request(self.host, "AI UNSUB", 350, 1).await;
        }
        let _ = self.task.await;
        if let Some(ai) = self.ai {
            let _ = ai.await;
        }
        if let Ok(mut recording) = self.recording.lock() {
            if let Some(recording) = recording.take() {
                let _ = recording.finish();
            }
        }
    }
}

#[derive(Default)]
struct Studio(AsyncMutex<Option<Connection>>, Mutex<Option<Ipv4Addr>>);

#[tauri::command]
async fn connect_device(
    app: AppHandle,
    studio: State<'_, Studio>,
    host: String,
    transport: String,
    session: u32,
) -> Result<Caps, String> {
    let host = parse_host(&host)?;
    if !matches!(transport.as_str(), "http-ts" | "udp-ts") {
        return Err("Unknown video transport".into());
    }
    let mut current = studio.0.lock().await;
    let restore_ai = {
        let mut desired = studio.1.lock().map_err(|e| e.to_string())?;
        if *desired != Some(host) {
            *desired = None;
        }
        desired.is_some()
    };
    if let Some(old) = current.take() {
        old.stop().await;
    }
    let caps = capabilities(host, 750, 2).await?;
    if caps
        .preview
        .as_ref()
        .is_some_and(|profile| profile.codec != "h264" || !profile.transports.contains(&transport))
    {
        return Err(format!("Camera does not advertise H.264 over {transport}"));
    }
    let udp = transport == "udp-ts";
    let socket = if udp {
        let socket = media::media_socket().await?;
        let reply = request(host, &format!("START {VIDEO_PORT}"), 750, 1).await?;
        if !reply.starts_with("OK STARTED ") {
            return Err(reply);
        }
        Some(socket)
    } else {
        None
    };
    let cancel = CancellationToken::new();
    let (output, receiver) = mpsc::channel(6);
    let recording = Arc::new(Mutex::new(None));
    let pipeline = Pipeline {
        app: app.clone(),
        session,
        host,
        udp: socket,
        output,
        cancel: cancel.clone(),
        recording: recording.clone(),
    };
    let task_cancel = cancel.clone();
    let task_recording = recording.clone();
    let pipeline_app = app.clone();
    let task = tokio::spawn(async move {
        let app = pipeline_app;
        let heartbeat = async {
            if !udp {
                return std::future::pending::<Result<(), String>>().await;
            }
            let mut missed = 0;
            loop {
                tokio::time::sleep(Duration::from_secs(2)).await;
                match request(host, "PING", 600, 1).await.as_deref() {
                    Ok("OK PONG 1") => missed = 0,
                    Ok("OK PONG 0") => return Err("Camera stopped UDP streaming".into()),
                    _ if missed > 0 => return Err("Camera heartbeat timed out".into()),
                    _ => missed += 1,
                }
            }
        };
        let result = tokio::select! {
            result = pipeline.run() => result,
            result = heartbeat => result,
        };
        if let Ok(mut recording) = task_recording.lock() {
            if let Some(recording) = recording.take() {
                let saved = recording.finish().ok().flatten();
                app.emit("recording-ended", saved.is_some()).ok();
            }
        }
        if !task_cancel.is_cancelled() {
            if let Err(error) = result {
                app.emit("preview-ended", json!({ "session":session, "error":error }))
                    .ok();
            }
            task_cancel.cancel();
        }
    });
    let mut connection = Connection {
        id: session,
        host,
        caps: caps.clone(),
        cancel,
        chunks: Arc::new(AsyncMutex::new(receiver)),
        recording,
        task,
        udp,
        ai: None,
    };
    if restore_ai && let Err(error) = subscribe(&app, &mut connection).await {
        app.emit("ai-error", error).ok();
    }
    *current = Some(connection);
    Ok(caps)
}

#[tauri::command]
async fn disconnect_device(studio: State<'_, Studio>, session: u32) -> Result<(), String> {
    let mut current = studio.0.lock().await;
    if current
        .as_ref()
        .is_none_or(|connection| connection.id == session)
    {
        *studio.1.lock().map_err(|e| e.to_string())? = None;
        if let Some(connection) = current.take() {
            connection.stop().await;
        }
    }
    Ok(())
}

#[tauri::command]
async fn read_preview_chunk(studio: State<'_, Studio>, session: u32) -> Result<Response, String> {
    let chunks = studio
        .0
        .lock()
        .await
        .as_ref()
        .filter(|c| c.id == session)
        .map(|c| c.chunks.clone())
        .ok_or("Preview session changed")?;
    let mut receiver = chunks.lock().await;
    receiver
        .recv()
        .await
        .map(Response::new)
        .ok_or_else(|| "Preview ended".into())
}

#[derive(Serialize)]
struct FoundDevice {
    host: String,
    caps: Caps,
}

#[tauri::command]
async fn discover(host: String) -> Result<Vec<FoundDevice>, String> {
    Ok(protocol::discover(parse_host(&host).ok())
        .await
        .into_iter()
        .map(|(ip, caps)| FoundDevice {
            host: ip.to_string(),
            caps,
        })
        .collect())
}

async fn subscribe(app: &AppHandle, connection: &mut Connection) -> Result<(), String> {
    if connection.ai.is_some() || connection.caps.ai.models.is_empty() {
        return Ok(());
    }
    let socket = UdpSocket::bind((Ipv4Addr::UNSPECIFIED, AI_PORT))
        .await
        .map_err(|e| format!("AI port {AI_PORT}: {e}"))?;
    let reply = request(connection.host, &format!("AI SUB {AI_PORT}"), 750, 1).await?;
    if !reply.starts_with("OK AI SUB ") {
        return Err(reply);
    }
    let id = connection.id;
    let host = connection.host;
    let app = app.clone();
    let cancel = connection.cancel.clone();
    let recording = connection.recording.clone();
    connection.ai = Some(tokio::spawn(async move {
        let mut bytes = vec![0; 65507];
        loop {
            let result = tokio::select! {
                value = socket.recv_from(&mut bytes) => value,
                _ = cancel.cancelled() => break,
            };
            let Ok((size, source)) = result else { break };
            if source.ip() != host {
                continue;
            }
            if let Some(data) = protocol::ai_event(&bytes[..size]) {
                if let Ok(mut active) = recording.lock()
                    && let Some(recording) = active.as_mut()
                {
                    recording.add_highlights(&data);
                }
                let _ = app.emit("ai-frame", json!({ "session":id, "data":data }));
            }
        }
    }));
    Ok(())
}

#[tauri::command]
async fn control(
    app: AppHandle,
    studio: State<'_, Studio>,
    session: u32,
    command: String,
) -> Result<Value, String> {
    let mut current = studio.0.lock().await;
    let connection = current
        .as_mut()
        .filter(|c| c.id == session && !c.cancel.is_cancelled())
        .ok_or("Camera is disconnected")?;
    if !protocol::command_allowed(&command, &connection.caps) {
        return Err("Unsupported command or parameters".into());
    }
    if matches!(command.as_str(), "AI ON" | "MODE ai" | "MODE eco") {
        subscribe(&app, connection).await?;
        *studio.1.lock().map_err(|e| e.to_string())? = Some(connection.host);
    }
    let wait = if command.starts_with("CLIP ") {
        2750
    } else {
        900
    };
    protocol::reply_json(&request(connection.host, &command, wait, 1).await?)
}

#[tauri::command]
async fn clip_prompt(
    studio: State<'_, Studio>,
    session: u32,
    id: u32,
    label: Option<String>,
    vector: Option<Vec<f32>>,
) -> Result<Value, String> {
    let current = studio.0.lock().await;
    let connection = current
        .as_ref()
        .filter(|c| c.id == session && !c.cancel.is_cancelled())
        .ok_or("Camera is disconnected")?;
    if !protocol::allows_embeddings(&connection.caps) || !(1..=2147483647).contains(&id) {
        return Err("Camera does not declare a compatible CLIP embedding space".into());
    }
    let command = match (label, vector) {
        (Some(label), Some(vector)) => {
            if label.trim().is_empty()
                || label.len() > 95
                || vector.len() != 512
                || vector.iter().any(|f| !f.is_finite())
            {
                return Err("Invalid prompt or 512-dimensional vector".into());
            }
            let peak = vector
                .iter()
                .fold(0.0_f32, |peak, value| peak.max(value.abs()));
            if peak < 1e-12 {
                return Err("Embedding is empty".into());
            }
            let scale = peak / 127.0;
            let quantized = vector
                .iter()
                .map(|value| (value / scale).round().clamp(-127.0, 127.0) as i8 as u8)
                .collect::<Vec<_>>();
            let b64 = base64::engine::general_purpose::STANDARD;
            format!(
                "CLIP SET {id} {} {scale:.9} {}",
                b64.encode(label.as_bytes()),
                b64.encode(quantized)
            )
        }
        (None, None) => format!("CLIP DEL {id}"),
        _ => return Err("Missing prompt data".into()),
    };
    protocol::reply_json(&request(connection.host, &command, 2750, 1).await?)
}

#[tauri::command]
async fn record_clip(
    app: AppHandle,
    studio: State<'_, Studio>,
    session: u32,
    start: bool,
) -> Result<Option<String>, String> {
    let current = studio.0.lock().await;
    let connection = current
        .as_ref()
        .filter(|c| c.id == session)
        .ok_or("Camera is disconnected")?;
    let mut recording = connection.recording.lock().map_err(|e| e.to_string())?;
    if start {
        if connection.cancel.is_cancelled() {
            return Err("Preview is offline".into());
        }
        if recording.is_some() {
            return Err("Recording is already active".into());
        }
        *recording = Some(library::begin_recording(&app)?);
        Ok(None)
    } else {
        let finished = recording.take().ok_or("No recording is active")?.finish()?;
        Ok(finished.and_then(|path| {
            path.file_name()
                .map(|name| name.to_string_lossy().into_owned())
        }))
    }
}

#[tauri::command]
async fn open_network_settings() -> Result<(), String> {
    let (program, argument) = if cfg!(target_os = "macos") {
        (
            "open",
            "x-apple.systempreferences:com.apple.wifi-settings-extension",
        )
    } else if cfg!(windows) {
        ("explorer.exe", "ms-settings:network-wifi")
    } else {
        ("nm-connection-editor", "")
    };
    let mut proc = std::process::Command::new(program);
    if !argument.is_empty() {
        proc.arg(argument);
    }
    proc.spawn()
        .map_err(|e| format!("Open Wi-Fi settings from your system menu: {e}"))?;
    Ok(())
}

fn main() {
    tauri::Builder::default()
        .manage(Studio::default())
        .invoke_handler(tauri::generate_handler![
            connect_device,
            disconnect_device,
            discover,
            read_preview_chunk,
            control,
            clip_prompt,
            record_clip,
            open_network_settings,
            library::save_photo,
            library::gallery,
            library::delete_media,
            library::trim_media,
            library::export_media
        ])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let app = window.app_handle().clone();
                tauri::async_runtime::spawn(async move {
                    let state = app.state::<Studio>();
                    if let Some(connection) = state.0.lock().await.take() {
                        connection.stop().await;
                    }
                    app.exit(0);
                });
            }
        })
        .run(tauri::generate_context!())
        .expect("Radian Studio could not start");
}
