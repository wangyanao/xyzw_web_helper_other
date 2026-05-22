/**
 * 服务端任务执行入口
 * 由 Flask APScheduler 调用：node run_task.js
 * 任务 JSON 通过 stdin 传入
 */

import { readFileSync, readdirSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';
import { request as httpsRequest } from 'https';
import { request as httpRequest } from 'http';
import GameClient, { transformTokenFromBin } from './gameClient.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TOKENS_FILE = join(__dirname, 'data', 'tokens.json');
const BIN_DIR = join(__dirname, 'bin');

/**
 * 对于 importMethod==='bin' 的 token，扫描 bin 目录找到匹配文件，
 * 重新 POST authuser 得到新 session JSON（避免过期）
 */
async function refreshTokenFromBin(tokenId, tokenName) {
  try {
    const files = readdirSync(BIN_DIR).filter(f => f.endsWith('.bin'));
    for (const f of files) {
      const data = readFileSync(join(BIN_DIR, f));
      const hash = createHash('md5').update(data).digest('hex');
      if (hash === tokenId) {
        const fresh = await transformTokenFromBin(data);
        log(tokenName, `已从 bin 文件刷新 session token`, 'info');
        return fresh;
      }
    }
    log(tokenName, `bin 目录未找到匹配文件 (tokenId=${tokenId})，使用已存储 token`, 'warning');
  } catch (e) {
    log(tokenName, `刷新 bin token 失败: ${e.message}，回退到已存储 token`, 'warning');
  }
  return null;
}

function loadTokens() {
  try {
    return JSON.parse(readFileSync(TOKENS_FILE, 'utf-8'));
  } catch {
    return {};
  }
}

function log(name, msg, level = 'info') {
  // 输出本地时间（Asia/Shanghai +8），避免 toISOString() 的 UTC 偏差
  const ts = new Date().toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  }).replace(/\//g, '-');
  console.log(JSON.stringify({ ts, name, msg, level }));
}

// 延迟工具
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function refreshConnectionParams(tokenStr) {
  try {
    const tokenObj = JSON.parse(tokenStr);
    if (tokenObj && typeof tokenObj === 'object' && (tokenObj.sessId !== undefined || tokenObj.connId !== undefined)) {
      const now = Date.now();
      tokenObj.sessId = now * 100 + Math.floor(Math.random() * 100);
      tokenObj.connId = now + Math.floor(Math.random() * 10);
      tokenObj.isRestore = 0;
      return JSON.stringify(tokenObj);
    }
  } catch {
    // 非 JSON token（例如纯 roleToken 字符串）不处理
  }
  return tokenStr;
}

/**
 * 对于 importMethod==='url' 的 token，从 sourceUrl 重新拉取最新 token
 */
async function refreshTokenFromUrl(tokenData, tokenName) {
  const sourceUrl = tokenData?.sourceUrl;
  if (!sourceUrl) {
    log(tokenName, `url 类型但无 sourceUrl，无法刷新`, 'warning');
    return null;
  }
  try {
    const fresh = await new Promise((resolve, reject) => {
      const isHttps = sourceUrl.startsWith('https');
      const doRequest = isHttps ? httpsRequest : httpRequest;
      const req = doRequest(sourceUrl, { method: 'GET', headers: { Accept: 'application/json' } }, (res) => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
            if (!body.token) throw new Error('返回数据中未找到 token 字段');
            resolve(body.token);
          } catch (e) { reject(e); }
        });
      });
      req.on('error', reject);
      req.setTimeout(15000, () => { req.destroy(); reject(new Error('URL 请求超时')); });
      req.end();
    });
    log(tokenName, `已从 URL 刷新 token`, 'info');
    return fresh;
  } catch (e) {
    log(tokenName, `从 URL 刷新 token 失败: ${e.message}，回退到已存储 token`, 'warning');
    return null;
  }
}

async function buildFreshActiveToken(tokenData, tokenId, tokenName, fallbackToken = '') {
  let nextToken = fallbackToken || tokenData?.token || '';
  const method = tokenData?.importMethod || 'manual';

  if (method === 'bin' || method === 'wxQrcode') {
    // bin/wxQrcode: 用原始 bin 文件重新 POST authuser 获取新 roleToken
    const fresh = await refreshTokenFromBin(tokenId, tokenName);
    if (fresh) {
      nextToken = fresh;
    } else {
      log(tokenName, `[${method}] bin 刷新失败，尝试仅刷新连接参数`, 'warning');
    }
  } else if (method === 'url') {
    // url: 从 sourceUrl 重新拉取完整 token
    const fresh = await refreshTokenFromUrl(tokenData, tokenName);
    if (fresh) {
      nextToken = fresh;
    } else {
      log(tokenName, `[url] URL 刷新失败，尝试仅刷新连接参数`, 'warning');
    }
  } else {
    // manual 等类型：无法自动刷新 roleToken，仅刷新 sessId/connId
    log(tokenName, `[${method}] 无自动刷新源，仅刷新连接参数`, 'info');
  }

  return refreshConnectionParams(nextToken);
}

// 连接状态判定：仅 _connected=true 不够，还要确保 ws 处于 OPEN
function hasActiveConnection(client) {
  return Boolean(client?._connected && client?._ws && client._ws.readyState === 1);
}

function isConnectionError(err) {
  const msg = String(err?.message || '');
  return (
    msg.includes('未连接') ||
    msg.includes('连接已断开') ||
    msg.includes('连接超时') ||
    msg.includes('WebSocket is not open') ||
    msg.includes('ECONNRESET') ||
    msg.includes('EPIPE') ||
    msg.includes('ETIMEDOUT') ||
    msg.includes('socket hang up')
  );
}

/**
 * 自动重连机制：检查连接状态，如果断开则重新连接
 * @param {GameClient} client - 游戏客户端
 * @param {string} tokenName - token 名称
 * @param {string} activeToken - 当前 token 字符串
 * @param {number} maxRetries - 最大重试次数
 */
async function ensureConnected(client, tokenName, getActiveToken, maxRetries = 3) {
  const retryErrors = []; // 追踪所有重试的错误
  
  for (let retry = 0; retry < maxRetries; retry++) {
    try {
      // 检查当前连接状态（如果已连接则不重连）
      if (hasActiveConnection(client)) {
        return true;
      }

      // 清理可能的半开连接，避免出现 _connected 与 readyState 不一致
      if (client?._ws && client._ws.readyState !== 1) {
        try { client.disconnect(); } catch {}
        await sleep(150);
      }

      const activeToken = await getActiveToken();
      
      log(tokenName, `重新连接中... (尝试 ${retry + 1}/${maxRetries})`);
      await client.connect(activeToken);
      log(tokenName, '重连成功');
      return true;
    } catch (err) {
      // 详细记录每次重试的错误（包括错误代码、消息、堆栈）
      const errorDetail = {
        retry: retry + 1,
        message: err.message,
        code: err.code || 'UNKNOWN',
        timestamp: new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })
      };
      retryErrors.push(errorDetail);
      
      log(tokenName, `重连失败 (${retry + 1}/${maxRetries}): ${err.message} [${err.code || 'N/A'}]`, 'warning');
      
      if (retry < maxRetries - 1) {
        await sleep(2000); // 等待 2 秒后重试
      }
    }
  }
  
  // 汇总输出所有重试的错误信息
  log(tokenName, `重连失败：已达最大重试次数 ${maxRetries}。错误详情: ${JSON.stringify(retryErrors)}`, 'error');
  return false;
}

function applyResilientSendWrapper(client, tokenName, getActiveToken, maxRetries = 3) {
  if (client._resilientSendWrapped) return;

  const rawSendWithPromise = client.sendWithPromise.bind(client);

  client.sendWithPromise = async (cmd, params = {}, timeout = 10000) => {
    let lastErr = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      if (!hasActiveConnection(client)) {
        const ok = await ensureConnected(client, tokenName, getActiveToken, maxRetries);
        if (!ok) {
          throw new Error(`命令 ${cmd} 执行前重连失败`);
        }
      }

      try {
        return await rawSendWithPromise(cmd, params, timeout);
      } catch (err) {
        lastErr = err;
        if (!isConnectionError(err) || attempt === maxRetries) {
          throw err;
        }

        log(tokenName, `命令 ${cmd} 连接异常，准备重连后重试 (${attempt}/${maxRetries}): ${err.message}`, 'warning');
        const ok = await ensureConnected(client, tokenName, getActiveToken, maxRetries);
        if (!ok) {
          throw err;
        }
        await sleep(200);
      }
    }

    throw lastErr || new Error(`命令 ${cmd} 执行失败`);
  };

  client._resilientSendWrapped = true;
}

// 「今日已完成」类错误码，视为正常完成而非失败
const ALREADY_DONE_CODES = new Set([
  2300190,   // 今天已经签到过了
  12000116,  // 今日已领取免费奖励
  1000020,   // 今天已经领取过奖励了
  700020,    // 已经领取过这个任务
  400190,    // 没有可领取的签到奖励
  3500020,   // 没有可领取的奖励
  12000050,  // 今日发车次数已达上限
  3300050,   // 今日免费扫荡券已领取
]);

// 「条件不满足」类错误码，静默跳过
const SKIP_CODES = new Set([
  1400010,   // 没有购买该月卡
  2300070,   // 未加入俱乐部
  200160,    // 模块未开启
  -10006,    // 功能未就绪/不可用
]);

function extractErrorCode(errMsg) {
  const m = String(errMsg).match(/游戏错误\s+(-?\d+)/);
  return m ? Number(m[1]) : null;
}

// ============================================================
// 单个命令执行（带容错）
// ============================================================
async function execCmd(client, tokenName, cmd, params = {}, desc = '', timeout = 10000) {
  try {
    const result = await client.sendWithPromise(cmd, params, timeout);
    log(tokenName, `✅ ${desc || cmd}`, 'success');
    return result;
  } catch (err) {
    const code = extractErrorCode(err.message);
    if (code !== null && ALREADY_DONE_CODES.has(code)) {
      log(tokenName, `✅ ${desc || cmd}（今日已完成）`, 'success');
      return null;
    }
    if (code !== null && SKIP_CODES.has(code)) {
      log(tokenName, `⊘ ${desc || cmd}（条件不满足，跳过）`, 'info');
      return null;
    }
    log(tokenName, `⚠️  ${desc || cmd} 失败: ${err.message}`, 'warning');
    return null;
  }
}

// ============================================================
// 任务类型实现
// ============================================================

/**
 * 完整日常任务（对齐前端 DailyTaskRunner.run() 逻辑）
 * 包含：基础操作、固定奖励、钓鱼/灯神免费次数、任务积分/箱子领取
 */
/**
 * 完整日常任务（对齐前端 DailyTaskRunner.run() 逻辑）
 * 支持 Token 级别的开关配置（payRecruit 等）
 */
async function runDailyBasic(client, tokenName, delay = 500, batchSettings = {}) {
  // 提取功能开关（默认都启用）
  const claimBottle = batchSettings.claimBottle ?? true;
  const claimHangUp = batchSettings.claimHangUp ?? true;
  const openBox = batchSettings.openBox ?? true;
  const claimEmail = batchSettings.claimEmail ?? true;
  const blackMarketPurchase = batchSettings.blackMarketPurchase ?? true;
  const arenaEnable = batchSettings.arenaEnable ?? true;
  
  // ── 1. 获取角色信息（判断任务完成状态）──
  let roleData = null;
  try {
    const res = await client.sendWithPromise('role_getroleinfo', {
      clientVersion: '2.10.3-f10a39eaa0c409f4-wx',
      inviteUid: 0,
      platform: 'hortor',
      platformExt: 'mix',
      scene: '',
    }, 10000);
    roleData = res?.role || null;
  } catch (e) {
    log(tokenName, `获取角色信息失败: ${e.message}，仍继续执行`, 'warning');
  }

  const completedTasks = roleData?.dailyTask?.complete ?? {};
  const isTaskDone = (id) => completedTasks[id] === -1;
  const statistics     = roleData?.statistics    ?? {};
  const statisticsTime = roleData?.statisticsTime ?? {};
  const isTodayAvail   = (t) => {
    if (!t) return true;
    return new Date().toDateString() !== new Date(t * 1000).toDateString();
  };

  // ── 2. 获取 battleVersion（用于 fight_* 命令）──
  const battleVersion = await getBattleVersion(client, tokenName);

  // ── 3. 保存当前阵容 ──
  let originalFormation = null;
  try {
    const ti = await client.sendWithPromise('presetteam_getinfo', {}, 5000);
    originalFormation = ti?.presetTeamInfo?.useTeamId ?? null;
    log(tokenName, `当前阵容: ${originalFormation}`);
  } catch (e) { log(tokenName, `获取阵容失败: ${e.message}`, 'warning'); }

  // ── 4. 基础操作 ──
  if (!isTaskDone(2))
    await execCmd(client, tokenName, 'system_mysharecallback', { isSkipShareCard: true, type: 2 }, '分享游戏'); await sleep(delay);
  if (!isTaskDone(3))
    await execCmd(client, tokenName, 'friend_batch', { friendId: 0 }, '赠送好友金币'); await sleep(delay);
  if (!isTaskDone(4)) {
    // 实际规则：免费招募每天仅 1 次
    await execCmd(
      client,
      tokenName,
      'hero_recruit',
      { byClub: false, recruitType: 3, recruitNumber: 1 },
      '免费招募 1/1'
    );
    await sleep(delay);

    // Token 级配置开启时，再执行 1 次付费招募
    if (batchSettings.payRecruit === true || batchSettings.payRecruit === 1) {
      await execCmd(
        client,
        tokenName,
        'hero_recruit',
        { byClub: false, recruitType: 1, recruitNumber: 1 },
        '付费招募 1/1'
      );
      await sleep(delay);
    }
  }
  if (!isTaskDone(6) && isTodayAvail(statisticsTime['buy:gold'])) {
    for (let i = 0; i < 3; i++) {
      await execCmd(client, tokenName, 'system_buygold', { buyNum: 1 }, `免费点金 ${i+1}/3`); await sleep(delay);
    }
  }
  
  // 领取挂机（读取 claimHangUp 开关）
  if (claimHangUp && !isTaskDone(5)) {
    await execCmd(client, tokenName, 'system_claimhangupreward', {}, '领取挂机奖励'); await sleep(delay);
    for (let i = 0; i < 4; i++) {
      await execCmd(client, tokenName, 'system_mysharecallback', { isSkipShareCard: true, type: 2 }, `挂机加钟 ${i+1}/4`); await sleep(delay);
    }
  }
  
  // 开箱（读取 openBox 开关）
  if (openBox && !isTaskDone(7)) {
    await execCmd(client, tokenName, 'item_openbox', { itemId: 2001, number: 10 }, '开启木质宝箱'); await sleep(delay);
  }

  // 重置罐子 + 领取盐罐（claimBottle 开关）
  await execCmd(client, tokenName, 'bottlehelper_stop',  { bottleType: -1 }, '停止盐罐计时'); await sleep(delay);
  await execCmd(client, tokenName, 'bottlehelper_start', { bottleType: -1 }, '开始盐罐计时'); await sleep(delay);
  if (claimBottle && !isTaskDone(14)) {
    await execCmd(client, tokenName, 'bottlehelper_claim', {}, '领取盐罐奖励'); await sleep(delay);
  }

  // ── 4b. 俱乐部BOSS（根据前端配置 bossTimes）──
  const bossTimes = Number(batchSettings.bossTimes ?? 2);  // 默认 2 次
  const bossFormation = Number(batchSettings.bossFormation ?? 2);  // 默认阵容 2
  
  if (bossTimes > 0) {
    // 获取已打次数
    let alreadyBoss = Number(statistics['legion:boss'] ?? 0);
    // 如果统计时间在今天，则重置为 0
    if (isTodayAvail(statisticsTime['legion:boss'])) {
      alreadyBoss = 0;
    }
    const remainingBoss = Math.max(bossTimes - alreadyBoss, 0);
    
    if (remainingBoss > 0) {
      // 切换到 BOSS 阵容
      if (originalFormation !== null && originalFormation !== bossFormation) {
        await client.sendWithPromise('presetteam_saveteam', { teamId: bossFormation }, 5000).catch(() => {});
        log(tokenName, `切换到俱乐部BOSS阵容 ${bossFormation}`, 'info');
        await sleep(delay);
      }
      
      // 打俱乐部BOSS
      for (let i = 0; i < remainingBoss; i++) {
        await execCmd(client, tokenName, 'fight_startlegionboss', {}, `俱乐部BOSS ${i+1}/${remainingBoss}`);
        await sleep(delay);
      }
    }
  }

  // ── 4c. 每日咸王考验（每天打 3 次 BOSS）──
  const DAY_BOSS_MAP = [9904, 9905, 9901, 9902, 9903, 9904, 9905]; // 周日~周六
  const todayBossId = DAY_BOSS_MAP[new Date().getDay()];
  // 切换到 BOSS 阵容（默认阵容 2）
  const xianwangBossFormation = 2;
  if (originalFormation !== null && originalFormation !== xianwangBossFormation) {
    await client.sendWithPromise('presetteam_saveteam', { teamId: xianwangBossFormation }, 5000).catch(() => {});
    log(tokenName, `切换到咸王BOSS阵容 ${xianwangBossFormation}`, 'info');
    await sleep(delay);
  }
  for (let i = 0; i < 3; i++) {
    await execCmd(client, tokenName, 'fight_startboss', { bossId: todayBossId, battleVersion }, `每日咸王考验 ${i+1}/3`); await sleep(delay);
  }

  // ── 5. 固定奖励 ──
  // 预热：先查询充值/特惠信息，部分游戏服务器要求先「打开页面」才允许领取
  await client.sendWithPromise('discount_getdiscountinfo', {}, 5000).catch(() => {});
  await sleep(delay);

  const fixedCmds = [
    { cmd: 'system_signinreward',         params: {},                desc: '福利签到' },
    { cmd: 'legion_signin',               params: {},                desc: '俱乐部签到' },
    { cmd: 'discount_claimreward',        params: { discountId: 1 }, desc: '领取每日礼包' },
    { cmd: 'collection_claimfreereward',  params: {},                desc: '领取每日免费奖励' },
    { cmd: 'card_claimreward',            params: { cardId: 1 },     desc: '领取免费礼包' },
    { cmd: 'card_claimreward',            params: { cardId: 4003 }, desc: '领取永久卡礼包' },
    // 领取邮件（读取 claimEmail 开关）
    { cmd: 'mail_claimallattachment',     params: { category: 0 },  desc: '领取邮件奖励', conditional: claimEmail },
    { cmd: 'collection_goodslist',        params: {},                desc: '刷新珍宝阁' },
    { cmd: 'collection_claimfreereward',  params: {},                desc: '领取珍宝阁免费礼包' },
  ];
  for (const { cmd, params, desc, conditional } of fixedCmds) {
    if (conditional !== false) {  // 默认执行或根据开关判断
      await execCmd(client, tokenName, cmd, params, desc); await sleep(delay);
    }
  }

  // ── 免费扭蛋 ──
  const freeGachaEnable = batchSettings.freeGachaEnable ?? true;
  if (freeGachaEnable && isTodayAvail(statisticsTime['gacha:free'])) {
    await execCmd(client, tokenName, 'gacha_drawreward', { num: 1, isGroup: false }, '免费扭蛋');
    await sleep(delay);
  }

  // ── 6. 免费活动（钓鱼/灯神）──
  if (isTodayAvail(statistics['artifact:normal:lottery:time'])) {
    for (let i = 0; i < 3; i++) {
      await execCmd(client, tokenName, 'artifact_lottery', { lotteryNumber: 1, newFree: true, type: 1 }, `免费钓鱼 ${i+1}/3`); await sleep(delay);
    }
  }
  const kingdoms = ['魏国','蜀国','吴国','群雄'];
  for (let gid = 1; gid <= 4; gid++) {
    if (isTodayAvail(statisticsTime[`genie:daily:free:${gid}`])) {
      await execCmd(client, tokenName, 'genie_sweep', { genieId: gid }, `${kingdoms[gid-1]}灯神免费扫荡`); await sleep(delay);
    }
  }
  for (let i = 0; i < 3; i++) {
    await execCmd(client, tokenName, 'genie_buysweep', {}, `领取免费扫荡券 ${i+1}/3`); await sleep(delay);
  }

  // ── 7. 黑市（读取 blackMarketPurchase 开关）──
  if (blackMarketPurchase && !isTaskDone(12)) {
    await execCmd(client, tokenName, 'store_purchase', { goodsId: 1 }, '黑市购买'); await sleep(delay);
  }

  // ── 8. 咸王梦境（周日/一/三/四）──
  const dow = new Date().getDay();
  if ([0,1,3,4].includes(dow)) {
    await execCmd(client, tokenName, 'dungeon_selecthero', { battleTeam: { 0: 107 } }, '咸王梦境'); await sleep(delay);
  }

  // 深海灯神（每周一免费 1 次）
  if (dow === 1 && isTodayAvail(statisticsTime['genie:daily:free:5'])) {
    await execCmd(client, tokenName, 'genie_sweep', { genieId: 5, sweepCnt: 1 }, '深海灯神免费扫荡');
    await sleep(delay);
  }

  // ── 9. 竞技场PK（需在任务积分领取前执行，避免积分判定时机过早）──
  if (arenaEnable) {
    await runArenaFight(client, tokenName, batchSettings, delay);
  }

  // ── 10. 恢复原阵容 ──
  if (originalFormation !== null) {
    await client.sendWithPromise('presetteam_saveteam', { teamId: originalFormation }, 5000).catch(() => {});
    log(tokenName, `已恢复原阵容 ${originalFormation}`);
    await sleep(delay);
  }

  // ── 11. 任务积分 + 日常/周常/通行证奖励（对齐前端逻辑：直接尝试全部领取，失败则跳过）──
  for (let taskId = 1; taskId <= 10; taskId++) {
    await execCmd(client, tokenName, 'task_claimdailypoint', { taskId }, `领取任务积分 ${taskId}/10`);
    await sleep(delay);
  }

  await execCmd(client, tokenName, 'task_claimdailyreward', { rewardId: 0 }, '领取日常任务奖励箱'); await sleep(delay);
  await execCmd(client, tokenName, 'task_claimweekreward',  { rewardId: 0 }, '领取周常任务奖励箱'); await sleep(delay);
  await execCmd(client, tokenName, 'activity_recyclewarorderrewardclaim', { actId: 1 }, '领取通行证奖励'); await sleep(delay);
}

/** 领取挂机奖励 */
async function runClaimHangUp(client, tokenName, delay = 500) {
  await execCmd(client, tokenName, 'system_claimhangupreward', {}, '领取挂机奖励');
  await sleep(delay);
}

/** 俱乐部签到 */
async function runClubSign(client, tokenName) {
  await execCmd(client, tokenName, 'legion_signin', {}, '俱乐部签到');
}

/** 领取每日免费奖励 */
async function runCollectionFree(client, tokenName) {
  await execCmd(client, tokenName, 'collection_claimfreereward', {}, '领取每日免费奖励');
}

/** 免费领取珍宝阁 */
async function runCollectionClaim(client, tokenName, delay = 500) {
  await execCmd(client, tokenName, 'collection_goodslist', {}, '刷新珍宝阁');
  await sleep(delay);
  await execCmd(client, tokenName, 'collection_claimfreereward', {}, '领取珍宝阁奖励');
}

/** 重置罐子（停止计时 → 开始计时，必须携带 bottleType: -1）*/
async function runResetBottles(client, tokenName, delay = 500) {
  await execCmd(client, tokenName, 'bottlehelper_stop',  { bottleType: -1 }, '停止计时（重置罐子）');
  await sleep(delay);
  await execCmd(client, tokenName, 'bottlehelper_start', { bottleType: -1 }, '开始计时（重置罐子）');
}

/** 一键领取盐罐 */
async function runClaimBottle(client, tokenName) {
  await execCmd(client, tokenName, 'bottlehelper_claim', {}, '一键领取盐罐');
}

/** 领取功法残卷挂机奖励 */
async function runLegacyClaim(client, tokenName) {
  await execCmd(client, tokenName, 'legacy_claimhangup', {}, '领取功法残卷');
}

/** 一键加钟（执行4次分享回调）*/
async function runAddHangUpTime(client, tokenName, delay = 500) {
  for (let i = 0; i < 4; i++) {
    await execCmd(client, tokenName, 'system_mysharecallback', { isSkipShareCard: true, type: 2 }, `加钟 ${i + 1}/4`);
    await sleep(delay);
  }
}

/**
 * 调用 fight_startlevel 获取 battleVersion
 * 所有 fight_start* 战斗命令都必须携带此版本号，否则服务端返回 200750
 */
async function getBattleVersion(client, tokenName) {
  try {
    const res = await client.sendWithPromise('fight_startlevel', {}, 5000);
    const v = res?.battleData?.version ?? null;
    log(tokenName, `battleVersion: ${v}`, 'info');
    return v;
  } catch (e) {
    log(tokenName, `获取 battleVersion 失败: ${e.message}`, 'warning');
    return null;
  }
}

// 从竞技场响应中提取目标 roleId（对齐前端 pickArenaTargetId 逻辑）
function pickArenaTargetId(targets) {
  const candidate =
    targets?.rankList?.[0] ||
    targets?.roleList?.[0] ||
    targets?.targets?.[0] ||
    targets?.targetList?.[0] ||
    targets?.list?.[0];
  if (candidate?.roleId) return candidate.roleId;
  if (candidate?.id) return candidate.id;
  return targets?.roleId || targets?.id || null;
}

/** 竞技场战斗（最多3次，含阵容切换，与前端 batcharenafight 完全对齐）*/
async function runArenaFight(client, tokenName, batchSettings = {}, delay = 500) {
  const arenaFormation = batchSettings.arenaFormation ?? 1;
  let currentFormation = null;
  let switched = false;
  try {
    // 0. 获取 battleVersion（fight_startareaarena 必须携带，否则服务端返回 200750）
    const battleVersion = await getBattleVersion(client, tokenName);

    // 1. 获取当前阵容
    const teamInfo = await client.sendWithPromise('presetteam_getinfo', {}, 5000);
    currentFormation = teamInfo?.presetTeamInfo?.useTeamId ?? null;

    // 2. 切换到竞技场阵容
    if (currentFormation !== arenaFormation) {
      await client.sendWithPromise('presetteam_saveteam', { teamId: arenaFormation }, 5000);
      switched = true;
      log(tokenName, `切换到竞技场阵容 ${arenaFormation}`, 'info');
    } else {
      log(tokenName, `当前已是竞技场阵容 ${arenaFormation}，无需切换`, 'info');
    }

    // 3. 循环打3场（每场独立调用 arena_startarea）
    for (let i = 0; i < 3; i++) {
      // arena_startarea 仅做"进入竞技场"，忽略返回值
      await client.sendWithPromise('arena_startarea', {}, 5000).catch(() => {});
      // 从 arena_getareatarget 获取目标列表
      const targets = await client.sendWithPromise('arena_getareatarget', { refresh: false }, 5000);
      const targetId = pickArenaTargetId(targets);
      if (!targetId) {
        log(tokenName, '竞技场：未找到可用目标', 'warning');
        break;
      }
      // 必须注入 battleVersion，否则服务端拒绝（错误 200750）
      await execCmd(client, tokenName, 'fight_startareaarena', { battleVersion, targetId }, `竞技场第 ${i + 1}/3 场`);
      await sleep(delay);
    }
  } catch (err) {
    log(tokenName, `竞技场失败: ${err.message}`, 'warning');
  } finally {
    // 4. 战斗结束后恢复原阵容
    if (switched && currentFormation !== null) {
      await client.sendWithPromise('presetteam_saveteam', { teamId: currentFormation }, 5000).catch(() => {});
      log(tokenName, `已恢复原阵容 ${currentFormation}`, 'info');
    }
  }
}

/** 黑市一键采购 */
async function runStorePurchase(client, tokenName) {
  await execCmd(client, tokenName, 'store_purchase', {}, '黑市一键采购');
}

/** 俱乐部商店购买四圣碎片 */
async function runLegionStoreBuyGoods(client, tokenName) {
  await execCmd(client, tokenName, 'legion_storebuygoods', { id: 6 }, '购买四圣碎片');
}

/** 咸王梦境（仅周日/一/三/四开放）*/
async function runBatchMengjing(client, tokenName, delay = 500) {
  const dayOfWeek = new Date().getDay();
  const openDays = [0, 1, 3, 4]; // 周日/一/三/四
  if (!openDays.includes(dayOfWeek)) {
    log(tokenName, `咸王梦境：今日非开放日（今天周${['日','一','二','三','四','五','六'][dayOfWeek]}）`, 'warning');
    return;
  }
  const mjbattleTeam = { 0: 107 };
  await execCmd(client, tokenName, 'dungeon_selecthero', { battleTeam: mjbattleTeam }, '咸王梦境');
  await sleep(delay);
}

/** 换皮闯关 */
async function runSkinChallenge(client, tokenName, delay = 500) {
  try {
    let res = await client.sendWithPromise('towers_getinfo', {}, 5000);
    let towerData = res?.actId ? res : (res?.towerData?.actId ? res.towerData : res);
    if (!towerData?.actId) {
      log(tokenName, '换皮闯关：活动未开放', 'warning');
      return;
    }
    // 检查活动时间
    const actId = String(towerData.actId);
    if (actId.length >= 6) {
      const startDate = new Date(`20${actId.substring(0,2)}-${actId.substring(2,4)}-${actId.substring(4,6)}T00:00:00`);
      const endDate = new Date(startDate); endDate.setDate(startDate.getDate() + 7);
      if (Date.now() < startDate.getTime() || Date.now() >= endDate.getTime()) {
        log(tokenName, '换皮闯关：活动已结束', 'warning');
        return;
      }
    }
    let levelRewardMap = towerData.levelRewardMap || {};
    const dayMap = { 5:[1], 6:[2], 0:[3], 1:[4], 2:[5], 3:[6], 4:[1,2,3,4,5,6] };
    const todayTypes = dayMap[new Date().getDay()] || [];

    const isTowerCleared = (type, map) => {
      const key = `${type}008`;
      return !!(map[key] || map[Number(key)]);
    };

    for (const type of todayTypes) {
      if (isTowerCleared(type, levelRewardMap)) continue;
      log(tokenName, `换皮闯关：开始挑战 BOSS${type}`, 'info');

      let needStart = true;
      let failCount = 0;

      while (!isTowerCleared(type, levelRewardMap)) {
        if (needStart) {
          try {
            await client.sendWithPromise('towers_start', { towerType: type }, 8000);
          } catch (e) {
            // 200330 = 存在未完成挑战，可直接 fight
            if (!e.message?.includes('200330')) {
              log(tokenName, `换皮闯关 BOSS${type} start失败: ${e.message}`, 'warning');
              break;
            }
          }
          await sleep(delay);
        }

        try {
          const fightRes = await client.sendWithPromise('towers_fight', { towerType: type }, 8000);
          const curHP = fightRes?.battleData?.result?.accept?.ext?.curHP;

          if (curHP === 0) {
            log(tokenName, `换皮闯关 BOSS${type} 当层通过`, 'success');
            needStart = false;
            failCount = 0;
            // 刷新进度
            res = await client.sendWithPromise('towers_getinfo', {}, 5000);
            towerData = res?.actId ? res : (res?.towerData?.actId ? res.towerData : res);
            levelRewardMap = towerData?.levelRewardMap || {};
          } else {
            log(tokenName, `换皮闯关 BOSS${type} 当层失败`, 'warning');
            needStart = true;
            failCount++;
            if (failCount >= 3) {
              log(tokenName, `换皮闯关 BOSS${type} 连续失败3次，跳过`, 'warning');
              break;
            }
          }
        } catch (e) {
          log(tokenName, `换皮闯关 BOSS${type} fight失败: ${e.message}`, 'warning');
          break;
        }
        await sleep(delay);
      }

      if (isTowerCleared(type, levelRewardMap)) {
        log(tokenName, `换皮闯关 BOSS${type} 全部通关`, 'success');
      }
    }
  } catch (err) {
    log(tokenName, `换皮闯关失败: ${err.message}`, 'warning');
  }
}

/** 灯神扫荡 */
async function runGenieSweep(client, tokenName, delay = 500) {
  try {
    const roleInfoRes = await client.sendWithPromise('role_getroleinfo', {}, 5000);
    const role = roleInfoRes?.role || roleInfoRes?.data?.role || {};
    const genieData = role.genie || {};
    const statisticsTime = role.statisticsTime || {};

    const isTodayAvail = (t) => {
      if (!t) return true;
      return new Date().toDateString() !== new Date(Number(t) * 1000).toDateString();
    };

    // 潜入深海：每周一免费 1 次，优先执行，不受扫荡券数量限制
    const dow = new Date().getDay();
    if (dow === 1 && isTodayAvail(statisticsTime['genie:daily:free:5'])) {
      await execCmd(client, tokenName, 'genie_sweep', { genieId: 5, sweepCnt: 1 }, '深海灯神免费扫荡');
      await sleep(delay);
    }

    const sweepTicketCount = role.items?.[1021]?.quantity || 0;
    if (sweepTicketCount <= 0) {
      log(tokenName, '灯神扫荡：扫荡券不足', 'warning');
      return;
    }
    // 找最高层数
    let maxLayer = -1, bestGenieId = -1;
    for (let i = 1; i <= 4; i++) {
      if (genieData[i] !== undefined && (genieData[i] + 1) > maxLayer) {
        maxLayer = genieData[i] + 1; bestGenieId = i;
      }
    }
    if (bestGenieId === -1) { log(tokenName, '灯神扫荡：未找到可扫荡关卡', 'warning'); return; }
    const names = { 1:'魏国', 2:'蜀国', 3:'吴国', 4:'群雄', 5:'深海' };
    log(tokenName, `灯神扫荡：${names[bestGenieId]}灯神 第${maxLayer}层，共${sweepTicketCount}张券`);
    let remaining = sweepTicketCount;
    while (remaining > 0) {
      const sweepCnt = Math.min(remaining, 20);
      const res = await client.sendWithPromise('genie_sweep', { genieId: bestGenieId, sweepCnt }, 8000);
      remaining = res?.role?.items?.[1021]?.quantity ?? 0;
      log(tokenName, `✅ 灯神扫荡 ${sweepCnt} 次，剩余 ${remaining} 张`, 'success');
      await sleep(delay);
    }
  } catch (err) {
    log(tokenName, `灯神扫荡失败: ${err.message}`, 'warning');
  }
}

/** 答题（study_startgame，仅发起，无法等待完成） */
async function runBatchStudy(client, tokenName) {
  await execCmd(client, tokenName, 'study_startgame', {}, '开始答题', 8000);
}

/** 宝库1-3层（bosstower_startboss x2 + bosstower_startbox x9）*/
async function runBaoku13(client, tokenName, delay = 500) {
  try {
    const info = await client.sendWithPromise('bosstower_getinfo', {}, 5000);
    const towerId = info?.bossTower?.towerId;
    if (towerId < 1 || towerId > 3) {
      log(tokenName, `宝库：当前层数 ${towerId} 不在1-3层范围，跳过`, 'warning');
      return;
    }
    for (let i = 0; i < 2; i++) {
      await execCmd(client, tokenName, 'bosstower_startboss', {}, `宝库BOSS ${i+1}/2`);
      await sleep(delay);
    }
    for (let i = 0; i < 9; i++) {
      await execCmd(client, tokenName, 'bosstower_startbox', {}, `宝库开箱 ${i+1}/9`);
      await sleep(delay);
    }
  } catch (err) { log(tokenName, `宝库1-3失败: ${err.message}`, 'warning'); }
}

/** 宝库4-5层（bosstower_startboss x2）*/
async function runBaoku45(client, tokenName, delay = 500) {
  try {
    const info = await client.sendWithPromise('bosstower_getinfo', {}, 5000);
    const towerId = info?.bossTower?.towerId;
    if (towerId < 4 || towerId > 5) {
      log(tokenName, `宝库：当前层数 ${towerId} 不在4-5层范围，跳过`, 'warning');
      return;
    }
    for (let i = 0; i < 2; i++) {
      await execCmd(client, tokenName, 'bosstower_startboss', {}, `宝库BOSS ${i+1}/2`);
      await sleep(delay);
    }
  } catch (err) { log(tokenName, `宝库4-5失败: ${err.message}`, 'warning'); }
}

/** 爬塔（fight_starttower，耗尽体力为止）*/
async function runClimbTower(client, tokenName, settings = {}, delay = 1000) {
  let originalFormation = null;
  try {
    // 阵容切换
    const towerFormation = settings.towerFormation;
    if (towerFormation) {
      try {
        const teamInfo = await client.sendWithPromise('presetteam_getinfo', {}, 5000);
        originalFormation = teamInfo?.presetTeamInfo?.useTeamId;
        if (originalFormation !== towerFormation) {
          await client.sendWithPromise('presetteam_saveteam', { teamId: towerFormation }, 5000);
          log(tokenName, `爬塔：切换到阵容${towerFormation}`, 'info');
        } else {
          originalFormation = null; // 无需切回
        }
      } catch (e) { log(tokenName, `阵容切换失败: ${e.message}`, 'warning'); }
      await sleep(500);
    }

    const battleVersion = await getBattleVersion(client, tokenName);
    const roleInfo = await client.sendWithPromise('role_getroleinfo', {}, 8000);
    let energy = roleInfo?.role?.tower?.energy || 0;
    log(tokenName, `爬塔：初始体力 ${energy}`);
    let count = 0; let fails = 0;
    while (energy > 0 && count < 100) {
      try {
        await client.sendWithPromise('fight_starttower', { battleVersion }, 8000);
        count++; fails = 0; energy--;
        log(tokenName, `✅ 爬塔第 ${count} 次`, 'success');
        await sleep(delay);
      } catch (err) {
        if (err.message?.includes('1500040')) {
          const floor = Math.floor((roleInfo?.role?.tower?.id || 0) / 10);
          if (floor > 0) await client.sendWithPromise('tower_claimreward', { rewardId: floor }, 3000).catch(() => {});
          await sleep(3000); continue;
        }
        if (err.message?.includes('200400')) {
          log(tokenName, '爬塔：操作过快，等待5秒', 'warning');
          await sleep(5000); continue;
        }
        if (++fails >= 3) break;
        await sleep(2000);
      }
      if (count % 5 === 0) {
        try { const r = await client.sendWithPromise('role_getroleinfo', {}, 5000); energy = r?.role?.tower?.energy || 0; } catch {}
      }
    }
    log(tokenName, `爬塔结束，共 ${count} 次`, 'success');
  } catch (err) { log(tokenName, `爬塔失败: ${err.message}`, 'warning'); }
  finally {
    // 切回原阵容
    if (originalFormation != null) {
      try {
        await client.sendWithPromise('presetteam_saveteam', { teamId: originalFormation }, 5000);
        log(tokenName, `爬塔：切回阵容${originalFormation}`, 'info');
      } catch {}
    }
  }
}

/** 爬怪异塔（evotower_readyfight + evotower_fight，耗尽能量）*/
async function runClimbWeirdTower(client, tokenName, settings = {}, delay = 500) {
  let originalFormation = null;
  try {
    // 阵容切换
    const towerFormation = settings.towerFormation;
    if (towerFormation) {
      try {
        const teamInfo = await client.sendWithPromise('presetteam_getinfo', {}, 5000);
        originalFormation = teamInfo?.presetTeamInfo?.useTeamId;
        if (originalFormation !== towerFormation) {
          await client.sendWithPromise('presetteam_saveteam', { teamId: towerFormation }, 5000);
          log(tokenName, `怪异塔：切换到阵容${towerFormation}`, 'info');
        } else {
          originalFormation = null;
        }
      } catch (e) { log(tokenName, `阵容切换失败: ${e.message}`, 'warning'); }
      await sleep(500);
    }

    let info = await client.sendWithPromise('evotower_getinfo', {}, 5000);
    let energy = info?.evoTower?.energy || 0;
    log(tokenName, `怪异塔：初始能量 ${energy}`);
    let count = 0; let fails = 0;
    while (energy > 0 && count < 100) {
      try {
        await client.sendWithPromise('evotower_readyfight', {}, 5000);
        const fightRes = await client.sendWithPromise('evotower_fight', { battleNum: 1, winNum: 1 }, 10000);
        count++; fails = 0;
        log(tokenName, `✅ 怪异塔第 ${count} 次`, 'success');
        await sleep(delay);
        // 刷新信息
        info = await client.sendWithPromise('evotower_getinfo', {}, 5000);
        const towerId = info?.evoTower?.towerId || 0;

        // 检查并领取每日任务奖励
        if (info?.evoTower?.taskClaimMap) {
          const now = new Date();
          const dateKey = `${String(now.getFullYear()).slice(2)}${String(now.getMonth()+1).padStart(2,'0')}${String(now.getDate()).padStart(2,'0')}`;
          const dailyTasks = info.evoTower.taskClaimMap[dateKey] || {};
          for (const taskId of [1, 2, 3]) {
            if (!dailyTasks[taskId]) {
              await client.sendWithPromise('evotower_claimtask', { taskId }, 2000).catch(() => {});
              await sleep(200);
            }
          }
        }

        // 通关10层领取奖励
        if (fightRes?.winList?.[0] && ((towerId % 10) + 1) === 1) {
          await client.sendWithPromise('evotower_claimreward', {}, 5000).catch(() => {});
          log(tokenName, `怪异塔：领取第${Math.floor(towerId / 10)}章通关奖励`, 'success');
        }
        energy = info?.evoTower?.energy || 0;
      } catch (err) {
        if (++fails >= 3) break;
        await sleep(1000);
        try { info = await client.sendWithPromise('evotower_getinfo', {}, 5000); energy = info?.evoTower?.energy || 0; } catch {}
      }
    }
    log(tokenName, `怪异塔结束，共 ${count} 次`, 'success');
  } catch (err) { log(tokenName, `怪异塔失败: ${err.message}`, 'warning'); }
  finally {
    if (originalFormation != null) {
      try {
        await client.sendWithPromise('presetteam_saveteam', { teamId: originalFormation }, 5000);
        log(tokenName, `怪异塔：切回阵容${originalFormation}`, 'info');
      } catch {}
    }
  }
}

/** 领取怪异塔免费道具 */
async function runClaimFreeEnergy(client, tokenName) {
  try {
    const res = await client.sendWithPromise('mergebox_getinfo', { actType: 1 }, 5000);
    if (res?.mergeBox?.freeEnergy > 0) {
      await execCmd(client, tokenName, 'mergebox_claimfreeenergy', { actType: 1 }, `领取免费道具${res.mergeBox.freeEnergy}个`);
    } else {
      log(tokenName, '怪异塔免费道具：暂无可领取');
    }
  } catch (err) { log(tokenName, `领取免费道具失败: ${err.message}`, 'warning'); }
}

/** 使用怪异塔道具（mergebox_openbox 循环直到耗尽）*/
async function runUseItems(client, tokenName, delay = 500) {
  try {
    const infoRes = await client.sendWithPromise('mergebox_getinfo', { actType: 1 }, 5000);
    const towerRes = await client.sendWithPromise('evotower_getinfo', {}, 5000);
    let costTotalCnt = infoRes?.mergeBox?.costTotalCnt || 0;
    let lotteryLeft = towerRes?.evoTower?.lotteryLeftCnt || 0;
    if (lotteryLeft <= 0) { log(tokenName, '使用道具：无剩余', 'warning'); return; }
    log(tokenName, `使用道具：剩余 ${lotteryLeft}，已用 ${costTotalCnt}`);
    let used = 0;
    while (lotteryLeft > 0) {
      let pos = costTotalCnt < 2 ? { gridX: 4, gridY: 5 } : costTotalCnt < 102 ? { gridX: 7, gridY: 3 } : { gridX: 6, gridY: 3 };
      await client.sendWithPromise('mergebox_openbox', { actType: 1, pos }, 5000);
      costTotalCnt++; lotteryLeft--; used++;
      await sleep(delay);
    }
    await client.sendWithPromise('mergebox_claimcostprogress', { actType: 1 }, 5000).catch(() => {});
    log(tokenName, `✅ 使用道具 ${used} 次`, 'success');
  } catch (err) { log(tokenName, `使用道具失败: ${err.message}`, 'warning'); }
}

/** 合成怪异塔材料（mergebox_mergeitem 两两配对合成）*/
async function runMergeItems(client, tokenName, delay = 500) {
  try {
    for (let loop = 0; loop < 20; loop++) {
      const infoRes = await client.sendWithPromise('mergebox_getinfo', { actType: 1 }, 5000);
      if (!infoRes?.mergeBox) break;
      // 领取合成奖励
      const taskMap = infoRes.mergeBox.taskMap || {};
      const taskClaimMap = infoRes.mergeBox.taskClaimMap || {};
      for (const taskId of Object.keys(taskMap)) {
        if (taskMap[taskId] !== 0 && !taskClaimMap[taskId]) {
          await client.sendWithPromise('mergebox_claimmergeprogress', { actType: 1, taskId: parseInt(taskId) }, 2000).catch(() => {});
          await sleep(delay);
        }
      }
      // 解析 gridMap（二维结构）并按 gridItemId 分组
      const gridMap = infoRes.mergeBox.gridMap || {};
      const items = [];
      for (const xStr in gridMap) {
        for (const yStr in gridMap[xStr]) {
          const item = gridMap[xStr][yStr];
          if (item.gridConfId == 0 && item.gridItemId > 0 && !item.isLock) {
            items.push({ x: parseInt(xStr), y: parseInt(yStr), id: item.gridItemId });
          }
        }
      }
      // 按 gridItemId 分组
      const grouped = {};
      for (const item of items) {
        if (!grouped[item.id]) grouped[item.id] = [];
        grouped[item.id].push(item);
      }
      // 检查是否有可合成项（同类 >= 2）
      let hasMerge = false;
      for (const id in grouped) {
        if (grouped[id].length >= 2) { hasMerge = true; break; }
      }
      if (!hasMerge) break;

      // 检查是否8级以上，使用自动合成
      const isLevel8OrAbove = taskMap['251212208'] && taskMap['251212208'] !== 0;
      if (isLevel8OrAbove) {
        await client.sendWithPromise('mergebox_automergeitem', { actType: 1 }, 10000).catch(() => {});
        log(tokenName, '合成：使用自动合成', 'info');
        await sleep(1500);
      } else {
        // 手动两两配对合成
        for (const id in grouped) {
          const group = grouped[id];
          while (group.length >= 2) {
            const source = group.shift();
            const target = group.shift();
            await client.sendWithPromise('mergebox_mergeitem', {
              actType: 1,
              sourcePos: { gridX: source.x, gridY: source.y },
              targetPos: { gridX: target.x, gridY: target.y }
            }, 2000).catch(() => {});
            await sleep(delay);
          }
        }
      }
      await sleep(500);
    }
    log(tokenName, '✅ 合成完成', 'success');
  } catch (err) { log(tokenName, `合成失败: ${err.message}`, 'warning'); }
}

/** 蟠桃园任务领取 */
async function runClaimPeachTasks(client, tokenName, delay = 500) {
  try {
    const res = await client.sendWithPromise('legion_getpayloadtask', {}, 5000);
    const payloadTask = res?.payloadTask;
    if (!payloadTask?.taskMap) { log(tokenName, '蟠桃园：无任务数据', 'warning'); return; }
    const PEACH_TASKS = (await import('../src/utils/batch/PeachTaskIds.js').catch(() => null))?.PEACH_TASKS || [];
    const taskMap = payloadTask.taskMap;
    for (const item of Object.values(taskMap)) {
      const tasks = PEACH_TASKS.filter(t => t.type === item.typ && item.progress >= t.target && item.claimedProgress < t.target);
      for (const task of tasks) {
        await execCmd(client, tokenName, 'legion_claimpayloadtask', { taskId: task.id }, `蟠桃园任务${task.id}`);
        await sleep(delay);
      }
    }
    // 积分奖励
    const res2 = await client.sendWithPromise('legion_getpayloadtask', {}, 5000);
    const pt = res2?.payloadTask;
    if (pt) {
      const pm = pt.progressMap || {};
      const tgpm = pt.taskGroupprogressMap || {};
      if ((pt.legionPoint || 0) > (pm[1] || pm['1'] || 0) && (tgpm[1] || tgpm['1'] || 0) < 25) {
        await execCmd(client, tokenName, 'legion_claimpayloadtaskprogress', { taskGroup: 1 }, '蟠桃园俱乐部积分奖励');
      }
      if ((pt.selfPoint || 0) > (pm[2] || pm['2'] || 0) && (tgpm[2] || tgpm['2'] || 0) < 25) {
        await execCmd(client, tokenName, 'legion_claimpayloadtaskprogress', { taskGroup: 2 }, '蟠桃园个人积分奖励');
      }
    }
  } catch (err) { log(tokenName, `蟠桃园失败: ${err.message}`, 'warning'); }
}

/** 梦境购买（使用 batchSettings.dreamPurchaseList）*/
async function runBuyDreamItems(client, tokenName, batchSettings = {}, delay = 500) {
  const rawPurchaseList = batchSettings?.dreamPurchaseList;
  const purchaseList = Array.isArray(rawPurchaseList) ? rawPurchaseList : [];
  if (!purchaseList.length) { log(tokenName, '梦境购买：未配置购买清单', 'warning'); return; }
  const dayOfWeek = new Date().getDay();
  if (![0, 1, 3, 4].includes(dayOfWeek)) {
    log(tokenName, `梦境购买：今日非开放日`, 'warning'); return;
  }

  const parsePurchaseKey = (item) => {
    if (typeof item === 'string') {
      const [merchantId, itemIndex] = item.split('-').map(Number);
      if (!Number.isNaN(merchantId) && !Number.isNaN(itemIndex)) {
        return { merchantId, itemIndex };
      }
      return null;
    }
    if (item && typeof item === 'object') {
      const merchantId = Number(item.merchantId ?? item.id);
      const itemIndex = Number(item.itemIndex ?? item.index);
      if (!Number.isNaN(merchantId) && !Number.isNaN(itemIndex)) {
        return { merchantId, itemIndex };
      }
    }
    return null;
  };

  try {
    const roleInfo = await client.sendWithPromise('role_getroleinfo', {}, 15000);
    const merchantData = roleInfo?.role?.dungeon?.merchant;
    if (!merchantData) { log(tokenName, '梦境购买：无法获取商店数据', 'warning'); return; }

    const levelId = Number(roleInfo?.role?.levelId || 0);
    if (levelId < 4000) {
      log(tokenName, `梦境购买：关卡 ${levelId} < 4000，跳过`, 'warning');
      return;
    }

    const operations = [];
    for (const rawItem of purchaseList) {
      const parsed = parsePurchaseKey(rawItem);
      if (!parsed) continue;

      const { merchantId, itemIndex } = parsed;
      const items = merchantData[merchantId];
      if (!Array.isArray(items)) continue;

      for (let pos = 0; pos < items.length; pos++) {
        if (items[pos] === itemIndex) {
          operations.push({ merchantId, itemIndex, pos });
        }
      }
    }

    if (!operations.length) {
      log(tokenName, '梦境购买：配置商品未在当前商店中出现', 'warning');
      return;
    }

    // 同商人内按 pos 倒序购买，避免前面购买后列表位移导致买错商品。
    operations.sort((a, b) => {
      if (a.merchantId !== b.merchantId) return a.merchantId - b.merchantId;
      return b.pos - a.pos;
    });

    let successCount = 0;
    let failCount = 0;
    for (const op of operations) {
      const result = await execCmd(
        client,
        tokenName,
        'dungeon_buymerchant',
        { id: op.merchantId, index: op.itemIndex, pos: op.pos },
        `梦境购买 ${op.merchantId}-${op.itemIndex}`,
        5000,
      );

      if (result && result.reward) successCount++;
      else failCount++;

      await sleep(delay);
    }

    log(tokenName, `梦境购买完成：成功 ${successCount}，失败 ${failCount}`, 'info');
  } catch (err) { log(tokenName, `梦境购买失败: ${err.message}`, 'warning'); }
}

// 标准化车辆列表（对齐前端 normalizeCars 逻辑）
function normalizeCars(raw) {
  const r = raw || {};
  const body = r.body || r;
  const roleCar = body.roleCar || body.rolecar || {};
  const carMap = roleCar.carDataMap || roleCar.cardatamap;
  if (carMap && typeof carMap === 'object') {
    return Object.entries(carMap).map(([id, info]) => ({ id, ...(info || {}) }));
  }
  let arr = body.cars || body.list || body.data || body.carList || [];
  if (!Array.isArray(arr) && typeof arr === 'object' && arr !== null) arr = Object.values(arr);
  return Array.isArray(arr) ? arr : [];
}

// 判断是否可收车（发出后满4小时，对齐前端 canClaim 逻辑）
function canClaim(car) {
  const t = Number(car?.sendAt || 0);
  if (!t) return false;
  const tsMs = t < 1e12 ? t * 1000 : t;
  return Date.now() - tsMs >= 4 * 60 * 60 * 1000;
}

/**
 * 检查车辆奖励是否满足自定义条件（对齐前端 checkRewardConditions）
 * @param {Array} rewards - 奖励列表
 * @param {object} conditions - { gold, recruit, jade, ticket }
 * @param {boolean} matchAll - true: AND, false: OR
 */
function checkRewardConditions(rewards, conditions, matchAll = false) {
  if (!Array.isArray(rewards) || !conditions) return false;
  const { gold = 0, recruit = 0, jade = 0, ticket = 0 } = conditions;
  if (!gold && !recruit && !jade && !ticket) return false;

  let goldCount = 0, recruitCount = 0, jadeCount = 0, ticketCount = 0;
  for (const r of rewards) {
    const val = Number(r.value || r.num || r.quantity || r.count || 0);
    const type = Number(r.type || 0);
    const itemId = Number(r.itemId || 0);
    if (type === 2) goldCount += val;           // 金砖
    if (itemId === 1001) recruitCount += val;   // 招募令
    if (itemId === 1022) jadeCount += val;      // 白玉
    if (itemId === 35002) ticketCount += val;   // 刷新券
  }

  if (matchAll) {
    if (gold > 0 && goldCount < gold) return false;
    if (recruit > 0 && recruitCount < recruit) return false;
    if (jade > 0 && jadeCount < jade) return false;
    if (ticket > 0 && ticketCount < ticket) return false;
    return true;
  } else {
    if (gold > 0 && goldCount >= gold) return true;
    if (recruit > 0 && recruitCount >= recruit) return true;
    if (jade > 0 && jadeCount >= jade) return true;
    if (ticket > 0 && ticketCount >= ticket) return true;
    return false;
  }
}

/** 统计赛车刷新券数量 */
function countRacingRefreshTickets(rewards) {
  if (!Array.isArray(rewards)) return 0;
  let cnt = 0;
  for (const r of rewards) {
    if (Number(r.itemId || 0) === 35002) cnt += Number(r.value || r.num || r.quantity || 0);
  }
  return cnt;
}

/** 判断是否大奖车（对齐前端 isBigPrize） */
function isBigPrize(rewards) {
  if (!Array.isArray(rewards)) return false;
  for (const r of rewards) {
    const type = Number(r.type || 0);
    const itemId = Number(r.itemId || 0);
    const val = Number(r.value || 0);
    // 金砖 >=500 或 招募令 >=5 或 红色碎片
    if (type === 2 && val >= 500) return true;
    if (itemId === 1001 && val >= 5) return true;
    if (itemId === 3201) return true;
  }
  return false;
}

/**
 * 判断是否应该发车（对齐前端 shouldSendCar）
 */
function shouldSendCar(car, tickets, minColor = 4, customConditions = {}, useGoldRefreshFallback = false, matchAll = false) {
  const color = Number(car?.color || 0);
  const rewards = Array.isArray(car?.rewards) ? car.rewards : [];
  const customConditionsMet = checkRewardConditions(rewards, customConditions, matchAll);

  if (useGoldRefreshFallback) {
    if (color < minColor) return false;
    const hasConditions = (customConditions.gold > 0 || customConditions.recruit > 0 || customConditions.jade > 0 || customConditions.ticket > 0);
    if (hasConditions) return customConditionsMet;
    return true;
  }

  if (customConditionsMet) return true;

  const racingTickets = countRacingRefreshTickets(rewards);
  if (tickets >= 6) {
    return color >= minColor && (color >= 5 || racingTickets >= 4 || isBigPrize(rewards));
  }
  return color >= minColor || racingTickets >= 2 || isBigPrize(rewards);
}

const GRADE_LABELS = { 1: '绿·普通', 2: '蓝·稀有', 3: '紫·史诗', 4: '橙·传说', 5: '红·神话', 6: '金·传奇' };
function gradeLabel(color) { return GRADE_LABELS[color] || `未知(${color})`; }

/** 智能发车（完整版：支持条件判断、刷新、金砖保底） */
async function runSmartSendCar(client, tokenName, settings = {}, delay = 500) {
  const minColor = settings.carMinColor ?? 4;
  const useGoldRefreshFallback = settings.useGoldRefreshFallback ?? false;
  const matchAll = settings.smartDepartureMatchAll ?? false;
  const customConditions = {
    gold: settings.smartDepartureGoldThreshold ?? 0,
    recruit: settings.smartDepartureRecruitThreshold ?? 0,
    jade: settings.smartDepartureJadeThreshold ?? 0,
    ticket: settings.smartDepartureTicketThreshold ?? 0,
  };

  const hasConditions = (customConditions.gold > 0 || customConditions.recruit > 0 || customConditions.jade > 0 || customConditions.ticket > 0);

  log(tokenName, `智能发车配置: 保底颜色=${gradeLabel(minColor)}, 金砖保底=${useGoldRefreshFallback}, 满足所有=${matchAll}, ` +
    `条件: 金砖>=${customConditions.gold} 招募令>=${customConditions.recruit} 白玉>=${customConditions.jade} 刷新券>=${customConditions.ticket}`);

  try {
    const res = await client.sendWithPromise('car_getrolecar', {}, 10000);
    const cars = normalizeCars(res);
    log(tokenName, `智能发车：共找到 ${cars.length} 辆车`);

    // 获取刷新券数量
    let refreshTickets = 0;
    try {
      const roleRes = await client.sendWithPromise('role_getroleinfo', {}, 8000);
      refreshTickets = Number(roleRes?.role?.items?.[35002]?.quantity || 0);
      log(tokenName, `剩余刷新券: ${refreshTickets}`);
    } catch (_) {}

    // 预加载护卫数据（红车优先绑定高红淬护卫）
    let helperUsageMap = {};
    let sortedHelpers = [];
    let currentRoleId = null;

    const updateHelperUsage = async () => {
      try {
        const resp = await client.sendWithPromise('car_getmemberhelpingcnt', {}, 5000);
        helperUsageMap = resp?.body?.memberHelpingCntMap || resp?.memberHelpingCntMap || {};
      } catch (_) {
        helperUsageMap = helperUsageMap || {};
      }
    };

    try {
      const roleRes = await client.sendWithPromise('role_getroleinfo', {}, 8000);
      currentRoleId = roleRes?.role?.roleId ? String(roleRes.role.roleId) : null;
    } catch (_) {}

    try {
      await updateHelperUsage();
      const legionRes = await client.sendWithPromise('legion_getinfo', {}, 8000);
      const membersMap = legionRes?.info?.members || legionRes?.body?.info?.members || {};
      const members = Object.values(membersMap || {});

      sortedHelpers = members
        .filter((m) => !currentRoleId || String(m?.roleId) !== currentRoleId)
        .map((m) => ({
          id: String(m?.roleId || ''),
          name: m?.name || m?.nickname || String(m?.roleId || ''),
          redQuench: Number(m?.custom?.red_quench_cnt || 0),
        }))
        .filter((m) => m.id)
        .sort((a, b) => b.redQuench - a.redQuench);

      log(tokenName, `护卫候选成员: ${sortedHelpers.length}（按红淬降序）`);
    } catch (e) {
      log(tokenName, `获取护卫数据失败，降级为不带护卫发车: ${e.message}`, 'warning');
      sortedHelpers = [];
    }

    const resolveHelperIdForCar = async (car) => {
      const color = Number(car?.color || 0);
      // 仅红(5)及以上自动拉护卫
      if (color < 5) return 0;

      const existing = Number(car?.helperId || car?.guardId || car?.helperBattleTeam?.roleId || 0);
      if (existing > 0) return existing;

      if (!sortedHelpers.length) return 0;

      // 每次分配前刷新使用次数，避免并发超限
      await updateHelperUsage();

      const best = sortedHelpers.find((h) => Number(helperUsageMap[h.id] || 0) < 4);
      if (!best) {
        log(tokenName, `车辆[${gradeLabel(color)}] 需护卫，但所有护卫次数已满`, 'warning');
        return 0;
      }

      helperUsageMap[best.id] = Number(helperUsageMap[best.id] || 0) + 1;
      log(tokenName, `车辆[${gradeLabel(color)}] 自动分配护卫: ${best.name}（红淬${best.redQuench}，已助战 ${helperUsageMap[best.id]}/4）`, 'info');
      return Number(best.id);
    };

    let sent = 0;
    for (const car of cars) {
      const sendAt = Number(car.sendAt ?? car.sendtime ?? car.send_at ?? 0);
      if (sendAt !== 0) continue; // 已在路上

      const effectiveTickets = useGoldRefreshFallback ? 999 : refreshTickets;

      // 1. 检查是否满足发车条件
      if (shouldSendCar(car, effectiveTickets, minColor, customConditions, useGoldRefreshFallback, matchAll)) {
        log(tokenName, `车辆[${gradeLabel(car.color)}] 满足条件，直接发车`);
        const helperId = await resolveHelperIdForCar(car);
        await execCmd(client, tokenName, 'car_send', { carId: String(car.id), helperId, text: '', isUpgrade: false }, `发车[${gradeLabel(car.color)}]`, 10000);
        sent++;
        await sleep(delay);
        continue;
      }

      // 2. 不满足条件，尝试刷新
      let canRefresh = false;
      const free = Number(car.refreshCount ?? 0) === 0;
      const useGoldFallback = useGoldRefreshFallback && !free && refreshTickets < 6;

      if (refreshTickets >= 6) canRefresh = true;
      else if (free) canRefresh = true;
      else if (useGoldFallback) {
        canRefresh = true;
        log(tokenName, `车辆[${gradeLabel(car.color)}] 启用金砖刷新`, 'warning');
      } else {
        // 无法刷新，直接发车
        log(tokenName, `车辆[${gradeLabel(car.color)}] 不满足条件且无刷新次数，直接发车`, 'warning');
        const helperId = await resolveHelperIdForCar(car);
        await execCmd(client, tokenName, 'car_send', { carId: String(car.id), helperId, text: '', isUpgrade: false }, `发车[${gradeLabel(car.color)}]`, 10000);
        sent++;
        await sleep(delay);
        continue;
      }

      // 3. 刷新循环
      while (canRefresh) {
        log(tokenName, `车辆[${gradeLabel(car.color)}] 尝试刷新...`);
        try {
          const resp = await client.sendWithPromise('car_refresh', { carId: String(car.id) }, 10000);
          const data = resp?.car || resp?.body?.car || resp;
          if (data && typeof data === 'object') {
            if (data.color != null) car.color = Number(data.color);
            if (data.refreshCount != null) car.refreshCount = Number(data.refreshCount);
            if (data.rewards != null) car.rewards = data.rewards;
          }
        } catch (e) {
          log(tokenName, `刷新失败: ${e.message}`, 'warning');
          break;
        }

        // 更新刷新券数量
        try {
          const roleRes = await client.sendWithPromise('role_getroleinfo', {}, 5000);
          refreshTickets = Number(roleRes?.role?.items?.[35002]?.quantity || 0);
        } catch (_) {}

        // 刷新后检查是否满足条件
        if (shouldSendCar(car, useGoldRefreshFallback ? 999 : refreshTickets, minColor, customConditions, useGoldRefreshFallback, matchAll)) {
          log(tokenName, `刷新后车辆[${gradeLabel(car.color)}] 满足条件，发车`, 'success');
          const helperId = await resolveHelperIdForCar(car);
          await execCmd(client, tokenName, 'car_send', { carId: String(car.id), helperId, text: '', isUpgrade: false }, `发车[${gradeLabel(car.color)}]`, 10000);
          sent++;
          await sleep(delay);
          break;
        }

        // 检查是否可以继续刷新
        const freeNow = Number(car.refreshCount ?? 0) === 0;
        const useGoldFallbackNow = useGoldRefreshFallback && !freeNow && refreshTickets < 6;

        if (refreshTickets >= 6) canRefresh = true;
        else if (freeNow) canRefresh = true;
        else if (useGoldFallbackNow) {
          canRefresh = true;
          log(tokenName, `车辆[${gradeLabel(car.color)}] 继续金砖刷新`, 'warning');
        } else {
          // 无法继续刷新，直接发车
          log(tokenName, `车辆[${gradeLabel(car.color)}] 刷新结束（无票），直接发车`, 'warning');
          const helperId = await resolveHelperIdForCar(car);
          await execCmd(client, tokenName, 'car_send', { carId: String(car.id), helperId, text: '', isUpgrade: false }, `发车[${gradeLabel(car.color)}]`, 10000);
          sent++;
          await sleep(delay);
          break;
        }

        await sleep(1000); // 刷新间隔
      }
    }
    log(tokenName, `✅ 智能发车完成，共发 ${sent} 辆`, 'success');
  } catch (err) { log(tokenName, `智能发车失败: ${err.message}`, 'warning'); }
}

/** 直接发车（不判断条件、不刷新，获取车辆后直接发出所有未发送的车） */
async function runDirectSendCar(client, tokenName, delay = 500) {
  try {
    const res = await client.sendWithPromise('car_getrolecar', {}, 10000);
    const cars = normalizeCars(res);
    log(tokenName, `直接发车：共找到 ${cars.length} 辆车`);

    let sent = 0;
    for (const car of cars) {
      const sendAt = Number(car.sendAt ?? car.sendtime ?? car.send_at ?? 0);
      if (sendAt !== 0) {
        log(tokenName, `车辆[${gradeLabel(car.color)}] 已在路上，跳过`);
        continue;
      }
      await execCmd(client, tokenName, 'car_send',
        { carId: String(car.id), helperId: 0, text: '', isUpgrade: false },
        `直接发车[${gradeLabel(car.color)}]`, 10000);
      sent++;
      await sleep(delay);
    }
    log(tokenName, `✅ 直接发车完成，共发 ${sent} 辆`, 'success');
  } catch (err) { log(tokenName, `直接发车失败: ${err.message}`, 'warning'); }
}

/** 批量开箱 */
async function runBatchOpenBox(client, tokenName, batchSettings = {}, delay = 500) {
  const boxType = batchSettings.defaultBoxType ?? 2001;
  const totalCount = batchSettings.boxCount ?? 100;
  const boxNames = { 2001: '木质宝箱', 2002: '青铜宝箱', 2003: '黄金宝箱', 2004: '铂金宝箱' };
  log(tokenName, `批量开箱：${boxNames[boxType] || boxType} x ${totalCount}`);
  try {
    const batches = Math.floor(totalCount / 10);
    const remainder = totalCount % 10;
    for (let i = 0; i < batches; i++) {
      await execCmd(client, tokenName, 'item_openbox', { itemId: boxType, number: 10 }, `开箱 ${(i + 1) * 10}/${totalCount}`);
      await sleep(delay);
    }
    if (remainder > 0) {
      await execCmd(client, tokenName, 'item_openbox', { itemId: boxType, number: remainder }, `开箱 ${totalCount}/${totalCount}`);
      await sleep(delay);
    }
    await execCmd(client, tokenName, 'item_batchclaimboxpointreward', {}, '自动领取宝箱积分');
    log(tokenName, `✅ 批量开箱完成`, 'success');
  } catch (err) { log(tokenName, `批量开箱失败: ${err.message}`, 'warning'); }
}

/** 按积分开箱 */
async function runBatchOpenBoxByPoints(client, tokenName, batchSettings = {}, delay = 500) {
  const targetPoints = batchSettings.targetBoxPoints ?? 1000;
  const boxPriority = [
    { id: 2001, name: '木质宝箱', points: 1, reserve: 200 },
    { id: 2002, name: '青铜宝箱', points: 10, reserve: 0 },
    { id: 2003, name: '黄金宝箱', points: 20, reserve: 0 },
    { id: 2004, name: '铂金宝箱', points: 50, reserve: 0 },
  ];
  log(tokenName, `按积分开箱：目标 ${targetPoints} 积分`);
  try {
    const roleRes = await client.sendWithPromise('role_getroleinfo', {}, 8000);
    const items = roleRes?.role?.items || {};
    const boxInventory = {};
    for (const box of boxPriority) {
      boxInventory[box.id] = items[box.id]?.quantity || 0;
    }
    log(tokenName, `箱子库存: 木质=${boxInventory[2001]}, 青铜=${boxInventory[2002]}, 黄金=${boxInventory[2003]}, 铂金=${boxInventory[2004]}`);

    // 计算开箱方案：先用木质（保留200），再用高级箱凑齐
    const boxToOpen = {};
    let remainingPoints = targetPoints;

    // 木质宝箱（保留 reserve 个）
    const woodenAvailable = boxInventory[2001] - 200;
    if (woodenAvailable >= 10) {
      let woodenToOpen = Math.min(woodenAvailable, remainingPoints);
      woodenToOpen = Math.floor(woodenToOpen / 10) * 10;
      if (woodenToOpen >= 10) {
        boxToOpen[2001] = woodenToOpen;
        remainingPoints -= woodenToOpen * 1;
      }
    }

    // 用高级箱填补剩余积分
    if (remainingPoints > 0) {
      for (const box of [boxPriority[3], boxPriority[2], boxPriority[1]]) { // 铂金→黄金→青铜
        const avail = Math.floor(boxInventory[box.id] / 10) * 10;
        if (avail <= 0 || remainingPoints <= 0) continue;
        const needBoxes = Math.min(avail, Math.ceil(remainingPoints / box.points / 10) * 10);
        if (needBoxes >= 10) {
          boxToOpen[box.id] = needBoxes;
          remainingPoints -= needBoxes * box.points;
        }
      }
    }

    if (remainingPoints > 0) {
      // 用额外木质补齐
      const extra = Math.ceil(remainingPoints / 10) * 10;
      if (extra <= Math.floor(boxInventory[2001] / 10) * 10) {
        boxToOpen[2001] = (boxToOpen[2001] || 0) + extra;
        remainingPoints -= extra;
      }
    }

    // 执行开箱
    for (const box of boxPriority) {
      const count = boxToOpen[box.id] || 0;
      if (count <= 0) continue;
      log(tokenName, `开启 ${box.name}: ${count} 个 (积分: ${count * box.points})`);
      const batches = Math.floor(count / 10);
      const remainder = count % 10;
      for (let i = 0; i < batches; i++) {
        await execCmd(client, tokenName, 'item_openbox', { itemId: box.id, number: 10 }, `${box.name} ${(i + 1) * 10}/${count}`);
        await sleep(delay);
      }
      if (remainder > 0) {
        await execCmd(client, tokenName, 'item_openbox', { itemId: box.id, number: remainder }, `${box.name} ${count}/${count}`);
        await sleep(delay);
      }
    }
    await execCmd(client, tokenName, 'item_batchclaimboxpointreward', {}, '领取宝箱积分奖励');
    log(tokenName, `✅ 按积分开箱完成`, 'success');
  } catch (err) { log(tokenName, `按积分开箱失败: ${err.message}`, 'warning'); }
}

/** 领取宝箱积分奖励 */
async function runBatchClaimBoxPointReward(client, tokenName) {
  await execCmd(client, tokenName, 'item_batchclaimboxpointreward', {}, '领取宝箱积分奖励');
}

/** 批量钓鱼 */
async function runBatchFish(client, tokenName, batchSettings = {}, delay = 500) {
  const fishType = batchSettings.defaultFishType ?? 1;
  const totalCount = batchSettings.fishCount ?? 100;
  const fishNames = { 1: '普通鱼竿', 2: '黄金鱼竿' };
  const rodId = fishType === 1 ? 1011 : 1012;
  log(tokenName, `批量钓鱼：${fishNames[fishType] || fishType} x ${totalCount}`);
  try {
    // 检查鱼竿库存
    const roleRes = await client.sendWithPromise('role_getroleinfo', {}, 8000);
    const rodCount = roleRes?.role?.items?.[rodId]?.quantity || 0;
    let availableCount = totalCount;
    if (rodCount < totalCount) {
      log(tokenName, `鱼竿不足 (${rodCount} < ${totalCount})，将仅消耗现有库存`, 'warning');
      availableCount = rodCount;
    }
    if (availableCount <= 0) {
      log(tokenName, '没有可用的鱼竿，停止任务', 'warning');
      return;
    }
    const batches = Math.floor(availableCount / 10);
    const remainder = availableCount % 10;
    for (let i = 0; i < batches; i++) {
      await execCmd(client, tokenName, 'artifact_lottery', { type: fishType, lotteryNumber: 10, newFree: true }, `钓鱼 ${(i + 1) * 10}/${availableCount}`);
      await sleep(delay);
      // 每50次后校验鱼竿数量
      if ((i + 1) % 5 === 0 && i < batches - 1) {
        try {
          const r = await client.sendWithPromise('role_getroleinfo', {}, 5000);
          const currentRod = r?.role?.items?.[rodId]?.quantity || 0;
          if (currentRod < 10) {
            log(tokenName, `鱼竿不足 (${currentRod} < 10)，停止`, 'warning');
            break;
          }
        } catch (_) {}
      }
    }
    if (remainder > 0) {
      await execCmd(client, tokenName, 'artifact_lottery', { type: fishType, lotteryNumber: remainder, newFree: true }, `钓鱼 ${availableCount}/${availableCount}`);
    }
    // 自动领取累计奖励
    try {
      const r = await client.sendWithPromise('role_getroleinfo', {}, 5000);
      const points = r?.role?.statistics?.['artifact:point'] || 0;
      const exchangeCount = Math.floor(points / 20);
      if (exchangeCount > 0) {
        log(tokenName, `检测到累计使用 ${points}，领取 ${exchangeCount} 次累计奖励`);
        for (let k = 0; k < exchangeCount; k++) {
          await execCmd(client, tokenName, 'artifact_exchange', {}, `领取累计奖励 ${k + 1}/${exchangeCount}`);
          await sleep(500);
        }
      }
    } catch (_) {}
    log(tokenName, `✅ 批量钓鱼完成`, 'success');
  } catch (err) { log(tokenName, `批量钓鱼失败: ${err.message}`, 'warning'); }
}

/** 批量招募 */
async function runBatchRecruit(client, tokenName, batchSettings = {}, delay = 500) {
  const totalCount = batchSettings.recruitCount ?? 100;
  const payRecruit = batchSettings.payRecruit ?? false;  // 是否执行付费招募
  const doPay = payRecruit === true || payRecruit === 1;  // 容错处理
  
  log(tokenName, `批量招募：${totalCount} 次 (付费招募: ${doPay ? '启用' : '禁用'})`);
  try {
    const batches = Math.floor(totalCount / 10);
    const remainder = totalCount % 10;
    for (let i = 0; i < batches; i++) {
      await execCmd(client, tokenName, 'hero_recruit', { recruitType: 1, recruitNumber: 10 }, `招募 ${(i + 1) * 10}/${totalCount}`);
      await sleep(delay);
    }
    if (remainder > 0) {
      await execCmd(client, tokenName, 'hero_recruit', { recruitType: 1, recruitNumber: remainder }, `招募 ${totalCount}/${totalCount}`);
    }
    
    // 付费招募（额外1次）
    if (doPay) {
      await execCmd(client, tokenName, 'hero_recruit', { recruitType: 3, recruitNumber: 1 }, `付费招募 1/1`);
      await sleep(delay);
    }
    
    log(tokenName, `✅ 批量招募完成`, 'success');
  } catch (err) { log(tokenName, `批量招募失败: ${err.message}`, 'warning'); }
}

/** 批量赠送功法残卷 */
async function runBatchLegacyGiftSend(client, tokenName, batchSettings = {}, delay = 500) {
  const recipientId = Number(batchSettings.receiverId || 0);
  const password = batchSettings.password || '';
  if (!recipientId || recipientId <= 0) {
    log(tokenName, '赠送功法：未配置接收者ID，跳过', 'warning');
    return;
  }
  if (!password) {
    log(tokenName, '赠送功法：未配置安全密码，跳过', 'warning');
    return;
  }
  try {
    // 1. 获取角色信息（检查功法残卷数量）
    const roleRes = await client.sendWithPromise('role_getroleinfo', {}, 8000);
    const quantity = Math.min(roleRes?.role?.items?.[37007]?.quantity || 0, 9999);
    if (quantity <= 0) {
      log(tokenName, '赠送功法：功法残卷不足（0个）', 'warning');
      return;
    }
    // 2. 查询接收者信息
    const rankRes = await client.sendWithPromise('rank_getroleinfo', {
      bottleType: 0, includeBottleTeam: false, isSearch: false, roleId: recipientId,
    }, 5000);
    if (!rankRes?.roleInfo?.roleId) {
      log(tokenName, `赠送功法：接收者 ${recipientId} 不存在`, 'error');
      return;
    }
    const serverName = rankRes.roleInfo.serverName || '';
    const targetName = rankRes.roleInfo.name || '';
    log(tokenName, `赠送目标: [${serverName}] ID:${recipientId} ${targetName}，数量: ${quantity}`);

    // 3. 解除安全密码
    const pwdRes = await client.sendWithPromise('role_commitpassword', { password, passwordType: 1 }, 5000);
    if (!pwdRes?.role?.statistics?.['que:wh:tm']) {
      log(tokenName, '赠送功法：安全密码验证失败', 'error');
      return;
    }
    log(tokenName, '安全密码验证成功');

    // 4. 赠送
    await client.sendWithPromise('legacy_sendgift', {
      itemCnt: quantity, legacyUIds: [], targetId: recipientId,
    }, 5000);
    log(tokenName, `✅ 成功赠送功法残卷 ${quantity} 个给 [${serverName}] ${targetName}`, 'success');
    await sleep(delay);
  } catch (err) { log(tokenName, `赠送功法残卷失败: ${err.message}`, 'warning'); }
}

/** 一键收车 */
async function runClaimCars(client, tokenName, delay = 500) {
  try {
    const res = await client.sendWithPromise('car_getrolecar', {}, 10000);
    const cars = normalizeCars(res);
    log(tokenName, `收车：共找到 ${cars.length} 辆车`);
    if (cars.length > 0) {
      const sample = cars[0];
      log(tokenName, `[调试] 车辆样例: id=${sample.id} sendAt=${sample.sendAt} color=${sample.color} status=${sample.status}`, 'info');
    }
    let claimed = 0;
    for (const car of cars) {
      if (canClaim(car)) {
        await execCmd(client, tokenName, 'car_claim', { carId: String(car.id) }, `收车[id:${car.id} 色:${car.color}]`, 10000);
        claimed++;
        await sleep(delay);
      }
    }
    log(tokenName, `✅ 收车完成，共收 ${claimed} 辆`, 'success');
  } catch (err) { log(tokenName, `收车失败: ${err.message}`, 'warning'); }
}

/** 钓鱼补齐（月度活动）- 补齐钓鱼进度至目标 320 次 */
async function runTopUpFish(client, tokenName, delay = 500) {
  const FISH_TARGET = 320;  // 月度钓鱼目标
  try {
    // 1. 获取月度活动进度
    log(tokenName, '获取月度钓鱼进度...');
    const actRes = await client.sendWithPromise('activity_get', {}, 10000);
    const myMonthInfo = actRes?.activity?.myMonthInfo || {};
    const currentFishNum = Number(myMonthInfo?.['2']?.num || 0);

    log(tokenName, `当前钓鱼进度: ${currentFishNum}/${FISH_TARGET}`);

    if (currentFishNum >= FISH_TARGET) {
      log(tokenName, '✅ 钓鱼进度已达标，无需补齐', 'success');
      return;
    }

    const need = FISH_TARGET - currentFishNum;
    log(tokenName, `需要补齐: ${need}次钓鱼`);

    // 2. 检查并消耗免费钓鱼次数（如果今天有）
    let roleInfo = null;
    try {
      const roleRes = await client.sendWithPromise('role_getroleinfo', {}, 8000);
      roleInfo = roleRes?.role || null;
    } catch (e) {
      log(tokenName, `获取角色信息失败: ${e.message}`, 'warning');
    }

    let freeUsed = 0;
    if (roleInfo) {
      const lastFreeTime = Number(roleInfo?.statisticsTime?.['artifact:normal:lottery:time'] || 0);
      const now = new Date();
      const lastFreeDate = new Date(lastFreeTime * 1000);
      
      // 判断是否今天还有免费钓鱼次数
      if (now.toDateString() === lastFreeDate.toDateString()) {
        log(tokenName, '✓ 今日免费钓鱼次数已使用，跳过', 'info');
      } else {
        log(tokenName, '检测到今日免费钓鱼次数，开始消耗 3 次');
        for (let i = 0; i < 3 && freeUsed < need; i++) {
          try {
            await execCmd(client, tokenName, 'artifact_lottery', { lotteryNumber: 1, newFree: true, type: 1 }, `免费钓鱼 ${i+1}/3`);
            freeUsed++;
            await sleep(delay);
          } catch (e) {
            log(tokenName, `免费钓鱼失败: ${e.message}`, 'warning');
            break;
          }
        }
      }
    }

    const remainNeed = need - freeUsed;
    if (remainNeed > 0) {
      log(tokenName, `还需补齐 ${remainNeed}次，开始使用钓竿钓鱼`);
      // 3. 使用普通钓竿补齐（需要消耗金币或其他资源）
      for (let i = 0; i < remainNeed; i++) {
        try {
          await execCmd(client, tokenName, 'artifact_lottery', { lotteryNumber: 1, newFree: false, type: 1 }, `付费钓鱼 ${i+1}/${remainNeed}`);
          await sleep(delay);
        } catch (e) {
          log(tokenName, `付费钓鱼${i+1}失败: ${e.message}`, 'warning');
          break;
        }
      }
    }

    // 4. 验证最终进度
    const finalRes = await client.sendWithPromise('activity_get', {}, 10000);
    const finalMyMonthInfo = finalRes?.activity?.myMonthInfo || {};
    const finalFishNum = Number(finalMyMonthInfo?.['2']?.num || 0);
    log(tokenName, `✅ 钓鱼补齐完成，最终进度: ${finalFishNum}/${FISH_TARGET}`, 'success');
  } catch (err) {
    log(tokenName, `钓鱼补齐失败: ${err.message}`, 'error');
  }
}

/** 竞技场补齐（月度活动）- 补齐竞技场进度至目标 240 次 */
async function runTopUpArena(client, tokenName, batchSettings = {}, delay = 500) {
  const ARENA_TARGET = 240;  // 月度竞技场目标
  try {
    // 1. 获取月度活动进度
    log(tokenName, '获取月度竞技场进度...');
    const actRes = await client.sendWithPromise('activity_get', {}, 10000);
    const myMonthInfo = actRes?.activity?.myMonthInfo || {};
    const currentArenaNum = Number(myMonthInfo?.['1']?.num || 0);

    log(tokenName, `当前竞技场进度: ${currentArenaNum}/${ARENA_TARGET}`);

    if (currentArenaNum >= ARENA_TARGET) {
      log(tokenName, '✅ 竞技场进度已达标，无需补齐', 'success');
      return;
    }

    const need = ARENA_TARGET - currentArenaNum;
    log(tokenName, `需要补齐: ${need}次竞技场战斗`);

    // 2. 获取 battleVersion（竞技场战斗必需）
    const battleVersion = await getBattleVersion(client, tokenName);
    if (!battleVersion) {
      log(tokenName, '获取 battleVersion 失败，无法进行竞技场战斗', 'error');
      return;
    }

    // 3. 获取竞技场阵容配置
    const arenaFormation = batchSettings.arenaFormation ?? 1;
    let currentFormation = null;
    let switched = false;
    
    try {
      const teamInfo = await client.sendWithPromise('presetteam_getinfo', {}, 5000);
      currentFormation = teamInfo?.presetTeamInfo?.useTeamId ?? null;

      if (currentFormation !== arenaFormation) {
        await client.sendWithPromise('presetteam_saveteam', { teamId: arenaFormation }, 5000);
        switched = true;
        log(tokenName, `已切换到竞技场阵容 ${arenaFormation}`, 'info');
      }
    } catch (e) {
      log(tokenName, `切换阵容失败: ${e.message}`, 'warning');
    }

    // 4. 循环进行竞技场战斗
    let arenaCount = 0;
    for (let i = 0; i < need && arenaCount < need; i++) {
      try {
        // 进入竞技场
        await client.sendWithPromise('arena_startarea', {}, 5000).catch(() => {});
        
        // 获取目标
        const targets = await client.sendWithPromise('arena_getareatarget', { refresh: false }, 5000);
        const targetId = pickArenaTargetId(targets);
        
        if (!targetId) {
          log(tokenName, `竞技场：未找到目标 ${i+1}/${need}`, 'warning');
          break;
        }

        // 执行战斗
        await execCmd(client, tokenName, 'fight_startareaarena', { battleVersion, targetId }, `竞技场补齐 ${i+1}/${need}`);
        arenaCount++;
        await sleep(delay);
      } catch (e) {
        log(tokenName, `竞技场战斗 ${i+1} 失败: ${e.message}`, 'warning');
        if (arenaCount === 0) break;  // 如果第一场就失败则中止
      }
    }

    // 5. 恢复原阵容
    if (switched && currentFormation !== null) {
      try {
        await client.sendWithPromise('presetteam_saveteam', { teamId: currentFormation }, 5000);
        log(tokenName, `已恢复原阵容 ${currentFormation}`, 'info');
      } catch (e) {
        log(tokenName, `恢复阵容失败: ${e.message}`, 'warning');
      }
    }

    // 6. 验证最终进度
    const finalRes = await client.sendWithPromise('activity_get', {}, 10000);
    const finalMyMonthInfo = finalRes?.activity?.myMonthInfo || {};
    const finalArenaNum = Number(finalMyMonthInfo?.['1']?.num || 0);
    log(tokenName, `✅ 竞技场补齐完成，共补齐 ${arenaCount}次，最终进度: ${finalArenaNum}/${ARENA_TARGET}`, 'success');
  } catch (err) {
    log(tokenName, `竞技场补齐失败: ${err.message}`, 'error');
  }
}

/**
 * 武将升级至目标等级 - 自动处理升级和进阶
 * 
 * 进阶等级阈值（来自前端游戏逻辑）：
 * - 100级 → order 1, 200级 → order 2, ... 5500级 → order 19
 */
const LEVEL_BREAKPOINTS = [
  { level: 100, order: 1 },
  { level: 200, order: 2 },
  { level: 300, order: 3 },
  { level: 500, order: 4 },
  { level: 700, order: 5 },
  { level: 900, order: 6 },
  { level: 1100, order: 7 },
  { level: 1300, order: 8 },
  { level: 1500, order: 9 },
  { level: 1800, order: 10 },
  { level: 2100, order: 11 },
  { level: 2400, order: 12 },
  { level: 2800, order: 13 },
  { level: 3200, order: 14 },
  { level: 3600, order: 15 },
  { level: 4000, order: 16 },
  { level: 4500, order: 17 },
  { level: 5000, order: 18 },
  { level: 5500, order: 19 },
];

/**
 * 判断升级过程中是否跨越进阶阈值
 * @param {number} currentLevel - 现在等级
 * @param {number} upgradeNum - 本次升级增量
 * @param {number} currentOrder - 当前进阶等级
 * @returns {number|false} 返回需要进阶的等级，若无则返回 false
 */
/**
 * 找到当前等级到目标等级之间，下一个需要进阶的阈值等级
 * @returns {{ level: number, order: number } | null}
 */
function getNextBreakpoint(currentLevel, currentOrder, target) {
  for (const bp of LEVEL_BREAKPOINTS) {
    if (bp.level > currentLevel && bp.level <= target && bp.order > currentOrder) {
      return bp;
    }
  }
  return null;
}

async function runHeroLevelUpgrade(client, tokenName, heroId, targetLevel = 6000, delay = 500) {
  targetLevel = Math.min(Number(targetLevel), 6000);  // 最高 6000
  
  try {
    // 1. 获取当前武将信息
    log(tokenName, `准备升级武将 (heroId=${heroId}) 至等级 ${targetLevel}`);
    
    const roleRes = await client.sendWithPromise('role_getroleinfo', {}, 8000);
    const hero = roleRes?.role?.heroes?.[heroId];
    
    if (!hero) {
      log(tokenName, `❌ 武将 ${heroId} 不存在`, 'error');
      return;
    }

    const currentLevel = hero.level || 0;
    const currentOrder = hero.order || 0;
    
    log(tokenName, `当前等级: ${currentLevel}/${6000}, 进阶等级: ${currentOrder}`, 'info');

    if (currentLevel >= targetLevel) {
      log(tokenName, `✅ 武将已达目标等级 ${targetLevel}，无需升级`, 'success');
      return;
    }

    // 2. 升级循环
    let level = currentLevel;
    let order = currentOrder;
    let upgradeCount = 0;

    while (level < targetLevel) {
      // 先检查当前等级是否正好在进阶点上，如果是则先进阶
      const atBreakpoint = LEVEL_BREAKPOINTS.find(b => b.level === level && b.order > order);
      if (atBreakpoint) {
        log(tokenName, `📈 到达进阶阈值 ${level} 级，执行进阶...`, 'info');
        try {
          const advRes = await client.sendWithPromise('hero_heroupgradeorder', { heroId }, 5000);
          const newHero = advRes?.role?.heroes?.[heroId];
          if (newHero) {
            order = newHero.order || order;
            log(tokenName, `✓ 进阶成功，当前进阶等级: ${order}`, 'info');
          } else {
            log(tokenName, `⚠️  进阶响应异常`, 'warning');
          }
        } catch (e) {
          log(tokenName, `⚠️  进阶失败: ${e.message}`, 'warning');
          break;
        }
        await sleep(delay);
        continue;
      }

      // 计算本次升级的步长：不能越过下一个进阶点
      const nextBp = getNextBreakpoint(level, order, targetLevel);
      let stepTarget;

      if (nextBp && nextBp.level <= level + 50) {
        stepTarget = nextBp.level;
      } else {
        stepTarget = Math.min(level + 50, targetLevel);
      }

      const need = stepTarget - level;

      if (need <= 0) {
        break;
      }

      // 将 need 拆解为合法步长 [50, 10, 5, 1] 的组合
      const VALID_STEPS = [50, 10, 5, 1];
      const steps = [];
      let remaining = need;
      for (const s of VALID_STEPS) {
        while (remaining >= s) {
          steps.push(s);
          remaining -= s;
        }
      }

      log(tokenName, `升级中... ${upgradeCount + 1} (当前 ${level}→${stepTarget}，升${need}级，分${steps.length}步)`);

      let stepFailed = false;
      for (const step of steps) {
        try {
          const upgradeRes = await client.sendWithPromise(
            'hero_heroupgradelevel',
            { heroId, upgradeNum: step },
            5000
          );
          const newHero = upgradeRes?.role?.heroes?.[heroId];
          if (newHero) {
            level = newHero.level || level;
            order = newHero.order || order;
          }
          await sleep(200);
        } catch (e) {
          log(tokenName, `升级失败(+${step}): ${e.message}`, 'error');
          stepFailed = true;
          break;
        }
      }

      if (stepFailed) break;

      upgradeCount++;
      log(tokenName, `✓ 升级成功，当前等级: ${level}/${6000}，进阶: ${order}`, 'info');
      
      await sleep(delay);
    }

    // 3. 最终验证
    try {
      const finalRes = await client.sendWithPromise('role_getroleinfo', {}, 8000);
      const finalHero = finalRes?.role?.heroes?.[heroId];
      if (finalHero) {
        level = finalHero.level || level;
        order = finalHero.order || order;
      }
    } catch (e) {
      log(tokenName, `最终验证失败: ${e.message}`, 'warning');
    }

    log(tokenName, `✅ 武将升级完成，共升级 ${upgradeCount}次，最终等级: ${level}/${6000}，进阶: ${order}`, 'success');

  } catch (err) {
    log(tokenName, `武将升级失败: ${err.message}`, 'error');
  }
}

/** 任务类型 → 执行函数映射
 * 延迟类型说明（对齐前端 delayConfig）：
 *   commandDelay: 通用命令间延迟（默认500ms）
 *   actionDelay:  开箱/钓鱼/招募等操作延迟（默认300ms）
 *   battleDelay:  竞技场/爬塔/宝库等战斗延迟（默认500ms）
 *   refreshDelay: 发车刷新等延迟（默认1000ms）
 *   longDelay:    功法赠送等长延迟（默认3000ms）
 *   taskDelay:    任务间延迟（在 main 循环中使用，默认500ms）
 */
const TASK_RUNNERS = {
  // ── 日常（commandDelay）──
  startBatch:               (c, n, s) => runDailyBasic(c, n, s.commandDelay, s),
  claimHangUpRewards:       (c, n)    => runClaimHangUp(c, n),
  batchclubsign:            (c, n)    => runClubSign(c, n),
  collection_claimfreereward:(c, n)   => runCollectionFree(c, n),
  collection_claimreward:   (c, n)    => runCollectionClaim(c, n),
  resetBottles:             (c, n, s) => runResetBottles(c, n, s.commandDelay),
  batchlingguanzi:          (c, n)    => runClaimBottle(c, n),
  batchLegacyClaim:         (c, n)    => runLegacyClaim(c, n),
  batchAddHangUpTime:       (c, n, s) => runAddHangUpTime(c, n, s.commandDelay),
  store_purchase:           (c, n)    => runStorePurchase(c, n),
  legion_storebuygoods:     (c, n)    => runLegionStoreBuyGoods(c, n),
  batchmengjing:            (c, n, s) => runBatchMengjing(c, n, s.commandDelay),
  batchStudy:               (c, n)    => runBatchStudy(c, n),
  batchClaimPeachTasks:     (c, n, s) => runClaimPeachTasks(c, n, s.commandDelay),
  // ── 战斗类（battleDelay）──
  batcharenafight:          (c, n, s) => runArenaFight(c, n, s, s.battleDelay || s.commandDelay),
  climbTower:               (c, n, s) => runClimbTower(c, n, s, s.battleDelay || s.commandDelay),
  climbWeirdTower:          (c, n, s) => runClimbWeirdTower(c, n, s, s.battleDelay || s.commandDelay),
  batchbaoku13:             (c, n, s) => runBaoku13(c, n, s.battleDelay || s.commandDelay),
  batchbaoku45:             (c, n, s) => runBaoku45(c, n, s.battleDelay || s.commandDelay),
  skinChallenge:            (c, n, s) => runSkinChallenge(c, n, s.battleDelay || s.commandDelay),
  batchTopUpArena:          (c, n, s) => runTopUpArena(c, n, s, s.battleDelay || s.commandDelay),
  // ── 操作类（actionDelay）──
  batchOpenBox:             (c, n, s) => runBatchOpenBox(c, n, s, s.actionDelay || s.commandDelay),
  batchOpenBoxByPoints:     (c, n, s) => runBatchOpenBoxByPoints(c, n, s, s.actionDelay || s.commandDelay),
  batchClaimBoxPointReward: (c, n)    => runBatchClaimBoxPointReward(c, n),
  batchFish:                (c, n, s) => runBatchFish(c, n, s, s.actionDelay || s.commandDelay),
  batchRecruit:             (c, n, s) => runBatchRecruit(c, n, s, s.actionDelay || s.commandDelay),
  batchUseItems:            (c, n, s) => runUseItems(c, n, s.actionDelay || s.commandDelay),
  batchMergeItems:          (c, n, s) => runMergeItems(c, n, s.actionDelay || s.commandDelay),
  batchClaimFreeEnergy:     (c, n)    => runClaimFreeEnergy(c, n),
  // ── 刷新类（refreshDelay）──
  batchSmartSendCar:        (c, n, s) => runSmartSendCar(c, n, s, s.refreshDelay || s.commandDelay),
  batchDirectSendCar:       (c, n, s) => runDirectSendCar(c, n, s.commandDelay),
  batchClaimCars:           (c, n, s) => runClaimCars(c, n, s.commandDelay),
  batchGenieSweep:          (c, n, s) => runGenieSweep(c, n, s.refreshDelay || s.commandDelay),
  batchTopUpFish:           (c, n, s) => runTopUpFish(c, n, s.commandDelay),
  // ── 长延迟（longDelay）──
  batchBuyDreamItems:       (c, n, s) => runBuyDreamItems(c, n, s, s.longDelay || s.commandDelay),
  batchLegacyGiftSendEnhanced: (c, n, s) => runBatchLegacyGiftSend(c, n, s, s.longDelay || s.commandDelay),
  // ── 工具 ──
  batchHeroLevelUpgrade:    (c, n, s) => runHeroLevelUpgrade(c, n, s.heroId, s.targetLevel, s.commandDelay),
};

// ============================================================
// 主流程
// ============================================================

async function main() {
  // 从 stdin 读取任务 JSON
  let taskJson = '';
  for await (const chunk of process.stdin) taskJson += chunk;

  let task;
  try {
    task = JSON.parse(taskJson.trim());
  } catch (e) {
    console.error('任务 JSON 解析失败:', e.message);
    process.exit(1);
  }

  const { name: taskName, selectedTokens = [], selectedTasks = [], batchSettings = {}, tokenSettings = {} } = task;
  const taskDelay = batchSettings.taskDelay ?? batchSettings.commandDelay ?? 500;
  const tokens = loadTokens();

  if (Object.keys(tokens).length === 0) {
    log(taskName, `⚠️  tokens.json 为空或不存在 (路径: ${TOKENS_FILE})，请确认前端已同步 Token`, 'error');
    process.exit(1);
  }

  log('scheduler', `=== 开始执行定时任务: ${taskName} ===`);

  for (const tokenId of selectedTokens) {
    const tokenData = tokens[tokenId];
    if (!tokenData) {
      log(taskName, `找不到 token: ${tokenId}`, 'error');
      continue;
    }

    const tokenName = tokenData.name || tokenId;
    const tokenStr = tokenData.token;
    if (!tokenStr) {
      log(taskName, `${tokenName} token 字符串为空`, 'error');
      continue;
    }

    // 合并 per-token 设置到 batchSettings（Token级别配置优先级高于全局配置）
    const perTokenSettings = tokenSettings[tokenId] || {};
    const mergedSettings = { ...batchSettings };
    // per-token 设置覆盖全局设置
    // 1. 阵容配置
    if (perTokenSettings.arenaFormation != null) mergedSettings.arenaFormation = perTokenSettings.arenaFormation;
    if (perTokenSettings.towerFormation != null) mergedSettings.towerFormation = perTokenSettings.towerFormation;
    if (perTokenSettings.bossFormation != null) mergedSettings.bossFormation = perTokenSettings.bossFormation;
    // 2. 任务次数/数量配置
    if (perTokenSettings.bossTimes != null) mergedSettings.bossTimes = perTokenSettings.bossTimes;
    if (perTokenSettings.boxCount != null) mergedSettings.boxCount = perTokenSettings.boxCount;
    if (perTokenSettings.fishCount != null) mergedSettings.fishCount = perTokenSettings.fishCount;
    if (perTokenSettings.recruitCount != null) mergedSettings.recruitCount = perTokenSettings.recruitCount;
    // 3. 功能开关配置
    if (perTokenSettings.payRecruit != null) mergedSettings.payRecruit = perTokenSettings.payRecruit;
    if (perTokenSettings.claimBottle != null) mergedSettings.claimBottle = perTokenSettings.claimBottle;
    if (perTokenSettings.claimHangUp != null) mergedSettings.claimHangUp = perTokenSettings.claimHangUp;
    if (perTokenSettings.arenaEnable != null) mergedSettings.arenaEnable = perTokenSettings.arenaEnable;
    if (perTokenSettings.openBox != null) mergedSettings.openBox = perTokenSettings.openBox;
    if (perTokenSettings.claimEmail != null) mergedSettings.claimEmail = perTokenSettings.claimEmail;
    if (perTokenSettings.blackMarketPurchase != null) mergedSettings.blackMarketPurchase = perTokenSettings.blackMarketPurchase;
    if (perTokenSettings.freeGachaEnable != null) mergedSettings.freeGachaEnable = perTokenSettings.freeGachaEnable;

    const client = new GameClient({
      log: (msg, level) => log(tokenName, msg, level),
    });

    try {
      // bin 导入的 token 含过期 session，连接前先刷新
      let activeToken = await buildFreshActiveToken(tokenData, tokenId, tokenName, tokenStr);
      const getFreshActiveToken = async () => {
        activeToken = await buildFreshActiveToken(tokenData, tokenId, tokenName, activeToken);
        return activeToken;
      };

      await client.connect(activeToken);
      log(tokenName, '连接成功');

      // 全局包一层：所有 sendWithPromise 都具备“自动重连 + 重试”能力
      applyResilientSendWrapper(client, tokenName, getFreshActiveToken, 3);

      // 在每个任务开始前检查连接（sendWithPromise 内也有二次兜底）
      let checkedTasksCount = 0;
      for (const taskType of selectedTasks) {
        const runner = TASK_RUNNERS[taskType];
        if (!runner) {
          log(tokenName, `不支持的任务类型: ${taskType}（需在 run_task.js 中补充）`, 'warning');
          continue;
        }
        
        const connected = await ensureConnected(client, tokenName, getFreshActiveToken, 3);
        if (!connected) {
          log(taskName, `[${taskType}] 跳过：连接失败`, 'error');
          checkedTasksCount++;
          continue;
        }
        checkedTasksCount++;
        
        log(tokenName, `执行任务: ${taskType}`);
        await runner(client, tokenName, mergedSettings);
        await sleep(taskDelay);  // 使用 taskDelay 作为任务间延迟
      }
    } catch (err) {
      log(tokenName, `执行失败: ${err.message}`, 'error');
    } finally {
      client.disconnect();
      // ✅ 顺序执行：每个token完成后等待 2 秒，再执行下一个token
      // 这样可以避免同时大量连接导致被游戏服务器重置
      await sleep(2000);
    }
  }

  log('scheduler', `=== 定时任务 ${taskName} 执行完毕 ===`);
}

main().catch(err => {
  console.error('run_task.js 异常:', err);
  process.exit(1);
});
