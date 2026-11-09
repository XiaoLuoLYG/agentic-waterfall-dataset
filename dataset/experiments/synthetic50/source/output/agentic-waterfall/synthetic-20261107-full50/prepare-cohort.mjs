import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { loadCohort } from '../../../experiments/agentic-waterfall/synthetic-collection/cohort.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const balancedRoot = resolve(root, '../synthetic-20261107-balanced');
const balancedPath = join(balancedRoot, 'cohort.json');
const draftPath = resolve(root, '../synthetic-readiness-20261106/cohort-50.json');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const read = path => JSON.parse(readFileSync(path));
const parseLines = text => text.split('\n').filter(Boolean).map(JSON.parse);
const visibleTitle = row => row.title.replace(/<[^>]+>/g, '').trim();
const visibleSummary = row => row.summary.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().slice(0, 450);
const currentPhase = (persona, round) => persona.phases.findLast(phase => phase.start <= round);
const encode = value => JSON.stringify(value, null, 2) + '\n';
const prior = read(balancedPath);
const oldUsers = new Set(prior.participants.map(entry => entry.persona.id));
const pilotUsers = ['u113', 'u114', 'u143'];
const baseArchive = resolve(balancedRoot, prior.reference_archive);
const baseArchiveBytes = readFileSync(baseArchive);
assert.equal(sha(baseArchiveBytes), prior.reference_archive_sha256, 'approved reference archive hash changed');
const supplementPath = join(root, 'reference-supplement.json');
const supplement = process.argv[2] !== '--pilot' && existsSync(supplementPath) ? read(supplementPath) : null;
const archive = supplement ? join(root, 'reference-with-supplement.jsonl.gz') : baseArchive;
const archiveBytes = readFileSync(archive);
if (supplement) {
  assert.equal(sha(archiveBytes), supplement.archive_sha256, 'supplemented archive hash changed');
  assert(archiveBytes.subarray(0, baseArchiveBytes.length).equals(baseArchiveBytes), 'old archive prefix changed');
}
const reference = parseLines(gunzipSync(archiveBytes).toString('utf8'));
const catalog = new Map(reference.filter(row => row.canonical_url?.startsWith('https://') &&
  row.title.trim() && ['text', 'video'].includes(row.metadata?.modality))
  .map(row => [row.content_version_id, row]));
const draft = read(draftPath);
const originalTags = new Map();
function remember(tag, version) {
  if (!originalTags.has(tag)) originalTags.set(tag, new Set());
  originalTags.get(tag).add(version);
}
for (const { rounds } of draft.participants) for (const { tag, version_id } of rounds.flat()) remember(tag, version_id);
const live = parseLines(readFileSync(join(balancedRoot, 'pool', 'selection.jsonl'), 'utf8'));
const liveIds = new Set(live.map(row => row.content_version_id));
for (const row of live) for (const tag of row.topic_tags) remember(tag, row.content_version_id);
for (const row of supplement?.lineage || []) remember(row.topic, row.content_version_id);

const editor = /VS\s*Code|Neovim|\bVim\b|\bZed\b|Sublime|Notepad\+\+|Emacs|代码编辑器|文本编辑器|code editor/i;
const excel = /Excel|Power\s*Query|电子表格|工作表|工作簿|spreadsheet|workbook/i;
const desk = /桌面|书桌|書桌|桌下|桌搭|电脑桌|工作台|工位|desk|workspace|battlestation/i;
const cable = /理线|理線|走线|走線|线材|線材|线缆|線纜|线夹|线卡|排插|cable|cord|wire/i;
const mic = /麦克风|麥克風|话筒|話筒|收音|拾音|microphone|\bmic\b|录音/i;
const place = /浙江|杭州|绍兴|紹興|宁波|寧波|西湖|临海|台州|湖州|嘉兴|嘉興|海宁|衢州|余杭|富阳|桐庐|舟山|金华|义乌|乌镇|烏鎮|莫干山|Zhejiang|Hangzhou|Shaoxing|Ningbo|West Lake|Wuzhen/i;
const titleAndContext = {
  excel: [excel, /技巧|快捷|入门|教程|操作|功能|tips|shortcuts|beginner|tutorial/i],
  excel_clean: [excel, /合并|合併|去重|汇总|匯總|清洗|重复项|combined?|merge|append|duplicat|cleansing/i],
  excel_native_clean: [excel, /合并|合併|去重|汇总|匯總|清洗|重复项|combined?|merge|append|duplicat/i],
  excel_formula: [/Excel|XLOOKUP|VLOOKUP|SUMIF|COUNTIF|INDEX.{0,4}MATCH|查找函数|条件求和/i, /查找|条件|函数|求和|公式|lookup|sumif|countif|formula|criteria/i],
  python_excel: [/Python|Pandas|openpyxl|xlwings/i, /Excel|工作簿|工作表|表格|xlsx/i],
  office: [/办公|效率|文件|电脑|軟件|Windows|Mac|keyboard|file|Office/i, /管理|快捷|整理|工具|操作|檔案|explorer|productivity|shortcut|manager/i],
  editors: [editor, /编辑器|配置|体验|比较|对比|對比|操作|快捷键|入门|设置|轻量|workflow|editor|comparison|settings|setup|tutorial/i],
  vim: [/Neovim|\bVim\b/i, /配置|操作|使用|键位|快捷键|入门|键盘|插件|LSP|setup|config|tutorial|keyboard|workflow|beginner/i],
  vscode_setup: [/VS\s*Code/i, /配置|设置|安装|工作流|插件|快捷键|调试|自定义|keyboard|workflow|setup|settings|config|extension/i],
  script_setup: [/Python|脚本|腳本|Anaconda|PyCharm/i, /安装|配置|环境|執行|执行|运行|命令行|脚本|install|setup|environment|execute|\brun\b|script/i],
  ai_dev: [/\bAI\b|LLM|Claude|Codex|Copilot|Cursor|DeepSeek|人工智能/i, /开发|编程|代码|程式|工作流|code|coding|developer|workflow|agent/i],
  desk: [desk, /理线|布置|布局|收纳|改造|电脑桌|桌搭|setup|organizing|cable/i],
  desk_cable: [desk, cable],
  desk_display: [/显示器|顯示器|双屏|雙屏|monitor|dual screen/i, /支架|桌面|摆放|桌搭|安装|夹|掛|臂|空间|arm|stand|mount|setup|desk/i],
  desk_display_install: [/显示器|顯示器|双屏|雙屏|monitor|dual screen/i, /安装|接线|連接|连接|支架|夹|裝|设置|install|mount|setup|extend display/i],
  audio_mic: [mic, /收音|拾音|麦克风|錄音|录音|摆放|降噪|测评|测试|settings|recording|sound|position|microphone/i],
  audio_tune: [mic, /设置|設定|底噪|降噪|增益|杂音|雜音|音量|噪音|声音|拾音|回声|settings|gain|noise|audio|echo/i],
  headphones: [/耳机|耳機|头戴|頭戴|耳塞|headphone|earbud/i, /降噪|佩戴|通勤|选购|对比|測評|评测|实测|noise cancellation|commut|review|comfort/i],
  travel_common: [place, /游|旅行|出行|周末|週末|攻略|路线|路線|行程|逛|trip|travel|weekend|visit|itinerar/i],
  travel_route: [place, /路线|路線|攻略|行程|游玩|一日游|一日遊|两日|怎么玩|itinerar|route|day trip/i],
  travel_rail: [place, /高铁|高鐵|动车|動車|火车|火車|铁路|鐵路|地铁|地鐵|train|rail|metro|station/i],
  travel_family: [/杭州|西湖|余杭|富阳|桐庐|滨江|临安|Hangzhou|West Lake/i, /亲子|親子|遛娃|带娃|帶娃|孩子|儿童|兒童|小朋友|动物园|動物園|游乐|樂園|family|kids|children|zoo/i],
  running_intro: [/跑步|慢跑|跑姿|jogging|running|runner/i, /新手|入门|零基础|跑姿|准备|熱身|热身|beginner|first run|start/i],
  running_plan: [/跑步|慢跑|5K|五公里|5公里|running|runner|jogging|couch to 5k/i, /训练|訓練|计划|計劃|配速|节奏|呼吸|循序|初跑|schedule|plan|train|pace|breathing/i],
  running_knee: [/跑步|跑前|跑后|跑者|慢跑|跑姿|running|runner|jogging/i, /热身|熱身|拉伸|放松|膝盖|膝蓋|膝关节|伤|injur|warm.?up|stretch|knee/i],
  phone_buy: [/手机|手機|iPhone|Pixel|Galaxy|小米|荣耀|華為|华为|OPPO|Vivo|smartphone/i, /评测|測評|测评|实测|体验|體驗|选购|推荐|对比|比較|review|compar|test/i],
  phone_photo: [/手机|手機|iPhone|Pixel|Galaxy|smartphone/i, /摄影|攝影|拍照|拍摄|拍攝|取景|构图|曝光|camera|photo|composition|exposure/i],
  phone_usage: [/手机|手機|iPhone|Pixel|Galaxy|安卓|smartphone/i, /使用|设置|設定|技巧|迁移|轉移|体验|教學|教程|入门|transfer|settings|tips|tutorial/i],
  video_post: [/剪辑|剪輯|剪映|CapCut|Premiere|达芬奇|達芬奇|视频|影片|video editing/i, /剪辑|剪輯|后期|後期|转场|字幕|调色|教程|素材|timelin|editing|workflow/i],
  camera_buy: [/相机|相機|微单|微單|单反|單反|camera|mirrorless|DSLR/i, /选购|選購|推荐|推薦|预算|預算|二手|购买|購買|买|購機|buy|budget|used|recommend|best/i],
  camera_review: [/相机|相機|微单|微單|单反|單反|camera|mirrorless|DSLR/i, /测评|測評|评测|对比|對比|比較|实测|样片|畫質|画质|review|compar|sample|image quality/i],
  camera_skill: [/相机|相機|摄影|攝影|拍摄|拍攝|拍照|微单|微單|photograph|camera/i, /构图|構圖|快门|快門|曝光|光圈|参数|參數|跟焦|对焦|對焦|教程|技巧|composition|exposure|shutter|aperture|manual mode|settings/i],
  reading: [/阅读|閱讀|读书|讀書|看书|书单|書單|书评|書評|好书|好書|\bbooks?\b|reading/i, /分享|推荐|推薦|书单|書單|书评|書評|好书|讀書|读书|review|recommen|reading|book/i],
  reading_method: [/阅读|閱讀|读书|讀書|看书|读完|讀完|\bbooks?\b|reading/i, /笔记|筆記|方法|摘抄|精读|精讀|复盘|復盤|体系|記憶|note|read effectively|method|remember/i],
  films: [/电影|電影|纪录片|紀錄片|影片|\bfilms?\b|\bmovies?\b|documentar/i, /推荐|推薦|片单|片單|好看|值得看|觀影|观影|经典|經典|documentar|watch|recommend|list/i],
};

function usefulText(row) {
  const title = visibleTitle(row), summary = visibleSummary(row);
  if (summary.length < (row.source === 'github' ? 15 : 55)) return false;
  if (row.source === 'reddit' && /\?|need advice|looking for advice|what should i|does anyone know|any suggestions|any ideas|how (?:can|do) i|\bhelp\b/i.test(title) &&
      !/here is|here are|i found|solved|worked for|solution|\bsteps\b/i.test(summary)) return false;
  return true;
}

function topicScore(tag, row) {
  const rule = titleAndContext[tag];
  const title = visibleTitle(row), summary = visibleSummary(row);
  if (!rule || !rule[0].test(title) || !rule[1].test(title + ' ' + summary)) return 0;
  if (tag === 'desk_cable' && /(?:windows|安卓|vivo|小米|\biOS\b).{0,15}(?:桌面|desktop).{0,12}(?:整理|布局|组件|小组件)/i.test(title)) return 0;
  if (tag === 'desk' && /手机|手機|iPhone|安卓|\biOS\b|桌面美化|小组件|小組件|数字桌面|数字化桌面/i.test(title)) return 0;
  if (tag === 'excel_native_clean' && /\bpython\b|pandas|openpyxl|claude|deepseek|AI Agent/i.test(title)) return 0;
  if (tag === 'editors' && /Claude Code vs|Codex vs|\bCursor\b.*Claude|\bClaude\b.*\bCursor\b/i.test(title)) return 0;
  if (tag === 'films' && /片尾|片头|拍摄教程|拍攝教程|电影感|電影感|剪辑教程|剪輯教程|撤档|快门/i.test(title)) return 0;
  const declared = originalTags.get(tag)?.has(row.content_version_id);
  const exactTitle = rule[1].test(title);
  return 1 + Number(declared) + Number(exactTitle) + Number(summary.length > 90);
}

function controlScore(tag, row) {
  const score = topicScore(tag, row);
  if (!score || row.metadata.modality === 'text' && !usefulText(row)) return 0;
  const title = visibleTitle(row), summary = visibleSummary(row), combined = title + ' ' + summary;
  if (tag === 'phone_buy' && !/拍照|摄像|影像|成像|样片|夜景|camera|photo/i.test(title)) return 0;
  if (tag === 'camera_skill' && (!/构图|構圖|快门|快門|曝光|光圈|手动|手動|参数|參數|菜单|菜單|composition|exposure|shutter|aperture|manual mode/i.test(combined) ||
      /胶片|膠片|蝴蝶刀|手机|手機|iPhone|运动摄影|体育赛事|摄影机|摄影风扇/i.test(title))) return 0;
  if (tag === 'office' && /\bpython\b|自动化办公.{0,5}脚本|技术手册|PDF开放下载/i.test(title)) return 0;
  if (tag === 'excel_formula' && (!/VLOOKUP|XLOOKUP|SUMIF|COUNTIF|INDEX.{0,5}MATCH|条件求和|条件统计|多条件查找|匹配|查找函数|lookup|conditional formula/i.test(combined) ||
      /Power\s*Query|数据透视|非函数|AI Agent/i.test(title))) return 0;
  if (tag === 'desk_display' && /虚拟显示器|遠程桌面|远程桌面|串流|驱动安装|virtual display/i.test(title)) return 0;
  if (tag === 'audio_mic' && /三极管|偏置电阻|电路|電路|原理图|模电|运放/i.test(title)) return 0;
  if (tag === 'audio_tune' && /推荐|选购|测评|評測|评测|開箱|开箱|好物|排名|\breview\b|录屏|錄屏|产品|话放/i.test(title)) return 0;
  if (tag === 'travel_family' && (/旅行社|榜单|排名|暑假限定|国庆限定|營銷|营销|跟团/i.test(title) ||
      !/路线|路線|攻略|地址|交通|地铁|地鐵|公交|站|行程|route|itinerar|walk/i.test(combined))) return 0;
  if (tag === 'travel_route' && !/站|交通|小时|小時|分钟|分鐘|地址|开馆|開館|hour|station|公交|地铁|路線|路口/i.test(combined)) return 0;
  if (tag === 'travel_rail' && (/隔离|隔離|暑假限定|動卧|动卧|跨国|新建高铁/i.test(title) ||
      !/车站|車站|交通|时间|時間|时长|時長|换乘|換乘|station|hour|transfer|schedule|出站|出口|公交|号线|號線/i.test(combined))) return 0;
  if (tag === 'desk_display_install' && /推荐|評測|评测|测评|开箱|開箱|值得买|best monitor/i.test(title) &&
      !/安装|夹|步骤|步驟|接口|接线|走线|设置|install|mount/i.test(summary)) return 0;
  if (tag === 'running_knee' && !/热身|熱身|拉伸|放松|步频|動作|动作|warm.?up|stretch|mobility/i.test(combined)) return 0;
  if (tag === 'running_plan' && (!/5\s*k|五公里|5\s*公里|5\s*km|C25K|周|配速|间歇|pace|week|walk.run/i.test(combined) ||
      /全马|半马|马拉松|marathon|负重|負重|装备|裝備/i.test(title) && !/5\s*k|五公里|5\s*公里/i.test(title))) return 0;
  if (tag === 'script_setup' && (/Sim4Life|Stata|数据分析|数据處理|数据处理|案例合集|源码合集|生医|生醫|pygame|AI Agent|PaddleOCR|激活|教培/i.test(title) ||
      !/安装|安裝|配置|环境|環境|解释器|解釋器|运行脚本|運行腳本|执行脚本|執行腳本|\bpython\b.{0,12}\brun\b|installer|install|environment/i.test(combined))) return 0;
  if (tag === 'vscode_setup' && (/Sim4Life|STM32|EIDE|C\/C\+\+|C\+\+|Python.*环境|Python.*環境|海龟绘图|Claude|DeepSeek|MCP|Copilot/i.test(title) ||
      !/快捷键|快捷鍵|键位|插件|扩展|擴展|設定|项目配置|工作区|工作區|workspace|shortcut|keybind|settings|extension/i.test(combined))) return 0;
  if (tag === 'excel_native_clean' && /Stata|Power\s*BI|Python|Pandas|AI Agent|Claude|DeepSeek/i.test(title)) return 0;
  if (tag === 'phone_photo' && (/收音|领夹|領夾|选购|選購|配件|外接镜头|外接鏡頭|预算|預算|值得买|買相機|买相机/i.test(title) ||
      !/设置|設置|設定|模式|夜景|HDR|曝光|构图|構圖|快门|快門|参数|參數|取景|操作|教程|技巧|composition|settings|exposure|shooting mode/i.test(combined))) return 0;
  if (tag === 'vim' && /dotfiles|config/i.test(title) && row.source === 'github' &&
      !/install|configure|installing|setup|plugin|command|lsp/i.test(summary)) return 0;
  const specifics = {
    audio_mic: /实际|實際|实测|實測|听感|試聽|试听|对比|對比|摆位|擺位|收音|pickup/i,
    audio_tune: /会议|會議|Windows|Teams|Zoom|回声|降噪|输入音量|输入设备/i,
    desk_display_install: /桌夹|桌夾|夹桌|夹具|夹式|夾式|安装|安裝|mount|clamp/i,
    editors: /快捷|对比|對比|体验|體驗|比较|比較|编辑器|編輯器|comparison|compared|code editors/i,
    running_plan: /5\s*k|五公里|5\s*公里|C25K/i,
    travel_rail: /一日游|一日遊|当天|當天|停留|往返|day trip|路线|路線/i,
    travel_family: /地铁|地鐵|公交|站[下出口]|步行|停车|停車|分钟|分鐘|地址|路线图|路線圖|集合/i,
    phone_photo: /设置|設置|設定|夜景|HDR|快门|快門|曝光|构图|構圖/i,
  };
  return score + Number(/教程|步骤|步驟|操作|讲解|講解|设置|設定|tutorial|guide|how to|steps/i.test(combined)) +
    2 * Number(Boolean(specifics[tag]?.test(combined)));
}

const background = [...catalog.values()].filter(row => originalTags.get('background')?.has(row.content_version_id) &&
  row.source !== 'twitch' && visibleTitle(row).length >= 12);
const rankedByTag = new Map();
function materials(tag) {
  if (rankedByTag.has(tag)) return rankedByTag.get(tag);
  const rows = tag === 'background' ? background.map(row => ({ row, score: 1, control: 1 }))
    : [...catalog.values()].filter(row => row.source !== 'twitch').map(row =>
      ({ row, score: topicScore(tag, row), control: controlScore(tag, row) })).filter(entry => entry.score);
  rankedByTag.set(tag, rows);
  return rows;
}

function buildDeck(personas, rounds, pins = {}) {
  const persona = personas[0];
  const used = new Set(), sourceUse = new Map(), order = new Map();
  const keys = row => [row.content_id, row.canonical_url.replace(/\/$/, '')];
  const reviewCards = new Map(Object.values(pins).flat().filter(Boolean).map(version => {
    const candidates = [...catalog.keys()].filter(id => id.startsWith('version:' + version));
    assert.equal(candidates.length, 1, 'reviewed card must have a unique version: ' + version);
    return [version, catalog.get(candidates[0])];
  }));
  const reserved = new Set([...reviewCards.values()].flatMap(keys));
  const seed = persona.pair || persona.id;
  function available(tag, modality, control) {
    return materials(tag).filter(({ row, control: quality }) => (!modality || row.metadata.modality === modality) &&
      (!control || quality) && keys(row).every(key => !used.has(key) && !reserved.has(key)));
  }
  function take(tag, { modality, control = false, pin, optional = false } = {}) {
    let row;
    if (pin) {
      row = reviewCards.get(pin);
      assert(row && keys(row).every(key => !used.has(key)) && (!modality || row.metadata.modality === modality), 'bad reviewed pin: ' + persona.id + '/' + pin);
    } else {
      const sorted = available(tag, modality, control);
      const tie = row => {
        if (!order.has(row.content_version_id)) order.set(row.content_version_id, sha(seed + '\0' + row.content_version_id).slice(0, 12));
        return order.get(row.content_version_id);
      };
      sorted.sort((a, b) => (control ? b.control - a.control : b.score - a.score) ||
        (sourceUse.get(a.row.source) || 0) - (sourceUse.get(b.row.source) || 0) ||
        Number(liveIds.has(b.row.content_version_id)) - Number(liveIds.has(a.row.content_version_id)) ||
        tie(a.row).localeCompare(tie(b.row)));
      row = sorted[0]?.row;
    }
    if (optional && !row) return null;
    assert(row, 'no suitable archived card: ' + [persona.id, tag, modality || 'any', control ? 'control' : 'topic'].join('/'));
    for (const key of keys(row)) used.add(key);
    sourceUse.set(row.source, (sourceUse.get(row.source) || 0) + 1);
    return { tag, version_id: row.content_version_id };
  }

  return Array.from({ length: rounds }, (_, index) => {
    const round = index + 1, phase = currentPhase(persona, round), cards = [];
    if (persona.pair) {
      if (phase.start === 1) {
        for (let slot = 0; slot < 3; slot++) cards.push(take(phase.focus, { pin: pins[round]?.[slot] }));
      } else {
        const other = currentPhase(personas[1], round), topics = [phase.focus, other.focus];
        for (const [slot, topic] of topics.entries()) cards.push(take(topic, { pin: pins[round]?.[slot] }));
        const until = persona.phases.find(item => item.start > round)?.start ?? rounds + 1;
        if (pins[round]?.length === 4 || round % 2 === 0 && topics.every(topic => available(topic).length > until - round)) {
          for (const [slot, topic] of topics.entries()) cards.push(take(topic, { pin: pins[round]?.[slot + 2] }));
        }
      }
    } else if (persona.subset === 'interactive_revision') {
      const strict = persona.phases[2], relaxed = persona.phases[3];
      const critical = [strict.start, relaxed.start - 1, relaxed.start].includes(round);
      const modality = critical ? strict.hard.modality : phase.hard.modality;
      cards.push(take(phase.focus, { modality, control: critical || Boolean(modality) || phase.start === round, pin: pins[round]?.[0] }));
      if (critical) {
        cards.push(take(phase.focus, { modality: modality === 'text' ? 'video' : 'text', control: true, pin: pins[round]?.[1] }));
      } else {
        const earlier = persona.phases[0].focus;
        if (earlier !== phase.focus) {
          const old = take(earlier, { optional: true });
          if (old) cards.push(old);
        }
      }
    } else {
      cards.push(take(phase.focus));
    }
    while (cards.length < 5) cards.push(take('background'));
    const rotate = index % cards.length;
    return [...cards.slice(rotate), ...cards.slice(0, rotate)];
  });
}

const pilotDesign = {
  u113: {
    rounds: 16, starts: [1, 4, 10],
    profile: '31 岁，男性，住成都，在小型物流公司做后端开发。白天用 VS Code 看服务日志，晚上会在旧笔记本上用 Neovim 改个人脚本。平时愿意为少一次鼠标操作改配置，先看能不能当场照做，常收藏键位对照和可复用的 Lua 配置。碰到一整套 AI 编程课或炫酷主题，通常看一眼就划掉。习惯在下班地铁上先看摘要，回家再试操作。',
    pins: {
      3: ['5e507f8031f7fc2bec8e00176d1846b8f83d24fd55c0c0148835e57880f248d2','bf6f3a4a7b316f3caf3fa4284624a2857fb0861f6b0c6a4ed6c86e3ecace8685','8bdf12e9c68f686b60c1c54ca54ce238e6b35f2628a6a6b4d0d50134b053227f'],
      4: ['66c33211764af27a839d60dbd7ca9349f890138bccb764d5fcb9af8d98f611cb','d98ad6ca558a2b9a8ed020ef95c960674f4cfeaa67931d8921eebe6ed6b651a4','0e19756a9196e59114e72afaabf79e5631c095e9f318d20e4b17b51e0583bd6c','4c93b839cedd3907bcd07017355c44fc9fc1ae61880c7f16cd7991c4826785a8'],
      10: ['1080449712d73951bc7145782a2cbeb6d661e8eff5b739bb55fce9830f2187f0','55fd6b15d7ab65ecb4a0eb35e55aed653258a695687b5f1a10fbb2fb6471215e'],
    },
  },
  u114: {
    rounds: 16, starts: [1, 4, 10],
    profile: '47 岁，女性，住无锡，在灯具门店负责采购和出入库。供应商发来一个现成的 Python 脚本帮她整理旧单号，只要在 Windows 上跑通一次。以前没配过环境，会停下来读安装、选择解释器和运行文件的实际步骤。手头的单子处理完就不想继续学编程，平时更需要文件批量改名、窗口快捷键和表格交接的方法。',
  },
  u143: {
    rounds: 16, starts: [1, 4, 8, 12], format: 'text',
    profile: '39 岁，女性，住厦门，在家给电商团队做商品图片。用的是租来的小书桌，显示器下方塞着排插，数位板和电脑每天都会拔插。她会先比较夹桌支架能腾多少位置，选好后更关心怎样把线固定又能单独抽换。收工前常把操作步骤转成手机清单，愿意保存标出背胶、魔术贴和线夹位置的帖子。只有漂亮桌搭照片、没有做法的卡片通常划掉。',
    commands: [
      '我想把屏幕架高一点，桌上好放数位板。能给我看看夹在桌沿的支架吗？',
      '架子装好了，可排插一拉就掉，数位板的线又得天天拔。想找那种固定住还能单独抽线的理法。',
      '我在桌底下边弄边对照，先发图文步骤吧，视频不方便来回找进度。',
      '排插固定好了。剩下几根线我想看看别人怎么绕，图文视频都可以。',
    ],
    pins: {
      1: ['1d9340f2c772ded2e775c3018d790df1ad27a3bb162a4db1359b91465793af41'],
      4: ['4c181c3e898feab8996823893f5fec4942da67c451edc9d633be75e577f1e5fa'],
      8: ['067df97b60968fe870c87fcbdd04d582eda186629f46a72a76190d9ec14913c3','52017be44e669ea5fd2d13490f78731662c08e08a1d73cdb1d41ac23df1f0fa3'],
      11: ['2d37b443e89cfba0e21398b41e56ca5bfe1e3ff52c5701640dbb7b33af14caf6','eed581072877d2f416055adf2aaed2ff5708c6cb5f97f3e0ba58e3af3c20d866'],
      12: ['6db68794b6cbea2da09c0fd133cf317a741006a1811fa5a4fd5bccf82a3b826d','d64aefe519a914e80fc4587bc27100db87309873f0a8d864bdfb54c442aa806a'],
    },
  },
};

function newPersona(original, spec) {
  const persona = structuredClone(original);
  assert(spec.profile.length >= 90 && !/[。！？][A-Za-z]+姓/.test(spec.profile), 'missing concrete private setting for ' + persona.id);
  persona.hidden_profile = spec.profile;
  assert(spec.starts.length === persona.phases.length, 'wrong phase count for ' + persona.id);
  for (const [index, phase] of persona.phases.entries()) {
    phase.start = spec.starts[index];
    phase.hard = {};
    phase.command = '';
    if (spec.focuses?.[index]) phase.focus = spec.focuses[index];
    if (spec.goals?.[index]) phase.goal = spec.goals[index];
    if (persona.subset === 'interactive_revision') {
      phase.command = spec.commands[index];
      if (index === 2) phase.hard = { modality: spec.format };
    }
  }
  return persona;
}

function inspectControls(participants) {
  return participants.filter(entry => entry.persona.subset === 'interactive_revision').map(({ persona, rounds }) => {
    const [initial, switchPhase, strict, relaxed] = persona.phases;
    return {
      user: persona.id,
      reused: oldUsers.has(persona.id),
      commands: persona.phases.map(({ start, command, hard }) => ({ round: start, command, hard })),
      target_turns: [initial.start, switchPhase.start, strict.start, relaxed.start - 1, relaxed.start].map(round => {
        const focus = currentPhase(persona, round).focus;
        return { round, focus, cards: rounds[round - 1].filter(card => card.tag === focus).map(card => {
          const row = catalog.get(card.version_id);
          return { version_id: card.version_id, source: row.source, modality: row.metadata.modality,
            title: visibleTitle(row), summary: visibleSummary(row), canonical_url: row.canonical_url };
        }) };
      }),
    };
  });
}

function writeValidated(path, value, lock = false) {
  const text = encode(value);
  if (lock && existsSync(path)) {
    assert.equal(readFileSync(path, 'utf8'), text, 'frozen cohort already exists with different contents');
    return loadCohort(path);
  }
  const temporary = path + '.tmp';
  writeFileSync(temporary, text, { mode: 0o600 });
  try {
    const verified = loadCohort(temporary);
    renameSync(temporary, path);
    return verified;
  } catch (error) {
    unlinkSync(temporary);
    throw error;
  }
}

async function run(option) {
  const pilotOnly = option === '--pilot';
  assert(pilotOnly || ['--draft', '--full'].includes(option), 'Use --pilot, --draft or --full');
  const extras = pilotOnly ? {} : (await import('./full-design.mjs')).design;
  const specs = { ...extras, ...pilotDesign };
  const accepted = prior.participants;
  const newUsers = draft.participants.filter(({ persona }) => !oldUsers.has(persona.id) && (!pilotOnly || pilotUsers.includes(persona.id)));
  assert.equal(newUsers.length, pilotOnly ? 3 : 40);
  const prepared = newUsers.map(({ persona }) => {
    const spec = specs[persona.id];
    assert(spec, 'missing scenario design: ' + persona.id);
    return { persona: newPersona(persona, spec), spec };
  });
  const builtPairs = new Map();
  const earlyPilotPath = join(root, 'pilot-cohort.json');
  const earlyPilot = !pilotOnly && existsSync(earlyPilotPath) ? new Map(
    read(earlyPilotPath).participants.map(entry => [entry.persona.id, entry])) : new Map();
  const newParticipants = prepared.map(({ persona, spec }) => {
    if (earlyPilot.has(persona.id)) {
      const entry = earlyPilot.get(persona.id);
      assert.deepEqual(entry.persona, persona, 'early pilot persona changed');
      return entry;
    }
    let rounds;
    if (persona.pair) {
      const mates = prepared.filter(x => x.persona.pair === persona.pair);
      assert(mates.length === 2 && mates.every(x => x.spec.rounds === spec.rounds && JSON.stringify(x.spec.starts) === JSON.stringify(spec.starts)));
      if (!builtPairs.has(persona.pair)) builtPairs.set(persona.pair, buildDeck(mates.map(x => x.persona), spec.rounds, mates[0].spec.pins));
      rounds = builtPairs.get(persona.pair);
    } else {
      rounds = buildDeck([persona], spec.rounds, spec.pins);
    }
    return { persona, rounds };
  });
  const participants = pilotOnly ? newParticipants : [...accepted, ...newParticipants].sort((a, b) => a.persona.id.localeCompare(b.persona.id));
  const base = {
    schema_version: 'awf-synthetic-cohort/1.1', data_origin: 'synthetic',
    reference_archive: relative(root, archive), reference_archive_sha256: sha(archiveBytes), pilot_users: pilotUsers,
    provenance: {
      reused_balanced_cohort_sha256: sha(readFileSync(balancedPath)), prior_draft_sha256: sha(readFileSync(draftPath)),
      retained_user_ids: pilotOnly ? [] : [...oldUsers].sort(),
      base_archive_sha256: sha(baseArchiveBytes), reference_supplement_sha256: supplement ? sha(readFileSync(supplementPath)) : null,
      source_only_acquisition_calls: supplement?.actions.length || 0,
      authored_private_profiles: true, authored_commands: true, common_matched_pair_decks: true,
    },
    participants,
  };
  const basename = pilotOnly ? 'pilot' : option === '--draft' ? 'draft' : 'full';
  const file = join(root, basename === 'full' ? 'cohort.json' : basename + '-cohort.json');
  const result = writeValidated(file, base, option !== '--draft');
  if (!pilotOnly) {
    assert.deepEqual(result.counts, { general: 10, behavior_ambiguity: 20, interactive_revision: 20 });
    const old = loadCohort(balancedPath);
    for (const original of accepted) {
      const id = original.persona.id;
      assert.deepEqual(participants.find(entry => entry.persona.id === id), original, 'retained participant changed: ' + id);
      assert.deepEqual(result.decks.get(id), old.decks.get(id), 'retained archive deck changed: ' + id);
      assert.deepEqual(result.checkpoints.get(id), old.checkpoints.get(id), 'retained cutoff rounds changed: ' + id);
    }
    const priorPilotFile = join(root, 'pilot-cohort.json');
    if (existsSync(priorPilotFile)) {
      const pilot = read(priorPilotFile);
      for (const participant of pilot.participants) assert.deepEqual(
        participants.find(entry => entry.persona.id === participant.persona.id), participant, 'early pilot participant changed');
    }
  }
  const rounds_by_user = Object.fromEntries(participants.map(({ persona, rounds }) => [persona.id, rounds.length]));
  const checkpoints_by_user = Object.fromEntries(result.checkpoints);
  const summary = {
    cohort_sha256: sha(readFileSync(file)), archive_sha256: sha(archiveBytes), groups: result.counts, pilot_users: pilotUsers,
    rounds: Object.values(rounds_by_user).reduce((sum, value) => sum + value, 0), rounds_by_user, checkpoints_by_user,
    retained_participant_entries_exact: pilotOnly ? 0 : accepted.length, interactive_materials: inspectControls(participants),
  };
  writeFileSync(join(root, basename + '-preflight.json'), encode(summary), { mode: 0o600 });
  console.log(JSON.stringify({ file, sha256: summary.cohort_sha256, groups: summary.groups,
    rounds: summary.rounds, pilot_rounds: pilotUsers.map(id => rounds_by_user[id]),
    retained: summary.retained_participant_entries_exact, unique_materials: result.unique_materials }));
}

await run(process.argv[2]);
