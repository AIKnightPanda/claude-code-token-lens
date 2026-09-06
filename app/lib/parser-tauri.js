/** 桌面端的 parser 入口：注入 Tauri I/O，再原样转出解析逻辑。 */
import { setIO } from './parser.js';
import { tauriIO } from './io-tauri.js';

setIO(tauriIO);

export * from './parser.js';
