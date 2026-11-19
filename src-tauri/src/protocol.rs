use futures_util::{StreamExt, future, stream};
use if_addrs::{IfAddr, Ifv4Addr};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::{BTreeMap, HashSet},
    io,
    net::{Ipv4Addr, SocketAddr, SocketAddrV4},
    time::Duration,
};
use tokio::{
    net::UdpSocket,
    time::{Instant, timeout, timeout_at},
};

pub const HTTP_PORT: u16 = 8554;
pub const VIDEO_PORT: u16 = 8555;
pub const CONTROL_PORT: u16 = 8556;
pub const AI_PORT: u16 = 8557;
pub const CLIP_SPACE: &str = "mobileclip2-s0-dfndr2b-v1";

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Version {
    pub major: u16,
    pub minor: u32,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Device {
    pub board: String,
    pub soc: String,
    pub sensor: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Preview {
    pub width: u32,
    pub height: u32,
    pub fps: f64,
    pub codec: String,
    pub transports: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Model {
    pub id: String,
    pub task: String,
    pub label: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ClipUser {
    pub model_id: String,
    pub embedding_space: String,
    pub dimensions: u32,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Ai {
    pub models: Vec<Model>,
    pub clip_user: Option<ClipUser>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Caps {
    pub protocol: Version,
    pub device: Device,
    pub preview: Option<Preview>,
    pub ai: Ai,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub controls: Option<Vec<String>>,
}

impl Caps {
    fn supports(&self, control: &str) -> bool {
        self.controls
            .as_ref()
            .is_none_or(|controls| controls.iter().any(|name| name == control))
    }
}

fn model_id(s: &str) -> bool {
    (1..=31).contains(&s.len())
        && s.as_bytes()[0].is_ascii_alphanumeric()
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
}

fn wire_name(s: &str) -> bool {
    (1..=64).contains(&s.len())
        && s.as_bytes()[0].is_ascii_lowercase()
        && s.bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
}

pub fn decode_caps(text: &str) -> Result<Caps, String> {
    let caps: Caps =
        serde_json::from_str(text).map_err(|e| format!("Invalid GET_CAPS JSON: {e}"))?;
    let Some(preview) = &caps.preview else {
        return Err("GET_CAPS has no preview profile".into());
    };
    if caps.protocol.major != 1 || caps.protocol.minor < 1 {
        return Err(format!(
            "Unsupported protocol {}.{}",
            caps.protocol.major, caps.protocol.minor
        ));
    }
    match &caps.controls {
        Some(controls) => {
            let mut defined = HashSet::new();
            if controls
                .iter()
                .any(|name| !wire_name(name) || !defined.insert(name))
            {
                return Err("Invalid GET_CAPS JSON: invalid or duplicate control name".into());
            }
        }
        None if caps.protocol.minor >= 2 => {
            return Err("Invalid GET_CAPS JSON: protocol v1.2 requires a controls array".into());
        }
        None => (),
    }
    if [
        &caps.device.board,
        &caps.device.soc,
        &caps.device.sensor,
        &preview.codec,
    ]
    .iter()
    .any(|s| s.is_empty())
        || preview.width == 0
        || preview.height == 0
        || !preview.fps.is_finite()
        || preview.fps <= 0.0
        || preview.transports.is_empty()
        || preview.transports.iter().any(String::is_empty)
        || preview.transports.iter().collect::<HashSet<_>>().len() != preview.transports.len()
    {
        return Err("Invalid capability profile".into());
    }
    let mut models = HashSet::new();
    for model in &caps.ai.models {
        if !model_id(&model.id)
            || !wire_name(&model.task)
            || !models.insert(&model.id)
            || model
                .label
                .as_ref()
                .is_some_and(|label| !(1..=64).contains(&label.chars().count()))
        {
            return Err("Invalid or duplicate AI model".into());
        }
    }
    if let Some(clip) = &caps.ai.clip_user {
        if clip.embedding_space.is_empty()
            || clip.dimensions == 0
            || !caps
                .ai
                .models
                .iter()
                .any(|m| m.id == clip.model_id && m.task == "open_vocab_search")
        {
            return Err("Invalid CLIP embedding descriptor".into());
        }
    }
    Ok(caps)
}

pub async fn request(
    host: Ipv4Addr,
    command: &str,
    wait_ms: u64,
    attempts: u8,
) -> Result<String, String> {
    let socket = UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0))
        .await
        .map_err(|e| e.to_string())?;
    socket
        .connect(SocketAddrV4::new(host, CONTROL_PORT))
        .await
        .map_err(|e| control_network_error(command, e))?;
    let mut buffer = vec![0; 65507];
    for _ in 0..attempts {
        socket
            .send(command.as_bytes())
            .await
            .map_err(|e| control_network_error(command, e))?;
        match timeout(Duration::from_millis(wait_ms), socket.recv(&mut buffer)).await {
            Ok(Ok(n)) => {
                return wire_reply(&buffer[..n]).map(str::to_owned);
            }
            Ok(Err(e)) => return Err(control_network_error(command, e)),
            Err(_) => (),
        }
    }
    Err(format!("{command} timed out at {host}:{CONTROL_PORT}"))
}

fn wire_reply(bytes: &[u8]) -> Result<&str, String> {
    let raw = std::str::from_utf8(bytes).map_err(|_| "Device sent invalid UTF-8")?;
    raw.strip_suffix('\n')
        .map(|text| text.trim_end_matches('\r'))
        .ok_or_else(|| "Device reply has no LF terminator".to_owned())
}

fn control_network_error(command: &str, error: io::Error) -> String {
    if cfg!(target_os = "macos")
        && matches!(
            error.kind(),
            io::ErrorKind::PermissionDenied | io::ErrorKind::BrokenPipe
        )
    {
        return format!(
            "{command}: {error}. Check Local Network access for Radian Studio in System Settings."
        );
    }
    format!("{command}: {error}")
}

pub async fn capabilities(host: Ipv4Addr, wait_ms: u64, attempts: u8) -> Result<Caps, String> {
    let reply = request(host, "GET_CAPS", wait_ms, attempts).await?;
    if reply != "ERR UNKNOWN" {
        return decode_caps(&reply);
    }
    #[derive(Deserialize)]
    struct Legacy {
        models: Vec<String>,
        current: String,
    }
    let fallback = request(host, "AI LIST", wait_ms, 1).await?;
    let legacy: Legacy =
        serde_json::from_str(&fallback).map_err(|_| "Could not confirm v1.0 compatibility")?;
    let mut seen = HashSet::new();
    if (!legacy.current.is_empty() && !model_id(&legacy.current))
        || legacy
            .models
            .iter()
            .any(|id| !model_id(id) || !seen.insert(id))
    {
        return Err("Invalid legacy model inventory".into());
    }
    let models = legacy
        .models
        .into_iter()
        .map(|id| {
            let task = match id.as_str() {
                "clip" => "open_vocab_search",
                "pose" => "pose_estimation",
                "seg" => "instance_segmentation",
                _ => "unknown",
            };
            Model {
                id,
                task: task.into(),
                label: None,
            }
        })
        .collect();
    Ok(Caps {
        protocol: Version { major: 1, minor: 0 },
        device: Device {
            board: "Radian v1.0".into(),
            soc: "Unknown".into(),
            sensor: "Unknown".into(),
        },
        preview: None,
        ai: Ai {
            models,
            clip_user: None,
        },
        controls: None,
    })
}

pub fn parse_host(host: &str) -> Result<Ipv4Addr, String> {
    let host = host
        .trim()
        .parse::<Ipv4Addr>()
        .map_err(|_| "Enter a valid IPv4 camera address")?;
    if host.is_unspecified() || host.is_multicast() || host.is_broadcast() {
        return Err("Enter a unicast IPv4 camera address".into());
    }
    Ok(host)
}

pub async fn discover(fallback: Option<Ipv4Addr>) -> Vec<(Ipv4Addr, Caps)> {
    let interfaces = if_addrs::get_if_addrs().unwrap_or_default();
    let mut addresses = HashSet::new();
    let networks = interfaces.into_iter().filter_map(|interface| {
        if !interface.is_oper_up() || interface.is_loopback() || interface.is_p2p() {
            return None;
        }
        let IfAddr::V4(network) = interface.addr else {
            return None;
        };
        ((1..=30).contains(&network.prefixlen)
            && !network.ip.is_unspecified()
            && addresses.insert((network.ip, network.netmask)))
        .then_some(network)
    });
    let broadcast_replies = future::join_all(networks.map(broadcast_caps)).await;
    let found = broadcast_replies
        .into_iter()
        .flatten()
        .collect::<BTreeMap<_, _>>();
    if let Some(address) = fallback
        && found.is_empty()
    {
        return scan_subnet(address).await;
    }
    found.into_iter().collect()
}

async fn broadcast_caps(network: Ifv4Addr) -> Vec<(Ipv4Addr, Caps)> {
    let Ok(socket) = UdpSocket::bind((network.ip, 0)).await else {
        return Vec::new();
    };
    let broadcast = directed_broadcast(network.ip, network.netmask);
    if socket.set_broadcast(true).is_err()
        || socket
            .send_to(b"GET_CAPS", (broadcast, CONTROL_PORT))
            .await
            .is_err()
    {
        return Vec::new();
    }
    let deadline = Instant::now() + Duration::from_millis(650);
    let mask = u32::from(network.netmask);
    let network_id = u32::from(network.ip) & mask;
    let mut bytes = vec![0; 65507];
    let mut found = BTreeMap::new();
    while let Ok(Ok((size, SocketAddr::V4(source)))) =
        timeout_at(deadline, socket.recv_from(&mut bytes)).await
    {
        if source.port() != CONTROL_PORT || u32::from(*source.ip()) & mask != network_id {
            continue;
        }
        if let Ok(caps) = wire_reply(&bytes[..size]).and_then(decode_caps) {
            found.insert(*source.ip(), caps);
        }
    }
    found.into_iter().collect()
}

fn directed_broadcast(address: Ipv4Addr, mask: Ipv4Addr) -> Ipv4Addr {
    Ipv4Addr::from(u32::from(address) | !u32::from(mask))
}

async fn scan_subnet(address: Ipv4Addr) -> Vec<(Ipv4Addr, Caps)> {
    let [a, b, c, _] = address.octets();
    let mut devices = stream::iter(1..=254)
        .map(|last| async move {
            let host = Ipv4Addr::new(a, b, c, last);
            capabilities(host, 220, 1)
                .await
                .ok()
                .map(|caps| (host, caps))
        })
        .buffer_unordered(32)
        .filter_map(std::future::ready)
        .collect::<Vec<_>>()
        .await;
    devices.sort_by_key(|(host, _)| *host);
    devices
}

pub fn command_allowed(cmd: &str, caps: &Caps) -> bool {
    if cmd.is_empty() || cmd.len() > 2047 || !cmd.bytes().all(|b| (32..=126).contains(&b)) {
        return false;
    }
    let parts: Vec<_> = cmd.split_ascii_whitespace().collect();
    match parts.as_slice() {
        ["STATUS" | "GET_CONFIG"] | ["AI", "LIST"] => true,
        ["HIGHLIGHTS" | "HIGHLIGHT_CLEAR"] => caps.supports("highlights"),
        ["TELEM"] => caps.supports("telemetry"),
        ["IDR"] => caps.supports("idr"),
        ["BITRATE", n] => caps.supports("bitrate") && integer_range(n, 200, 10000),
        ["GOP", n] => caps.supports("gop") && integer_range(n, 5, 120),
        ["MODE", "stream" | "ai" | "eco"] | ["AI", "ON" | "OFF"] => !caps.ai.models.is_empty(),
        ["ISP", "PRESET", "normal" | "aqua" | "dehaze" | "night"] => caps.supports("isp_preset"),
        ["ISP", wb, ev, shutter, iso] => {
            caps.supports("isp")
                && integer_range(wb, 0, 12000)
                && (*wb == "0" || integer_range(wb, 1500, 12000))
                && integer_range(ev, -30, 30)
                && integer_range(shutter, 0, 1_000_000)
                && integer_range(iso, 0, 102400)
        }
        ["ENHANCE", flags @ ..] => {
            caps.supports("enhance")
                && flags.len() == 5
                && flags.iter().all(|flag| matches!(*flag, "0" | "1"))
        }
        ["PRESET", name] => caps.supports("scene_preset") && model_id(name),
        ["AI", "MODEL", id] => caps.ai.models.iter().any(|model| model.id == *id),
        ["AI", "THRESH", conf, nms] => {
            !caps.ai.models.is_empty()
                && float_range(conf, 0.05, 0.95)
                && float_range(nms, 0.10, 0.95)
        }
        ["AI", "THRESH", conf] => !caps.ai.models.is_empty() && float_range(conf, 0.05, 0.95),
        ["AI", "INTERVAL", ms] => !caps.ai.models.is_empty() && integer_range(ms, 0, 5000),
        ["CLIP", "INFO" | "LIST" | "RELOAD"] => has_clip(caps),
        ["CLIP", "FILTER", filter @ ..] => {
            has_clip(caps) && filter.iter().all(|word| model_id(word))
        }
        ["CLIP", "MAP", "0" | "1"] | ["CLIP", "SRC", "bank"] => has_clip(caps),
        ["CLIP", "THRESH", value] => has_clip(caps) && float_range(value, 0.05, 0.50),
        ["CLIP", "SRC", "user"] => allows_embeddings(caps),
        _ => false,
    }
}

fn has_clip(caps: &Caps) -> bool {
    caps.ai
        .models
        .iter()
        .any(|model| model.task == "open_vocab_search")
}

pub fn allows_embeddings(caps: &Caps) -> bool {
    caps.ai.clip_user.as_ref().is_some_and(|clip| {
        clip.model_id == "clip" && clip.embedding_space == CLIP_SPACE && clip.dimensions == 512
    })
}

fn integer_range(s: &str, low: i32, high: i32) -> bool {
    s.parse::<i32>().is_ok_and(|n| (low..=high).contains(&n))
}

fn float_range(s: &str, low: f64, high: f64) -> bool {
    s.parse::<f64>().is_ok_and(|n| (low..=high).contains(&n))
}

pub fn reply_json(reply: &str) -> Result<Value, String> {
    if reply.starts_with("ERR ") {
        return Err(reply.to_owned());
    }
    if reply.starts_with("OK ") {
        return Ok(Value::String(reply.to_owned()));
    }
    serde_json::from_str(reply).map_err(|e| format!("Invalid reply: {e}"))
}

pub fn ai_event(bytes: &[u8]) -> Option<Value> {
    let event: Value = serde_json::from_slice(bytes).ok()?;
    let source = event.as_object()?;
    source.get("ts")?.as_u64()?;
    source.get("model")?.as_str()?;
    for field in ["w", "h"] {
        if !(1..=8192).contains(&source.get(field)?.as_u64()?) {
            return None;
        }
    }
    if source.get("dets")?.as_array()?.len() > 30 {
        return None;
    }
    Some(event)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn official_capabilities_when_available() {
        let Ok(path) = std::env::var("RADIAN_PROTOCOL_FIXTURE") else {
            return;
        };
        let caps = decode_caps(&std::fs::read_to_string(path).unwrap()).unwrap();
        assert_eq!(caps.protocol.major, 1);
        assert_eq!(caps.preview.unwrap().width, 1280);
    }

    #[test]
    fn preserves_minor_extensions_and_checks_semantics() {
        let fixture = r#"{"protocol":{"major":1,"minor":5},"device":{"board":"fixture","soc":"sim","sensor":"bars"},"preview":{"width":1280,"height":720,"fps":30,"codec":"h264","transports":["http-ts","future"]},"ai":{"models":[{"id":"custom","task":"future_task"}]},"controls":["idr","future_control"],"unknown":"ignored"}"#;
        let caps = decode_caps(fixture).unwrap();
        assert!(command_allowed("AI MODEL custom", &caps));
        assert!(!command_allowed("AI MODEL unknown", &caps));
        assert!(!command_allowed("IDR\nSTOP", &caps));
        assert!(decode_caps(&fixture.replace("\"major\":1", "\"major\":2")).is_err());
        assert!(decode_caps(&fixture.replace("\"fps\":30", "\"fps\":0")).is_err());
    }

    #[test]
    fn advertised_controls_gate_commands_and_empty_inventory_gates_ai() {
        let baseline = r#"{"protocol":{"major":1,"minor":1},"device":{"board":"fixture","soc":"sim","sensor":"bars"},"preview":{"width":2560,"height":1440,"fps":30,"codec":"h264","transports":["http-ts"]},"ai":{"models":[]}}"#;
        let old = decode_caps(baseline).unwrap();
        assert!(command_allowed("TELEM", &old));
        let missing = baseline.replace("\"minor\":1", "\"minor\":2");
        assert!(decode_caps(&missing).is_err());
        let updated = format!(
            r#"{},"controls":["bitrate","gop","idr","future_control"]}}"#,
            missing.strip_suffix('}').unwrap()
        );
        let new = decode_caps(&updated).unwrap();
        for command in ["STATUS", "AI LIST", "IDR", "BITRATE 7000", "GOP 30"] {
            assert!(command_allowed(command, &new), "{command}");
        }
        for command in [
            "TELEM",
            "HIGHLIGHTS",
            "ISP 0 0 0 0",
            "ISP PRESET aqua",
            "PRESET WIDE",
            "ENHANCE 1 0 0 0 0",
            "AI ON",
            "MODE eco",
        ] {
            assert!(!command_allowed(command, &new), "{command}");
        }
        let empty =
            decode_caps(&updated.replace(r#"["bitrate","gop","idr","future_control"]"#, "[]"))
                .unwrap();
        assert!(!command_allowed("IDR", &empty));
        assert!(decode_caps(&updated.replace("future_control", "gop")).is_err());
        assert!(decode_caps(&updated.replace("future_control", "Bad control")).is_err());
    }

    #[test]
    fn broadcast_obeys_interface_prefix() {
        let address = Ipv4Addr::new(169, 254, 38, 42);
        assert_eq!(
            directed_broadcast(address, Ipv4Addr::new(255, 255, 0, 0)),
            Ipv4Addr::new(169, 254, 255, 255)
        );
        assert_eq!(
            directed_broadcast(address, Ipv4Addr::new(255, 255, 255, 0)),
            Ipv4Addr::new(169, 254, 38, 255)
        );
    }
}
