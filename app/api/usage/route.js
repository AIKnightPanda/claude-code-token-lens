import fs from 'fs';
import path from 'path';
import os from 'os';
import { NextResponse } from 'next/server';

const CACHE_FILE = path.join(process.cwd(), 'data', 'usage_cache.json');

const PRICING = {
  'claude-opus-5': { input: 15, output: 75, cacheWrite: 18.75, cacheRead: 1.5 },
  'claude-sonnet-5': { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  'claude-haiku-4-5-20251001': { input: 0.25, output: 1.25, cacheWrite: 0.30, cacheRead: 0.025 },
  'gpt-5.6-terra': { input: 5, output: 15, cacheWrite: 0, cacheRead: 0 },
  'fallback': { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 }
};

function getPrice(model) {
  if (PRICING[model]) return PRICING[model];
  if (model.includes('opus')) return PRICING['claude-opus-5'];
  if (model.includes('sonnet')) return PRICING['claude-sonnet-5'];
  if (model.includes('haiku')) return PRICING['claude-haiku-4-5-20251001'];
  if (model.includes('gpt')) return PRICING['gpt-5.6-terra'];
  return PRICING['fallback'];
}

function ensureCacheDir() {
  const dir = path.dirname(CACHE_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const refresh = searchParams.get('refresh') === 'true';
    const forceReset = searchParams.get('reset') === 'true'; // A hidden way to fully reset

    let cache = { fileRegistry: {}, projects: [], sessions: [], conversations: [], turns: [], daily: [] };

    if (!forceReset && fs.existsSync(CACHE_FILE)) {
      try {
        const cached = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
        cache = { ...cache, ...cached };
        if (!cache.fileRegistry) cache.fileRegistry = {};
      } catch(e) {}
    }

    if (!refresh && !forceReset && fs.existsSync(CACHE_FILE)) {
      return NextResponse.json(cache);
    }

    const projectsDir = path.join(os.homedir(), '.claude', 'projects');
    const filesToParse = [];

    if (fs.existsSync(projectsDir)) {
      const projFolders = fs.readdirSync(projectsDir);
      for (const pf of projFolders) {
        if (pf.startsWith('.')) continue;
        const projPath = path.join(projectsDir, pf);
        if (!fs.statSync(projPath).isDirectory()) continue;
        
        const projectName = pf;
        const files = fs.readdirSync(projPath);
        for (const f of files) {
          if (!f.endsWith('.jsonl')) continue;
          const filePath = path.join(projPath, f);
          const stat = fs.statSync(filePath);
          
          if (!cache.fileRegistry[filePath] || cache.fileRegistry[filePath] < stat.mtimeMs) {
            filesToParse.push({ filePath, projectName, rawProjectName: pf, mtimeMs: stat.mtimeMs, sessionId: f.replace('.jsonl', '') });
          }
        }
      }
    }

    // If there are files to parse, we do the incremental logic
    if (filesToParse.length > 0) {
      const sessionIdsToUpdate = new Set(filesToParse.map(f => f.sessionId));
      
      // Keep only data for sessions NOT being updated
      cache.sessions = cache.sessions.filter(s => !sessionIdsToUpdate.has(s.sessionId));
      cache.conversations = cache.conversations.filter(c => !sessionIdsToUpdate.has(c.sessionId));
      cache.turns = cache.turns.filter(t => !sessionIdsToUpdate.has(t.sessionId));

      for (const fObj of filesToParse) {
        const content = fs.readFileSync(fObj.filePath, 'utf8');
        const lines = content.split('\n');
        
        let sCost = 0, sTotalTokens = 0, sInput = 0, sOutput = 0, sCache = 0;
        const sModels = new Set();
        let sLastActivity = null;
        let sCustomTitle = null;
        let sAiTitle = null;

        let currentConv = null;

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const entry = JSON.parse(line);
            if (entry.cwd && !fObj.cwd) fObj.cwd = entry.cwd;
            if (entry.timestamp) {
              sLastActivity = entry.timestamp;
              if (!fObj.firstActivity) fObj.firstActivity = entry.timestamp;
            }
            if (entry.customTitle) sCustomTitle = entry.customTitle;
            if (entry.aiTitle) sAiTitle = entry.aiTitle;

            // Start of a Conversation (User Prompt)
            let isRealUserPrompt = false;
            if (entry.type === 'user' || entry.role === 'user') {
              isRealUserPrompt = true;
              if (entry.message && Array.isArray(entry.message.content)) {
                if (entry.message.content.some(c => c.type === 'tool_result')) {
                  isRealUserPrompt = false;
                }
              }
            }

            if (isRealUserPrompt) {
              let text = 'User Prompt';
              if (typeof entry.message === 'string') {
                text = entry.message;
              } else if (Array.isArray(entry.message)) {
                text = entry.message.map(m => m.text || '').join(' ');
              } else if (entry.message && typeof entry.message.content === 'string') {
                text = entry.message.content;
              } else if (entry.message && Array.isArray(entry.message.content)) {
                text = entry.message.content.map(m => m.text || '').join(' ');
              }
              
              currentConv = {
                id: entry.uuid || Math.random().toString(),
                sessionId: fObj.sessionId,
                projectName: fObj.projectName,
                rawProjectName: fObj.rawProjectName,
                date: entry.timestamp,
                prompt: text.substring(0, 2000),
                inputTokens: 0,
                outputTokens: 0,
                cacheTokens: 0,
                totalTokens: 0,
                cost: 0,
                models: new Set(),
                turnCount: 0
              };
              cache.conversations.push(currentConv);
            }

            // Assistant Turn
            if (entry.type === 'assistant' && entry.message && entry.message.usage) {
              const usage = entry.message.usage;
              const rawModel = entry.message.model || 'claude-sonnet-5';
              const model = rawModel === '<synthetic>' ? 'claude-sonnet-5' : rawModel;
              const price = getPrice(model);
              
              const iTokens = usage.input_tokens || 0;
              const oTokens = usage.output_tokens || 0;
              const cw = usage.cache_creation_input_tokens || 0;
              const cr = usage.cache_read_input_tokens || 0;
              
              const tCost = (iTokens * price.input + oTokens * price.output + cw * price.cacheWrite + cr * price.cacheRead) / 1000000;
              const tTokens = iTokens + oTokens + cw + cr;
              
              // If no conversation was active, create a dummy one
              if (!currentConv) {
                currentConv = {
                  id: entry.uuid || Math.random().toString(),
                  sessionId: fObj.sessionId,
                  projectName: fObj.projectName,
                  date: entry.timestamp,
                  prompt: '(Background Task / Initial Turn)',
                  inputTokens: 0, outputTokens: 0, cacheTokens: 0, totalTokens: 0, cost: 0, models: new Set(), turnCount: 0
                };
                cache.conversations.push(currentConv);
              }

              currentConv.inputTokens += iTokens;
              currentConv.outputTokens += oTokens;
              currentConv.cacheTokens += (cw + cr);
              currentConv.totalTokens += tTokens;
              currentConv.cost += tCost;
              currentConv.models.add(model);
              currentConv.turnCount += 1;

              cache.turns.push({
                uuid: entry.uuid || Math.random().toString(),
                conversationId: currentConv.id,
                sessionId: fObj.sessionId,
                projectName: fObj.projectName,
                timestamp: entry.timestamp,
                model,
                inputTokens: iTokens,
                outputTokens: oTokens,
                cacheTokens: cw + cr,
                totalTokens: tTokens,
                cost: tCost
              });
              
              sCost += tCost;
              sTotalTokens += tTokens;
              sInput += iTokens;
              sOutput += oTokens;
              sCache += (cw + cr);
              sModels.add(model);
            }
          } catch(e) {}
        }
        // 确定最终的 projectName 和 rawProjectName（基于 CWD）
        const finalProjectName = fObj.cwd ? fObj.cwd.split('/').pop() : fObj.projectName;
        const finalRawProjectName = fObj.cwd || fObj.rawProjectName;

        // 回溯更新本次解析产生的所有 conversations 和 turns 的 projectName
        for (const c of cache.conversations) {
          if (c.sessionId === fObj.sessionId) {
            c.projectName = finalProjectName;
            c.rawProjectName = finalRawProjectName;
          }
        }
        for (const t of cache.turns) {
          if (t.sessionId === fObj.sessionId) {
            t.projectName = finalProjectName;
            t.rawProjectName = finalRawProjectName;
          }
        }

        if (sTotalTokens > 0) {
          cache.sessions.push({
            sessionId: fObj.sessionId,
            sessionName: sCustomTitle || sAiTitle || fObj.sessionId,
            projectName: finalProjectName,
            rawProjectName: finalRawProjectName,
            firstActivity: fObj.firstActivity,
            date: sLastActivity || new Date().toISOString(),
            inputTokens: sInput,
            outputTokens: sOutput,
            cacheTokens: sCache,
            totalTokens: sTotalTokens,
            cost: sCost,
            models: Array.from(sModels)
          });
        }
        
        // Update registry
        cache.fileRegistry[fObj.filePath] = fObj.mtimeMs;
      }
      // Filter out empty conversations (e.g., system prompts, aborted calls, or synthetic meta-events like 'Continue from where you left off')
      cache.conversations = cache.conversations.filter(c => c.totalTokens > 0);
      
      // Deduplicate conversations and turns by ID to handle Claude Code session migrations
      const uniqueConvs = new Map();
      for (const c of cache.conversations) uniqueConvs.set(c.id, c);
      cache.conversations = Array.from(uniqueConvs.values());
      
      const uniqueTurns = new Map();
      for (const t of cache.turns) uniqueTurns.set(t.uuid, t);
      cache.turns = Array.from(uniqueTurns.values());
      
      // Convert sets to arrays in conversations
      for (const conv of cache.conversations) {
        if (conv.models instanceof Set) {
          conv.models = Array.from(conv.models);
        }
      }

      // Re-aggregate Projects and Daily
      const projectsMap = new Map();
      const dailyMap = new Map();

      for (const s of cache.sessions) {
        // Project Aggregation
        if (!projectsMap.has(s.rawProjectName)) {
          projectsMap.set(s.rawProjectName, {
            projectName: s.projectName,
            rawProjectName: s.rawProjectName,
            firstActivity: s.firstActivity,
            lastActivity: s.date,
            sessionCount: 0,
            conversationCount: 0,
            inputTokens: 0, outputTokens: 0, cacheTokens: 0, totalTokens: 0, totalCost: 0,
            models: new Set()
          });
        }
        const p = projectsMap.get(s.rawProjectName);
        if (s.firstActivity && (!p.firstActivity || new Date(s.firstActivity) < new Date(p.firstActivity))) {
          p.firstActivity = s.firstActivity;
        }
        if (s.date && (!p.lastActivity || new Date(s.date) > new Date(p.lastActivity))) {
          p.lastActivity = s.date;
          p.projectName = s.projectName;
        }
        p.sessionCount++;
        p.inputTokens += s.inputTokens;
        p.outputTokens += s.outputTokens;
        p.cacheTokens += s.cacheTokens;
        p.totalTokens += s.totalTokens;
        p.totalCost += s.cost;
        s.models.forEach(m => p.models.add(m));
      }

      for (const conv of cache.conversations) {
        if (conv.date) {
          const dayStr = conv.date.split('T')[0];
          if (!dailyMap.has(dayStr)) {
            dailyMap.set(dayStr, {
              period: dayStr,
              date: dayStr,
              conversationCount: 0,
              totalCost: 0, totalTokens: 0, inputTokens: 0, outputTokens: 0, cacheTokens: 0,
              models: new Set()
            });
          }
          const d = dailyMap.get(dayStr);
          d.conversationCount++;
          d.totalCost += (conv.cost || 0);
          d.totalTokens += (conv.totalTokens || 0);
          d.inputTokens += (conv.inputTokens || 0);
          d.outputTokens += (conv.outputTokens || 0);
          d.cacheTokens += (conv.cacheTokens || 0);
          if (conv.models) {
            conv.models.forEach(m => d.models.add(m));
          }
        }
        if (conv.rawProjectName && projectsMap.has(conv.rawProjectName)) {
          projectsMap.get(conv.rawProjectName).conversationCount++;
        } else {
          // 兜底：遍历 projectsMap 查找匹配的 projectName
          for (const [key, proj] of projectsMap.entries()) {
            if (proj.projectName === conv.projectName) {
              proj.conversationCount++;
              break;
            }
          }
        }
      }

      // Map session names back to conversations
      const sessionNameMap = new Map();
      for (const s of cache.sessions) {
        sessionNameMap.set(s.sessionId, s.sessionName);
      }
      for (const c of cache.conversations) {
        c.sessionName = sessionNameMap.get(c.sessionId) || c.sessionId;
      }

      cache.projects = Array.from(projectsMap.values()).map(p => ({ ...p, models: Array.from(p.models) })).sort((a,b) => b.totalCost - a.totalCost);
      cache.daily = Array.from(dailyMap.values()).map(d => ({ ...d, modelsUsed: Array.from(d.models) })).sort((a,b) => a.period.localeCompare(b.period));
      
      cache.generatedAt = new Date().toISOString();
      
      ensureCacheDir();
      fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2), 'utf8');
    }

    return NextResponse.json(cache);
  } catch (error) {
    console.error('API Error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
