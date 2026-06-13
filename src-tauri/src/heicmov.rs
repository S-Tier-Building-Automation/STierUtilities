use serde::{Deserialize, Serialize};
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::time::SystemTime;
use tauri::{AppHandle, Manager};
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_shell::process::Output;
use tauri_plugin_shell::ShellExt;

const MEDIA_FILTER: &[&str] = &["heic", "heif", "mov"];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MediaKind {
    Image,
    Video,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ImageFormat {
    Jpeg,
    Png,
}

impl Default for ImageFormat {
    fn default() -> Self {
        Self::Jpeg
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProbeResult {
    pub path: String,
    pub kind: MediaKind,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub duration_sec: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PreviewResult {
    pub preview_path: String,
    pub mime: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConvertFileResult {
    pub input: String,
    pub output: String,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConvertBatchResult {
    pub results: Vec<ConvertFileResult>,
}

fn media_kind(path: &Path) -> Option<MediaKind> {
    let ext = path.extension()?.to_str()?.to_lowercase();
    match ext.as_str() {
        "heic" | "heif" => Some(MediaKind::Image),
        "mov" => Some(MediaKind::Video),
        _ => None,
    }
}

fn is_supported_media(path: &Path) -> bool {
    media_kind(path).is_some()
}

fn cache_key(path: &Path) -> Result<String, String> {
    let meta = std::fs::metadata(path).map_err(|e| e.to_string())?;
    let modified = meta
        .modified()
        .unwrap_or(SystemTime::UNIX_EPOCH)
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let mut hasher = DefaultHasher::new();
    path.to_string_lossy().hash(&mut hasher);
    modified.hash(&mut hasher);
    Ok(format!("{:016x}", hasher.finish()))
}

fn heicmov_cache_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?
        .join("heicmov");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// Evict oldest cache files until the directory is under `max_bytes`. Returns the
/// number of files removed. The preview cache is keyed by path+mtime and never
/// self-expires, so this keeps it bounded (addresses the unbounded-growth gap).
fn prune_cache(dir: &Path, max_bytes: u64) -> Result<usize, String> {
    if !dir.exists() {
        return Ok(0);
    }
    let mut files: Vec<(PathBuf, u64, SystemTime)> = Vec::new();
    let mut total: u64 = 0;
    for entry in std::fs::read_dir(dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let meta = match entry.metadata() {
            Ok(m) if m.is_file() => m,
            _ => continue,
        };
        total += meta.len();
        files.push((entry.path(), meta.len(), meta.modified().unwrap_or(SystemTime::UNIX_EPOCH)));
    }
    if total <= max_bytes {
        return Ok(0);
    }
    files.sort_by_key(|f| f.2); // oldest first
    let mut removed = 0;
    let mut running = total;
    for (path, size, _) in files {
        if running <= max_bytes {
            break;
        }
        if std::fs::remove_file(&path).is_ok() {
            running -= size;
            removed += 1;
        }
    }
    Ok(removed)
}

/// Prune the preview cache to a budget (default 512 MiB).
#[tauri::command]
pub async fn heicmov_prune_cache(app: AppHandle, max_bytes: Option<u64>) -> Result<usize, String> {
    let dir = heicmov_cache_dir(&app)?;
    prune_cache(&dir, max_bytes.unwrap_or(512 * 1024 * 1024))
}

/// Delete the entire preview cache. Returns the number of files removed.
#[tauri::command]
pub async fn heicmov_clear_cache(app: AppHandle) -> Result<usize, String> {
    let dir = heicmov_cache_dir(&app)?;
    let mut removed = 0;
    if dir.exists() {
        for entry in std::fs::read_dir(&dir).map_err(|e| e.to_string())? {
            if let Ok(e) = entry {
                if e.metadata().map(|m| m.is_file()).unwrap_or(false) && std::fs::remove_file(e.path()).is_ok() {
                    removed += 1;
                }
            }
        }
    }
    Ok(removed)
}

fn sidecar_output(output: Output) -> Result<(), String> {
    if output.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&output.stderr);
    let stdout = String::from_utf8_lossy(&output.stdout);
    let msg = if stderr.trim().is_empty() {
        stdout.trim().to_string()
    } else {
        stderr.trim().to_string()
    };
    if msg.is_empty() {
        Err(format!("ffmpeg exited with status {:?}", output.status.code()))
    } else {
        Err(msg)
    }
}

async fn run_sidecar(app: &AppHandle, name: &str, args: Vec<String>) -> Result<(), String> {
    let output = app
        .shell()
        .sidecar(name)
        .map_err(|e| e.to_string())?
        .args(args)
        .output()
        .await
        .map_err(|e| e.to_string())?;
    sidecar_output(output)
}

async fn run_ffmpeg(app: &AppHandle, args: Vec<String>) -> Result<(), String> {
    run_sidecar(app, "binaries/ffmpeg", args).await
}

async fn run_ffprobe(app: &AppHandle, args: Vec<String>) -> Result<String, String> {
    let output = app
        .shell()
        .sidecar("binaries/ffprobe")
        .map_err(|e| e.to_string())?
        .args(args)
        .output()
        .await
        .map_err(|e| e.to_string())?;
    if output.status.success() {
        return Ok(String::from_utf8_lossy(&output.stdout).to_string());
    }
    let stderr = String::from_utf8_lossy(&output.stderr);
    Err(stderr.trim().to_string())
}

fn output_path_for(
    input: &Path,
    output_dir: Option<&Path>,
    image_format: ImageFormat,
) -> PathBuf {
    let stem = input
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "output".into());
    let ext = match media_kind(input) {
        Some(MediaKind::Image) => match image_format {
            ImageFormat::Jpeg => "jpg",
            ImageFormat::Png => "png",
        },
        Some(MediaKind::Video) => "mp4",
        None => "out",
    };
    let dir = output_dir.unwrap_or_else(|| input.parent().unwrap_or(Path::new(".")));
    dir.join(format!("{stem}.{ext}"))
}

#[tauri::command]
pub fn heicmov_pick_files() -> Option<Vec<String>> {
    let picked = rfd::FileDialog::new()
        .add_filter("HEIC, HEIF & MOV", MEDIA_FILTER)
        .pick_files()?;
    let paths: Vec<String> = picked
        .into_iter()
        .filter(|p| is_supported_media(p))
        .map(|p| p.to_string_lossy().into_owned())
        .collect();
    if paths.is_empty() {
        None
    } else {
        Some(paths)
    }
}

#[tauri::command]
pub fn heicmov_pick_output_dir() -> Option<String> {
    rfd::FileDialog::new()
        .pick_folder()
        .map(|p| p.to_string_lossy().into_owned())
}

#[tauri::command]
pub async fn heicmov_probe(app: AppHandle, path: String) -> Result<ProbeResult, String> {
    let path_buf = PathBuf::from(&path);
    let kind = media_kind(&path_buf).ok_or_else(|| "unsupported file type".to_string())?;

    let json = run_ffprobe(
        &app,
        vec![
            "-v".into(),
            "quiet".into(),
            "-print_format".into(),
            "json".into(),
            "-show_format".into(),
            "-show_streams".into(),
            path.clone(),
        ],
    )
    .await?;

    let value: serde_json::Value =
        serde_json::from_str(&json).map_err(|e| format!("ffprobe JSON parse failed: {e}"))?;

    let streams = value
        .get("streams")
        .and_then(|s| s.as_array())
        .cloned()
        .unwrap_or_default();

    let mut width = None;
    let mut height = None;
    let mut duration_sec = value
        .get("format")
        .and_then(|f| f.get("duration"))
        .and_then(|d| d.as_str())
        .and_then(|d| d.parse::<f64>().ok());

    let stream_type = match kind {
        MediaKind::Image => "video",
        MediaKind::Video => "video",
    };

    for stream in streams {
        if stream.get("codec_type").and_then(|t| t.as_str()) != Some(stream_type) {
            continue;
        }
        width = stream.get("width").and_then(|w| w.as_u64()).map(|w| w as u32);
        height = stream
            .get("height")
            .and_then(|h| h.as_u64())
            .map(|h| h as u32);
        if duration_sec.is_none() {
            duration_sec = stream
                .get("duration")
                .and_then(|d| d.as_str())
                .and_then(|d| d.parse::<f64>().ok());
        }
        break;
    }

    Ok(ProbeResult {
        path,
        kind,
        width,
        height,
        duration_sec,
    })
}

#[tauri::command]
pub async fn heicmov_make_preview(app: AppHandle, path: String) -> Result<PreviewResult, String> {
    let input = PathBuf::from(&path);
    let kind = media_kind(&input).ok_or_else(|| "unsupported file type".to_string())?;
    let cache_dir = heicmov_cache_dir(&app)?;
    let key = cache_key(&input)?;
    let preview_path = match kind {
        MediaKind::Image => cache_dir.join(format!("{key}.jpg")),
        MediaKind::Video => cache_dir.join(format!("{key}.mp4")),
    };

    if preview_path.exists() {
        return Ok(PreviewResult {
            preview_path: preview_path.to_string_lossy().into_owned(),
            mime: match kind {
                MediaKind::Image => "image/jpeg".into(),
                MediaKind::Video => "video/mp4".into(),
            },
        });
    }

    match kind {
        MediaKind::Image => {
            run_ffmpeg(
                &app,
                vec![
                    "-y".into(),
                    "-i".into(),
                    path.clone(),
                    "-vf".into(),
                    "scale='min(1920,iw)':-2".into(),
                    "-q:v".into(),
                    "3".into(),
                    preview_path.to_string_lossy().into_owned(),
                ],
            )
            .await?;
            Ok(PreviewResult {
                preview_path: preview_path.to_string_lossy().into_owned(),
                mime: "image/jpeg".into(),
            })
        }
        MediaKind::Video => {
            run_ffmpeg(
                &app,
                vec![
                    "-y".into(),
                    "-i".into(),
                    path.clone(),
                    "-t".into(),
                    "30".into(),
                    "-c:v".into(),
                    "libx264".into(),
                    "-preset".into(),
                    "veryfast".into(),
                    "-crf".into(),
                    "28".into(),
                    "-c:a".into(),
                    "aac".into(),
                    "-b:a".into(),
                    "128k".into(),
                    "-movflags".into(),
                    "+faststart".into(),
                    preview_path.to_string_lossy().into_owned(),
                ],
            )
            .await?;
            Ok(PreviewResult {
                preview_path: preview_path.to_string_lossy().into_owned(),
                mime: "video/mp4".into(),
            })
        }
    }
}

#[tauri::command]
pub async fn heicmov_convert(
    app: AppHandle,
    paths: Vec<String>,
    output_dir: Option<String>,
    image_format: Option<ImageFormat>,
    overwrite: Option<bool>,
) -> Result<ConvertBatchResult, String> {
    let image_format = image_format.unwrap_or_default();
    let overwrite = overwrite.unwrap_or(false);
    let out_dir = output_dir
        .map(PathBuf::from)
        .filter(|p| !p.as_os_str().is_empty());

    if let Some(ref dir) = out_dir {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }

    let mut results = Vec::with_capacity(paths.len());

    for path in paths {
        let input = PathBuf::from(&path);
        if !is_supported_media(&input) {
            results.push(ConvertFileResult {
                input: path.clone(),
                output: String::new(),
                ok: false,
                error: Some("unsupported file type".into()),
            });
            continue;
        }

        let output = output_path_for(
            &input,
            out_dir.as_deref(),
            image_format,
        );

        if output.exists() && !overwrite {
            results.push(ConvertFileResult {
                input: path.clone(),
                output: output.to_string_lossy().into_owned(),
                ok: false,
                error: Some("output already exists (enable overwrite to replace)".into()),
            });
            continue;
        }

        let convert_result = match media_kind(&input) {
            Some(MediaKind::Image) => convert_image(&app, &path, &output, image_format).await,
            Some(MediaKind::Video) => convert_video(&app, &path, &output).await,
            None => Err("unsupported file type".into()),
        };

        match convert_result {
            Ok(()) => results.push(ConvertFileResult {
                input: path,
                output: output.to_string_lossy().into_owned(),
                ok: true,
                error: None,
            }),
            Err(err) => results.push(ConvertFileResult {
                input: path,
                output: output.to_string_lossy().into_owned(),
                ok: false,
                error: Some(err),
            }),
        }
    }

    Ok(ConvertBatchResult { results })
}

async fn convert_image(
    app: &AppHandle,
    input: &str,
    output: &Path,
    format: ImageFormat,
) -> Result<(), String> {
    let out = output.to_string_lossy().into_owned();
    let mut args = vec!["-y".into(), "-i".into(), input.to_string()];
    match format {
        ImageFormat::Jpeg => {
            args.extend(["-q:v".into(), "2".into()]);
        }
        ImageFormat::Png => {
            args.extend(["-compression_level".into(), "6".into()]);
        }
    }
    args.push(out);
    run_ffmpeg(app, args).await
}

async fn convert_video(app: &AppHandle, input: &str, output: &Path) -> Result<(), String> {
    run_ffmpeg(
        app,
        vec![
            "-y".into(),
            "-i".into(),
            input.to_string(),
            "-c:v".into(),
            "libx264".into(),
            "-preset".into(),
            "medium".into(),
            "-crf".into(),
            "23".into(),
            "-c:a".into(),
            "aac".into(),
            "-b:a".into(),
            "192k".into(),
            "-movflags".into(),
            "+faststart".into(),
            output.to_string_lossy().into_owned(),
        ],
    )
    .await
}

#[tauri::command]
pub async fn heicmov_open_path(app: AppHandle, path: String) -> Result<(), String> {
    app.opener()
        .open_path(path, None::<&str>)
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dir_total(dir: &Path) -> u64 {
        std::fs::read_dir(dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter_map(|e| e.metadata().ok())
            .filter(|m| m.is_file())
            .map(|m| m.len())
            .sum()
    }

    #[test]
    fn prune_cache_evicts_down_to_budget() {
        let dir = std::env::temp_dir().join(format!("stier_heicmov_prune_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        // 5 files of 1 KiB each = 5 KiB total.
        for i in 0..5 {
            std::fs::write(dir.join(format!("f{i}.bin")), vec![0u8; 1024]).unwrap();
        }
        assert_eq!(dir_total(&dir), 5 * 1024);

        // Prune to 2 KiB: should remove at least 3 files and leave <= budget.
        let removed = prune_cache(&dir, 2 * 1024).unwrap();
        assert!(removed >= 3, "expected to evict at least 3 files, got {removed}");
        assert!(dir_total(&dir) <= 2 * 1024);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn prune_cache_noop_when_under_budget() {
        let dir = std::env::temp_dir().join(format!("stier_heicmov_under_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("a.bin"), vec![0u8; 100]).unwrap();
        assert_eq!(prune_cache(&dir, 10 * 1024).unwrap(), 0);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn prune_cache_missing_dir_is_ok() {
        let dir = std::env::temp_dir().join("stier_heicmov_does_not_exist_xyz");
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(prune_cache(&dir, 1024).unwrap(), 0);
    }
}
