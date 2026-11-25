// 诊断信息：用户在「设置 → 通用」里导出，反馈问题时附上。
//
// 只放版本、设置和运行日志的最后一段。API Key、令牌、Cookie、授权参数一律打码，
// 日志本身也只记状态变化，不含对话内容。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const LOG_FILE = process.env.FIRE_RING_LOG_FILE || path.join(os.homedir(), 'Library', 'Logs', 'Fire Ring', 'bridge.log');
const LOG_LINES = 400;

/** 去掉看起来像凭据的东西。 */
export function redact(text) {
  return String(text)
    .replace(/sk-[A-Za-z0-9_-]{6,}/g, 'sk-***')
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 ***')
    .replace(/\b(token|access_token|refresh_token|api[_-]?key|apikey|key|secret|password|cookie|authorization|code|state)(\s*[=:]\s*)("?)[^\s"&,;]+/gi, '$1$2$3***')
    .replace(/([?&](?:code|state|token|key|access_token|sig|signature)=)[^&\s"]+/gi, '$1***')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, (id) => id.slice(0, 8) + '-…');
}

function tail(file, lines) {
  try {
    const size = fs.statSync(file).size;
    const take = Math.min(size, 256 * 1024);
    const handle = fs.openSync(file, 'r');
    const buffer = Buffer.alloc(take);
    fs.readSync(handle, buffer, 0, take, size - take);
    fs.closeSync(handle);
    return buffer.toString('utf8').split('\n').slice(-lines).join('\n');
  } catch (error) {
    return '（读不到日志：' + error.code + '）';
  }
}

/**
 * @param {object} facts 版本、线路、设置等，由调用方从现有状态里取
 */
export function buildDiagnostics(facts, { logFile = LOG_FILE, now = new Date() } = {}) {
  const block = (title, value) => '## ' + title + '\n' + (typeof value === 'string' ? value : JSON.stringify(value, null, 2)) + '\n';
  const parts = [
    '# Fire Ring 诊断信息',
    '生成时间：' + now.toISOString(),
    '',
    block('版本', { version: facts.version, arch: process.arch, node: process.versions.node, platform: os.release() }),
    block('网络线路', facts.route),
    block('连接的工具', facts.tools),
    block('设置', facts.config),
    block('刘海', facts.notch),
    block('DeepSeek 余额', facts.deepseek),
    block('更新', facts.update),
    block('运行日志（最后 ' + LOG_LINES + ' 行）', tail(logFile, LOG_LINES)),
  ];
  return redact(parts.join('\n'));
}
