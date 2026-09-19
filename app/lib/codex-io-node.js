/**
 * Codex 的 Node 侧 I/O 适配器（`npm run verify:codex` 用）。
 *
 * 独立于 io-node.js：缓存写在 data/codex_usage_cache.json 和
 * data/codex_turns/ 下，互不覆盖。日志目录可用 CODEX_HOME 覆盖 ——
 * 这个环境变量名沿用 Codex CLI 自己的约定，方便拿别的机器的 ~/.codex 对账。
 */
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import os from 'os';

const DATA_DIR = path.join(process.cwd(), 'data');
const CACHE_FILE = path.join(DATA_DIR, 'codex_usage_cache.json');
const TURNS_DIR = path.join(DATA_DIR, 'codex_turns');

function turnsShardPath(sessionId) {
  return path.join(TURNS_DIR, sessionId + '.json');
}

async function ensureDirs() {
  await fsp.mkdir(TURNS_DIR, { recursive: true });
}

async function readIfExists(p) {
  try {
    return await fsp.readFile(p, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

async function writeAtomic(p, text) {
  await ensureDirs();
  const tmp = p + '.tmp';
  await fsp.writeFile(tmp, text, 'utf8');
  await fsp.rename(tmp, p);
}

/** 递归收集一个目录下的全部 *.jsonl 文件（Codex 按 sessions/YYYY/MM/DD 分层存放）。 */
async function collectJsonlFiles(dir, out) {
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await collectJsonlFiles(full, out);
    } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      out.push(full);
    }
  }
}

/** 没有 cwd 信息时的兜底项目名：从 sessions/YYYY/MM/DD/ 路径拼出日期。 */
function folderNameFor(homeDir, filePath) {
  const rel = path.relative(homeDir, filePath);
  const parts = rel.split(path.sep);
  if (parts[0] === 'sessions' && parts.length >= 4) {
    return parts[1] + '-' + parts[2] + '-' + parts[3];
  }
  return parts[0] === 'archived_sessions' ? 'archived' : 'codex';
}

export const codexNodeIO = {
  homeDir() {
    return process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  },

  readSessionIndex() {
    return readIfExists(path.join(codexNodeIO.homeDir(), 'session_index.jsonl'));
  },

  async listLogFiles() {
    const homeDir = codexNodeIO.homeDir();
    const files = [];
    await collectJsonlFiles(path.join(homeDir, 'sessions'), files);
    await collectJsonlFiles(path.join(homeDir, 'archived_sessions'), files);

    const out = [];
    for (const filePath of files) {
      const name = path.basename(filePath);
      try {
        const st = await fsp.stat(filePath);
        if (!st.isFile()) continue;
        out.push({
          filePath,
          folderName: folderNameFor(homeDir, filePath),
          sessionId: name.slice(0, -'.jsonl'.length),
          mtimeMs: st.mtimeMs,
          size: st.size,
        });
      } catch {
        /* 文件在扫描过程中消失，跳过 */
      }
    }
    return out;
  },

  /**
   * 手动按字节 `\n` 分行，不用 readline —— Node 的 readline 会把 U+2028/U+2029
   * （行分隔符/段分隔符）也当作换行拆开，Codex 日志里网页抓取内容偶尔会带这类字符，
   * 一旦被拆开就切碎了一整条合法 JSON。桌面端走的是 Rust 分块 + 按字节 `\n` 切，
   * 没有这个问题；这里手动实现同样的语义，让 verify 脚本和生产路径的行为一致。
   */
  async *readLines(filePath, startOffset) {
    const stream = fs.createReadStream(filePath, { encoding: 'utf8', start: startOffset });
    let carry = '';
    for await (const chunk of stream) {
      carry += chunk;
      let idx;
      while ((idx = carry.indexOf('\n')) !== -1) {
        yield carry.slice(0, idx);
        carry = carry.slice(idx + 1);
      }
    }
    if (carry) yield carry;
  },

  readCache() {
    return readIfExists(CACHE_FILE);
  },

  writeCache(text) {
    return writeAtomic(CACHE_FILE, text);
  },

  readTurns(sessionId) {
    return readIfExists(turnsShardPath(sessionId));
  },

  writeTurns(sessionId, text) {
    return writeAtomic(turnsShardPath(sessionId), text);
  },

  async removeTurns(sessionId) {
    await fsp.rm(turnsShardPath(sessionId), { force: true });
  },

  async clearAllTurns() {
    await fsp.rm(TURNS_DIR, { recursive: true, force: true });
  },
};

export default codexNodeIO;
