/**
 * Node 侧的 I/O 适配器。
 *
 * 只服务于开发期的脚本（`npm run verify`）和本地调试：缓存写在工程目录的
 * `data/` 下，日志目录可以用 CLAUDE_PROJECTS_DIR 覆盖，方便拿别人的日志对账。
 * 桌面端走的是 ./io-tauri.js，两者对上同一套接口，解析逻辑只有一份。
 */
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import os from 'os';

const DATA_DIR = path.join(process.cwd(), 'data');
const CACHE_FILE = path.join(DATA_DIR, 'usage_cache.json');
const TURNS_DIR = path.join(DATA_DIR, 'turns');

function turnsShardPath(sessionId) {
  return path.join(TURNS_DIR, sessionId + '.json');
}

async function ensureDirs() {
  await fsp.mkdir(TURNS_DIR, { recursive: true });
}

/** 读文件；文件不存在返回 null，让上层能把「没有缓存」和「缓存坏了」分开处理。 */
async function readIfExists(p) {
  try {
    return await fsp.readFile(p, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

/** 先写 .tmp 再 rename：中途崩溃不会留下半截 JSON。 */
async function writeAtomic(p, text) {
  await ensureDirs();
  const tmp = p + '.tmp';
  await fsp.writeFile(tmp, text, 'utf8');
  await fsp.rename(tmp, p);
}

export const nodeIO = {
  projectsDir() {
    return process.env.CLAUDE_PROJECTS_DIR || path.join(os.homedir(), '.claude', 'projects');
  },

  /**
   * 扫描日志目录，列出所有 session 文件及其 mtime / size。
   *
   * 子 agent 的日志不在主日志里，而是在 `<sessionId>/subagents/agent-*.jsonl`，
   * 它的用量主日志里完全没有，漏扫就少算。这类文件归属父会话：sessionId 取目录名，
   * subagent 取文件名。
   */
  async listLogFiles() {
    const projectsDir = nodeIO.projectsDir();
    const out = [];
    const push = async (filePath, fields) => {
      try {
        const st = await fsp.stat(filePath);
        if (!st.isFile()) return;
        out.push({ filePath, ...fields, mtimeMs: st.mtimeMs, size: st.size });
      } catch {
        /* 文件在扫描过程中消失，跳过 */
      }
    };
    let projectFolders;
    try {
      projectFolders = await fsp.readdir(projectsDir, { withFileTypes: true });
    } catch {
      return out;
    }
    for (const folder of projectFolders) {
      if (!folder.isDirectory() || folder.name.startsWith('.')) continue;
      const projPath = path.join(projectsDir, folder.name);
      let entries;
      try {
        entries = await fsp.readdir(projPath, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const ent of entries) {
        if (ent.isDirectory()) {
          const subDir = path.join(projPath, ent.name, 'subagents');
          let subs;
          try {
            subs = await fsp.readdir(subDir);
          } catch {
            continue;
          }
          for (const f of subs) {
            if (!f.endsWith('.jsonl')) continue;
            await push(path.join(subDir, f), {
              projectPath: projPath,
              folderName: folder.name,
              sessionId: ent.name,
              subagent: f.slice(0, -6),
            });
          }
          continue;
        }
        if (!ent.name.endsWith('.jsonl')) continue;
        await push(path.join(projPath, ent.name), {
          projectPath: projPath,
          folderName: folder.name,
          sessionId: ent.name.slice(0, -6),
        });
      }
    }
    return out;
  },

  /**
   * 从 startOffset（字节）开始逐行读，不把整个文件读进内存：
   * 实测单个 session 文件可达 68MB，一次性读入会让 RSS 冲到约 1GB。
   *
   * 手动按字节 `\n` 分行，不用 readline —— Node 的 readline 会把 U+2028/U+2029
   * （行分隔符/段分隔符）也当作换行拆开，转录里粘贴的网页内容偶尔会带这类字符，
   * 一旦被拆开就切碎了一整条合法 JSON，导致那一行的 usage 被静默丢弃。
   * 桌面端走的是 Rust 分块 + 按字节 `\n` 切，没有这个问题；这里手动实现同样的
   * 语义，让 verify 脚本和生产路径的行为一致。
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

export default nodeIO;
