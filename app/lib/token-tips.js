/**
 * 省 token 小技巧：内容来自用户自己的实测经验 + 官方文档（Claude Code 的
 * prompt-caching 文档、OpenAI 的 prompt caching 文档）交叉核对后整理。
 *
 * 每个 provider 下是 { highlight, tips }：
 * - highlight：额度换算这一条单独摘出来，用高亮块常显在最上面，不参与编号、
 *   不折叠——这条是帮用户建立"这个数字大概意味着什么"的心理模型，
 *   不是一个可以直接执行的动作，混进下面的编号列表里反而会被埋没。
 * - tips：剩下的建议，按重要程度从高到低排好序，标题给出明确的动作本身，
 *   解释单独一段、默认折叠，只讲清楚"为什么"——具体到会触发什么机制、
 *   多付出什么代价，不铺垫背景也不绕圈子。
 *
 * 两个 provider 的底层机制相通（前缀匹配缓存、一次对话由多轮请求组成、
 * 切模型或切档位会让缓存作废），但具体数字不一样，分开维护两份文案，
 * 而不是套一个模板硬塞变量——避免为了复用牺牲准确性。
 */
export const TOKEN_TIPS = {
  claude: {
    zh: {
      highlight: {
        title: '1 美元的用量约等于 Pro 套餐 5 小时额度的 2%',
        body: '不同套餐对应的比例不一样，请以 /usage 中的实际数据对比为准。',
      },
      tips: [
        {
          title: '同一 session 中，两次消息间隔最好不要超过 1 小时',
          body: '正式套餐下，对话缓存默认保留 1 小时；用 API Key 或超出套餐额度后缩短为 5 分钟。超过这个时间，缓存会过期，无法命中。缓存命中时，之前处理过的内容只按标准输入价的约 10% 计费；缓存过期后，下一条消息需要把系统提示、CLAUDE.md 和全部历史对话按全价重新处理一次。',
        },
        {
          title: '完成一个小任务后应立即执行 /compact，千万不要拖到很久之后、等到下一个任务开始时才做',
          body: '/compact 本身也是一次请求，会把当前对话重新发给模型生成摘要。缓存未过期时执行，这次请求能命中缓存，只需为生成摘要付费；拖到缓存过期后再执行，就要把全部历史当作未缓存内容重新处理一遍，等于把这段对话的 token 又消耗了一次。',
        },
        {
          title: '重点关注上下文长度，不要等到自动触发压缩',
          body: '一次对话通常包含不止一次请求——每追加一条消息、每次工具调用后模型再回复，都是新的一次请求，每一次请求都要把当前累积的完整上下文重新发给模型一遍。以实测数据为例，一次对话平均会产生约 14 次请求，上下文里多出来的部分会在这些请求里被重复计费十几次，而不是只算一次账。按经验，上下文涨到 200～300k token 左右就可以考虑主动压缩。',
        },
        {
          title: '模型、effort、工具在会话开头定好，中途不要更换',
          body: '切换模型、调整 effort 档位，或者中途增删会把工具定义写入系统提示的 MCP 服务器，都会让已经处理过的上下文前缀失效。下一条消息需要把当前全部上下文按全价重新处理一次，而不是按缓存命中价（约标准价的 10%）计费。',
        },
        {
          title: '简单任务调低 effort 或更换轻量模型，复杂探索交给子 agent',
          body: '简单修改不需要满血配置，调低 effort 或更换规格更低的模型，能直接降低这条请求的计费单价。翻查大量文件、耗时较长的探索性任务应交给子 agent（Task 工具）处理，子 agent 使用独立的上下文，处理过程不会计入主对话，主对话的上下文长度不受影响。',
        },
        {
          title: '桌面端的 side chat 并不便宜，和当前任务无关的小问题建议开新会话问',
          body: 'side chat 会复制主会话的全部上下文，在后台另起一个分支来回答。每发一条消息，都要把主会话的全部历史连同问题一起发给模型一次，主会话有多长，这个问题就有多贵。如果主会话已经闲置超过缓存有效期，第一条消息还要按全价重新处理全部历史：一个 19 万 token 的 Opus 5 会话，光这一步就约 1～2 美元。另外，side chat 不写日志，这部分用量不在本工具的统计范围内。',
        },
      ],
    },
    en: {
      highlight: {
        title: '$1 of usage is roughly 2% of a Pro plan’s 5-hour quota',
        body: 'The ratio differs by plan — check the actual numbers in /usage for yours.',
      },
      tips: [
        {
          title: 'In the same session, keep the gap between messages under 1 hour',
          body: "On a paid plan, the conversation cache is kept for 1 hour by default; using an API key, or exceeding your plan's included usage, shortens that to 5 minutes. Past that time, the cache expires and the next request cannot reuse it. A cache hit bills the earlier content at roughly 10% of the standard input rate; once the cache expires, the next message reprocesses the system prompt, CLAUDE.md, and the entire conversation history at full price.",
        },
        {
          title: "Run /compact immediately after finishing a small task — never let it slip until much later, or until the next task has already started",
          body: '/compact is itself a request that resends the current conversation to generate a summary. Run it before the cache expires and that request hits the cache, so you only pay to generate the summary. Wait until the cache has expired, and the request reprocesses the entire history as uncached input — spending roughly the same tokens as the conversation itself, a second time.',
        },
        {
          title: "Pay close attention to context length — don't wait for automatic compaction",
          body: 'A single conversation usually spans more than one request — every added message, and every model reply after a tool call, is a new request, and each one resends the full accumulated context. In observed usage, a conversation averages around 14 requests, so the extra tokens in a long context get billed that many times over, not just once. As a rule of thumb, consider compacting once context reaches roughly 200k–300k tokens.',
        },
        {
          title: "Set model, effort, and tools at the start — don't change them mid-session",
          body: "Switching models, changing the effort level, or connecting/disconnecting an MCP server whose tool definitions load into the system prompt all invalidate the cached prefix. The next message reprocesses the entire current context at full price instead of the roughly 10% cache-hit rate.",
        },
        {
          title: 'Lower effort or use a smaller model for easy work; hand exploration to a subagent',
          body: "A quick edit doesn't need a full-strength setup — lowering the effort level or switching to a smaller model directly cuts that request's rate. Work that scans many files and runs long should go to a subagent (the Task tool) instead: it runs in its own context, so that work never gets added to the main conversation and the main context doesn't grow.",
        },
        {
          title: "Side chats in the desktop app aren't cheap — ask unrelated quick questions in a new session",
          body: "A side chat copies the main session's full context and answers in a background branch. Every message you send there resends the main session's entire history along with the question, so the question costs as much as the main session is long. If the main session has sat idle past the cache lifetime, the first message also reprocesses the whole history at full price: for a 190k-token Opus 5 session, that step alone is roughly $1-2. Side chats also write no log, so their usage is not included in this app's numbers.",
        },
      ],
    },
  },
  codex: {
    zh: {
      highlight: {
        title: 'Codex 的额度受 5 小时滚动窗口和每周总量两道限制约束',
        body: '碰到任意一道上限都要等重置或加购额度，具体数字请以 CLI 或 ChatGPT 用量面板为准。',
      },
      tips: [
        {
          title: '同一 session 中，消息间隔最好不要超过 30 分钟',
          body: 'Codex 的缓存依赖请求前缀完全匹配。较新的模型默认给前缀至少 30 分钟的有效期，较早的模型通常 5～10 分钟不活动就可能失效，最长不超过 1 小时。缓存过期后，下一条消息需要把系统指令、工具定义和全部历史对话按全价重新处理一次，而不是按缓存命中价计费。',
        },
        {
          title: '完成一个小任务后应立即执行 /compact，千万不要拖到很久之后、等到下一个任务开始时才做',
          body: '/compact 会把当前对话重新发给模型生成摘要。缓存未过期时执行，这次请求能命中缓存；拖到缓存过期，或者等接近上下文上限触发自动压缩才处理，就要把全部历史当作未缓存内容重新处理一遍，等于把这段对话的 token 又消耗了一次。',
        },
        {
          title: '重点关注上下文长度，不要等到自动触发压缩',
          body: '一次对话通常包含不止一次请求——每追加一条消息、每次工具调用后模型再回复，都是新的一次请求，每一次请求都要把当前累积的完整上下文重新发给模型一遍。上下文里多出来的部分会在这些请求里被重复计费，请求次数越多，影响越大，具体次数可以在"交互明细"里按对话核对。按经验，上下文涨到 200～300k token 左右就可以考虑主动压缩。',
        },
        {
          title: '模型和 reasoning effort 在会话开头定好，中途不要更换',
          body: '中途切换模型或调整 reasoning effort，会让已经处理过的上下文前缀失效，下一条消息需要按全价重新处理一次。另外，大段命令行输出或几千行的文件不应整份放入上下文，应先摘要或用 grep/sed 定位到具体片段，直接减少每次请求要处理的内容量。',
        },
        {
          title: '简单任务调低 reasoning effort 或更换轻量模型，长任务的工具输出应先过滤',
          body: '简单修改调低 reasoning effort 或更换更轻量的模型档位，能直接降低这条请求的计费单价。翻查大量文件、耗时较长的任务应让工具输出先经过筛选再进入上下文，避免主对话堆积不必要的原始内容，上下文长度不会因此增加。',
        },
      ],
    },
    en: {
      highlight: {
        title: 'Codex usage is capped by both a 5-hour rolling window and a weekly total',
        body: 'Hitting either one means waiting for the reset or buying extra credits — check the exact numbers in the CLI or the ChatGPT usage panel.',
      },
      tips: [
        {
          title: 'In the same session, keep the gap between messages under 30 minutes',
          body: "Codex's cache depends on an exact match of the request prefix. Newer model families default to at least a 30-minute cache lifetime; older ones are typically cleared after 5-10 minutes of inactivity and always expire within an hour. Once the cache expires, the next message reprocesses the system instructions, tool definitions, and entire history at full price instead of the cache-hit rate.",
        },
        {
          title: "Run /compact immediately after finishing a small task — never let it slip until much later, or until the next task has already started",
          body: '/compact resends the current conversation to generate a summary. Run it before the cache expires and that request hits the cache. Wait until the cache has expired, or until auto-compaction fires near the context limit, and the request reprocesses the entire history as uncached input — spending roughly the same tokens as the conversation itself, a second time.',
        },
        {
          title: "Pay close attention to context length — don't wait for automatic compaction",
          body: 'A single conversation usually spans more than one request — every added message, and every model reply after a tool call, is a new request, and each one resends the full accumulated context. The extra tokens in a long context get billed across all of those requests, not just once; the exact request count for a given conversation is visible in the turn-level view. As a rule of thumb, consider compacting once context reaches roughly 200k–300k tokens.',
        },
        {
          title: "Set model and reasoning effort at the start — don't change them mid-session",
          body: "Switching models or changing reasoning effort mid-session invalidates the cached prefix, so the next message is reprocessed at full price. Also avoid pasting whole command outputs or multi-thousand-line files into context — summarizing or using grep/sed to pull the relevant snippet directly cuts what each request has to process.",
        },
        {
          title: 'Lower reasoning effort or use a smaller model for easy work; filter tool output on long tasks',
          body: "A quick edit doesn't need full reasoning effort — lowering it or switching to a lighter model directly cuts that request's rate. Long, file-heavy tasks should filter tool output before it enters context, so the main conversation doesn't accumulate unnecessary raw content and its length doesn't grow as a result.",
        },
      ],
    },
  },
};
