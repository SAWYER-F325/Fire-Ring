// The one way out to the internet for the bridge (Claude usage, update checks
// and update downloads).
//
// The route comes from config.json, never from environment variables:
//   custom   tunnel through the configured HTTP proxy, and only through it; if
//            it is down the request fails, with no fallback anywhere else
//   system   the HTTPS proxy in macOS network settings, if one is switched on;
//            otherwise a direct connection
//   direct   a direct connection
//   off      nothing at all: every request fails before a socket is opened
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import { readConfig, validProxyUrl } from './config.mjs';

const TIMEOUT_MS = 10_000;
const SYSTEM_PROXY_TTL_MS = 30_000;

export class EgressError extends Error {}

let systemProxyCache = { at: 0, value: null };

/** The HTTPS proxy macOS is set to use, or null. */
function systemProxy(now = Date.now()) {
  if (now - systemProxyCache.at < SYSTEM_PROXY_TTL_MS) return systemProxyCache.value;
  let value = null;
  try {
    const out = execFileSync('/usr/sbin/scutil', ['--proxy'], { encoding: 'utf8', timeout: 3000 });
    const field = (name) => (out.match(new RegExp('\\b' + name + '\\s*:\\s*(\\S+)')) || [])[1];
    if (field('HTTPSEnable') === '1' && field('HTTPSProxy') && Number(field('HTTPSPort'))) {
      value = { host: field('HTTPSProxy'), port: Number(field('HTTPSPort')) };
    }
  } catch {
    /* no scutil answer: treat as no proxy */
  }
  systemProxyCache = { at: now, value };
  return value;
}

/** How requests leave right now: { proxy: {host, port} | null, label, error? }. */
export function currentRoute() {
  const { proxy } = readConfig();
  if (proxy.mode === 'off') return { proxy: null, label: '已断网', offline: true };
  if (proxy.mode === 'direct') return { proxy: null, label: '直连' };
  if (proxy.mode === 'custom') {
    if (!validProxyUrl(proxy.url)) return { proxy: null, label: proxy.url || '未填写', error: '代理地址无效' };
    const u = new URL(proxy.url);
    const target = { host: u.hostname, port: Number(u.port || 80) };
    return { proxy: target, label: target.host + ':' + target.port };
  }
  const found = systemProxy();
  return found
    ? { proxy: found, label: '系统代理 ' + found.host + ':' + found.port }
    : { proxy: null, label: '系统设置未开代理，直连' };
}

function tunnelSocket(proxy, target) {
  return new Promise((resolve, reject) => {
    const name = proxy.host + ':' + proxy.port;
    const authority = target.hostname + ':' + (target.port || '443');
    const tunnel = http.request({
      host: proxy.host,
      port: proxy.port,
      method: 'CONNECT',
      path: authority,
      headers: { Host: authority },
      timeout: TIMEOUT_MS,
    });
    tunnel.on('timeout', () => tunnel.destroy(new EgressError('代理 ' + name + ' 没有响应')));
    tunnel.on('error', (error) => reject(error instanceof EgressError ? error : new EgressError('连不上代理 ' + name + '：' + (error.code || error.message))));
    tunnel.on('connect', (answer, socket) => {
      if (answer.statusCode !== 200) {
        socket.destroy();
        reject(new EgressError('代理 ' + name + ' 拒绝了连接：' + answer.statusCode));
        return;
      }
      resolve(socket);
    });
    tunnel.end();
  });
}

/** Opens one https request along the configured route; resolves the response. */
async function open({ method, url, headers = {}, body = null }) {
  const target = new URL(url);
  if (target.protocol !== 'https:') throw new EgressError('只允许 https 请求');
  const route = currentRoute();
  if (route.offline) throw new EgressError('已断网，Fire Ring 不发出任何网络请求');
  if (route.error) throw new EgressError(route.error + '：' + route.label);
  const socket = route.proxy ? await tunnelSocket(route.proxy, target) : null;
  return new Promise((resolve, reject) => {
    const options = {
      host: target.hostname,
      port: Number(target.port || 443),
      defaultPort: 443,
      path: target.pathname + target.search,
      method,
      headers: body ? { ...headers, 'Content-Length': Buffer.byteLength(body) } : headers,
      timeout: TIMEOUT_MS,
    };
    if (socket) {
      // agent:false creates a new default Agent and ignores this tunnel.
      // Leave agent unset so ClientRequest uses the supplied socket factory.
      options.createConnection = () => tls.connect({ socket, servername: target.hostname });
    } else {
      options.agent = false;
    }
    const request = https.request(options, resolve);
    request.on('timeout', () => request.destroy(new Error('请求超时')));
    request.on('error', (error) => reject(socket || error instanceof EgressError ? error : new EgressError('连不上 ' + target.hostname + '：' + (error.code || error.message))));
    request.end(body || undefined);
  });
}

/** GET an https URL. Resolves { status, headers, body }. */
export function getThroughEgress(url, headers = {}) {
  return requestThroughEgress({ method: 'GET', url, headers });
}

/** Any https request with a text answer. Resolves { status, headers, body }. */
export async function requestThroughEgress({ method, url, headers = {}, body = null }) {
  const response = await open({ method, url, headers, body });
  return new Promise((resolve, reject) => {
    let text = '';
    response.setEncoding('utf8');
    response.on('data', (chunk) => { text += chunk; });
    response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: text }));
    response.on('error', reject);
  });
}

/**
 * Saves an https download to `file`, following redirects (GitHub serves release
 * files from another host) along the same route. Resolves the byte count.
 */
export async function downloadThroughEgress(url, file, { headers = {}, maxBytes = 400 * 1024 * 1024, onProgress } = {}) {
  let next = url;
  for (let hop = 0; hop < 6; hop++) {
    const response = await open({ method: 'GET', url: next, headers });
    if ([301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location) {
      response.resume();
      next = new URL(response.headers.location, next).toString();
      continue;
    }
    if (response.statusCode !== 200) {
      response.resume();
      throw new EgressError('下载失败：HTTP ' + response.statusCode);
    }
    const total = Number(response.headers['content-length']) || 0;
    if (total > maxBytes) {
      response.resume();
      throw new EgressError('下载文件过大');
    }
    return new Promise((resolve, reject) => {
      const out = fs.createWriteStream(file);
      let received = 0;
      response.on('data', (chunk) => {
        received += chunk.length;
        if (received > maxBytes) {
          response.destroy(new EgressError('下载文件过大'));
          return;
        }
        if (onProgress) onProgress(received, total);
      });
      response.on('error', (error) => { out.destroy(); reject(error); });
      out.on('error', reject);
      out.on('finish', () => resolve(received));
      response.pipe(out);
    });
  }
  throw new EgressError('重定向次数过多');
}
