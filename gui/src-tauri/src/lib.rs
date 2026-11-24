use serde::{Deserialize, Serialize};
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, RunEvent, State};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

struct WorkerProcess {
    child: Child,
    stdin: ChildStdin,
}

struct WorkerState {
    process: Mutex<Option<WorkerProcess>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AppInfo {
    bark_root: String,
    default_output_dir: String,
    python_path: String,
    worker_script_path: String,
    python_exists: bool,
    worker_script_exists: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct VoicePreset {
    id: String,
    label: String,
    language: String,
    is_v2: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GenerateRequest {
    id: String,
    text: String,
    history_prompt: Option<String>,
    text_temp: f64,
    waveform_temp: f64,
    output_dir: String,
    output_filename: String,
    use_small_models: bool,
    offload_cpu: bool,
    save_prompt_npz: bool,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GenerationRecord {
    id: String,
    text: String,
    preset: String,
    text_temp: f64,
    waveform_temp: f64,
    use_small_models: bool,
    offload_cpu: bool,
    output_path: String,
    prompt_path: Option<String>,
    duration_seconds: f64,
    sample_rate: u32,
    created_at: String,
}

fn is_bark_root(candidate: &Path) -> bool {
    candidate.join("bark").join("assets").join("prompts").is_dir()
        && candidate.join("gui").join("python").join("bark_worker.py").is_file()
}

fn find_bark_root() -> Result<PathBuf, String> {
    let mut seeds: Vec<PathBuf> = Vec::new();
    if let Ok(cwd) = std::env::current_dir() {
        seeds.push(cwd);
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            seeds.push(parent.to_path_buf());
        }
    }

    for seed in seeds {
        for ancestor in seed.ancestors() {
            if is_bark_root(ancestor) {
                return Ok(ancestor.to_path_buf());
            }
        }
    }

    Err("Could not locate the Bark repository root (expected bark/assets/prompts and gui/python/bark_worker.py).".to_string())
}

fn resolve_python_path(bark_root: &Path) -> PathBuf {
    #[cfg(target_os = "windows")]
    let venv_py = bark_root.join(".venv").join("Scripts").join("python.exe");
    #[cfg(not(target_os = "windows"))]
    let venv_py = bark_root.join(".venv").join("bin").join("python");

    if venv_py.is_file() {
        venv_py
    } else {
        PathBuf::from("python")
    }
}

fn collect_presets(dir: &Path, prefix: &str, out: &mut Vec<VoicePreset>) -> Result<(), String> {
    let entries = fs::read_dir(dir).map_err(|e| format!("Failed to read prompts dir: {e}"))?;
    for entry in entries.flatten() {
        let path = entry.path();
        let file_name = entry.file_name().to_string_lossy().to_string();
        if path.is_dir() {
            let next_prefix = if prefix.is_empty() {
                file_name
            } else {
                format!("{prefix}/{file_name}")
            };
            collect_presets(&path, &next_prefix, out)?;
        } else if path.extension().and_then(|s| s.to_str()) == Some("npz") {
            let stem = path
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or(&file_name)
                .to_string();
            let id = if prefix.is_empty() {
                stem.clone()
            } else {
                format!("{prefix}/{stem}")
            };
            let is_v2 = prefix == "v2" || id.starts_with("v2/");
            let language = stem
                .split('_')
                .next()
                .filter(|part| part.len() == 2)
                .unwrap_or("other")
                .to_string();
            out.push(VoicePreset {
                id,
                label: stem,
                language,
                is_v2,
            });
        }
    }
    Ok(())
}

fn ensure_worker_started(app: &AppHandle, state: &State<WorkerState>) -> Result<(), String> {
    let mut guard = state
        .process
        .lock()
        .map_err(|_| "Worker mutex poisoned".to_string())?;

    if let Some(worker) = guard.as_mut() {
        if let Ok(None) = worker.child.try_wait() {
            return Ok(());
        }
        *guard = None;
    }

    let bark_root = find_bark_root()?;
    let python_path = resolve_python_path(&bark_root);
    let worker_script = bark_root.join("gui").join("python").join("bark_worker.py");

    if !worker_script.is_file() {
        return Err(format!(
            "Worker script not found at {}",
            worker_script.display()
        ));
    }

    let mut cmd = Command::new(&python_path);
    cmd.arg("-u")
        .arg(&worker_script)
        .current_dir(&bark_root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn Python worker ({}): {e}", python_path.display()))?;

    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "Failed to capture worker stdin".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Failed to capture worker stdout".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "Failed to capture worker stderr".to_string())?;

    let app_stdout = app.clone();
    std::thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines().map_while(Result::ok) {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            if let Ok(val) = serde_json::from_str::<serde_json::Value>(trimmed) {
                let event_type = val
                    .get("type")
                    .and_then(|v| v.as_str())
                    .unwrap_or("message");
                let event_name = match event_type {
                    "ready" => "bark-ready",
                    "pong" => "bark-pong",
                    "status" => "bark-status",
                    "result" => "bark-result",
                    "preloaded" => "bark-preloaded",
                    "error" => "bark-error",
                    _ => "bark-message",
                };
                let _ = app_stdout.emit(event_name, val);
            }
        }
        let _ = app_stdout.emit("bark-exit", serde_json::json!({ "exited": true }));
    });

    let app_stderr = app.clone();
    std::thread::spawn(move || {
        let reader = BufReader::new(stderr);
        for line in reader.lines().map_while(Result::ok) {
            let cleaned = line.trim();
            if !cleaned.is_empty() {
                let _ = app_stderr.emit("bark-log", cleaned.to_string());
            }
        }
    });

    *guard = Some(WorkerProcess { child, stdin });
    Ok(())
}

fn send_worker_json(state: &State<WorkerState>, payload: &serde_json::Value) -> Result<(), String> {
    let mut guard = state
        .process
        .lock()
        .map_err(|_| "Worker mutex poisoned".to_string())?;

    let worker = guard
        .as_mut()
        .ok_or_else(|| "Python worker is not running".to_string())?;

    let line = serde_json::to_string(payload).map_err(|e| e.to_string())?;
    worker
        .stdin
        .write_all(line.as_bytes())
        .and_then(|_| worker.stdin.write_all(b"\n"))
        .and_then(|_| worker.stdin.flush())
        .map_err(|e| format!("Failed to write to worker stdin: {e}"))
}

#[tauri::command]
fn get_app_info() -> Result<AppInfo, String> {
    let bark_root = find_bark_root()?;
    let python_path = resolve_python_path(&bark_root);
    let worker_script = bark_root.join("gui").join("python").join("bark_worker.py");
    let default_output_dir = bark_root.join("outputs");

    Ok(AppInfo {
        bark_root: bark_root.to_string_lossy().to_string(),
        default_output_dir: default_output_dir.to_string_lossy().to_string(),
        python_exists: python_path.is_file(),
        worker_script_exists: worker_script.is_file(),
        python_path: python_path.to_string_lossy().to_string(),
        worker_script_path: worker_script.to_string_lossy().to_string(),
    })
}

#[tauri::command]
fn list_voice_presets() -> Result<Vec<VoicePreset>, String> {
    let bark_root = find_bark_root()?;
    let prompts_dir = bark_root.join("bark").join("assets").join("prompts");
    let mut presets = Vec::new();
    collect_presets(&prompts_dir, "", &mut presets)?;
    presets.sort_by(|a, b| b.is_v2.cmp(&a.is_v2).then_with(|| a.id.cmp(&b.id)));
    Ok(presets)
}

#[tauri::command]
fn init_worker(app: AppHandle, state: State<WorkerState>) -> Result<(), String> {
    ensure_worker_started(&app, &state)?;
    send_worker_json(&state, &serde_json::json!({ "cmd": "ping" }))
}

#[tauri::command]
fn generate_audio(
    app: AppHandle,
    state: State<WorkerState>,
    request: GenerateRequest,
) -> Result<(), String> {
    ensure_worker_started(&app, &state)?;
    let payload = serde_json::json!({
        "cmd": "generate",
        "id": request.id,
        "text": request.text,
        "history_prompt": request.history_prompt,
        "text_temp": request.text_temp,
        "waveform_temp": request.waveform_temp,
        "output_dir": request.output_dir,
        "output_filename": request.output_filename,
        "use_small_models": request.use_small_models,
        "offload_cpu": request.offload_cpu,
        "save_prompt_npz": request.save_prompt_npz,
    });
    send_worker_json(&state, &payload)
}

#[tauri::command]
fn stop_worker(state: State<WorkerState>) -> Result<(), String> {
    let mut guard = state
        .process
        .lock()
        .map_err(|_| "Worker mutex poisoned".to_string())?;

    if let Some(mut worker) = guard.take() {
        let _ = worker.child.kill();
        let _ = worker.child.wait();
    }
    Ok(())
}

#[tauri::command]
fn read_audio_file(path: String) -> Result<tauri::ipc::Response, String> {
    let bytes = fs::read(&path).map_err(|e| format!("Failed to read audio file '{path}': {e}"))?;
    Ok(tauri::ipc::Response::new(bytes))
}

#[tauri::command]
fn reveal_in_explorer(path: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        Command::new("explorer")
            .arg(format!("/select,{path}"))
            .spawn()
            .map_err(|e| format!("Failed to open Explorer: {e}"))?;
        return Ok(());
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = path;
        Err("Reveal in Explorer is only supported on Windows.".to_string())
    }
}

fn resolve_db_path() -> Result<PathBuf, String> {
    let bark_root = find_bark_root()?;
    let outputs_dir = bark_root.join("outputs");
    fs::create_dir_all(&outputs_dir)
        .map_err(|e| format!("Failed to create outputs directory: {e}"))?;
    Ok(outputs_dir.join("generations.json"))
}

fn read_db_records(db_path: &Path) -> Result<Vec<GenerationRecord>, String> {
    if !db_path.is_file() {
        return Ok(Vec::new());
    }
    let raw = fs::read_to_string(db_path)
        .map_err(|e| format!("Failed to read database '{}': {e}", db_path.display()))?;
    if raw.trim().is_empty() {
        return Ok(Vec::new());
    }
    serde_json::from_str::<Vec<GenerationRecord>>(&raw)
        .map_err(|e| format!("Failed to parse database '{}': {e}", db_path.display()))
}

fn write_db_records(db_path: &Path, records: &[GenerationRecord]) -> Result<(), String> {
    let json = serde_json::to_string_pretty(records)
        .map_err(|e| format!("Failed to serialize database: {e}"))?;
    fs::write(db_path, json)
        .map_err(|e| format!("Failed to write database '{}': {e}", db_path.display()))
}

#[tauri::command]
fn load_generation_db() -> Result<Vec<GenerationRecord>, String> {
    let db_path = resolve_db_path()?;
    read_db_records(&db_path)
}

#[tauri::command]
fn append_generation_record(record: GenerationRecord) -> Result<Vec<GenerationRecord>, String> {
    let db_path = resolve_db_path()?;
    let mut records = read_db_records(&db_path)?;
    records.retain(|existing| existing.id != record.id);
    records.insert(0, record);
    write_db_records(&db_path, &records)?;
    Ok(records)
}

#[tauri::command]
fn delete_generation_record(
    id: String,
    delete_files: bool,
) -> Result<Vec<GenerationRecord>, String> {
    let db_path = resolve_db_path()?;
    let mut records = read_db_records(&db_path)?;
    if delete_files {
        if let Some(target) = records.iter().find(|r| r.id == id) {
            let wav_path = Path::new(&target.output_path);
            if wav_path.is_file() {
                let _ = fs::remove_file(wav_path);
            }
            if let Some(npz) = &target.prompt_path {
                let npz_path = Path::new(npz);
                if npz_path.is_file() {
                    let _ = fs::remove_file(npz_path);
                }
            }
        }
    }
    records.retain(|r| r.id != id);
    write_db_records(&db_path, &records)?;
    Ok(records)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .manage(WorkerState {
            process: Mutex::new(None),
        })
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
        .invoke_handler(tauri::generate_handler![
            get_app_info,
            list_voice_presets,
            init_worker,
            generate_audio,
            stop_worker,
            read_audio_file,
            reveal_in_explorer,
            load_generation_db,
            append_generation_record,
            delete_generation_record,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app_handle, event| {
        if let RunEvent::Exit = event {
            let state = app_handle.state::<WorkerState>();
            if let Ok(mut guard) = state.process.lock() {
                if let Some(mut worker) = guard.take() {
                    let _ = worker.child.kill();
                    let _ = worker.child.wait();
                }
            };
        }
    });
}
