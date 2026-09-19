// Prevents an additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! Rust 侧只做三件事：列日志文件、按字节区间读日志、读写缓存。
//!
//! 解析和去重逻辑仍然全在前端里（Claude 走 app/lib/parser.js，Codex 走
//! app/lib/codex-parser.js —— Node 的 verify 脚本和桌面端各自共用一份），
//! 这边只提供 WebView 拿不到的能力：
//!   - 文件的 mtime / size：增量刷新的判断依据，fs 插件给不了；
//!   - 按偏移分块读：单个 session 日志实测可达 68MB，整块塞过 IPC 会把界面卡死；
//!   - 应用数据目录的读写：缓存路径由这边决定，前端只传相对文件名。
//!
//! Claude 和 Codex 各有一套独立的命令（list_log_files/read_log_chunk 对
//! list_codex_log_files/read_codex_log_chunk），互不调用、互不共享状态 ——
//! 一侧的日志目录不存在或解析出错，不会影响另一侧的命令继续工作。

use std::fs::{self, File};
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde::Serialize;
use tauri::{AppHandle, Manager};

/// 单块最多读多少字节。前端给的 limit 会被夹到这个范围内。
const MIN_CHUNK: u64 = 64 * 1024;
const MAX_CHUNK: u64 = 16 * 1024 * 1024;

/// 一个 session 日志文件的元信息。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LogFile {
    file_path: String,
    project_path: String,
    folder_name: String,
    session_id: String,
    mtime_ms: f64,
    size: u64,
    /// 子 agent 日志的文件名（不含扩展名），主日志为 None。子 agent 日志的 session_id 是父会话。
    #[serde(skip_serializing_if = "Option::is_none")]
    subagent: Option<String>,
}

/// 一段日志内容。除文件末尾外，text 一定以换行结尾，
/// 这样前端不用处理跨块的半行，也不会切出半个 UTF-8 字符。
#[derive(Serialize)]
struct Chunk {
    text: String,
    /// 下一次该从哪个字节继续读。
    next: u64,
    eof: bool,
}

fn err(context: &str, e: impl std::fmt::Display) -> String {
    format!("{context}: {e}")
}

fn projects_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let home = app
        .path()
        .home_dir()
        .map_err(|e| err("无法定位用户主目录", e))?;
    Ok(home.join(".claude").join("projects"))
}

/// Codex（本机「ChatGPT 桌面版」实际读取的数据源）的日志根目录。
///
/// 与 Claude 的日志完全独立的一套命令，专门保证两边互不影响：即使这边的
/// 目录扫描或解析出错，也不会拖累 projects_dir 那一侧已经在用的命令。
fn codex_home_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let home = app
        .path()
        .home_dir()
        .map_err(|e| err("无法定位用户主目录", e))?;
    Ok(home.join(".codex"))
}

/// 取一个日志文件的元信息；拿不到（比如扫描途中文件被删）就返回 None。
fn log_file_entry(
    path: &Path,
    project_path: &Path,
    folder_name: &str,
    session_id: String,
    subagent: Option<String>,
) -> Option<LogFile> {
    let meta = path.metadata().ok()?;
    if !meta.is_file() {
        return None;
    }
    let mtime_ms = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as f64)
        .unwrap_or(0.0);
    Some(LogFile {
        file_path: path.to_string_lossy().into_owned(),
        project_path: project_path.to_string_lossy().into_owned(),
        folder_name: folder_name.to_string(),
        session_id,
        mtime_ms,
        size: meta.len(),
        subagent,
    })
}

/// 列出 ~/.claude/projects/<project>/<session>.jsonl，以及子 agent 的
/// <project>/<session>/subagents/agent-*.jsonl —— 子 agent 的用量不会写进主日志，漏扫就少算。
#[tauri::command]
fn list_log_files(app: AppHandle) -> Result<Vec<LogFile>, String> {
    let root = projects_dir(&app)?;
    let mut out = Vec::new();

    // 还没用过 Claude Code 的机器上这个目录不存在，这是正常情况，不是错误。
    let entries = match fs::read_dir(&root) {
        Ok(entries) => entries,
        Err(_) => return Ok(out),
    };

    for entry in entries.flatten() {
        let project_path = entry.path();
        if !project_path.is_dir() {
            continue;
        }
        let folder_name = match entry.file_name().into_string() {
            Ok(name) => name,
            Err(_) => continue,
        };
        if folder_name.starts_with('.') {
            continue;
        }

        let files = match fs::read_dir(&project_path) {
            Ok(files) => files,
            Err(_) => continue,
        };
        for file in files.flatten() {
            let name = match file.file_name().into_string() {
                Ok(name) => name,
                Err(_) => continue,
            };
            let path = file.path();
            if path.is_dir() {
                // 目录名就是父会话的 sessionId，里面的 subagents/ 才是子 agent 日志。
                let subagents = match fs::read_dir(path.join("subagents")) {
                    Ok(subagents) => subagents,
                    Err(_) => continue,
                };
                for sub in subagents.flatten() {
                    let sub_name = match sub.file_name().into_string() {
                        Ok(sub_name) => sub_name,
                        Err(_) => continue,
                    };
                    if let Some(stem) = sub_name.strip_suffix(".jsonl") {
                        out.extend(log_file_entry(
                            &sub.path(),
                            &project_path,
                            &folder_name,
                            name.clone(),
                            Some(stem.to_string()),
                        ));
                    }
                }
                continue;
            }
            if let Some(stem) = name.strip_suffix(".jsonl") {
                out.extend(log_file_entry(&path, &project_path, &folder_name, stem.to_string(), None));
            }
        }
    }

    Ok(out)
}

/// 一个 Codex rollout 日志文件的元信息。
///
/// 与 LogFile 的字段故意不完全对齐：Codex 按日期分层存放（sessions/YYYY/MM/DD/），
/// 不像 Claude 那样用一层项目文件夹，真正的项目路径（cwd）要解析文件内容才知道，
/// 这里的 folder_name 只是内容里没有 cwd 时的兜底展示名。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CodexLogFile {
    file_path: String,
    folder_name: String,
    session_id: String,
    mtime_ms: f64,
    size: u64,
}

/// 递归收集一个目录下的全部 *.jsonl 文件。Codex 的 sessions 目录按
/// YYYY/MM/DD 分层，archived_sessions 是平铺的，两种都要能扫到。
fn collect_jsonl_files(dir: &Path, out: &mut Vec<PathBuf>) {
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_jsonl_files(&path, out);
        } else if path.extension().and_then(|s| s.to_str()) == Some("jsonl") {
            out.push(path);
        }
    }
}

/// 没有 cwd 信息时的兜底项目名：从 sessions/YYYY/MM/DD/ 路径拼出日期。
fn codex_folder_name(home: &Path, path: &Path) -> String {
    if let Ok(rel) = path.strip_prefix(home) {
        let parts: Vec<&str> = rel
            .components()
            .filter_map(|c| c.as_os_str().to_str())
            .collect();
        if parts.first() == Some(&"sessions") && parts.len() >= 4 {
            return format!("{}-{}-{}", parts[1], parts[2], parts[3]);
        }
        if parts.first() == Some(&"archived_sessions") {
            return "archived".to_string();
        }
    }
    "codex".to_string()
}

/// 列出 ~/.codex/sessions 和 ~/.codex/archived_sessions 下的全部 rollout 日志。
#[tauri::command]
fn list_codex_log_files(app: AppHandle) -> Result<Vec<CodexLogFile>, String> {
    let home = codex_home_dir(&app)?;
    let mut files = Vec::new();
    collect_jsonl_files(&home.join("sessions"), &mut files);
    collect_jsonl_files(&home.join("archived_sessions"), &mut files);

    let mut out = Vec::new();
    for path in files {
        let meta = match path.metadata() {
            Ok(meta) => meta,
            Err(_) => continue,
        };
        if !meta.is_file() {
            continue;
        }
        let mtime_ms = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as f64)
            .unwrap_or(0.0);
        let session_id = path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("unknown")
            .to_string();
        out.push(CodexLogFile {
            file_path: path.to_string_lossy().into_owned(),
            folder_name: codex_folder_name(&home, &path),
            session_id,
            mtime_ms,
            size: meta.len(),
        });
    }

    Ok(out)
}

/// 从 offset 开始读一段日志，块尾对齐到换行。`root` 划定了允许读取的目录边界，
/// 前端传什么路径都不能越出去 —— Claude 和 Codex 各自传各自的根目录，
/// 保证一侧的路径穿越尝试碰不到另一侧的文件。
fn read_chunk_in_root(root: &Path, path: String, offset: u64, limit: u64) -> Result<Chunk, String> {
    let root = root
        .canonicalize()
        .map_err(|e| err("日志目录不存在", e))?;
    let target = PathBuf::from(&path)
        .canonicalize()
        .map_err(|e| err("日志文件打不开", e))?;
    if !target.starts_with(&root) || target.extension().and_then(|s| s.to_str()) != Some("jsonl") {
        return Err(format!("拒绝读取日志目录以外的文件: {}", target.display()));
    }

    let file = File::open(&target).map_err(|e| err("日志文件打不开", e))?;
    let len = file
        .metadata()
        .map_err(|e| err("读不到文件大小", e))?
        .len();
    if offset >= len {
        return Ok(Chunk {
            text: String::new(),
            next: len,
            eof: true,
        });
    }

    let want = limit.clamp(MIN_CHUNK, MAX_CHUNK).min(len - offset);
    let mut reader = BufReader::new(file);
    reader
        .seek(SeekFrom::Start(offset))
        .map_err(|e| err("定位日志偏移失败", e))?;

    let mut buf = Vec::with_capacity(want as usize);
    (&mut reader)
        .take(want)
        .read_to_end(&mut buf)
        .map_err(|e| err("读取日志失败", e))?;

    let mut at_eof = offset + buf.len() as u64 >= len;
    if !at_eof {
        match buf.iter().rposition(|b| *b == b'\n') {
            // 常规情况：丢掉块尾那半行，下一块从它开头接着读。
            Some(i) => buf.truncate(i + 1),
            // 单行长度超过一整块（日志里偶尔有超长的粘贴内容），补读到行尾为止。
            None => {
                let read = reader
                    .read_until(b'\n', &mut buf)
                    .map_err(|e| err("读取日志失败", e))?;
                if read == 0 {
                    at_eof = true;
                }
            }
        }
    }

    let next = offset + buf.len() as u64;
    Ok(Chunk {
        // 切点永远在换行处，所以这里不会截断多字节字符。
        text: String::from_utf8_lossy(&buf).into_owned(),
        next,
        eof: at_eof || next >= len,
    })
}

#[tauri::command]
fn read_log_chunk(app: AppHandle, path: String, offset: u64, limit: u64) -> Result<Chunk, String> {
    let root = projects_dir(&app)?;
    read_chunk_in_root(&root, path, offset, limit)
}

#[tauri::command]
fn read_codex_log_chunk(app: AppHandle, path: String, offset: u64, limit: u64) -> Result<Chunk, String> {
    let root = codex_home_dir(&app)?;
    read_chunk_in_root(&root, path, offset, limit)
}

/// ~/.codex/session_index.jsonl：Codex 桌面版给每个 thread 起的真实标题，
/// 和 rollout 日志完全独立的一份小索引，体量很小（一个 session 一行），
/// 不值得为它搭分块读取，直接整个文件读回去，前端自己按行解析 JSON。
#[tauri::command]
fn read_codex_session_index(app: AppHandle) -> Result<Option<String>, String> {
    let path = codex_home_dir(&app)?.join("session_index.jsonl");
    match fs::read_to_string(&path) {
        Ok(text) => Ok(Some(text)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(err("读取会话索引失败", e)),
    }
}

/// 缓存文件名白名单：只允许形如 `usage_cache.json`、`codex_usage_cache.json`、
/// `turns/<sessionId>.json`、`codex_turns/<sessionId>.json` 这样的相对名 ——
/// Claude 和 Codex 的缓存文件名前缀不同，靠这个规则天然隔开，不需要额外校验。
fn cache_path(app: &AppHandle, name: &str) -> Result<PathBuf, String> {
    let safe = !name.is_empty()
        && !name.contains("..")
        && !name.starts_with('/')
        && name.split('/').count() <= 2
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-' | '/'));
    if !safe {
        return Err(format!("非法的缓存文件名: {name}"));
    }
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| err("无法定位应用数据目录", e))?;
    Ok(dir.join(name))
}

#[tauri::command]
fn cache_read(app: AppHandle, name: String) -> Result<Option<String>, String> {
    let path = cache_path(&app, &name)?;
    match fs::read_to_string(&path) {
        Ok(text) => Ok(Some(text)),
        // 首次启动没有缓存，返回 None 让前端走「全量重建」而不是报错。
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(err("读取缓存失败", e)),
    }
}

#[tauri::command]
fn cache_write(app: AppHandle, name: String, contents: String) -> Result<(), String> {
    let path = cache_path(&app, &name)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| err("创建缓存目录失败", e))?;
    }
    // 先写 .tmp 再 rename：中途崩溃不会留下半截 JSON。
    let tmp = PathBuf::from(format!("{}.tmp", path.to_string_lossy()));
    fs::write(&tmp, contents).map_err(|e| err("写入缓存失败", e))?;
    fs::rename(&tmp, &path).map_err(|e| err("替换缓存失败", e))?;
    Ok(())
}

#[tauri::command]
fn cache_remove(app: AppHandle, name: String) -> Result<(), String> {
    let path = cache_path(&app, &name)?;
    match fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(err("删除缓存失败", e)),
    }
}

#[tauri::command]
fn cache_clear_turns(app: AppHandle) -> Result<(), String> {
    let path = cache_path(&app, "turns")?;
    match fs::remove_dir_all(&path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(err("清空 turn 缓存失败", e)),
    }
}

/// 与 cache_clear_turns 分开成独立命令而不是加个参数，是为了让 Claude 和 Codex
/// 两侧的缓存清空操作在类型层面就不可能互相牵连。
#[tauri::command]
fn cache_clear_codex_turns(app: AppHandle) -> Result<(), String> {
    let path = cache_path(&app, "codex_turns")?;
    match fs::remove_dir_all(&path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(err("清空 turn 缓存失败", e)),
    }
}

fn main() {
    tauri::Builder::default()
        // 页脚的项目主页要交给系统浏览器打开：WebView 自己拦截 window.open，
        // 不注册这个插件的话前端 invoke 会直接被拒，点了没有任何反应。
        .plugin(tauri_plugin_opener::init())
        // 标题栏上带版本号：版本号只在 package.json 里维护一处（tauri.conf.json 指向它），
        // 这里直接取运行时的版本，不在窗口配置里再写死一份。
        .setup(|app| {
            if let Some(window) = app.get_webview_window("main") {
                let title = window.title().unwrap_or_else(|_| "Claude Code Token Lens".into());
                let _ = window.set_title(&format!("{title} v{}", app.package_info().version));
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_log_files,
            read_log_chunk,
            list_codex_log_files,
            read_codex_log_chunk,
            read_codex_session_index,
            cache_read,
            cache_write,
            cache_remove,
            cache_clear_turns,
            cache_clear_codex_turns,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
