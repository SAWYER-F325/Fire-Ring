// 刘海之外的提醒：任务开始等你、一轮做完、一直没处理、额度变低时，产生一条提醒。
// 提醒交给 App 去响铃和发系统通知；这里只决定要不要提醒、用哪个声音、写什么字。
//
// 只记录状态和标题，不读对话内容。第一次读取只当基线，重启不会把旧任务再提醒一遍。
import { readConfig } from './config.mjs';

export const MAX_REMINDERS = 3;
const QUOTA_CHECK_MS = 60_000;
const KEEP = 20;

const TOOL_NAME = {
  claude: 'Claude Code',
  codex: 'Codex',
  dsh: 'DeepSeek',
  antigravity: 'Antigravity',
  cursor: 'Cursor',
  grok: 'Grok',
};
const WINDOW_NAME = { five_hour: '5 小时', weekly: '每周' };
const toolName = (s) => TOOL_NAME[s.provider] || s.providerName || '任务';
const hhmm = (ms) => new Date(ms).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });

export function createAlerts({
  now = Date.now,
  config = () => readConfig(),
  codexQuota = () => null,
  deepseekBalance = () => null,
} = {}) {
  let seq = 0;
  const events = [];
  const lastStatus = new Map();   // id -> status
  const lastEnded = new Map();    // id -> when its latest turn ended
  const reminders = new Map();    // id -> { lastAt, count }
  let primed = false;
  const lowFired = new Map();     // 'codex:five_hour' -> resetsAt，'deepseek' -> true
  let quotaCheckedAt = -Infinity;
  let quotaPrimed = false;

  // 一条提醒：声音、通知和文字都按现在的设置定好，App 照做即可。
  function push(kind, { sound, notify, title, plain, body, session = null }) {
    const { alerts } = config();
    if (alerts.pausedUntil > now()) return;
    const volume = alerts.volume;
    const wantsSound = sound !== 'none' && volume > 0;
    if (!wantsSound && !notify) return;
    seq += 1;
    events.push({
      seq,
      at: now(),
      kind,
      session,
      sound: wantsSound ? sound : 'none',
      volume,
      notify,
      title: alerts.notify.title ? title : plain,
      body: alerts.notify.title ? body : '打开 Fire Ring 查看',
    });
    while (events.length > KEEP) events.shift();
    // 只记种类、会话编号和发了什么，不记标题和对话内容
    console.log('[alert] ' + new Date(now()).toISOString().slice(11, 19) + ' #' + seq + ' ' + kind
      + (session ? ' ' + String(session).slice(0, 8) : '')
      + ' 声音=' + (wantsSound ? sound : '无') + ' 通知=' + (notify ? '是' : '否'));
  }

  function sessionAlert(kind, s, extra = '') {
    const { alerts } = config();
    const which = kind === 'done' ? 'done' : 'wait';
    const tool = alerts.tools[s.provider];
    if (tool && !tool[which]) return;
    const name = toolName(s);
    const label = s.title || s.project || '';
    const text = {
      wait: [name + ' 在等你', name + ' 有 1 个任务在等你'],
      remind: [name + ' 还在等你', name + ' 有 1 个任务还在等你'],
      done: [name + ' 完成了', name + ' 有 1 个任务完成了'],
    }[kind];
    push(kind, {
      sound: alerts.sounds[which],
      notify: alerts.notify[which],
      title: text[0],
      plain: text[1],
      body: label + extra,
      session: s.id,
    });
  }

  /** 每次读完任务状态后调用。 */
  function observe(sessions) {
    const { alerts } = config();
    const t = now();
    const seen = new Set();
    for (const s of sessions) {
      seen.add(s.id);
      const before = lastStatus.get(s.id);
      lastStatus.set(s.id, s.status);
      // 一轮结束（包括你正看着它结束的）：响「完成」。没有这个信息的，看状态变成完成。
      const endedBefore = lastEnded.get(s.id);
      const ended = s.turnEndedAt ?? null;
      lastEnded.set(s.id, ended);
      const justEnded = ended !== null ? ended !== endedBefore : (s.status === 'finished' && before !== 'finished');
      if (s.status !== 'waiting') reminders.delete(s.id);
      if (!primed) {
        if (s.status === 'waiting') reminders.set(s.id, { lastAt: t, count: 0 });
        continue;
      }
      if (s.status === 'waiting' && before !== 'waiting') {
        reminders.set(s.id, { lastAt: t, count: 0 });
        sessionAlert('wait', s);
      } else if (justEnded && s.status !== 'waiting') {
        sessionAlert('done', s);
      } else if (s.status === 'waiting' && alerts.remind > 0) {
        const r = reminders.get(s.id) || { lastAt: t, count: 0 };
        reminders.set(s.id, r);
        if (r.count < MAX_REMINDERS && t - r.lastAt >= alerts.remind * 60_000) {
          r.count += 1;
          r.lastAt = t;
          const minutes = Math.round((t - (s.updatedAt || t)) / 60_000);
          sessionAlert('remind', s, minutes > 0 ? ' · 等了 ' + minutes + ' 分钟' : '');
        }
      }
    }
    for (const id of [...lastStatus.keys()]) if (!seen.has(id)) { lastStatus.delete(id); lastEnded.delete(id); reminders.delete(id); }
    primed = true;
    checkQuota();
  }

  // 额度：每分钟看一次。降到设定值以下提醒一次，重置后再降下来才会再提醒。
  function checkQuota() {
    const t = now();
    if (t - quotaCheckedAt < QUOTA_CHECK_MS) return;
    quotaCheckedAt = t;
    const { alerts, providers } = config();
    const fire = (key, mark, message) => {
      if (lowFired.get(key) === mark) return;
      lowFired.set(key, mark);
      if (quotaPrimed) push('quota', { sound: alerts.sounds.wait, notify: true, ...message });
    };

    const q = providers.codex && alerts.codexLow > 0 ? codexQuota() : null;
    for (const w of (q && q.state === 'ok' ? q.windows : [])) {
      const key = 'codex:' + w.kind;
      if (w.reset || w.leftPercent > alerts.codexLow) { lowFired.delete(key); continue; }
      const left = Math.max(0, Math.round(w.leftPercent));
      const title = 'Codex ' + (WINDOW_NAME[w.kind] || '') + '额度剩 ' + left + '%';
      fire(key, w.resetsAt, { title, plain: title, body: w.resetsAt ? hhmm(w.resetsAt * 1000) + ' 重置' : '' });
    }

    const reading = providers.dsh && alerts.dsLow.on ? deepseekBalance() : null;
    const main = reading && Array.isArray(reading.balances) ? reading.balances[0] : null;
    if (main && Number.isFinite(Number(main.total))) {
      const total = Number(main.total);
      if (total >= alerts.dsLow.amount) lowFired.delete('deepseek');
      else {
        const money = (main.currency === 'USD' ? '$' : '¥') + total.toFixed(2);
        const title = 'DeepSeek 余额只剩 ' + money;
        fire('deepseek', true, { title, plain: title, body: '低于你设的 ¥' + alerts.dsLow.amount + '，记得充值' });
      }
    }
    quotaPrimed = true;
  }

  return {
    observe,
    /** 最新的序号和最近的提醒，给刘海页面转交 App。 */
    latest: () => ({ seq, events: events.slice() }),
  };
}
