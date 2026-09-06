/**
 * 桌面端（Tauri）的 I/O 适配器。
 *
 * WebView 里没有 fs，所有读写都交给 Rust 侧的几个命令（见 src-tauri/src/main.rs）：
 *   - list_log_files  拿到每个日志文件的 mtime / size —— 增量刷新全靠这两个值
 *   - read_log_chunk  按「字节偏移」分块读，块尾对齐到换行，前端不用处理半个字符
 *   - cache_*         读写应用数据目录里的缓存，路径由 Rust 决定，前端只给相对名
 *
 * 之所以不用 fs 插件：它没有 stat（拿不到 mtime/size），而且一次性把 68MB 的
 * 文件塞过 IPC 会让 WebView 直接卡死。
 */
import { invoke } from '@tauri-apps/api/core';

/** 每次过 IPC 的字节数。4MB 在解析速度和内存峰值之间比较平衡。 */
const CHUNK_BYTES = 4 * 1024 * 1024;

const CACHE_NAME = 'usage_cache.json';

function turnsName(sessionId) {
  return 'turns/' + sessionId + '.json';
}

function assertDesktop() {
  if (typeof window === 'undefined' || !window.__TAURI_INTERNALS__) {
    throw new Error(
      'Claude Code Token Lens 需要在桌面端运行（浏览器里没有读取本地日志的权限）。'
      + '请用 npm run tauri:dev 启动，或安装打包好的桌面应用。'
    );
  }
}

export const tauriIO = {
  projectsDir() {
    // 桌面端不需要它：目录扫描整个发生在 Rust 侧。
    throw new Error('getProjectsDir() is not available in the desktop build');
  },

  async listLogFiles() {
    assertDesktop();
    return await invoke('list_log_files');
  },

  /**
   * 从 startOffset（字节）开始逐行读。
   *
   * Rust 保证每一块都在换行处切断，所以这里不需要跨块拼接残行；
   * 只有文件最后一行可能没有结尾换行，单独处理。
   */
  async *readLines(filePath, startOffset) {
    assertDesktop();
    let offset = startOffset;
    for (;;) {
      const chunk = await invoke('read_log_chunk', { path: filePath, offset, limit: CHUNK_BYTES });
      if (chunk.text) {
        const lines = chunk.text.split('\n');
        const tail = lines.pop();
        for (const line of lines) yield line;
        // 非空只可能出现在文件末尾没有换行的情况。
        if (tail) yield tail;
      }
      offset = chunk.next;
      if (chunk.eof) break;
    }
  },

  async readCache() {
    assertDesktop();
    return await invoke('cache_read', { name: CACHE_NAME });
  },

  async writeCache(text) {
    assertDesktop();
    await invoke('cache_write', { name: CACHE_NAME, contents: text });
  },

  async readTurns(sessionId) {
    assertDesktop();
    return await invoke('cache_read', { name: turnsName(sessionId) });
  },

  async writeTurns(sessionId, text) {
    assertDesktop();
    await invoke('cache_write', { name: turnsName(sessionId), contents: text });
  },

  async removeTurns(sessionId) {
    assertDesktop();
    await invoke('cache_remove', { name: turnsName(sessionId) });
  },

  async clearAllTurns() {
    assertDesktop();
    await invoke('cache_clear_turns');
  },
};

export default tauriIO;
