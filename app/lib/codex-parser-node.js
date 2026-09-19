/** Node 环境下的 Codex parser 入口：注入 Node I/O，再原样转出解析逻辑。 */
import { setIO } from './codex-parser.js';
import { codexNodeIO } from './codex-io-node.js';

setIO(codexNodeIO);

export * from './codex-parser.js';
