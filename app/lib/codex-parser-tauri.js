/** 桌面端的 Codex parser 入口：注入 Tauri I/O，再原样转出解析逻辑。 */
import { setIO } from './codex-parser.js';
import { codexTauriIO } from './codex-io-tauri.js';

setIO(codexTauriIO);

export * from './codex-parser.js';
