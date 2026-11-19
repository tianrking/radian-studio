use crate::protocol::{HTTP_PORT, VIDEO_PORT};
use futures_util::StreamExt;
use std::{
    io,
    net::Ipv4Addr,
    path::{Path, PathBuf},
    process::Stdio,
    sync::{Arc, Mutex},
    time::Duration,
};
use tauri::{AppHandle, Emitter};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWriteExt},
    net::UdpSocket,
    process::Command,
    sync::mpsc,
    time::timeout,
};
use tokio_util::sync::CancellationToken;

pub const FRAME_EVENT: &str = "preview-format";
pub const MAX_BOX: usize = 16 * 1024 * 1024;

pub fn ffmpeg() -> PathBuf {
    if let Some(value) = std::env::var_os("RADIAN_FFMPEG") {
        return value.into();
    }
    let name = if cfg!(windows) {
        "ffmpeg.exe"
    } else {
        "ffmpeg"
    };
    let sibling = std::env::current_exe()
        .ok()
        .and_then(|path| path.parent().map(|p| p.join(name)));
    if let Some(path) = sibling.filter(|p| p.is_file()) {
        return path;
    }
    if cfg!(target_os = "macos") {
        for dir in ["/opt/homebrew/bin", "/usr/local/bin"] {
            let path = Path::new(dir).join(name);
            if path.is_file() {
                return path;
            }
        }
    }
    name.into()
}

pub fn hidden_command(executable: &Path) -> Command {
    let mut command = Command::new(executable);
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    command.kill_on_drop(true);
    command
}

type Recording = Arc<Mutex<Option<ActiveRecording>>>;

#[derive(serde::Serialize, serde::Deserialize)]
pub struct Highlight {
    pub seconds: f64,
    pub label: String,
    pub score: f64,
}

pub struct ActiveRecording {
    pub temp: PathBuf,
    pub output: PathBuf,
    pub file: std::fs::File,
    pub started: Option<(u64, std::time::Instant)>,
    pub highlights: Vec<Highlight>,
}

impl ActiveRecording {
    pub fn finish(self) -> Result<Option<PathBuf>, String> {
        let Self {
            temp,
            output,
            file,
            started,
            highlights,
        } = self;
        let flushed = file.sync_all().map_err(|e| e.to_string());
        drop(file);
        if started.is_some() && flushed.is_ok() {
            std::fs::rename(&temp, &output).map_err(|e| e.to_string())?;
            if !highlights.is_empty() {
                let _ = std::fs::write(
                    output.with_extension("highlights.json"),
                    serde_json::to_vec(&highlights).unwrap_or_default(),
                );
            }
            return Ok(Some(output));
        }
        let _ = std::fs::remove_file(temp);
        flushed.map(|()| None)
    }

    pub fn add_highlights(&mut self, event: &serde_json::Value) {
        let Some((_, started)) = self.started else {
            return;
        };
        let seconds = started.elapsed().as_secs_f64();
        let Some(detections) = event["dets"].as_array() else {
            return;
        };
        for detection in detections {
            if self.highlights.len() >= 64 {
                break;
            }
            let (Some(label), Some(score)) =
                (detection["label"].as_str(), detection["score"].as_f64())
            else {
                continue;
            };
            if label.is_empty()
                || label.len() > 360
                || score < 0.55
                || score > 1.0
                || self
                    .highlights
                    .iter()
                    .any(|h| h.label == label && seconds - h.seconds < 10.0)
            {
                continue;
            }
            self.highlights.push(Highlight {
                seconds,
                label: label.to_owned(),
                score,
            });
        }
    }
}

fn record_part(
    recording: &Recording,
    init: &[u8],
    fragment: &[u8],
    keyframe: bool,
) -> Result<(), String> {
    use std::io::Write;
    let mut active = recording.lock().map_err(|e| e.to_string())?;
    let Some(recording) = active.as_mut() else {
        return Ok(());
    };
    if recording.started.is_none() && !keyframe {
        return Ok(());
    }
    let (offset, wide, decode_time) =
        fragment_decode_time(fragment).ok_or("Missing video fragment timestamp")?;
    let base = if let Some((base, _)) = recording.started {
        base
    } else {
        recording.file.write_all(init).map_err(|e| e.to_string())?;
        recording.started = Some((decode_time, std::time::Instant::now()));
        decode_time
    };
    let relative = decode_time
        .checked_sub(base)
        .ok_or("Video timestamps restarted during recording")?;
    let mut fragment = fragment.to_vec();
    if wide {
        fragment[offset..offset + 8].copy_from_slice(&relative.to_be_bytes());
    } else {
        fragment[offset..offset + 4].copy_from_slice(&(relative as u32).to_be_bytes());
    }
    recording
        .file
        .write_all(&fragment)
        .map_err(|e| e.to_string())
}

fn fragment_decode_time(fragment: &[u8]) -> Option<(usize, bool, u64)> {
    let end = number(fragment, 0)? as usize;
    let moof = fragment.get(8..end)?;
    let traffic = nested_box(moof, b"traf")?;
    let timestamp = nested_box(traffic, b"tfdt")?;
    let offset = timestamp.as_ptr() as usize - fragment.as_ptr() as usize + 4;
    match timestamp.first()? {
        0 => Some((offset, false, number(timestamp, 4)? as u64)),
        1 => Some((
            offset,
            true,
            u64::from_be_bytes(timestamp.get(4..12)?.try_into().ok()?),
        )),
        _ => None,
    }
}

pub async fn media_socket() -> Result<UdpSocket, String> {
    UdpSocket::bind((Ipv4Addr::UNSPECIFIED, VIDEO_PORT))
        .await
        .map_err(|e| format!("Cannot open video UDP port {VIDEO_PORT}: {e}"))
}

pub struct Pipeline {
    pub app: AppHandle,
    pub session: u32,
    pub host: Ipv4Addr,
    pub udp: Option<UdpSocket>,
    pub output: mpsc::Sender<Vec<u8>>,
    pub cancel: CancellationToken,
    pub recording: Recording,
}

impl Pipeline {
    pub async fn run(self) -> Result<(), String> {
        let mut child = hidden_command(&ffmpeg());
        child.args([
            "-hide_banner",
            "-loglevel",
            "error",
            "-fflags",
            "+discardcorrupt",
            "-f",
            "mpegts",
            "-probesize",
            "65536",
            "-analyzeduration",
            "250000",
            "-i",
            "pipe:0",
            "-map",
            "0:v:0",
            "-an",
            "-c:v",
            "copy",
            "-movflags",
            "+empty_moov+default_base_moof+frag_keyframe",
            "-frag_duration",
            "200000",
            "-flush_packets",
            "1",
            "-f",
            "mp4",
            "pipe:1",
        ]);
        let mut child = child
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("Could not launch FFmpeg: {e}"))?;
        let mut input = child.stdin.take().expect("piped stdin");
        let mut stdout = child.stdout.take().expect("piped stdout");
        let stderr = child.stderr.take().expect("piped stderr");
        let log_task = tokio::spawn(async move {
            let mut buf = Vec::new();
            let _ = stderr.take(4096).read_to_end(&mut buf).await;
            String::from_utf8_lossy(&buf).trim().to_owned()
        });

        let feed = async {
            if let Some(socket) = self.udp {
                let mut data = [0_u8; 65507];
                loop {
                    let (n, source) = timeout(Duration::from_secs(5), socket.recv_from(&mut data))
                        .await
                        .map_err(|_| "UDP preview stalled".to_string())?
                        .map_err(|e| e.to_string())?;
                    if source.ip() == self.host
                        && n != 0
                        && n <= 1316
                        && n % 188 == 0
                        && data[..n].chunks_exact(188).all(|packet| packet[0] == 0x47)
                    {
                        input
                            .write_all(&data[..n])
                            .await
                            .map_err(|e| e.to_string())?;
                    }
                }
            } else {
                let client = reqwest::Client::builder()
                    .no_proxy()
                    .redirect(reqwest::redirect::Policy::none())
                    .connect_timeout(Duration::from_secs(3))
                    .read_timeout(Duration::from_secs(5))
                    .build()
                    .map_err(|e| e.to_string())?;
                let url = format!("http://{}:{HTTP_PORT}/live.ts", self.host);
                let response = client
                    .get(url)
                    .send()
                    .await
                    .map_err(|e| format!("HTTP preview: {e}"))?;
                if response.status() != reqwest::StatusCode::OK {
                    return Err(format!("Video server returned HTTP {}", response.status()));
                }
                let kind = response
                    .headers()
                    .get(reqwest::header::CONTENT_TYPE)
                    .and_then(|t| t.to_str().ok())
                    .and_then(|t| t.split(';').next())
                    .unwrap_or("")
                    .trim();
                if !kind.eq_ignore_ascii_case("video/mp2t") {
                    return Err(format!("Unexpected video content type: {kind}"));
                }
                let mut bytes = response.bytes_stream();
                while let Some(chunk) = bytes.next().await {
                    let chunk = chunk.map_err(|e| format!("HTTP preview: {e}"))?;
                    input.write_all(&chunk).await.map_err(|e| e.to_string())?;
                }
                Err("Camera closed the HTTP video stream".to_owned())
            }
        };
        let emit = async {
            let mut init = Vec::new();
            let mut moof = Vec::new();
            loop {
                let part = read_box(&mut stdout)
                    .await
                    .map_err(|e| format!("Video demux: {e}"))?;
                match &part[4..8] {
                    b"ftyp" => init = part,
                    b"moov" => {
                        let codec =
                            avc_codec(&part).ok_or("MPEG-TS did not yield an AVC configuration")?;
                        init.extend(part);
                        self.app
                            .emit(
                                FRAME_EVENT,
                                serde_json::json!({"session": self.session, "codec": codec}),
                            )
                            .map_err(|e| e.to_string())?;
                        self.output
                            .send(init.clone())
                            .await
                            .map_err(|_| "Viewer closed")?;
                    }
                    b"moof" => moof = part,
                    b"mdat" if !moof.is_empty() => {
                        let independent = fragment_is_keyframe(&moof);
                        moof.extend(part);
                        if let Err(error) = record_part(&self.recording, &init, &moof, independent)
                        {
                            self.app.emit("recording-error", error).ok();
                            if let Ok(mut active) = self.recording.lock() {
                                if let Some(failed) = active.take() {
                                    let _ = failed.finish();
                                }
                            }
                        }
                        timeout(
                            Duration::from_secs(2),
                            self.output.send(std::mem::take(&mut moof)),
                        )
                        .await
                        .map_err(|_| "Viewer buffer stalled")?
                        .map_err(|_| "Viewer closed")?;
                    }
                    _ => (),
                }
            }
        };
        let result = tokio::select! {
            result = feed => result,
            result = emit => result,
            _ = self.cancel.cancelled() => Ok(()),
        };
        let _ = child.kill().await;
        let log = timeout(Duration::from_millis(300), log_task)
            .await
            .ok()
            .and_then(Result::ok)
            .unwrap_or_default();
        result.map_err(|error| {
            if log.is_empty() {
                error
            } else {
                format!("{error} · {log}")
            }
        })
    }
}

pub async fn read_box(reader: &mut (impl AsyncRead + Unpin)) -> io::Result<Vec<u8>> {
    let mut header = [0; 8];
    reader.read_exact(&mut header).await?;
    let size = u32::from_be_bytes(header[..4].try_into().unwrap()) as usize;
    if !(8..=MAX_BOX).contains(&size) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "Invalid fragmented MP4 box size",
        ));
    }
    let mut data = vec![0; size];
    data[..8].copy_from_slice(&header);
    reader.read_exact(&mut data[8..]).await?;
    Ok(data)
}

fn avc_codec(moov: &[u8]) -> Option<String> {
    let config = moov.windows(5).position(|w| w == b"avcC\x01")? + 5;
    let [profile, compat, level] = *<&[u8; 3]>::try_from(moov.get(config..config + 3)?).ok()?;
    Some(format!("avc1.{profile:02X}{compat:02X}{level:02X}"))
}

fn nested_box<'a>(mut data: &'a [u8], kind: &[u8; 4]) -> Option<&'a [u8]> {
    while data.len() >= 8 {
        let len = u32::from_be_bytes(data[..4].try_into().ok()?) as usize;
        if len < 8 || len > data.len() {
            return None;
        }
        if &data[4..8] == kind {
            return Some(&data[8..len]);
        }
        data = &data[len..];
    }
    None
}

fn number(data: &[u8], offset: usize) -> Option<u32> {
    Some(u32::from_be_bytes(
        data.get(offset..offset + 4)?.try_into().ok()?,
    ))
}

pub fn fragment_is_keyframe(moof: &[u8]) -> bool {
    let Some(traf) = moof.get(8..).and_then(|body| nested_box(body, b"traf")) else {
        return false;
    };
    let Some(trun) = nested_box(traf, b"trun") else {
        return false;
    };
    let flags = number(trun, 0).unwrap_or(0);
    let first = 8 + if flags & 1 != 0 { 4 } else { 0 };
    let sample_offset =
        first + if flags & 0x100 != 0 { 4 } else { 0 } + if flags & 0x200 != 0 { 4 } else { 0 };
    let sample_flags = if flags & 4 != 0 {
        number(trun, first)
    } else if flags & 0x400 != 0 {
        number(trun, sample_offset)
    } else if let Some(tfhd) = nested_box(traf, b"tfhd") {
        let f = number(tfhd, 0).unwrap_or(0);
        let offset = 8
            + if f & 1 != 0 { 8 } else { 0 }
            + if f & 2 != 0 { 4 } else { 0 }
            + if f & 8 != 0 { 4 } else { 0 }
            + if f & 16 != 0 { 4 } else { 0 };
        if f & 32 != 0 {
            number(tfhd, offset)
        } else {
            None
        }
    } else {
        None
    };
    sample_flags.is_some_and(|value| value & 0x10000 == 0 && value & 0x03000000 != 0x01000000)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn parses_real_ffmpeg_fragments_when_available() {
        let Ok(path) = std::env::var("RADIAN_FMP4_FIXTURE") else {
            return;
        };
        let mut file = tokio::fs::File::open(path).await.unwrap();
        let first = read_box(&mut file).await.unwrap();
        assert_eq!(&first[4..8], b"ftyp");
        let second = read_box(&mut file).await.unwrap();
        assert!(avc_codec(&second).unwrap().starts_with("avc1."));
        let third = read_box(&mut file).await.unwrap();
        assert!(fragment_is_keyframe(&third));
        let fourth = read_box(&mut file).await.unwrap();
        assert_eq!(&fourth[4..8], b"mdat");
        let fifth = read_box(&mut file).await.unwrap();
        assert!(!fragment_is_keyframe(&fifth));
    }
}
