/**
 * Codex（本机「ChatGPT 桌面版」实际读取的数据源）的桌面端 I/O 适配器。
 *
 * 与 io-tauri.js 完全独立：调的是 Rust 侧单独注册的
 * list_codex_log_files / read_codex_log_chunk 命令，缓存文件名也加了
 * codex_ 前缀（见 src-tauri/src/main.rs 的 cache_path 白名单），
 * 确保 Claude 一侧出错或数据结构变化不会波及这边。
 */
import { invoke } from '@tauri-apps/api/core';

const CHUNK_BYTES = 4 * 1024 * 1024;

const CACHE_NAME = 'codex_usage_cache.json';

function turnsName(sessionId) {
  return 'codex_turns/' + sessionId + '.json';
}

function assertDesktop() {
  if (typeof window === 'undefined' || !window.__TAURI_INTERNALS__) {
    throw new Error(
      'Claude Code Token Lens 需要在桌面端运行（浏览器里没有读取本地日志的权限）。'
      + '请用 npm run tauri:dev 启动，或安装打包好的桌面应用。'
    );
  }
}

export const codexTauriIO = {
  homeDir() {
    throw new Error('getCodexHomeDir() is not available in the desktop build');
  },

  async listLogFiles() {
    assertDesktop();
    return await invoke('list_codex_log_files');
  },

  async readSessionIndex() {
    assertDesktop();
    return await invoke('read_codex_session_index');
  },

  async *readLines(filePath, startOffset) {
    assertDesktop();
    let offset = startOffset;
    for (;;) {
      const chunk = await invoke('read_codex_log_chunk', { path: filePath, offset, limit: CHUNK_BYTES });
      if (chunk.text) {
        const lines = chunk.text.split('\n');
        const tail = lines.pop();
        for (const line of lines) yield line;
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
    await invoke('cache_clear_codex_turns');
  },
};

export default codexTauriIO;
