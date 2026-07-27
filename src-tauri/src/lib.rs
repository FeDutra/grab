use serde::Serialize;
use tauri::{AppHandle, Emitter, State, Manager};
use tauri_plugin_shell::ShellExt;
use tauri_plugin_shell::process::{CommandEvent, CommandChild};
use std::sync::{Arc, Mutex};
use std::collections::HashMap;

struct AppState {
    children: Arc<Mutex<HashMap<String, CommandChild>>>,
}

#[derive(Clone, Serialize)]
struct DownloadProgress {
    id: String,
    status: String, 
    progress: Option<f32>,
    filename: Option<String>,
    error: Option<String>,
}

#[tauri::command]
async fn stop_all_downloads(state: State<'_, AppState>) -> Result<(), String> {
    let mut children = state.children.lock().unwrap();
    for (_id, child) in children.drain() {
        let _ = child.kill();
    }
    Ok(())
}

#[tauri::command]
async fn start_download(app: AppHandle, state: State<'_, AppState>, id: String, url: String, destination: String, format: String, quality: String) -> Result<(), String> {
    let _ = app.emit("download-progress", DownloadProgress {
        id: id.clone(),
        status: "processing".into(),
        progress: Some(0.0),
        filename: None,
        error: None,
    });

    let mut args = vec![
        "-o".to_string(), format!("{}/%(title)s.%(ext)s", destination), 
        "--newline".to_string(), 
    ];

    let mut model_path_opt = None;

    if let Ok(resource_dir) = app.path().resource_dir() {
        #[cfg(target_os = "windows")]
        let ffmpeg_name = "ffmpeg.exe";
        #[cfg(not(target_os = "windows"))]
        let ffmpeg_name = "ffmpeg";

        let path1 = resource_dir.join(ffmpeg_name);
        let path2 = resource_dir.join("resources").join(ffmpeg_name);
        
        let ffmpeg_path = if path1.exists() {
            Some(path1)
        } else if path2.exists() {
            Some(path2)
        } else {
            None
        };

        if let Some(path) = ffmpeg_path {
            args.push("--ffmpeg-location".to_string());
            args.push(path.to_string_lossy().to_string());
        }

        let model1 = resource_dir.join("ggml-base.bin");
        let model2 = resource_dir.join("resources").join("ggml-base.bin");
        if model1.exists() {
            model_path_opt = Some(model1.to_string_lossy().to_string());
        } else if model2.exists() {
            model_path_opt = Some(model2.to_string_lossy().to_string());
        }
    }
    
    if format == "audio" {
        args.push("-x".to_string());
        args.push("--audio-format".to_string());
        args.push("mp3".to_string());
        if quality == "max" {
            args.push("--audio-quality".to_string());
            args.push("0".to_string());
        }
    } else if format == "texto" {
        args.push("-x".to_string());
        args.push("--audio-format".to_string());
        args.push("wav".to_string());
        args.push("--postprocessor-args".to_string());
        args.push("-ar 16000 -ac 1 -c:a pcm_s16le".to_string());
    } else {
        if quality == "max" {
            args.push("-f".to_string());
            args.push("bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best".to_string());
            args.push("--merge-output-format".to_string());
            args.push("mp4".to_string());
        } else {
            args.push("-f".to_string());
            args.push("b".to_string());
        }
    }

    args.push(url.clone());

    let sidecar_command = app.shell().sidecar("yt-dlp")
        .map_err(|e| e.to_string())?
        .args(args);

    let (mut rx, child) = sidecar_command.spawn()
        .map_err(|e| e.to_string())?;

    state.children.lock().unwrap().insert(id.clone(), child);

    let id_clone = id.clone();
    let children_ref = state.children.clone();
    let format_clone = format.clone();
    let app_clone = app.clone();

    tauri::async_runtime::spawn(async move {
        let mut success = false;
        let mut err_msg = String::new();
        let mut current_filename = None;
        let mut last_progress = 0.0;
        let mut final_wav_path = None;

        while let Some(event) = rx.recv().await {
            if let CommandEvent::Stdout(line) = event {
                let line_str = String::from_utf8_lossy(&line);
                let line_str = line_str.trim();

                if line_str.starts_with("[download] Destination:") || line_str.starts_with("[ExtractAudio] Destination:") {
                    let parts: Vec<&str> = line_str.split("Destination:").collect();
                    if parts.len() > 1 {
                        let path = parts[1].trim();
                        if path.ends_with(".wav") {
                            final_wav_path = Some(path.to_string());
                        }
                        if let Some(file_name) = std::path::Path::new(path).file_name() {
                            current_filename = Some(file_name.to_string_lossy().to_string());
                        }
                    }
                } else if line_str.starts_with("[download]") && line_str.contains("%") {
                    if let Some(pct_start) = line_str.find(']') {
                        let after_bracket = &line_str[pct_start + 1..];
                        if let Some(pct_end) = after_bracket.find('%') {
                            let pct_str = &after_bracket[..pct_end].trim();
                            if let Ok(pct) = pct_str.parse::<f32>() {
                                last_progress = pct;
                                let _ = app_clone.emit("download-progress", DownloadProgress {
                                    id: id_clone.clone(),
                                    status: "processing".into(),
                                    progress: Some(if format_clone == "texto" { pct * 0.5 } else { pct }),
                                    filename: current_filename.clone(),
                                    error: None,
                                });
                            }
                        }
                    }
                }
            } else if let CommandEvent::Stderr(line) = event {
                let line_str = String::from_utf8_lossy(&line);
                err_msg = line_str.to_string();
            } else if let CommandEvent::Terminated(payload) = event {
                success = payload.code == Some(0);
            }
        }

        children_ref.lock().unwrap().remove(&id_clone);

        if success && format_clone == "texto" {
            let _ = app_clone.emit("download-progress", DownloadProgress {
                id: id_clone.clone(),
                status: "processing".into(),
                progress: Some(75.0),
                filename: current_filename.clone().map(|f| format!("Transcrevendo: {}", f)),
                error: None,
            });

            if let (Some(wav_path), Some(model_path)) = (final_wav_path.clone(), model_path_opt) {
                if let Ok(whisper_cmd) = app_clone.shell().sidecar("whisper-cli") {
                    let w_args = vec![
                        "-m".to_string(), model_path,
                        "-f".to_string(), wav_path.clone(),
                        "-otxt".to_string(),
                        "-osrt".to_string()
                    ];
                    
                    if let Ok(output) = whisper_cmd.args(w_args).output().await {
                        if output.status.success() {
                            let _ = std::fs::remove_file(&wav_path); // delete the temp wav
                        } else {
                            success = false;
                            err_msg = String::from_utf8_lossy(&output.stderr).to_string();
                        }
                    } else {
                        success = false;
                        err_msg = "Failed to run whisper-cli".into();
                    }
                } else {
                    success = false;
                    err_msg = "whisper-cli not found".into();
                }
            } else {
                success = false;
                err_msg = "Missing wav file or model".into();
            }
        }

        let final_status = if success { "completed" } else { "failed" };
        let _ = app_clone.emit("download-progress", DownloadProgress {
            id: id_clone.clone(),
            status: final_status.into(),
            progress: if success { Some(100.0) } else { Some(last_progress) },
            filename: current_filename.clone(),
            error: if success { None } else { Some(err_msg) },
        });
    });

    Ok(())
}

#[tauri::command]
async fn stop_download(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let mut children = state.children.lock().unwrap();
    if let Some(child) = children.remove(&id) {
        let _ = child.kill();
    }
    Ok(())
}

#[tauri::command]
fn reveal_in_finder(path: String) {
    #[cfg(target_os = "macos")]
    {
        let _ = std::process::Command::new("open")
            .arg("-R")
            .arg(&path)
            .spawn();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .manage(AppState { children: Arc::new(Mutex::new(HashMap::new())) })
    .plugin(tauri_plugin_shell::init())
    .plugin(tauri_plugin_fs::init())
    .plugin(tauri_plugin_dialog::init())
    .invoke_handler(tauri::generate_handler![start_download, stop_all_downloads, stop_download, reveal_in_finder])
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      Ok(())
    })
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
