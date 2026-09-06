/** Node 环境下的 parser 入口：注入 Node I/O，再原样转出解析逻辑。 */
import { setIO } from './parser.js';
import { nodeIO } from './io-node.js';

setIO(nodeIO);

export * from './parser.js';
