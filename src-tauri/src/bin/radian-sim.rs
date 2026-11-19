use serde_json::{Value, json};
use std::{
    net::{Ipv4Addr, SocketAddr},
    path::PathBuf,
    process::Stdio,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream, UdpSocket},
    process::{Child, Command},
    time::{sleep, timeout},
};

const MOCK: &str = r#"{"protocol":{"major":1,"minor":1},"device":{"board":"Studio simulator","soc":"sg2002-sim","sensor":"720p test pattern"},"preview":{"width":1280,"height":720,"fps":30,"codec":"h264","transports":["http-ts","udp-ts"]},"ai":{"models":[{"id":"yolo11n","task":"object_detection"},{"id":"pose","task":"pose_estimation"},{"id":"seg","task":"segmentation"},{"id":"clip","task":"open_vocab_search"}],"clip_user":{"model_id":"clip","embedding_space":"mobileclip2-s0-dfndr2b-v1","dimensions":512}}}"#;

struct Camera {
    preview: Option<(SocketAddr, Instant)>,
    subscriber: Option<SocketAddr>,
    enabled: bool,
    model: String,
    bitrate: u32,
    gop: u32,
    clip_map: bool,
    source: String,
    terms: std::collections::BTreeMap<u32, String>,
}

impl Default for Camera {
    fn default() -> Self {
        Self {
            preview: None,
            subscriber: None,
            enabled: false,
            model: "yolo11n".into(),
            bitrate: 2000,
            gop: 30,
            clip_map: false,
            source: "bank".into(),
            terms: Default::default(),
        }
    }
}

fn stream(path: &PathBuf) -> std::io::Result<Child> {
    Command::new(std::env::var_os("RADIAN_FFMPEG").unwrap_or_else(|| "ffmpeg".into()))
        .args([
            "-hide_banner",
            "-loglevel",
            "error",
            "-nostdin",
            "-re",
            "-stream_loop",
            "-1",
            "-i",
        ])
        .arg(path)
        .args([
            "-map",
            "0:v:0",
            "-c:v",
            "copy",
            "-mpegts_pmt_start_pid",
            "0x1000",
            "-mpegts_start_pid",
            "0x0100",
            "-muxdelay",
            "0",
            "-flush_packets",
            "1",
            "-f",
            "mpegts",
            "pipe:1",
        ])
        .kill_on_drop(true)
        .stdout(Stdio::piped())
        .spawn()
}

async fn http(mut client: TcpStream, path: PathBuf) -> std::io::Result<()> {
    let request = timeout(Duration::from_secs(2), client.read_u8()).await;
    if !matches!(request, Ok(Ok(b'G'))) {
        return Ok(());
    }
    let mut matched = 0;
    while matched < 4 {
        let next = timeout(Duration::from_secs(2), client.read_u8()).await??;
        matched = if next == b"\r\n\r\n"[matched] {
            matched + 1
        } else {
            0
        };
    }
    client
        .write_all(b"HTTP/1.1 200 OK\r\nContent-Type: video/mp2t\r\nConnection: close\r\n\r\n")
        .await?;
    let mut process = stream(&path)?;
    let mut output = process.stdout.take().unwrap();
    let mut packets = [0_u8; 1237];
    loop {
        let size = output.read(&mut packets).await?;
        if size == 0 {
            return Ok(());
        }
        client.write_all(&packets[..size]).await?;
    }
}

fn handle(state: &mut Camera, source: SocketAddr, command: &str) -> String {
    let parts = command.split_whitespace().collect::<Vec<_>>();
    match parts.as_slice() {
        ["GET_CAPS"] => MOCK.to_owned(),
        ["AI", "LIST"] => json!({"models":["yolo11n","pose","seg","clip"],"current":state.model}).to_string(),
        ["START", port] => {
            let endpoint = SocketAddr::new(source.ip(), port.parse().unwrap_or(8555));
            state.preview = Some((endpoint,Instant::now()));
            format!("OK STARTED {endpoint}")
        }
        ["PING"] => {
            if let Some((_,last)) = state.preview.as_mut() { *last = Instant::now(); }
            format!("OK PONG {}", u8::from(state.preview.is_some()))
        }
        ["STOP"] => { state.preview = None; state.subscriber = None; "OK STOPPED".into() }
        ["AI", "SUB", port] => {
            let dest = SocketAddr::new(source.ip(), port.parse().unwrap_or(8557));
            state.subscriber = Some(dest); format!("OK AI SUB {dest}")
        }
        ["AI", "UNSUB"] => { state.subscriber = None; "OK AI UNSUB".into() }
        ["AI", "ON"] => { state.enabled = true; format!("OK AI ON model={}",state.model) }
        ["AI", "OFF"] => { state.enabled = false; "OK AI OFF".into() }
        ["AI", "MODEL", id @ ("yolo11n" | "pose" | "seg" | "clip")] => { state.model = id.to_string(); format!("OK AI MODEL {id}") }
        ["MODE", mode] => { state.enabled = *mode != "stream"; format!("OK MODE {mode}") }
        ["BITRATE", n] => { state.bitrate = n.parse().unwrap_or(2000); format!("OK {command}") }
        ["GOP", n] => { state.gop = n.parse().unwrap_or(30); format!("OK {command}") }
        ["STATUS" | "GET_CONFIG"] => json!({"streaming":u8::from(state.preview.is_some()),"fps":30,"bitrate":state.bitrate,
            "gop":state.gop,"ai_enabled":u8::from(state.enabled),"model":state.model,"conf":0.25,"nms":0.45,"infer_ms":37,
            "ai_fps":10,"mode":if state.enabled {"ai"} else {"stream"},"isp_preset":"normal","highlights":1}).to_string(),
        ["HIGHLIGHTS"] => json!({"count":1,"items":[{"ts":500,"label":"sea turtle","score":0.92}]}).to_string(),
        ["HIGHLIGHT_CLEAR"] => "OK HIGHLIGHTS CLEARED".into(),
        ["TELEM"] => "OK depth=0.0 temp=26.5 max_depth=0.0 dive_sec=0 vz=0.0".into(),
        ["CLIP", "INFO"] => json!({"src":state.source,"grid":[8,8],"thresh":0.2,"map":u8::from(state.clip_map),
            "dim":512,"max_user":32,"ids":state.terms.keys().collect::<Vec<_>>()}).to_string(),
        ["CLIP", "LIST"] => json!({"count":4,"total":4,"filter":"all","prompts":["sea turtle","a school of fish","coral reef","diver"]}).to_string(),
        ["CLIP", "MAP", value] => { state.clip_map = *value == "1"; format!("OK {command}") }
        ["CLIP", "SRC", src] => { state.source = src.to_string(); format!("OK {command}") }
        ["CLIP", "SET", id, label, scale, data] => {
            use base64::Engine;
            let decode = base64::engine::general_purpose::STANDARD;
            let valid = decode.decode(data).is_ok_and(|v| v.len() == 512 && v.iter().any(|b| *b != 0))
                && scale.parse::<f64>().is_ok_and(|n| n.is_finite() && n > 0.0);
            match (id.parse::<u32>(), decode.decode(label).ok().and_then(|b| String::from_utf8(b).ok())) {
                (Ok(id), Some(label)) if valid => { state.terms.insert(id, label); format!("OK CLIP SET {id}") }
                _ => "ERR CLIP_ARG".into(),
            }
        }
        ["CLIP", "DEL", id] => { if let Ok(id) = id.parse() { state.terms.remove(&id); } format!("OK {command}") }
        [first, ..] if matches!(*first,"ISP"|"ENHANCE"|"PRESET"|"CLIP"|"AI"|"IDR") => format!("OK {command}"),
        _ => "ERR UNKNOWN".into(),
    }
}

async fn udp_video(state: Arc<Mutex<Camera>>, path: PathBuf) {
    let Ok(socket) = UdpSocket::bind((Ipv4Addr::LOCALHOST, 0)).await else {
        return;
    };
    loop {
        sleep(Duration::from_millis(50)).await;
        let endpoint = state.lock().unwrap().preview.map(|(addr, _)| addr);
        let Some(endpoint) = endpoint else { continue };
        let Ok(mut process) = stream(&path) else {
            continue;
        };
        let mut output = process.stdout.take().unwrap();
        let mut packet = [0_u8; 188];
        while output.read_exact(&mut packet).await.is_ok() {
            let active = state.lock().unwrap().preview.is_some_and(|(addr, last)| {
                addr == endpoint && last.elapsed() < Duration::from_secs(8)
            });
            if !active {
                let mut state = state.lock().unwrap();
                if state
                    .preview
                    .is_some_and(|(_, last)| last.elapsed() >= Duration::from_secs(8))
                {
                    state.preview = None;
                }
                break;
            }
            if socket.send_to(&packet, endpoint).await.is_err() {
                break;
            }
        }
        let _ = process.kill().await;
    }
}

async fn events(state: Arc<Mutex<Camera>>) {
    let Ok(socket) = UdpSocket::bind((Ipv4Addr::LOCALHOST, 0)).await else {
        return;
    };
    let boot = Instant::now();
    loop {
        sleep(Duration::from_millis(100)).await;
        let event = {
            let state = state.lock().unwrap();
            if !state.enabled {
                continue;
            }
            state.subscriber.map(|subscriber| {
                let model = &state.model;
                let label = if model == "clip" && state.source == "user" {
                    state.terms.values().next().map(String::as_str).unwrap_or("sea turtle")
                } else if model == "pose" { "person" } else { "sea turtle" };
                let mut detection = json!({"cls":0,"label":label,"score":0.92,"x1":400,"y1":185,"x2":900,"y2":530});
                if model == "clip" {
                    detection["sim"] = json!(0.31);
                    if state.clip_map { detection["map"] = json!("8x8:0000000000111100013474100149f7400149f740013474100011110000000000"); }
                }
                let mut payload: Value = json!({"ts":boot.elapsed().as_millis(),"model":model,"w":1280,"h":720,"infer_ms":37.4,"dets":[detection]});
                if model == "seg" { payload["seg"] = json!({"w":8,"h":4,"rle":[0,11,1,4,0,4,1,4,0,9]}); }
                (subscriber,payload.to_string())
            })
        };
        if let Some((target, payload)) = event {
            let _ = socket.send_to(payload.as_bytes(), target).await;
        }
    }
}

#[tokio::main]
async fn main() -> std::io::Result<()> {
    let path: PathBuf = std::env::args_os()
        .nth(1)
        .expect("Pass a 720p30 H.264 MPEG-TS fixture")
        .into();
    if !path.is_file() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            "Fixture not found",
        ));
    }
    let path = path.canonicalize()?;
    let control = UdpSocket::bind((Ipv4Addr::LOCALHOST, 8556)).await?;
    let preview = TcpListener::bind((Ipv4Addr::LOCALHOST, 8554)).await?;
    let camera = Arc::new(Mutex::new(Camera::default()));
    tokio::spawn(udp_video(camera.clone(), path.clone()));
    tokio::spawn(events(camera.clone()));
    println!("Radian simulator at 127.0.0.1 · UDP control/AI and HTTP/UDP preview");
    let mut buffer = [0_u8; 2048];
    loop {
        tokio::select! {
            incoming = preview.accept() => {
                let (client,_) = incoming?;
                let copy = path.clone();
                tokio::spawn(async move { let _ = http(client,copy).await; });
            }
            datagram = control.recv_from(&mut buffer) => {
                let (len,source) = datagram?;
                if let Ok(command) = std::str::from_utf8(&buffer[..len]) {
                    let reply = handle(&mut camera.lock().unwrap(),source,command.trim_end());
                    control.send_to(format!("{reply}\n").as_bytes(),source).await?;
                }
            }
        }
    }
}
