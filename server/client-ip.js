// Resolve the real client IP for rate limiting and per-caller scoping.
//
// In production the app sits behind Cloudflare and the host's nginx, so req.socket.remoteAddress
// is a proxy address shared by every visitor. Proxy headers are only honoured when TRUST_PROXY is
// set, because anyone can send them directly to an unproxied server and impersonate other callers.
import net from 'node:net';

const TRUST_PROXY = ['1', 'true', 'yes'].includes(String(process.env.TRUST_PROXY || '').toLowerCase());

function firstIp(value) {
  if (!value) return null;
  const candidate = String(value).split(',')[0].trim();
  return net.isIP(candidate) ? candidate : null;
}

/** @param {import('node:http').IncomingMessage} req */
export function clientIp(req, { trustProxy = TRUST_PROXY } = {}) {
  if (trustProxy) {
    const h = req.headers || {};
    const fromProxy = firstIp(h['cf-connecting-ip']) || firstIp(h['x-forwarded-for']) || firstIp(h['x-real-ip']);
    if (fromProxy) return fromProxy;
  }
  return req.socket?.remoteAddress || 'x';
}
