'use strict';
// Shared helpers: signed sessions, password hashing, HTTP helpers, student validation.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');

if (process.env.NODE_ENV === 'production' && (!process.env.SESSION_SECRET || !process.env.INTERNAL_TOKEN)) {
  console.error('FATAL: SESSION_SECRET and INTERNAL_TOKEN must be set in production');
  process.exit(1);
}
const SECRET = process.env.SESSION_SECRET || 'dev-session-secret';
const INTERNAL_TOKEN = process.env.INTERNAL_TOKEN || 'dev-internal-token';
const HOST = process.env.POD_NAME || process.env.HOSTNAME || os.hostname();

const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });

// ---- signed session token: base64url(payload).HMAC-SHA256 ----
function signToken(payload, aud, ttlSec = 8 * 3600) {
  const body = Buffer.from(JSON.stringify({ ...payload, aud, exp: Math.floor(Date.now() / 1000) + ttlSec })).toString('base64url');
  const sig = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  return body + '.' + sig;
}
function verifyToken(token, aud) {
  if (typeof token !== 'string') return null;
  const i = token.indexOf('.');
  if (i < 1) return null;
  const body = token.slice(0, i);
  const a = Buffer.from(token.slice(i + 1));
  const b = Buffer.from(crypto.createHmac('sha256', SECRET).update(body).digest('base64url'));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (p.aud !== aud || !p.login || typeof p.login !== 'string' || p.exp < Math.floor(Date.now() / 1000)) return null;
    return p;
  } catch { return null; }
}

// ---- passwords (scrypt) ----
const scrypt = (pw, salt) => new Promise((res, rej) => crypto.scrypt(pw, salt, 32, (e, k) => (e ? rej(e) : res(k))));
async function hashPassword(pw, salt = crypto.randomBytes(16).toString('hex')) {
  return { salt, hash: (await scrypt(pw, salt)).toString('hex') };
}
async function checkPassword(pw, salt, hash) {
  const h = await scrypt(pw, salt);
  const e = Buffer.from(hash, 'hex');
  return h.length === e.length && crypto.timingSafeEqual(h, e);
}

// ---- internal (pod-to-pod / control) auth ----
function requireInternal(req, res) {
  const got = Buffer.from(String(req.headers['x-internal-token'] || ''));
  const want = Buffer.from(INTERNAL_TOKEN);
  if (got.length === want.length && crypto.timingSafeEqual(got, want)) return true;
  send(res, 403, { error: 'forbidden' });
  return false;
}

// ---- HTTP helpers ----
function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(bad('body too large', 413)); req.destroy(); } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
async function readJson(req) {
  const b = await readBody(req);
  if (!b.length) return {};
  try { return JSON.parse(b.toString()); } catch { throw bad('invalid JSON'); }
}
function send(res, status, obj, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(JSON.stringify(obj));
}
function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}
async function call(url, { method = 'GET', body, headers = {}, timeout = 2000, internal = false } = {}) {
  const h = { ...headers };
  if (internal) h['x-internal-token'] = INTERNAL_TOKEN;
  let payload;
  if (body !== undefined) {
    payload = (typeof body === 'string' || Buffer.isBuffer(body)) ? body : JSON.stringify(body);
    if (!h['content-type']) h['content-type'] = 'application/json';
  }
  const r = await fetch(url, { method, headers: h, body: payload, signal: AbortSignal.timeout(timeout) });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, json, text };
}

// ---- file persistence (atomic) ----
function loadJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function saveJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj));
  fs.renameSync(tmp, file);
}

// ---- student records ----
const newId = () => crypto.randomBytes(6).toString('hex');
function num(v, label) {
  const n = Number(v);
  if (v === '' || v === null || !Number.isFinite(n) || n < 0 || n > 100) throw bad(label + ' must be a number from 0 to 100');
  return Math.round(n * 10) / 10;
}
function cleanStudent(b, partial = false) {
  const out = {};
  if (!partial || b.name !== undefined) {
    const n = String(b.name ?? '').trim();
    if (!n || n.length > 60) throw bad('name must be 1-60 characters');
    out.name = n;
  }
  if (!partial || b.regno !== undefined) {
    const r = String(b.regno ?? '').trim();
    if (!/^[A-Za-z0-9_-]{1,20}$/.test(r)) throw bad('reg no must be 1-20 letters, digits, - or _');
    out.regno = r;
  }
  if (!partial || b.attendance !== undefined) out.attendance = num(b.attendance, 'attendance');
  if (!partial || b.marks !== undefined) out.marks = num(b.marks, 'marks');
  return out;
}
function applyOp(list, op) {
  if (!op || typeof op !== 'object') throw bad('invalid operation');
  if (op.type === 'add') {
    if (!/^[a-f0-9]{12}$/.test(String(op.id || ''))) throw bad('invalid id');
    if (list.length >= 500) throw bad('limit of 500 students per account reached', 409);
    if (list.some((s) => s.id === op.id)) throw bad('duplicate id', 409);
    return [...list, { id: op.id, ...cleanStudent(op.student || {}) }];
  }
  if (op.type === 'update') {
    const i = list.findIndex((s) => s.id === op.id);
    if (i < 0) throw bad('student not found', 404);
    const next = list.slice();
    next[i] = { ...list[i], ...cleanStudent(op.fields || {}, true) };
    return next;
  }
  if (op.type === 'delete') {
    if (!list.some((s) => s.id === op.id)) throw bad('student not found', 404);
    return list.filter((s) => s.id !== op.id);
  }
  throw bad('unknown operation');
}
function validList(list) {
  if (!Array.isArray(list) || list.length > 500) throw bad('invalid list');
  return list.map((s) => {
    if (!s || !/^[a-f0-9]{12}$/.test(String(s.id))) throw bad('invalid id');
    return { id: s.id, ...cleanStudent(s) };
  });
}
const sessionCookie = (name, value, maxAge = 8 * 3600) =>
  `${name}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const LOGIN_RE = /^[a-z][a-z0-9_]{2,19}$/;

// Turn an HTTP request on /api/students[/:id] into an operation
function opFromRequest(method, parts, body) {
  if (method === 'POST' && parts.length === 2) return { type: 'add', id: newId(), student: body };
  if (method === 'PUT' && parts.length === 3) return { type: 'update', id: parts[2], fields: body };
  if (method === 'DELETE' && parts.length === 3) return { type: 'delete', id: parts[2] };
  throw bad('not found', 404);
}

module.exports = {
  HOST, bad, signToken, verifyToken, hashPassword, checkPassword, requireInternal,
  readBody, readJson, send, parseCookies, call, loadJson, saveJson,
  newId, applyOp, opFromRequest, cleanStudent, validList, sessionCookie, sleep, LOGIN_RE,
};
