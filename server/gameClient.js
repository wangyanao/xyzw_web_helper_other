/**
 * 独立游戏客户端 - 纯 Node.js，无浏览器依赖
 * 协议：BON 编解码 + "x" 加密 + WebSocket (ws 库)
 */

import WebSocket from 'ws';

// ============================================================
// BON 协议实现（转译自 src/utils/bonProtocol.js）
// ============================================================

class DataWriter {
  constructor() { this._chunks = []; this._len = 0; }

  writeUInt8(v) {
    const b = new Uint8Array(1); b[0] = v & 0xFF;
    this._chunks.push(b); this._len++;
  }
  writeInt32(v) {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setInt32(0, v, true);
    this._chunks.push(b); this._len += 4;
  }
  writeInt64(v) {
    const b = new Uint8Array(8);
    const n = typeof v === 'bigint' ? v : BigInt(Math.floor(Number(v)));
    new DataView(b.buffer).setBigInt64(0, n, true);
    this._chunks.push(b); this._len += 8;
  }
  writeFloat32(v) {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setFloat32(0, v, true);
    this._chunks.push(b); this._len += 4;
  }
  writeFloat64(v) {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setFloat64(0, v, true);
    this._chunks.push(b); this._len += 8;
  }
  write7BitInt(v) {
    while (v > 0x7F) { this.writeUInt8((v & 0x7F) | 0x80); v >>>= 7; }
    this.writeUInt8(v & 0x7F);
  }
  writeUTF(s) {
    const bytes = new TextEncoder().encode(s);
    this.write7BitInt(bytes.length);
    if (bytes.length > 0) { this._chunks.push(bytes); this._len += bytes.length; }
  }
  getBytes() {
    const out = new Uint8Array(this._len);
    let offset = 0;
    for (const c of this._chunks) { out.set(c, offset); offset += c.length; }
    return out;
  }
}

class DataReader {
  constructor(bytes) { this._d = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes); this._p = 0; }
  reset(bytes) { this._d = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes); this._p = 0; }
  readUInt8() { return this._d[this._p++]; }
  readInt32() {
    const v = new DataView(this._d.buffer, this._d.byteOffset + this._p, 4).getInt32(0, true);
    this._p += 4; return v;
  }
  readInt64() {
    const n = new DataView(this._d.buffer, this._d.byteOffset + this._p, 8).getBigInt64(0, true);
    this._p += 8;
    return (n >= BigInt(Number.MIN_SAFE_INTEGER) && n <= BigInt(Number.MAX_SAFE_INTEGER)) ? Number(n) : n;
  }
  readFloat32() {
    const v = new DataView(this._d.buffer, this._d.byteOffset + this._p, 4).getFloat32(0, true);
    this._p += 4; return v;
  }
  readFloat64() {
    const v = new DataView(this._d.buffer, this._d.byteOffset + this._p, 8).getFloat64(0, true);
    this._p += 8; return v;
  }
  read7BitInt() {
    let r = 0, s = 0;
    while (true) { const b = this.readUInt8(); r |= (b & 0x7F) << s; if (!(b & 0x80)) break; s += 7; }
    return r;
  }
  readUTF() {
    const len = this.read7BitInt();
    const bytes = this._d.slice(this._p, this._p + len); this._p += len;
    return new TextDecoder('utf-8').decode(bytes);
  }
  readUint8Array(len) {
    const bytes = this._d.slice(this._p, this._p + len); this._p += len; return bytes;
  }
}

class BonEncoder {
  constructor() { this.dw = new DataWriter(); this._sc = []; }
  reset() { this.dw = new DataWriter(); this._sc = []; }

  encode(v) {
    if (v === null || v === undefined) { this.dw.writeUInt8(0); return; }
    if (v instanceof Uint8Array) { this._binary(v); return; }
    switch (typeof v) {
      case 'number': this._number(v); break;
      case 'boolean': this.dw.writeUInt8(6); this.dw.writeUInt8(v ? 1 : 0); break;
      case 'string': this._string(v); break;
      default:
        if (Array.isArray(v)) this._array(v);
        else if (v instanceof Date) { this.dw.writeUInt8(10); this.dw.writeInt64(v.getTime()); }
        else this._object(v);
    }
  }
  _number(v) {
    if ((v | 0) === v) { this.dw.writeUInt8(1); this.dw.writeInt32(v); }
    else if (Math.floor(v) === v) { this.dw.writeUInt8(2); this.dw.writeInt64(v); }
    else { this.dw.writeUInt8(4); this.dw.writeFloat64(v); }
  }
  _string(s) {
    const idx = this._sc.indexOf(s);
    if (idx >= 0) { this.dw.writeUInt8(99); this.dw.write7BitInt(idx); }
    else { this._sc.push(s); this.dw.writeUInt8(5); this.dw.writeUTF(s); }
  }
  _binary(u8) {
    this.dw.writeUInt8(7); this.dw.write7BitInt(u8.length);
    if (u8.length > 0) { this.dw._chunks.push(u8); this.dw._len += u8.length; }
  }
  _array(arr) {
    this.dw.writeUInt8(9); this.dw.write7BitInt(arr.length);
    for (const item of arr) this.encode(item);
  }
  _object(obj) {
    const keys = Object.keys(obj).filter(k => obj[k] !== undefined);
    this.dw.writeUInt8(8); this.dw.write7BitInt(keys.length);
    for (const k of keys) { this.encode(k); this.encode(obj[k]); }
  }
  getBytes() { return this.dw.getBytes(); }
}

class BonDecoder {
  constructor() { this.dr = new DataReader(new Uint8Array(0)); this._sa = []; }
  reset(bytes) { this.dr.reset(bytes); this._sa = []; }
  decode() {
    const tag = this.dr.readUInt8();
    switch (tag) {
      case 0: return null;
      case 1: return this.dr.readInt32();
      case 2: return this.dr.readInt64();
      case 3: return this.dr.readFloat32();
      case 4: return this.dr.readFloat64();
      case 5: { const s = this.dr.readUTF(); this._sa.push(s); return s; }
      case 6: return this.dr.readUInt8() === 1;
      case 7: { const len = this.dr.read7BitInt(); return this.dr.readUint8Array(len); }
      case 8: {
        const count = this.dr.read7BitInt(); const obj = {};
        for (let i = 0; i < count; i++) { const k = this.decode(); obj[k] = this.decode(); }
        return obj;
      }
      case 9: { const len = this.dr.read7BitInt(); return Array.from({ length: len }, () => this.decode()); }
      case 10: return new Date(this.dr.readInt64());
      case 99: return this._sa[this.dr.read7BitInt()];
      default: return null;
    }
  }
}

const _enc = new BonEncoder();
const _dec = new BonDecoder();

const bon = {
  encode(v) { _enc.reset(); _enc.encode(v); return _enc.getBytes(); },
  decode(b) { _dec.reset(b instanceof Uint8Array ? b : new Uint8Array(b)); return _dec.decode(); },
};

// ============================================================
// 加密 - "x" 方案（与前端 bonProtocol.js 完全一致）
// ============================================================

function encryptX(buf) {
  const rnd = (Math.random() * 0xFFFFFFFF) >>> 0;
  const n = new Uint8Array(buf.length + 4);
  n[0] = rnd & 0xFF; n[1] = (rnd >>> 8) & 0xFF;
  n[2] = (rnd >>> 16) & 0xFF; n[3] = (rnd >>> 24) & 0xFF;
  n.set(buf, 4);
  const r = 2 + Math.floor(Math.random() * 248);
  for (let i = n.length - 1; i >= 0; i--) n[i] ^= r;
  n[0] = 112; n[1] = 120;
  n[2] = (n[2] & 0b10101010) | (((r >> 7) & 1) << 6) | (((r >> 6) & 1) << 4) | (((r >> 5) & 1) << 2) | ((r >> 4) & 1);
  n[3] = (n[3] & 0b10101010) | (((r >> 3) & 1) << 6) | (((r >> 2) & 1) << 4) | (((r >> 1) & 1) << 2) | (r & 1);
  return n;
}

function decryptX(e) {
  e = new Uint8Array(e);
  const t = (((e[2] >> 6) & 1) << 7) | (((e[2] >> 4) & 1) << 6) | (((e[2] >> 2) & 1) << 5) | ((e[2] & 1) << 4) |
    (((e[3] >> 6) & 1) << 3) | (((e[3] >> 4) & 1) << 2) | (((e[3] >> 2) & 1) << 1) | (e[3] & 1);
  for (let i = e.length - 1; i >= 4; i--) e[i] ^= t;
  return e.subarray(4);
}

function decryptAuto(data) {
  const e = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (e.length > 4 && e[0] === 112) {
    if (e[1] === 120) return decryptX(e);  // x scheme
    // lx/xtm not needed for receiving with default server settings
  }
  return e;
}

// ============================================================
// 响应命令映射（处理服务器以独立cmd名返回而非resp字段匹配的情况）
// key: 服务器返回的响应cmd（小写），value: 原始请求cmd
// ============================================================
const RESP_CMD_MAP = {
  // 阵容
  presetteam_saveteamresp: 'presetteam_saveteam',
  presetteam_getinforesp: 'presetteam_getinfo',
  // 角色信息
  role_getroleinforesp: 'role_getroleinfo',
  // 战斗
  fight_startbossresp: 'fight_startboss',
  fight_startlegionbossresp: 'fight_startlegionboss',
  fight_startpvpresp: 'fight_startpvp',
  fight_startareaarenaresp: 'fight_startareaarena',
  fight_starttowerresp: 'fight_starttower',
  // 竞技场
  arena_startarearesp: 'arena_startarea',
  arena_getareatargetresp: 'arena_getareatarget',
  arena_getarearankresp: 'arena_getarearank',
  // 招募/背包
  hero_recruitresp: 'hero_recruit',
  item_openboxresp: 'item_openbox',
  item_openpackresp: 'item_openpack',
  // 挂机/好友
  system_claimhanguprewardresp: 'system_claimhangupreward',
  friend_batchresp: 'friend_batch',
  // 俱乐部
  legion_signinresp: 'legion_signin',
  legion_getinforesp: 'legion_getinfo',
  // 盐罐
  bottlehelper_claimresp: 'bottlehelper_claim',
  bottlehelper_startresp: 'bottlehelper_start',
  bottlehelper_stopresp: 'bottlehelper_stop',
  // 商店/珍宝阁
  store_buyresp: 'store_purchase',
  collection_goodslistresp: 'collection_goodslist',
  collection_claimfreerewardresp: 'collection_claimfreereward',
  // 邮件
  mail_claimallattachmentresp: 'mail_claimallattachment',
  // 充值/特惠
  discount_getdiscountinforesp: 'discount_getdiscountinfo',
  // 塔
  tower_claimrewardresp: 'tower_claimreward',
  evotowerinforesp: 'evotower_getinfo',
  evotower_fightresp: 'evotower_fight',
  // 任务
  task_claimdailyrewardresp: 'task_claimdailyreward',
  task_claimweekrewardresp: 'task_claimweekreward',
  // 咸王宝库
  bosstower_getinforesp: 'bosstower_getinfo',
  bosstower_startbossresp: 'bosstower_startboss',
  bosstower_startboxresp: 'bosstower_startbox',
  // 版本信息
  system_getdatabundleverresp: 'system_getdatabundlever',
  // 活动
  activity_getresp: 'activity_get',
  // 答题
  studyresp: 'study_startgame',
  // 同步响应（多命令共享）
  syncresp: ['system_mysharecallback', 'task_claimdailypoint'],
  syncrewardresp: [
    'system_buygold', 'discount_claimreward', 'card_claimreward',
    'artifact_lottery', 'genie_sweep', 'genie_buysweep',
    'system_signinreward', 'dungeon_selecthero',
  ],
};

// ============================================================
// 游戏客户端
// ============================================================

export class GameClient {
  constructor(opts = {}) {
    this._seq = 1;
    this._ack = 0;
    this._pending = new Map();   // seq -> {resolve, reject, timeoutId}
    this._ws = null;
    this._connected = false;
    this._heartbeatTimer = null;
    this.log = opts.log || ((msg, level) => console.log(`[${level || 'info'}] ${new Date().toISOString()} ${msg}`));
  }

  connect(tokenJson) {
    return new Promise((resolve, reject) => {
      if (this._ws) {
        try {
          this._ws.onopen = null;
          this._ws.onmessage = null;
          this._ws.onclose = null;
          this._ws.onerror = null;
          this._ws.close();
        } catch {}
      }

      this._ack = 0;
      this._seq = 1;
      this._stopHeartbeat();

      const url = `wss://xxz-xyzw.hortorgames.com/agent?p=${encodeURIComponent(tokenJson)}&e=x&lang=chinese`;
      this.log(`连接游戏服务器...`);
      const ws = new WebSocket(url);
      ws.binaryType = 'nodebuffer';
      this._ws = ws;

      const timer = setTimeout(() => reject(new Error('连接超时')), 15000);

      ws.on('open', () => {
        if (this._ws !== ws) return;
        clearTimeout(timer);
        this._connected = true;
        this.log('已连接');
        this._startHeartbeat();
        resolve();
      });

      ws.on('message', (data) => {
        if (this._ws !== ws) return;
        this._onMessage(data);
      });

      ws.on('close', (code) => {
        if (this._ws !== ws) return;
        this._connected = false;
        this._stopHeartbeat();
        this._ws = null;
        this.log(`连接已断开: ${code}`);
        for (const [, { reject: rej, timeoutId }] of this._pending) {
          clearTimeout(timeoutId); rej(new Error('连接已断开'));
        }
        this._pending.clear();
      });

      ws.on('error', (err) => {
        if (this._ws !== ws) return;
        clearTimeout(timer);
        this.log(`连接错误: ${err.message}`, 'error');
        if (!this._connected) reject(err);
      });
    });
  }

  _onMessage(data) {
    try {
      const plain = decryptAuto(new Uint8Array(data));
      const outer = bon.decode(plain);
      if (!outer) return;

      // 更新 ack（用于心跳和下次发包）
      if (outer.seq) this._ack = outer.seq;

      const _resolvePending = (pending, key) => {
        clearTimeout(pending.timeoutId);
        this._pending.delete(key);
        if (outer.code && outer.code !== 0) {
          pending.reject(new Error(`游戏错误 ${outer.code}: ${outer.hint || ''}`));
          return;
        }
        let body = outer.body;
        if (body instanceof Uint8Array && body.length > 0) {
          try { body = bon.decode(body); } catch { /* keep raw */ }
        }
        pending.resolve(body ?? outer);
      };

      // 方式1：通过 resp 字段匹配等待中的 Promise
      const resp = outer.resp;
      if (resp !== undefined) {
        const pending = this._pending.get(resp);
        if (pending) { _resolvePending(pending, resp); return; }
      }

      // 方式2：通过响应 cmd 名匹配（如 presetteam_saveteamresp -> presetteam_saveteam）
      const respCmd = (outer.cmd || '').toLowerCase();
      if (respCmd) {
        // 从响应 cmd 推断原始命令名
        const origCmd = RESP_CMD_MAP[respCmd]
          || (respCmd.endsWith('resp') ? respCmd.slice(0, -4) : null);
        if (origCmd) {
          const origCmds = Array.isArray(origCmd) ? origCmd : [origCmd];
          for (const [key, pending] of this._pending) {
            if (origCmds.includes(pending.cmd)) {
              _resolvePending(pending, key);
              return;
            }
          }
        }
      }
    } catch { /* 忽略解析错误 */ }
  }

  /**
   * 发送命令并等待响应
   * @param {string} cmd 命令名
   * @param {object} params 参数
   * @param {number} timeout 超时毫秒
   */
  sendWithPromise(cmd, params = {}, timeout = 10000) {
    return new Promise((resolve, reject) => {
      if (!this._connected || !this._ws || this._ws.readyState !== WebSocket.OPEN) {
        reject(new Error('未连接'));
        return;
      }

      const seq = this._seq++;
      // body 先 BON 编码（不加密），作为外层消息的 body 字段（binary tag 7）
      const body = bon.encode(params);
      const outer = { cmd, ack: this._ack, seq, time: Date.now(), body };
      const data = encryptX(bon.encode(outer));

      const timeoutId = setTimeout(() => {
        this._pending.delete(seq);
        reject(new Error(`超时: ${cmd}`));
      }, timeout);

      this._pending.set(seq, { resolve, reject, timeoutId, cmd });
      this._ws.send(Buffer.from(data), (err) => {
        if (err) {
          clearTimeout(timeoutId);
          this._pending.delete(seq);
          reject(err);
        }
      });
    });
  }

  /**
   * 发送命令（不等待响应，fire-and-forget）
   */
  send(cmd, params = {}) {
    if (!this._connected || !this._ws || this._ws.readyState !== WebSocket.OPEN) return;
    const seq = this._seq++;
    const body = bon.encode(params);
    const outer = { cmd, ack: this._ack, seq, time: Date.now(), body };
    this._ws.send(Buffer.from(encryptX(bon.encode(outer))), () => {});
  }

  _startHeartbeat() {
    this._heartbeatTimer = setInterval(() => {
      if (!this._connected || !this._ws || this._ws.readyState !== WebSocket.OPEN) return;
      const outer = { cmd: '_sys/ack', ack: this._ack, seq: 0, time: Date.now(), body: {} };
      this._ws.send(Buffer.from(encryptX(bon.encode(outer))), () => {});
    }, 5000);
  }

  _stopHeartbeat() {
    if (this._heartbeatTimer) { clearInterval(this._heartbeatTimer); this._heartbeatTimer = null; }
  }

  disconnect() {
    this._stopHeartbeat();
    if (this._ws) {
      try {
        this._ws.onopen = null;
        this._ws.onmessage = null;
        this._ws.onclose = null;
        this._ws.onerror = null;
        this._ws.close();
      } catch {}
      this._ws = null;
    }
    this._connected = false;
    this._ack = 0;
  }
}

/**
 * 类似前端 transformToken：将 bin 二进制 POST 到 authuser 接口，得到新 session JSON
 * 每次执行任务前调用，避免使用过期的 sessId/connId
 */
export async function transformTokenFromBin(binBuffer) {
  const { request } = await import('https');
  return new Promise((resolve, reject) => {
    const buf = Buffer.isBuffer(binBuffer) ? binBuffer : Buffer.from(binBuffer);
    const options = {
      hostname: 'xxz-xyzw.hortorgames.com',
      path: '/login/authuser?_seq=1',
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Length': buf.length,
        'Referer': 'https://xxz-xyzw.hortorgames.com/',
      },
    };
    const req = request(options, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        try {
          const data = Buffer.concat(chunks);
          // 解密 → BON 解码外层 → 解码 body
          const plain = decryptAuto(new Uint8Array(data));
          const outer = bon.decode(plain);
          let body = outer?.body;
          if (body instanceof Uint8Array && body.length > 0) {
            body = bon.decode(body);
          } else if (!body) {
            body = outer; // 部分服务器直接返回平坦对象
          }
          if (!body) throw new Error('authuser 响应为空');
          const sessId = Date.now() * 100 + Math.floor(Math.random() * 100);
          const connId = Date.now() + Math.floor(Math.random() * 10);
          resolve(JSON.stringify({ ...body, sessId, connId, isRestore: 0 }));
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(buf);
    req.end();
  });
}

export default GameClient;
