// Prevents an additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! Rust 侧只做三件事：列日志文件、按字节区间读日志、读写缓存。
//!
//! 解析和去重逻辑仍然全在前端的 app/lib/parser.js 里（Node 的 verify 脚本和
//! 桌面端共用同一份），这边只提供 WebView 拿不到的能力：
//!   - 文件的 mtime / size：增量刷新的判断依据，fs 插件给不了；
//!   - 按偏移分块读：单个 session 日志实测可达 68MB，整块塞过 IPC 会把界面卡死；
//!   - 应用数据目录的读写：缓存路径由这边决定，前端只传相对文件名。

use std::fs::{self, File};
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::PathBuf;
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

/// 列出 ~/.claude/projects/<project>/<session>.jsonl 的全部文件。
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
            if !name.ends_with(".jsonl") {
                continue;
            }
            // 文件可能在扫描过程中消失，拿不到元信息就跳过。
            let meta = match file.metadata() {
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

            out.push(LogFile {
                file_path: file.path().to_string_lossy().into_owned(),
                project_path: project_path.to_string_lossy().into_owned(),
                folder_name: folder_name.clone(),
                session_id: name[..name.len() - ".jsonl".len()].to_string(),
                mtime_ms,
                size: meta.len(),
            });
        }
    }

    Ok(out)
}

/// 从 offset 开始读一段日志，块尾对齐到换行。
#[tauri::command]
fn read_log_chunk(app: AppHandle, path: String, offset: u64, limit: u64) -> Result<Chunk, String> {
    let root = projects_dir(&app)
        .and_then(|p| p.canonicalize().map_err(|e| err("日志目录不存在", e)))?;
    let target = PathBuf::from(&path)
        .canonicalize()
        .map_err(|e| err("日志文件打不开", e))?;
    // 前端传什么路径都不能越出日志目录。
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

/// 缓存文件名白名单：只允许 `usage_cache.json` 和 `turns/<sessionId>.json`。
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

fn main() {
    tauri::Builder::default()
        // 页脚的项目主页要交给系统浏览器打开：WebView 自己拦截 window.open，
        // 不注册这个插件的话前端 invoke 会直接被拒，点了没有任何反应。
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            list_log_files,
            read_log_chunk,
            cache_read,
            cache_write,
            cache_remove,
            cache_clear_turns,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
