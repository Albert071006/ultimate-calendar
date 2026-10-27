"""Private stdio reader. No GUI, network, send actions, or saved database keys."""
from __future__ import annotations
import argparse
import base64
import contextlib
import ctypes
import hashlib
import importlib.util
import io
import json
import logging
import os
from pathlib import Path
import re
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import time
import types
import xml.etree.ElementTree as ET

MAX_LINE = 16384
MAX_TEXT = 990000

class ReaderError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code

def encode_cursor(key):
    return base64.urlsafe_b64encode(json.dumps(list(key), separators=(',', ':')).encode()).decode()

def parse_cursor(value):
    if value is None:
        return None
    try:
        if not isinstance(value, str) or len(value) > 1000:
            raise ValueError()
        key = json.loads(base64.b64decode(value, altchars=b'-_', validate=True))
        if not isinstance(key, list) or len(key) != 3 or type(key[0]) is not int or type(key[2]) is not int or not isinstance(key[1], str) or len(key[1]) > 200:
            raise ValueError()
        return tuple(key)
    except (ValueError, TypeError, UnicodeError):
        raise ReaderError('VALIDATION', '微信历史游标无效') from None

def strict_rows(tables, cursor, limit, shard_label):
    """Bounded keyset pagination; never swallow a missing/unreadable shard."""
    rows = []
    for conn, table in tables:
        if not re.fullmatch(r'[A-Za-z0-9_]+', table):
            raise ReaderError('STORAGE', '微信消息表格式不支持')
        shard = shard_label(conn)
        where, params = '', []
        if cursor:
            seq, before_shard, local_id = cursor
            where = 'WHERE sort_seq < ? OR (sort_seq = ? AND (? < ? OR (? = ? AND local_id < ?)))'
            params = [seq, seq, shard, before_shard, shard, before_shard, local_id]
        rows.extend(conn.execute(
            'SELECT local_id,local_type,real_sender_id,create_time,message_content,source,packed_info_data,compress_content,server_id,sort_seq,? AS shard '
            f'FROM "{table}" {where} ORDER BY sort_seq DESC,local_id DESC LIMIT ?',
            [shard, *params, limit + 1]).fetchall())
    rows.sort(key=lambda row: (row['sort_seq'], row['shard'], row['local_id']), reverse=True)
    return rows[:limit], len(rows) > limit

def xml_root(value):
    if not isinstance(value, str) or len(value) > MAX_TEXT or '<!DOCTYPE' in value.upper() or '<!ENTITY' in value.upper():
        return None
    try:
        return ET.fromstring(value)
    except ET.ParseError:
        return None

def normalize_row(db, row, maps, group_id, names):
    message = db._msg_row_to_dict(row, maps)
    sender = message.get('sender_username') or ''
    raw_type = int(row['local_type']) & 0xFFFFFFFF
    content = message.get('content') or ''
    if not isinstance(content, str):
        content = '[暂不支持的消息]'
    # Cards and references may contain readable titles; media is never presented as decoded.
    if raw_type != 1:
        root = xml_root(content)
        if root is not None:
            titles = [root.findtext('.//appmsg/title'), root.findtext('.//appmsg/des')]
            content = '\n'.join(v for v in titles if v) or ''
        elif content.lstrip().startswith('<'):
            content = ''
        if raw_type in (3, 34, 43, 49) or not content:
            content = '\n'.join(filter(None, [content, f'[{message.get("type", "附件")}：当前只读采集未读取附件内容，请在微信查看]']))
    segments = [{'type': 'text', 'data': {'text': content[:MAX_TEXT]}}]
    source = row['source']
    if isinstance(source, bytes):
        source = source.decode('utf-8', errors='replace')
    root = xml_root(source)
    if root is not None:
        for wxid in (root.findtext('.//atuserlist') or '').split(',')[:100]:
            if re.fullmatch(r'[A-Za-z0-9_@.-]{1,180}', wxid):
                segments.append({'type': 'at', 'data': {'wechat': 'all' if wxid == 'notify@all' else 'wechat:' + wxid}})
    server_id = row['server_id']
    message_id = 's:' + str(server_id) if server_id and str(server_id) != '0' else 'l:' + hashlib.sha256(json.dumps([row['shard'], row['local_id'], row['create_time']], separators=(',', ':')).encode()).hexdigest()
    return {'message_type': 'group', 'group_id': group_id, 'message_id': message_id,
            'time': row['create_time'], 'user_id': 'wechat:' + sender if sender else '',
            'sender': {'nickname': names.get(sender, '')}, 'message': segments}

def load_vendor():
    # Deliberately skip upstream __init__, UIA, sending, media, and logger side effects.
    logger = types.ModuleType('wechatauto.logger')
    logger.wxlog = logging.getLogger('calendar-wechat')
    logger.wxlog.handlers = [logging.NullHandler()]
    logger.wxlog.propagate = False
    sys.modules['wechatauto.logger'] = logger
    spec = importlib.util.spec_from_file_location('calendar_wechat_db', Path(__file__).parent / 'vendor/db.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

def protect_directory(path):
    """Fail closed if the private cache cannot be limited to this Windows user."""
    path.mkdir(parents=True, exist_ok=True)
    if os.name != 'nt':
        raise ReaderError('UNSUPPORTED', '微信本机采集仅支持 Windows')
    result = subprocess.run(['whoami', '/user', '/fo', 'csv', '/nh'], capture_output=True, creationflags=subprocess.CREATE_NO_WINDOW)
    match = re.search(rb'S-1-5-[0-9-]+', result.stdout)
    if not match:
        raise ReaderError('PERMISSION', '无法保护微信本机缓存目录')
    sid = match.group().decode('ascii')
    result = subprocess.run(['icacls', str(path), '/inheritance:r', '/grant:r', f'*{sid}:(OI)(CI)F', '*S-1-5-18:(OI)(CI)F', '*S-1-5-32-544:(OI)(CI)F'], capture_output=True, creationflags=subprocess.CREATE_NO_WINDOW)
    if result.returncode:
        raise ReaderError('PERMISSION', '无法保护微信本机缓存目录')

class Reader:
    def __init__(self, workdir):
        self.module = load_vendor()
        protect_directory(Path(workdir))
        self.temp = tempfile.TemporaryDirectory(prefix='reader-', dir=workdir)
        self.db = None
        self.groups = {}
        self.names = {}
        self.validated_at = 0
        self.pids = ()

    def close(self):
        self.db = None
        self.temp.cleanup()

    def connect(self, account_id=None):
        if account_id is not None and (not isinstance(account_id, str) or not account_id.startswith('wechat:')):
            raise ReaderError('VALIDATION', '微信账号标识无效')
        accounts = self.module.list_accounts()
        if account_id:
            accounts = [a for a in accounts if 'wechat:' + a['wxid'] == account_id]
        if len(accounts) != 1:
            raise ReaderError('ACCOUNT_SELECTION_REQUIRED', '未找到唯一的微信账号；请仅保留要采集的账号登录后再连接')
        module = self.module
        class BoundDB(module.WeChatDB):
            # Keys stay in this process. Never read/write upstream global key caches.
            def _load_key_cache(self, path): return {}
            def _save_keys(self): pass
            def _stable_key_file(self, account=None): return None
            def _try_other_accounts(self): return False
            def _select_account_by_keys(self, candidates): return False
            def extract_master_key(self): return None
            def _open(self, rel):
                conn = super()._open(rel)
                stamp = Path(self.workdir) / (rel.replace(os.sep, '__') + '.stamp')
                try:
                    fields = stamp.read_text().split(',')
                    if len(fields) != 6 or int(fields[-1]) < 0:
                        stamp.unlink(missing_ok=True)
                        raise ReaderError('READ_PENDING', '微信正在保存新消息，稍后自动重试')
                except Exception:
                    conn.close()
                    raise
                return conn
            def _load_or_extract_keys(self, master_key=None):
                self._keys = self.extract_keys()
                if not self._keys or not any('contact' in rel and self._key_works(rel) for rel in self._keys):
                    raise ReaderError('NOT_LOGGED_IN', '无法读取该微信账号，请确认已登录且微信版本受支持')
        self.db = BoundDB(account=accounts[0]['account'], workdir=self.temp.name)
        self.pids = tuple(sorted(self.db._find_weixin_pids()))
        if not self.pids:
            raise ReaderError('NOT_LOGGED_IN', '请先登录电脑微信')
        self.validated_at = time.monotonic()
        self.refresh_groups()

    def verify(self, account_id=None):
        if self.db is None:
            self.connect(account_id)
        actual = 'wechat:' + self.db.wxid
        if account_id is not None and actual != account_id:
            raise ReaderError('ACCOUNT_CHANGED', '微信账号已改变，请重新确认账号和群选择')
        current_pids = tuple(sorted(self.db._find_weixin_pids()))
        if not current_pids or current_pids != self.pids:
            raise ReaderError('NOT_LOGGED_IN', '微信已退出或重新启动，请重新连接')
        if time.monotonic() - self.validated_at > 60:
            # Revalidate keys from live process, so a logged-out cached DB is not called online.
            keys = self.db.extract_keys()
            contacts = [rel for rel in keys if 'contact' in rel]
            if not contacts:
                raise ReaderError('ACCOUNT_CHANGED', '无法确认当前微信账号，请重新连接')
            self.db._keys = keys
            self.validated_at = time.monotonic()
        return actual

    def refresh_groups(self):
        conn = self.db._contact_conn()
        if conn is None:
            raise ReaderError('STORAGE', '无法读取微信群列表')
        try:
            self.names = {r['username']: (r['remark'] or r['nick_name'] or '') for r in conn.execute('SELECT username,remark,nick_name FROM contact')}
            self.groups = {r['username']: self.names.get(r['username'], '') or r['username'] for r in conn.execute('SELECT username FROM chat_room') if r['username'].endswith('@chatroom')}
        finally:
            conn.close()

    def handle(self, request):
        if not isinstance(request, dict) or set(request) - {'id', 'action', 'accountId', 'groupId', 'cursor', 'limit'}:
            raise ReaderError('VALIDATION', '微信采集请求格式无效')
        action = request.get('action')
        if action not in ('status', 'groups', 'history'):
            raise ReaderError('VALIDATION', '微信采集只允许查询状态、群列表和群历史')
        account_id = self.verify(request.get('accountId'))
        if action == 'status':
            return {'accountId': account_id, 'nickname': self.names.get(self.db.wxid, '') or '微信账号'}
        if action == 'groups':
            self.refresh_groups()
            return [{'id': key, 'name': value} for key, value in self.groups.items()]
        if request.get('accountId') != account_id:
            raise ReaderError('VALIDATION', '读取群消息前需要绑定微信账号')
        group = request.get('groupId')
        if not isinstance(group, str) or group not in self.groups:
            raise ReaderError('VALIDATION', '该群不属于已连接的微信账号')
        limit = request.get('limit', 100)
        if type(limit) is not int or not 1 <= limit <= 100:
            raise ReaderError('VALIDATION', '微信消息分页大小无效')
        cursor = parse_cursor(request.get('cursor'))
        def query(tables):
            rows, more = strict_rows(tables, cursor, limit, self.db._shard_label)
            maps = self.db._shard_maps(tables)
            messages = [normalize_row(self.db, row, maps, group, self.names) for row in rows]
            # Continue once after a nonempty final page; local exhaustion cannot prove cloud completeness.
            next_cursor = encode_cursor((rows[-1]['sort_seq'], rows[-1]['shard'], rows[-1]['local_id'])) if rows else None
            return {'messages': messages, 'nextCursor': next_cursor, 'complete': False}
        return self.db._run_msg_query(group, query) or {'messages': [], 'nextCursor': None, 'complete': False}

def main():
    sys.stdout.reconfigure(encoding='utf-8', errors='strict')
    parser = argparse.ArgumentParser()
    parser.add_argument('--workdir', required=True)
    args = parser.parse_args()
    reader = None
    try:
        reader = Reader(Path(args.workdir).resolve())
        while True:
            line = sys.stdin.buffer.readline(MAX_LINE + 1)
            if not line:
                break
            if len(line) > MAX_LINE:
                break
            request_id = None
            try:
                request = json.loads(line)
                request_id = request.get('id') if isinstance(request, dict) else None
                if not isinstance(request_id, (str, int)) or isinstance(request_id, bool):
                    raise ReaderError('VALIDATION', '缺少请求标识')
                with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                    data = reader.handle(request)
                response = {'id': request_id, 'ok': True, 'data': data}
            except ReaderError as error:
                response = {'id': request_id, 'ok': False, 'error': {'code': error.code, 'message': str(error)}}
            except Exception:
                response = {'id': request_id, 'ok': False, 'error': {'code': 'READ_FAILED', 'message': '微信本机读取失败，请检查登录状态或客户端兼容性'}}
            sys.stdout.write(json.dumps(response, ensure_ascii=False, separators=(',', ':')) + '\n')
            sys.stdout.flush()
    finally:
        if reader:
            reader.close()

if __name__ == '__main__':
    main()
