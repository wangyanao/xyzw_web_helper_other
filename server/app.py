"""
xyzw-web-helper 后端服务
用途：保存微信扫码/bin导入产生的 bin 文件到服务器，供随时恢复使用
"""

import os
import re
import json
import uuid
import hmac
import hashlib
import subprocess
import threading
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo
from functools import wraps
from flask import Flask, request, jsonify, send_from_directory
from flask_cors import CORS
from apscheduler.schedulers.background import BackgroundScheduler
from apscheduler.triggers.cron import CronTrigger
from apscheduler.events import EVENT_JOB_ERROR, EVENT_JOB_EXECUTED, EVENT_JOB_MISSED

TZ_SHANGHAI = ZoneInfo('Asia/Shanghai')

def now_shanghai():
    """返回上海时区的当前时间"""
    return datetime.now(TZ_SHANGHAI)

app = Flask(__name__)

def _parse_cors_origins() -> list:
    """从环境变量读取 CORS 白名单，返回去重后的 origin 列表。"""
    default_origins = [
        'https://wangyanao.top:30001',
        'https://wangyanao.top',
        'http://localhost:3000',
        'http://127.0.0.1:3000',
        'http://localhost:5173',
        'http://127.0.0.1:5173',
    ]
    raw = os.environ.get('CORS_ALLOWED_ORIGINS', ','.join(default_origins))
    origins = [item.strip() for item in raw.split(',') if item.strip()]
    # 保持顺序去重，避免重复配置
    return list(dict.fromkeys(origins))


CORS(
    app,
    resources={
        r'/api/*': {
            'origins': _parse_cors_origins(),
            'supports_credentials': True,
            'allow_headers': ['Content-Type', 'X-Session-Token', 'X-Upload-Secret'],
            'methods': ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
        }
    },
)

# ===== 存储目录 =====
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
BIN_DIR = os.path.join(BASE_DIR, 'bin')
DATA_DIR = os.path.join(BASE_DIR, 'data')
TASKS_FILE = os.path.join(DATA_DIR, 'tasks.json')
TOKENS_FILE = os.path.join(DATA_DIR, 'tokens.json')
LINEUPS_FILE = os.path.join(DATA_DIR, 'lineups.json')
USERS_FILE = os.path.join(DATA_DIR, 'users.json')
BIN_MAP_FILE = os.path.join(DATA_DIR, 'bin_map.json')  # filename → tokenId (MD5)
RUN_TASK_JS = os.path.join(BASE_DIR, 'run_task.js')
os.makedirs(BIN_DIR, exist_ok=True)
os.makedirs(DATA_DIR, exist_ok=True)

# ===== 配置 =====
UPLOAD_SECRET = os.environ.get('UPLOAD_SECRET', '')
# JWT 签名密钥（可通过环境变量覆盖）
JWT_SECRET = os.environ.get('JWT_SECRET', 'xyzw_jwt_secret_change_me_in_prod')
# session token 过期时间（秒），默认 24 小时
SESSION_TTL = int(os.environ.get('SESSION_TTL', 86400))

# ===== 内存 session 存储（tokenId -> {userId, role, exp}）=====
_sessions: dict = {}

# ===== 文件操作锁（防止并发读写导致 JSON 损坏）=====
_users_lock = threading.Lock()
_tokens_lock = threading.Lock()
_tasks_lock = threading.Lock()
_bin_map_lock = threading.Lock()
_lineups_lock = threading.Lock()


# ===== 用户数据持久化 =====

DEFAULT_ADMIN_PASSWORD_HASH = hashlib.sha256(b'xyzw@2024').hexdigest()

def load_users() -> dict:
    """从 users.json 读取用户数据，不存在则返回默认管理员（不覆盖写入）"""
    with _users_lock:
        try:
            if os.path.isfile(USERS_FILE):
                with open(USERS_FILE, 'r', encoding='utf-8') as f:
                    data = json.load(f)
                    if isinstance(data, dict) and data:
                        return data
        except Exception as e:
            print(f'[users] 读取 users.json 失败: {e}，返回内存默认值（不覆盖文件）')
            return {
                'admin': {
                    'id': 'admin',
                    'username': 'admin',
                    'passwordHash': DEFAULT_ADMIN_PASSWORD_HASH,
                    'role': 'admin',
                    'assignedTokenIds': [],
                    'createdAt': now_shanghai().isoformat(),
                }
            }
        # 文件不存在或为空，初始化并写入
        default = {
            'admin': {
                'id': 'admin',
                'username': 'admin',
                'passwordHash': DEFAULT_ADMIN_PASSWORD_HASH,
                'role': 'admin',
                'assignedTokenIds': [],
                'createdAt': now_shanghai().isoformat(),
            }
        }
        _save_users_unsafe(default)
        return default


def _save_users_unsafe(users: dict):
    """写入 users.json（调用方须已持有 _users_lock）"""
    tmp = USERS_FILE + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(users, f, ensure_ascii=False, indent=2)
    os.replace(tmp, USERS_FILE)  # 原子替换，防止截断


def save_users(users: dict):
    with _users_lock:
        _save_users_unsafe(users)


def load_bin_map() -> dict:
    """filename -> tokenId (MD5) 映射"""
    with _bin_map_lock:
        try:
            if os.path.isfile(BIN_MAP_FILE):
                with open(BIN_MAP_FILE, 'r', encoding='utf-8') as f:
                    return json.load(f)
        except Exception:
            pass
        return {}


def save_bin_map(m: dict):
    with _bin_map_lock:
        tmp = BIN_MAP_FILE + '.tmp'
        with open(tmp, 'w', encoding='utf-8') as f:
            json.dump(m, f, ensure_ascii=False, indent=2)
        os.replace(tmp, BIN_MAP_FILE)


# ===== Session 工具 =====

def _make_session_token(user_id: str, role: str) -> str:
    token = str(uuid.uuid4())
    _sessions[token] = {
        'userId': user_id,
        'role': role,
        'exp': now_shanghai() + timedelta(seconds=SESSION_TTL),
    }
    return token


def _get_session(token: str) -> dict:
    s = _sessions.get(token)
    if not s:
        return None
    if now_shanghai() > s['exp']:
        del _sessions[token]
        return None
    return s


def require_auth(f):
    """装饰器：需要登录才能访问"""
    @wraps(f)
    def wrapper(*args, **kwargs):
        token = request.headers.get('X-Session-Token', '')
        session = _get_session(token)
        if not session:
            return jsonify({'error': '未登录或session已过期'}), 401
        request.session = session
        return f(*args, **kwargs)
    return wrapper


def require_admin(f):
    """装饰器：需要管理员权限"""
    @wraps(f)
    def wrapper(*args, **kwargs):
        token = request.headers.get('X-Session-Token', '')
        session = _get_session(token)
        if not session:
            return jsonify({'error': '未登录或session已过期'}), 401
        if session.get('role') != 'admin':
            return jsonify({'error': '无管理员权限'}), 403
        request.session = session
        return f(*args, **kwargs)
    return wrapper


# ===== 用户管理 API =====

@app.route('/api/users/login', methods=['POST'])
def user_login():
    """登录接口"""
    body = request.get_json(silent=True) or {}
    username = (body.get('username') or '').strip().lower()
    password_hash = (body.get('passwordHash') or '').strip().lower()  # 前端已做 SHA-256

    if not username or not password_hash:
        return jsonify({'error': '用户名或密码不能为空'}), 400

    users = load_users()
    user = next((u for u in users.values() if u['username'].lower() == username), None)
    if not user:
        return jsonify({'error': '用户名不存在'}), 404
    if user['passwordHash'] != password_hash:
        return jsonify({'error': '密码错误'}), 401

    token = _make_session_token(user['id'], user['role'])
    return jsonify({
        'token': token,
        'user': {
            'id': user['id'],
            'username': user['username'],
            'role': user['role'],
        }
    })


@app.route('/api/users/logout', methods=['POST'])
def user_logout():
    token = request.headers.get('X-Session-Token', '')
    if token in _sessions:
        del _sessions[token]
    return jsonify({'success': True})


@app.route('/api/users/me', methods=['GET'])
@require_auth
def get_me():
    """获取当前登录用户信息（含分配的 tokenIds）"""
    users = load_users()
    user = users.get(request.session['userId'])
    if not user:
        return jsonify({'error': '用户不存在'}), 404
    return jsonify({
        'id': user['id'],
        'username': user['username'],
        'role': user['role'],
        'assignedTokenIds': user.get('assignedTokenIds', []),
    })


@app.route('/api/users', methods=['GET'])
@require_admin
def list_users():
    """管理员：获取所有用户列表（不含密码哈希）"""
    users = load_users()
    result = [
        {
            'id': u['id'],
            'username': u['username'],
            'role': u['role'],
            'assignedTokenIds': u.get('assignedTokenIds', []),
            'createdAt': u.get('createdAt', ''),
        }
        for u in users.values()
    ]
    return jsonify(result)


@app.route('/api/users', methods=['POST'])
@require_admin
def create_user():
    """管理员：创建新用户"""
    body = request.get_json(silent=True) or {}
    username = (body.get('username') or '').strip()
    password_hash = (body.get('passwordHash') or '').strip().lower()
    role = body.get('role', 'user')

    if not username or not password_hash:
        return jsonify({'error': '用户名和密码不能为空'}), 400
    if role not in ('admin', 'user'):
        return jsonify({'error': '角色无效'}), 400

    users = load_users()
    if any(u['username'].lower() == username.lower() for u in users.values()):
        return jsonify({'error': '用户名已存在'}), 409

    new_id = f'user_{uuid.uuid4().hex[:8]}'
    users[new_id] = {
        'id': new_id,
        'username': username,
        'passwordHash': password_hash,
        'role': role,
        'assignedTokenIds': [],
        'createdAt': now_shanghai().isoformat(),
    }
    save_users(users)
    return jsonify({'success': True, 'id': new_id}), 201


@app.route('/api/users/<user_id>', methods=['DELETE'])
@require_admin
def delete_user(user_id):
    """管理员：删除用户（不能删除内置 admin）"""
    if user_id == 'admin':
        return jsonify({'error': '不能删除内置管理员账号'}), 400
    users = load_users()
    if user_id not in users:
        return jsonify({'error': '用户不存在'}), 404
    del users[user_id]
    save_users(users)
    return jsonify({'success': True})


@app.route('/api/users/<user_id>/password', methods=['PUT'])
@require_auth
def change_password(user_id):
    """修改密码：admin 可改任意人，普通用户只能改自己"""
    session = request.session
    if session['role'] != 'admin' and session['userId'] != user_id:
        return jsonify({'error': '无权限修改该用户密码'}), 403

    body = request.get_json(silent=True) or {}
    new_hash = (body.get('passwordHash') or '').strip().lower()
    if not new_hash:
        return jsonify({'error': '密码不能为空'}), 400

    users = load_users()
    if user_id not in users:
        return jsonify({'error': '用户不存在'}), 404

    users[user_id]['passwordHash'] = new_hash
    save_users(users)
    return jsonify({'success': True})


@app.route('/api/users/<user_id>/tokens', methods=['PUT'])
@require_auth
def assign_tokens(user_id):
    """分配 token 可见性：admin 可修改任意用户，普通用户只能给自己追加"""
    session = request.session
    is_admin = session.get('role') == 'admin'
    is_self = session.get('userId') == user_id

    if not is_admin and not is_self:
        return jsonify({'error': '无权限修改其他用户的 token 分配'}), 403

    users = load_users()
    if user_id not in users:
        return jsonify({'error': '用户不存在'}), 404

    body = request.get_json(silent=True) or {}
    token_ids = body.get('tokenIds', [])
    if not isinstance(token_ids, list):
        return jsonify({'error': 'tokenIds 必须是数组'}), 400

    if is_admin:
        # 管理员可以任意覆盖
        users[user_id]['assignedTokenIds'] = list(set(token_ids))
    else:
        # 普通用户只能追加（不能删除他人分配给自己的）
        existing = set(users[user_id].get('assignedTokenIds', []))
        users[user_id]['assignedTokenIds'] = list(existing | set(token_ids))

    save_users(users)
    return jsonify({'success': True})


# ===== APScheduler =====
scheduler = BackgroundScheduler(
    timezone='Asia/Shanghai',
    job_defaults={
        'misfire_grace_time': 3600,  # 允许最多1小时内补发（防容器重启/延迟导致错过）
        'coalesce': True,            # 错过多次只补发一次
    }
)

def _job_event_listener(event):
    if hasattr(event, 'exception') and event.exception:
        print(f'[scheduler] ❌ 任务执行出错: {event.job_id} → {event.exception}', flush=True)
    elif hasattr(event, 'scheduled_run_time'):
        # MISSED event
        print(f'[scheduler] ⚠️  任务错过执行: {event.job_id}, 计划时间: {event.scheduled_run_time}', flush=True)

scheduler.add_listener(_job_event_listener, EVENT_JOB_ERROR | EVENT_JOB_MISSED)


def check_secret():
    """验证请求头中的 X-Upload-Secret，为空时跳过验证"""
    if not UPLOAD_SECRET:
        return True
    return request.headers.get('X-Upload-Secret', '') == UPLOAD_SECRET


def safe_filename(filename: str) -> str:
    """防路径穿越，同时保留 Unicode（中文）字符"""
    # 只取文件名部分，去掉任何路径前缀
    filename = os.path.basename(filename)
    # 禁止 '..' 序列
    filename = filename.replace('..', '')
    # 只保留：Unicode 字母/数字、中文、连字符、下划线、点
    filename = re.sub(r'[^\w\u4e00-\u9fff\-.]', '_', filename)
    return filename.strip('._') or 'unnamed.bin'


# ===== 路由 =====

@app.route('/api/bin/upload', methods=['POST'])
def upload_bin():
    """
    接收前端上传的 bin 文件，保存到服务器
    Query: filename=xxx.bin
    Body: 二进制数据
    Header: X-Upload-Secret: <secret>（环境变量 UPLOAD_SECRET 不为空时必须提供）
    """
    if not check_secret():
        return jsonify({'error': '上传密钥错误'}), 403

    filename = request.args.get('filename', '').strip()
    if not filename:
        return jsonify({'error': '缺少 filename 参数'}), 400

    # 安全文件名，强制 .bin 后缀
    safe_name = safe_filename(filename)
    if not safe_name:
        return jsonify({'error': '非法文件名'}), 400
    if not safe_name.endswith('.bin'):
        safe_name += '.bin'

    data = request.get_data()
    if not data:
        return jsonify({'error': '请求体为空'}), 400

    filepath = os.path.join(BIN_DIR, safe_name)
    with open(filepath, 'wb') as f:
        f.write(data)

    # 记录 filename → tokenId (MD5) 映射，供 list 过滤使用
    token_id = hashlib.md5(data).hexdigest()
    bin_map = load_bin_map()
    bin_map[safe_name] = token_id
    save_bin_map(bin_map)

    size = len(data)
    print(f'[bin] 已保存: {safe_name} ({size} bytes) tokenId={token_id}')
    return jsonify({'success': True, 'filename': safe_name, 'size': size})


@app.route('/api/bin/list', methods=['GET'])
def list_bins():
    """列出 bin 文件。admin 返回全部，普通用户只返回 assignedTokenIds 对应的文件"""
    if not check_secret():
        return jsonify({'error': '密钥错误'}), 403

    bin_map = load_bin_map()  # filename -> tokenId
    all_files = []
    for fname in sorted(os.listdir(BIN_DIR)):
        if not fname.endswith('.bin'):
            continue
        fpath = os.path.join(BIN_DIR, fname)
        stat = os.stat(fpath)
        all_files.append({
            'name': fname,
            'size': stat.st_size,
            'mtime': int(stat.st_mtime),
            'tokenId': bin_map.get(fname, ''),
        })

    # 尝试从 session 判断角色，普通用户按 assignedTokenIds 过滤
    session_token = request.headers.get('X-Session-Token', '')
    session = _get_session(session_token) if session_token else None
    if session and session.get('role') != 'admin':
        users = load_users()
        user = users.get(session['userId'])
        assigned = set(user.get('assignedTokenIds', [])) if user else set()
        all_files = [f for f in all_files if bin_map.get(f['name']) in assigned]

    return jsonify({'files': all_files})


@app.route('/api/bin/download/<filename>', methods=['GET'])
def download_bin(filename):
    """下载指定 bin 文件"""
    if not check_secret():
        return jsonify({'error': '密钥错误'}), 403

    safe_name = safe_filename(filename)
    filepath = os.path.join(BIN_DIR, safe_name)
    if not os.path.isfile(filepath):
        return jsonify({'error': '文件不存在'}), 404

    return send_from_directory(BIN_DIR, safe_name, as_attachment=True)


@app.route('/api/bin/delete/<filename>', methods=['DELETE'])
def delete_bin(filename):
    """删除指定 bin 文件，同时清理 bin_map.json 中的记录"""
    if not check_secret():
        return jsonify({'error': '密钥错误'}), 403

    safe_name = safe_filename(filename)
    filepath = os.path.join(BIN_DIR, safe_name)
    if not os.path.isfile(filepath):
        return jsonify({'error': '文件不存在'}), 404

    os.remove(filepath)

    # 清理映射记录
    bin_map = load_bin_map()
    if safe_name in bin_map:
        del bin_map[safe_name]
        save_bin_map(bin_map)

    return jsonify({'success': True})


@app.route('/api/bin/health', methods=['GET'])
def health():
    """健康检查接口"""
    count = len([f for f in os.listdir(BIN_DIR) if f.endswith('.bin')])
    return jsonify({'status': 'ok', 'bin_count': count})


# ===== 定时任务工具函数 =====

def load_tasks():
    """从 tasks.json 读取任务列表"""
    try:
        with open(TASKS_FILE, 'r', encoding='utf-8') as f:
            return json.load(f)
    except Exception:
        return []


def save_tasks(tasks):
    """保存任务列表到 tasks.json（原子写入，带锁防并发覆盖）"""
    with _tasks_lock:
        tmp = TASKS_FILE + '.tmp'
        with open(tmp, 'w', encoding='utf-8') as f:
            json.dump(tasks, f, ensure_ascii=False, indent=2)
        os.replace(tmp, TASKS_FILE)


def load_tokens():
    """从 tokens.json 读取 token 映射"""
    with _tokens_lock:
        try:
            with open(TOKENS_FILE, 'r', encoding='utf-8') as f:
                return json.load(f)
        except Exception:
            return {}


def save_tokens(tokens):
    """保存 token 映射到 tokens.json（原子写入）"""
    with _tokens_lock:
        tmp = TOKENS_FILE + '.tmp'
        with open(tmp, 'w', encoding='utf-8') as f:
            json.dump(tokens, f, ensure_ascii=False, indent=2)
        os.replace(tmp, TOKENS_FILE)


def load_lineups():
    """从 lineups.json 读取按 tokenId 归档的阵容数据"""
    with _lineups_lock:
        try:
            with open(LINEUPS_FILE, 'r', encoding='utf-8') as f:
                data = json.load(f)
                return data if isinstance(data, dict) else {}
        except Exception:
            return {}


def save_lineups(lineups):
    """保存按 tokenId 归档的阵容数据（原子写入）"""
    with _lineups_lock:
        tmp = LINEUPS_FILE + '.tmp'
        with open(tmp, 'w', encoding='utf-8') as f:
            json.dump(lineups, f, ensure_ascii=False, indent=2)
        os.replace(tmp, LINEUPS_FILE)


def upsert_lineups_for_token(token_key, lineups):
    """在同一锁内完成读取-更新-写回，避免并发覆盖"""
    with _lineups_lock:
        data = {}
        try:
            if os.path.isfile(LINEUPS_FILE):
                with open(LINEUPS_FILE, 'r', encoding='utf-8') as f:
                    loaded = json.load(f)
                    if isinstance(loaded, dict):
                        data = loaded
        except Exception:
            data = {}

        data[str(token_key)] = lineups

        tmp = LINEUPS_FILE + '.tmp'
        with open(tmp, 'w', encoding='utf-8') as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        os.replace(tmp, LINEUPS_FILE)


def delete_lineups_for_token(token_key):
    """在同一锁内完成读取-删除-写回，避免并发覆盖"""
    with _lineups_lock:
        data = {}
        try:
            if os.path.isfile(LINEUPS_FILE):
                with open(LINEUPS_FILE, 'r', encoding='utf-8') as f:
                    loaded = json.load(f)
                    if isinstance(loaded, dict):
                        data = loaded
        except Exception:
            data = {}

        key = str(token_key)
        deleted = key in data
        if deleted:
            del data[key]
            tmp = LINEUPS_FILE + '.tmp'
            with open(tmp, 'w', encoding='utf-8') as f:
                json.dump(data, f, ensure_ascii=False, indent=2)
            os.replace(tmp, LINEUPS_FILE)

        return deleted


def _fire_task(task_id):
    """APScheduler 回调 —— 启动 Node.js 子进程执行任务"""
    tasks = load_tasks()
    task = next((t for t in tasks if t['id'] == task_id), None)
    if not task:
        print(f'[scheduler] 任务 {task_id} 不存在，跳过')
        return
    if not task.get('enabled', True):
        print(f'[scheduler] 任务 {task["name"]} 已禁用，跳过')
        return

    print(f'[scheduler] {now_shanghai().strftime("%Y-%m-%d %H:%M:%S")} 触发任务: {task["name"]}', flush=True)
    print(f'[scheduler] tokens 路径: {TOKENS_FILE}, tasks 路径: {TASKS_FILE}', flush=True)
    try:
        proc = subprocess.Popen(
            ['node', RUN_TASK_JS],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
        )
        task_json = json.dumps(task, ensure_ascii=False).encode('utf-8')
        stdout, _ = proc.communicate(input=task_json, timeout=1800)
        print(stdout.decode('utf-8', errors='replace'))
        print(f'[scheduler] 任务 {task["name"]} 执行完毕，退出码: {proc.returncode}')
    except subprocess.TimeoutExpired:
        proc.kill()
        print(f'[scheduler] 任务 {task["name"]} 超时（30分钟）已终止')
    except Exception as e:
        print(f'[scheduler] 任务 {task["name"]} 启动失败: {e}')


def _add_job(task):
    """将任务注册到 APScheduler"""
    task_id = task['id']
    job_id = f'task_{task_id}'

    # 先移除旧 job（若存在）
    if scheduler.get_job(job_id):
        scheduler.remove_job(job_id)

    if not task.get('enabled', True):
        return

    run_type = task.get('runType', 'daily')
    if run_type == 'daily':
        run_time = task.get('runTime', '08:00')
        h, m = run_time.split(':')
        scheduler.add_job(
            _fire_task,
            CronTrigger(hour=int(h), minute=int(m), timezone='Asia/Shanghai'),
            id=job_id,
            args=[task_id],
            replace_existing=True,
        )
    elif run_type == 'cron':
        cron_expr = task.get('cronExpression', '0 8 * * *')
        scheduler.add_job(
            _fire_task,
            CronTrigger.from_crontab(cron_expr, timezone='Asia/Shanghai'),
            id=job_id,
            args=[task_id],
            replace_existing=True,
        )
    print(f'[scheduler] 已注册任务: {task["name"]} ({run_type})', flush=True)


# ===== 定时任务 API =====

@app.route('/api/tasks', methods=['GET'])
@require_auth
def get_tasks():
    """获取所有定时任务"""
    return jsonify(load_tasks())


@app.route('/api/tasks/sync', methods=['POST'])
@require_admin
def sync_tasks():
    """
    前端同步全量任务列表到服务器
    Body: JSON 数组（所有定时任务）
    """
    data = request.get_json(silent=True)
    if not isinstance(data, list):
        return jsonify({'error': '请求体必须是 JSON 数组'}), 400

    save_tasks(data)

    # 重新注册所有 job
    for task in data:
        _add_job(task)

    # 移除已不存在的 job
    existing_ids = {f'task_{t["id"]}' for t in data}
    for job in scheduler.get_jobs():
        if job.id.startswith('task_') and job.id not in existing_ids:
            scheduler.remove_job(job.id)
            print(f'[scheduler] 已移除旧任务 job: {job.id}')

    return jsonify({'success': True, 'count': len(data)})


@app.route('/api/tasks/<task_id>', methods=['DELETE'])
@require_admin
def delete_task(task_id):
    """删除指定任务"""
    tasks = load_tasks()
    tasks = [t for t in tasks if t['id'] != task_id]
    save_tasks(tasks)

    job_id = f'task_{task_id}'
    if scheduler.get_job(job_id):
        scheduler.remove_job(job_id)

    return jsonify({'success': True})


@app.route('/api/tasks/<task_id>/trigger', methods=['POST'])
@require_admin
def trigger_task(task_id):
    """立即手动触发一次指定任务（测试用）"""
    tasks = load_tasks()
    task = next((t for t in tasks if t['id'] == task_id), None)
    if not task:
        return jsonify({'error': '任务不存在'}), 404

    import threading
    threading.Thread(target=_fire_task, args=(task_id,), daemon=True).start()
    return jsonify({'success': True, 'message': f'任务 {task["name"]} 已触发（后台执行）'})


@app.route('/api/token-settings/<token_id>', methods=['GET', 'PUT'])
@require_auth
def handle_token_settings(token_id):
    """获取/保存单个 Token 的 per-token 设置（跨浏览器持久化）"""
    if request.method == 'GET':
        tasks = load_tasks()
        for task in tasks:
            ts = task.get('tokenSettings', {}).get(token_id)
            if ts:
                return jsonify(ts)
        return jsonify({})

    # PUT: 保存设置到所有包含此 token 的任务
    data = request.get_json(silent=True)
    if not data or 'settings' not in data:
        return jsonify({'error': '缺少 settings 字段'}), 400

    settings = data['settings']
    tasks = load_tasks()
    updated = False
    for task in tasks:
        if token_id in task.get('selectedTokens', []):
            if 'tokenSettings' not in task:
                task['tokenSettings'] = {}
            task['tokenSettings'][token_id] = settings
            updated = True

    if not updated:
        return jsonify({'error': '未找到包含该 token 的定时任务'}), 404

    save_tasks(tasks)
    return jsonify({'success': True})


# ===== Token 同步 API =====

@app.route('/api/tokens/sync', methods=['POST'])
@require_auth
def sync_tokens():
    """
    前端同步 token 数据到服务器（供定时任务使用）
    采用合并模式：只新增/更新传入的 token，不删除已有 token。
    避免多浏览器/多用户场景下互相覆盖。
    Body: { tokenId: { id, name, token, server }, ... }
    """
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        return jsonify({'error': '请求体必须是 JSON 对象'}), 400

    # 只保存必要字段
    safe = {}
    for tid, tdata in data.items():
        safe[tid] = {
            'id':          tdata.get('id', tid),
            'name':        tdata.get('name', ''),
            'token':       tdata.get('token', ''),
            'server':      tdata.get('server', ''),
            'importMethod': tdata.get('importMethod', 'manual'),
        }

    if not safe:
        return jsonify({'success': True, 'count': 0})

    # 合并模式：读取已有 token，用传入数据更新/新增，保留未传入的 token
    existing = load_tokens()
    existing.update(safe)
    save_tokens(existing)

    return jsonify({'success': True, 'count': len(safe)})


@app.route('/api/tokens/<token_id>', methods=['DELETE'])
@require_auth
def delete_token(token_id):
    """从服务端 tokens.json 中删除指定 token"""
    tokens = load_tokens()
    if token_id not in tokens:
        return jsonify({'success': True, 'deleted': False})
    del tokens[token_id]
    save_tokens(tokens)
    return jsonify({'success': True, 'deleted': True})


@app.route('/api/tokens', methods=['GET'])
@require_auth
def get_tokens():
    """返回已存储的 token 列表（脱敏，不返回 token 字段）"""
    tokens = load_tokens()
    result = [
        {'id': v['id'], 'name': v['name'], 'server': v['server']}
        for v in tokens.values()
    ]
    return jsonify(result)


@app.route('/api/tokens/full', methods=['GET'])
@require_auth
def get_full_tokens_for_current_user():
    """按当前登录用户返回可见 token 全量信息（含 token 字段）"""
    tokens = load_tokens()
    session = request.session

    if session.get('role') == 'admin':
        return jsonify({
            'success': True,
            'tokens': list(tokens.values()),
            'scope': 'admin_all',
        })

    users = load_users()
    me = users.get(session.get('userId')) or {}
    assigned_ids = set(me.get('assignedTokenIds', []) if isinstance(me.get('assignedTokenIds', []), list) else [])

    visible = [
        t for tid, t in tokens.items()
        if tid in assigned_ids
    ]

    return jsonify({
        'success': True,
        'tokens': visible,
        'scope': 'user_assigned',
    })


@app.route('/api/lineups/<token_id>', methods=['GET'])
@require_auth
def get_lineups(token_id):
    """按 tokenId 或 roleId 获取已保存阵容"""
    if not token_id:
        return jsonify({'error': 'token_id 不能为空'}), 400

    all_lineups = load_lineups()
    token_key = str(token_id)

    # 首先尝试用 token_id 作为 key 直接查询
    lineups = all_lineups.get(token_key, [])
    if not isinstance(lineups, list):
        lineups = []

    # 如果 token_id 查询有结果，直接返回
    if lineups:
        return jsonify({'success': True, 'tokenId': token_key, 'lineups': lineups})

    # 如果没找到，尝试用 roleId 查询（从请求参数中获取）
    role_id_str = request.args.get('roleId')
    if role_id_str:
        try:
            role_id = int(role_id_str)
            tokens = load_tokens()
            for tid, tdata in tokens.items():
                token_role_id = None
                try:
                    raw_token = tdata.get('token')
                    if isinstance(raw_token, str) and raw_token.startswith('{'):
                        token_obj = json.loads(raw_token)
                        token_role_id = token_obj.get('roleId')
                except Exception:
                    token_role_id = None

                if token_role_id is None:
                    try:
                        token_role_id = int(tdata.get('roleId')) if tdata.get('roleId') is not None else None
                    except Exception:
                        token_role_id = None

                # 仅在 roleId 精确匹配时返回，避免串号
                if token_role_id == role_id:
                    lineups = all_lineups.get(str(tid), [])
                    if lineups and isinstance(lineups, list):
                        return jsonify({
                            'success': True,
                            'tokenId': str(tid),
                            'lineups': lineups,
                            'source': 'roleId_match'
                        })
        except (ValueError, TypeError):
            pass

    return jsonify({'success': True, 'tokenId': token_key, 'lineups': []})


@app.route('/api/lineups/<token_id>', methods=['PUT'])
@require_auth
def put_lineups(token_id):
    """按 tokenId 全量覆盖保存阵容"""
    if not token_id:
        return jsonify({'error': 'token_id 不能为空'}), 400

    body = request.get_json(silent=True) or {}
    lineups = body.get('lineups')
    if not isinstance(lineups, list):
        return jsonify({'error': 'lineups 必须是数组'}), 400

    token_key = str(token_id)

    # 归属校验：拒绝跨 token 写入，防止污染数据再次入库。
    normalized_lineups = []
    for idx, lineup in enumerate(lineups):
        if not isinstance(lineup, dict):
            return jsonify({'error': f'lineups[{idx}] 必须是对象'}), 400

        owner_token_id = lineup.get('ownerTokenId')
        if owner_token_id is not None and str(owner_token_id) != token_key:
            return jsonify({
                'error': f'lineups[{idx}].ownerTokenId 与请求 token_id 不一致',
                'tokenId': token_key,
                'ownerTokenId': str(owner_token_id),
            }), 400

        item = dict(lineup)
        item['ownerTokenId'] = token_key
        normalized_lineups.append(item)

    upsert_lineups_for_token(token_key, normalized_lineups)

    return jsonify({'success': True, 'tokenId': token_key, 'count': len(normalized_lineups)})


@app.route('/api/lineups/<token_id>', methods=['DELETE'])
@require_auth
def delete_lineups(token_id):
    """按 tokenId 删除已保存阵容"""
    if not token_id:
        return jsonify({'error': 'token_id 不能为空'}), 400

    token_key = str(token_id)
    deleted = delete_lineups_for_token(token_key)

    return jsonify({'success': True, 'tokenId': token_key, 'deleted': deleted})


@app.route('/api/scheduler/jobs', methods=['GET'])
@require_admin
def list_scheduler_jobs():
    """查看 APScheduler 当前注册的所有 job"""
    jobs = []
    for job in scheduler.get_jobs():
        jobs.append({
            'id': job.id,
            'name': job.name,
            'next_run': str(job.next_run_time) if job.next_run_time else None,
        })
    return jsonify({'running': scheduler.running, 'jobs': jobs})


# ===== 启动时加载任务 =====
def _load_and_schedule_all():
    """从 tasks.json 加载任务并注册到 APScheduler"""
    tasks = load_tasks()
    for task in tasks:
        try:
            _add_job(task)
        except Exception as e:
            print(f'[scheduler] 加载任务 {task.get("name")} 失败: {e}')
    print(f'[scheduler] 已加载 {len(tasks)} 个定时任务')


_scheduler_bootstrapped = False


def _bootstrap_scheduler_once():
    """确保调度器只启动一次"""
    global _scheduler_bootstrapped
    if _scheduler_bootstrapped:
        return
    _load_and_schedule_all()
    scheduler.start()
    _scheduler_bootstrapped = True
    print(f'[scheduler] APScheduler 已启动', flush=True)


if __name__ == '__main__':
    port = int(os.environ.get('PORT', 5001))
    print(f'[xyzw-bin-server] 启动在 http://0.0.0.0:{port}')
    print(f'[xyzw-bin-server] Bin 目录: {BIN_DIR}')
    if UPLOAD_SECRET:
        print(f'[xyzw-bin-server] 上传密钥已启用')
    else:
        print(f'[xyzw-bin-server] ⚠️  上传密钥未设置，任何人都可上传（建议设置 UPLOAD_SECRET 环境变量）')

    # 补全历史 bin 文件的 filename→tokenId 映射（新增字段前上传的文件）
    bin_map = load_bin_map()
    updated = False
    for fname in os.listdir(BIN_DIR):
        if not fname.endswith('.bin') or fname in bin_map:
            continue
        try:
            fpath = os.path.join(BIN_DIR, fname)
            with open(fpath, 'rb') as f:
                data = f.read()
            bin_map[fname] = hashlib.md5(data).hexdigest()
            updated = True
        except Exception as e:
            print(f'[bin_map] 补全失败: {fname} → {e}')
    if updated:
        save_bin_map(bin_map)
        print(f'[bin_map] 已补全 bin_map.json，共 {len(bin_map)} 条记录')

    # 启动定时任务调度器
    _bootstrap_scheduler_once()

    # 本地直接运行时仍保留 Flask 启动方式
    app.run(host='0.0.0.0', port=port, debug=False)
