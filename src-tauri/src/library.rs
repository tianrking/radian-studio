use crate::media::{ActiveRecording, Highlight, ffmpeg, hidden_command};
use serde::Serialize;
use std::{
    path::{Path, PathBuf},
    sync::atomic::{AtomicU32, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Manager};
use tokio::fs;

static NEXT: AtomicU32 = AtomicU32::new(0);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    pub name: String,
    pub path: String,
    pub kind: &'static str,
    pub bytes: u64,
    pub modified: u64,
    pub highlights: Vec<Highlight>,
}

pub fn media_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_local_data_dir()
        .map_err(|e| e.to_string())?
        .join("media");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn timestamp(time: SystemTime) -> u64 {
    time.duration_since(UNIX_EPOCH)
        .map(|value| value.as_millis() as u64)
        .unwrap_or(0)
}

fn new_name(extension: &str) -> String {
    format!(
        "RADIAN-{}-{}.{}",
        timestamp(SystemTime::now()),
        NEXT.fetch_add(1, Ordering::Relaxed),
        extension
    )
}

fn permitted_name(name: &str) -> bool {
    name.starts_with("RADIAN-")
        && name
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"-.".contains(&c))
        && (name.ends_with(".jpg") || name.ends_with(".mp4"))
}

pub fn begin_recording(app: &AppHandle) -> Result<ActiveRecording, String> {
    let output = media_dir(app)?.join(new_name("mp4"));
    let temp = output.with_extension("part");
    let file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temp)
        .map_err(|e| e.to_string())?;
    Ok(ActiveRecording {
        temp,
        output,
        file,
        started: None,
        highlights: Vec::new(),
    })
}

#[tauri::command]
pub async fn save_photo(app: AppHandle, image: Vec<u8>) -> Result<String, String> {
    if image.len() > 20 * 1024 * 1024
        || !image.starts_with(&[0xff, 0xd8, 0xff])
        || !image.ends_with(&[0xff, 0xd9])
    {
        return Err("Expected a JPEG image".into());
    }
    let name = new_name("jpg");
    fs::write(media_dir(&app)?.join(&name), image)
        .await
        .map_err(|e| e.to_string())?;
    Ok(name)
}

#[tauri::command]
pub async fn gallery(app: AppHandle) -> Result<Vec<Item>, String> {
    let mut dir = fs::read_dir(media_dir(&app)?)
        .await
        .map_err(|e| e.to_string())?;
    let mut items = Vec::new();
    while let Some(entry) = dir.next_entry().await.map_err(|e| e.to_string())? {
        let name = entry.file_name().to_string_lossy().into_owned();
        if !permitted_name(&name)
            || !entry
                .file_type()
                .await
                .map_err(|e| e.to_string())?
                .is_file()
        {
            continue;
        }
        let info = entry.metadata().await.map_err(|e| e.to_string())?;
        let highlights = if name.ends_with(".mp4") {
            let metadata_path = entry.path().with_extension("highlights.json");
            match fs::read(metadata_path).await {
                Ok(data) if data.len() <= 65536 => {
                    serde_json::from_slice(&data).unwrap_or_default()
                }
                _ => Vec::new(),
            }
        } else {
            Vec::new()
        };
        items.push(Item {
            highlights,
            kind: if name.ends_with(".mp4") {
                "video"
            } else {
                "photo"
            },
            name,
            path: entry.path().to_string_lossy().into_owned(),
            bytes: info.len(),
            modified: info.modified().map(timestamp).unwrap_or(0),
        });
    }
    items.sort_by_key(|item| std::cmp::Reverse(item.modified));
    Ok(items)
}

async fn item_path(app: &AppHandle, name: &str) -> Result<PathBuf, String> {
    if !permitted_name(name) {
        return Err("Invalid media name".into());
    }
    let file = media_dir(app)?.join(name);
    if !fs::symlink_metadata(&file)
        .await
        .map_err(|e| e.to_string())?
        .is_file()
    {
        return Err("Media file is missing".into());
    }
    Ok(file)
}

#[tauri::command]
pub async fn delete_media(app: AppHandle, name: String) -> Result<(), String> {
    let path = item_path(&app, &name).await?;
    fs::remove_file(&path).await.map_err(|e| e.to_string())?;
    if name.ends_with(".mp4") {
        let _ = fs::remove_file(path.with_extension("highlights.json")).await;
    }
    Ok(())
}

#[tauri::command]
pub async fn trim_media(
    app: AppHandle,
    name: String,
    from: f64,
    to: f64,
) -> Result<String, String> {
    if !name.ends_with(".mp4")
        || !from.is_finite()
        || !to.is_finite()
        || from < 0.0
        || to <= from
        || to - from > 86400.0
    {
        return Err("Enter a valid trim range in seconds".into());
    }
    let source = item_path(&app, &name).await?;
    let output = new_name("mp4");
    let path = media_dir(&app)?.join(&output);
    let temp = path.with_extension("part");
    let result = hidden_command(&ffmpeg())
        .args([
            "-hide_banner",
            "-loglevel",
            "error",
            "-nostdin",
            "-ss",
            &format!("{from:.3}"),
            "-i",
        ])
        .arg(source)
        .args([
            "-t",
            &format!("{:.3}", to - from),
            "-map",
            "0:v:0",
            "-c:v",
            "copy",
            "-avoid_negative_ts",
            "make_zero",
            "-movflags",
            "+faststart",
            "-f",
            "mp4",
        ])
        .arg(&temp)
        .output()
        .await
        .map_err(|e| e.to_string())?;
    if !result.status.success() {
        let _ = fs::remove_file(&temp).await;
        return Err(format!(
            "Trim failed: {}",
            String::from_utf8_lossy(&result.stderr)
        ));
    }
    fs::rename(temp, path).await.map_err(|e| e.to_string())?;
    Ok(output)
}

#[tauri::command]
pub async fn export_media(
    app: AppHandle,
    name: String,
    directory: String,
) -> Result<String, String> {
    let source = item_path(&app, &name).await?;
    let target = Path::new(&directory);
    if !target.is_absolute() || !fs::metadata(target).await.is_ok_and(|meta| meta.is_dir()) {
        return Err("Choose an existing absolute destination directory".into());
    }
    let target = target.join(name);
    let mut input = fs::File::open(source).await.map_err(|e| e.to_string())?;
    let mut destination = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&target)
        .await
        .map_err(|e| e.to_string())?;
    if let Err(error) = tokio::io::copy(&mut input, &mut destination).await {
        drop(destination);
        let _ = fs::remove_file(&target).await;
        return Err(error.to_string());
    }
    Ok(target.to_string_lossy().into_owned())
}
