import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { config } from './config.js';
import { passwordSource, sessionSecret, setPassword, setupCode, validatePassword, verifyPassword } from './settings.js';
import { errorMessage } from './util.js';

const COOKIE = 'signal_session';
const TTL_MS = 8 * 60 * 60 * 1000;

const sign = (payload: string) => crypto.createHmac('sha256', sessionSecret()).update(payload).digest('base64url');

function safeEqual(a: string, b: string): boolean {
  return crypto.timingSafeEqual(crypto.createHash('sha256').update(a).digest(), crypto.createHash('sha256').update(b).digest());
}

function readCookie(req: Request, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return undefined;
}

export const needsSetup = (): boolean => !config.demo && passwordSource() === null;

export function isAuthenticated(req: Request): boolean {
  if (config.demo) return true;
  const raw = readCookie(req, COOKIE);
  if (!raw) return false;
  const [issued, sig] = raw.split('.');
  if (!issued || !sig || !safeEqual(sign(issued), sig)) return false;
  return Date.now() - Number(issued) < TTL_MS;
}

function startSession(req: Request, res: Response): void {
  const issued = String(Date.now());
  setCookie(res, `${issued}.${sign(issued)}`, TTL_MS, req.secure);
}

function setCookie(res: Response, value: string, maxAgeMs: number, secure: boolean) {
  res.setHeader(
    'Set-Cookie',
    `${COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(maxAgeMs / 1000)}${secure ? '; Secure' : ''}`,
  );
}

// Simple in-memory brute-force guard: 10 failures per IP per 15 minutes (shared by login and setup).
const failures = new Map<string, { count: number; until: number }>();
function throttled(req: Request, res: Response): boolean {
  const f = failures.get(req.ip ?? 'unknown');
  if (f && f.count >= 10 && f.until > Date.now()) {
    res.status(429).json({ error: 'Too many attempts. Try again in 15 minutes.' });
    return true;
  }
  return false;
}
function fail(req: Request): void {
  const ip = req.ip ?? 'unknown';
  const f = failures.get(ip);
  failures.set(ip, { count: f && f.until > Date.now() ? f.count + 1 : 1, until: Date.now() + 15 * 60 * 1000 });
}

export async function login(req: Request, res: Response): Promise<void> {
  if (throttled(req, res)) return;
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  if (!(await verifyPassword(password))) {
    fail(req);
    res.status(401).json({ error: 'Incorrect password' });
    return;
  }
  failures.delete(req.ip ?? 'unknown');
  startSession(req, res);
  res.json({ ok: true });
}

/** First run: claim the dashboard with the setup code printed in the server console. */
export async function setup(req: Request, res: Response): Promise<void> {
  if (!needsSetup()) {
    res.status(409).json({ error: 'Aisty Signal is already set up. Sign in instead.' });
    return;
  }
  if (throttled(req, res)) return;
  const code = String(req.body?.setupCode ?? '').trim().toUpperCase();
  if (!safeEqual(code, setupCode)) {
    fail(req);
    res.status(401).json({ error: 'Setup code is incorrect. Copy it from the terminal where Aisty Signal is running.' });
    return;
  }
  try {
    await setPassword(validatePassword(req.body?.password));
  } catch (err) {
    res.status(400).json({ error: errorMessage(err) });
    return;
  }
  startSession(req, res);
  res.json({ ok: true });
}

export async function changePassword(req: Request, res: Response): Promise<void> {
  if (passwordSource() === 'env') {
    res.status(409).json({ error: 'The password is set by SIGNAL_ADMIN_PASSWORD in .env. Change it there.' });
    return;
  }
  if (throttled(req, res)) return;
  if (!(await verifyPassword(String(req.body?.current ?? '')))) {
    fail(req);
    res.status(401).json({ error: 'Current password is incorrect' });
    return;
  }
  try {
    await setPassword(validatePassword(req.body?.next));
  } catch (err) {
    res.status(400).json({ error: errorMessage(err) });
    return;
  }
  startSession(req, res); // the secret rotated, so issue a fresh session for this browser
  res.json({ ok: true });
}

export function logout(req: Request, res: Response): void {
  setCookie(res, '', 0, req.secure);
  res.json({ ok: true });
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!isAuthenticated(req)) {
    res.status(401).json({ error: needsSetup() ? 'Setup required' : 'Not signed in' });
    return;
  }
  next();
}

/** CSRF guard for state-changing requests: browsers can't add custom headers cross-site without CORS. */
export function requireAppHeader(req: Request, res: Response, next: NextFunction): void {
  if (req.method !== 'GET' && req.get('x-signal') !== '1') {
    res.status(403).json({ error: 'Missing X-Signal header' });
    return;
  }
  next();
}
