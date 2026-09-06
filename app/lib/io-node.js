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
import readline from 'readline';

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

  /** 扫描日志目录，列出所有 session 文件及其 mtime / size。 */
  async listLogFiles() {
    const projectsDir = nodeIO.projectsDir();
    const out = [];
    let projectFolders;
    try {
      projectFolders = await fsp.readdir(projectsDir, { withFileTypes: true });
    } catch {
      return out;
    }
    for (const folder of projectFolders) {
      if (!folder.isDirectory() || folder.name.startsWith('.')) continue;
      const projPath = path.join(projectsDir, folder.name);
      let files;
      try {
        files = await fsp.readdir(projPath);
      } catch {
        continue;
      }
      for (const f of files) {
        if (!f.endsWith('.jsonl')) continue;
        const filePath = path.join(projPath, f);
        try {
          const st = await fsp.stat(filePath);
          if (!st.isFile()) continue;
          out.push({
            filePath,
            projectPath: projPath,
            folderName: folder.name,
            sessionId: f.slice(0, -6),
            mtimeMs: st.mtimeMs,
            size: st.size,
          });
        } catch {
          /* 文件在扫描过程中消失，跳过 */
        }
      }
    }
    return out;
  },

  /**
   * 从 startOffset（字节）开始逐行读，不把整个文件读进内存：
   * 实测单个 session 文件可达 68MB，一次性读入会让 RSS 冲到约 1GB。
   */
  async *readLines(filePath, startOffset) {
    const stream = fs.createReadStream(filePath, { encoding: 'utf8', start: startOffset });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of rl) yield line;
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
