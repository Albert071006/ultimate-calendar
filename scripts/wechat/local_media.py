# SPDX-License-Identifier: Apache-2.0
"""Bounded, local-only WeChat media reader. See NOTICE.md for upstream attribution.

This module never fetches URLs, opens UI, writes process memory, or persists keys.
Only an already verified message row may be passed by worker.py.
"""
from __future__ import annotations
import ctypes
import hashlib
import os
from pathlib import Path
import re
import struct
import subprocess
import sys
import time
import uuid
import xml.etree.ElementTree as ET

MAX_BYTES = 25 * 1024 * 1024
V1_MAGIC = b'\x07\x08\x05\x56\x02\x05'
V2_MAGIC = b'\x07\x08\x56\x32\x08\x07'
HEX_MD5 = re.compile(r'^[a-fA-F0-9]{32}$')


class MediaError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def parse_xml(text):
    if not isinstance(text, str) or len(text) > 990000 or '<!DOCTYPE' in text.upper() or '<!ENTITY' in text.upper():
        return None
    candidate = text.strip()
    # Group messages can prepend sender identifiers or a short container prefix
    # to the complete <msg> document. The file kind still requires appmsg/type=6.
    # Refuse declarations/entities anywhere, including outside the extracted XML.
    start = re.search(r'<msg(?:\s[^<>]*|)>', candidate)
    end = candidate.rfind('</msg>')
    if start and start.start() <= 512 and end >= start.end():
        candidate = candidate[start.start():end + len('</msg>')]
    try:
        return ET.fromstring(candidate)
    except ET.ParseError:
        return None


def safe_name(value):
    if not isinstance(value, str):
        return None
    value = value.strip()
    if not value or len(value) > 200 or value in ('.', '..') or re.search(r'[\\/:*?"<>|\x00-\x1f\x7f]', value) or value.endswith(('.', ' ')):
        return None
    if re.fullmatch(r'(?i)(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?', value):
        return None
    return value


def attachment_description(local_type, content):
    raw_type = int(local_type) & 0xFFFFFFFF
    if raw_type == 3:
        return {'kind': 'image', 'name': '微信群图片.jpg', 'size': None}
    if raw_type != 49:
        return None
    root = parse_xml(content)
    if root is None or root.findtext('.//appmsg/type') != '6':
        return None
    name = safe_name(root.findtext('.//appmsg/title')) or '微信文件'
    total = root.findtext('.//appattach/totallen')
    size = int(total) if total and re.fullmatch(r'\d{1,12}', total) else None
    return {'kind': 'file', 'name': name, 'size': size}


def is_reparse(path):
    info = path.lstat()
    return path.is_symlink() or bool(getattr(info, 'st_file_attributes', 0) & 0x400)


def checked_path(root, path):
    """Reject traversal and every symlink/junction below the account/cache root."""
    root, path = Path(root).absolute(), Path(path).absolute()
    try:
        parts = path.relative_to(root).parts
    except ValueError:
        raise MediaError('PERMISSION', '附件路径不在受控目录内') from None
    if '..' in parts or is_reparse(root):
        raise MediaError('PERMISSION', '附件路径包含不允许的链接')
    current = root
    for part in parts:
        current /= part
        if is_reparse(current):
            raise MediaError('PERMISSION', '附件路径包含不允许的链接')
    if not path.resolve().is_relative_to(root.resolve()):
        raise MediaError('PERMISSION', '附件路径不在受控目录内')
    return path


def bounded_read(root, path, maximum=MAX_BYTES):
    path = checked_path(root, path)
    before = path.stat()
    if not path.is_file():
        raise MediaError('NOT_DOWNLOADED', '该附件尚未下载到电脑微信，请下载后重试')
    if before.st_size <= 0:
        raise MediaError('READ_PENDING', '微信附件仍在下载，请稍后重试')
    if before.st_size > maximum:
        raise MediaError('TOO_LARGE', '附件超过 25 MB 自动分析上限')
    with path.open('rb') as stream:
        data = stream.read(maximum + 1)
    after = checked_path(root, path).stat()
    if len(data) > maximum:
        raise MediaError('TOO_LARGE', '附件超过 25 MB 自动分析上限')
    if (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns) or len(data) != after.st_size:
        raise MediaError('READ_PENDING', '微信附件仍在下载，请稍后重试')
    return data


def image_magic(data):
    bmp = len(data) >= 14 and data[:2] == b'BM' and data[6:10] == b'\0' * 4 and 26 <= struct.unpack_from('<I', data, 2)[0] <= MAX_BYTES
    return bmp or data.startswith((b'\xff\xd8\xff', b'\x89PNG\r\n\x1a\n', b'GIF87a', b'GIF89a', b'wxgf')) or (data[:4] == b'RIFF' and data[8:12] == b'WEBP')


def complete_image(data):
    """Return (bytes, extension), refusing a truncated image or unknown container."""
    if data.startswith(b'\xff\xd8\xff'):
        end = data.rfind(b'\xff\xd9', max(0, len(data) - 34))
        if end >= 3:
            return data[:end + 2], 'jpg'
    elif data.startswith(b'\x89PNG\r\n\x1a\n'):
        marker = b'IEND\xaeB`\x82'
        end = data.rfind(marker, max(0, len(data) - 40))
        if end >= 8:
            return data[:end + len(marker)], 'png'
    elif data.startswith((b'GIF87a', b'GIF89a')) and data.endswith(b';'):
        return data, 'gif'
    elif data[:4] == b'RIFF' and data[8:12] == b'WEBP' and len(data) >= 12:
        size = struct.unpack_from('<I', data, 4)[0] + 8
        if 12 <= size <= len(data) and len(data) - size <= 32:
            return data[:size], 'webp'
    elif data.startswith(b'BM') and len(data) >= 26:
        size = struct.unpack_from('<I', data, 2)[0]
        if 26 <= size <= len(data) and len(data) - size <= 32:
            return data[:size], 'bmp'
    raise MediaError('READ_FAILED', '图片内容不完整或格式暂不支持，请在微信查看后重试')


def aes_decrypt(data, key):
    from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
    decryptor = Cipher(algorithms.AES(key), modes.ECB()).decryptor()
    return decryptor.update(data) + decryptor.finalize()


def valid_aes_key(probe, key):
    try:
        return len(key) == 16 and image_magic(aes_decrypt(probe, key))
    except Exception:
        return False


def decrypt_dat(data, key=None, xor_key=None):
    """Decrypt the v2/v1/pure-XOR local container, never guessing incomplete output."""
    if image_magic(data):
        return data
    if data.startswith(V2_MAGIC):
        if len(data) < 31:
            raise MediaError('READ_PENDING', '微信图片仍在下载，请稍后重试')
        aes_size, xor_size = struct.unpack_from('<II', data, 6)
        aes_length = (aes_size // 16 + 1) * 16
        if aes_size > MAX_BYTES or xor_size > MAX_BYTES or 15 + aes_length + xor_size > len(data):
            raise MediaError('READ_PENDING', '微信图片仍在下载，请稍后重试')
        if key is None:
            raise MediaError('IMAGE_KEY_UNAVAILABLE', '无法读取图片密钥；请保持微信登录并打开一张图片后重试')
        decoded = aes_decrypt(data[15:15 + aes_length], key)
        padding = decoded[-1] if decoded else 0
        if not 1 <= padding <= 16 or decoded[-padding:] != bytes([padding]) * padding or len(decoded) - padding != aes_size:
            raise MediaError('READ_FAILED', '微信图片解密校验未通过')
        prefix = decoded[:-padding] + data[15 + aes_length:len(data) - xor_size if xor_size else len(data)]
        tail = data[len(data) - xor_size:] if xor_size else b''
        if not tail:
            return prefix
        candidates = [xor_key] if xor_key is not None else []
        if xor_key is None:
            # Recover only from the actual image's known end marker, not unrelated chats.
            marker = b'\xff\xd9' if prefix.startswith(b'\xff\xd8\xff') else b'IEND\xaeB`\x82' if prefix.startswith(b'\x89PNG') else None
            if marker:
                for offset in range(min(33, len(tail) - len(marker) + 1)):
                    end = len(tail) - offset
                    sample = tail[end - len(marker):end]
                    candidate = sample[0] ^ marker[0]
                    if bytes(value ^ candidate for value in sample) == marker:
                        candidates.append(candidate)
            elif prefix.startswith((b'GIF87a', b'GIF89a')):
                candidates.append(tail[-1] ^ ord(';'))
        for candidate in dict.fromkeys(candidates):
            output = prefix + bytes(value ^ candidate for value in tail)
            if output.startswith(b'wxgf') and xor_key is not None:
                return output
            try:
                return complete_image(output)[0]
            except MediaError:
                pass
        raise MediaError('IMAGE_KEY_UNAVAILABLE', '无法验证图片内容，请在微信中打开该图片后重试')
    body = data[22:] if data.startswith(V1_MAGIC) and len(data) > 22 else data
    candidates = [xor_key] if xor_key is not None else []
    for magic in (b'\xff\xd8\xff', b'\x89PNG\r\n\x1a\n', b'GIF89a', b'GIF87a', b'RIFF', b'BM'):
        if len(body) >= len(magic):
            candidate = body[0] ^ magic[0]
            if bytes(value ^ candidate for value in body[:len(magic)]) == magic:
                candidates.append(candidate)
    for candidate in dict.fromkeys(candidates):
        try:
            return complete_image(bytes(value ^ candidate for value in body))[0]
        except MediaError:
            pass
    raise MediaError('UNSUPPORTED', '该微信图片缓存格式暂不支持')


def message_image_hashes(row, content):
    hashes = []
    root = parse_xml(content)
    if root is not None:
        for element in root.iter('img'):
            for key in ('md5', 'hdmd5', 'originalmd5'):
                value = element.get(key, '')
                if HEX_MD5.fullmatch(value):
                    hashes.append(value.lower())
    hashes += re.findall(r'\bmd5\s*[=:]\s*["\']?([a-fA-F0-9]{32})\b', content or '')
    # The XML digest describes the transferred image; the local cache may use a
    # different digest in packed_info_data. Keep both and require one local match
    # within this exact group's cache. Never search another chat or pick a guess.
    packed = row.get('packed_info_data')
    if isinstance(packed, bytes):
        hashes += [value.decode().lower() for value in re.findall(rb'(?<![a-fA-F0-9])[a-fA-F0-9]{32}(?![a-fA-F0-9])', packed)]
    return list(dict.fromkeys(value.lower() for value in hashes))[:16]


class LocalMedia:
    def __init__(self, db, module, output_dir):
        self.db, self.module = db, module
        self.account_root = Path(db.account_dir).absolute()
        self.output_dir = Path(output_dir).absolute()
        self.output_dir.mkdir(parents=True, exist_ok=True)
        self.key = None
        self.xor_key = None
        self.last_scan = -60.0

    def _keys(self, probe):
        if self.key and valid_aes_key(probe, self.key):
            return self.key, self.xor_key
        if time.monotonic() - self.last_scan < 60:
            raise MediaError('IMAGE_KEY_UNAVAILABLE', '图片密钥暂不可读，请在微信打开图片，稍等一分钟后重试')
        self.last_scan = time.monotonic()
        deadline = time.monotonic() + 12
        vendor, db = self.module, self.db
        k32 = vendor._k32
        pids = db._find_weixin_pids()
        def read(handle, address, size):
            if size <= 0 or size > 512 * 1024 * 1024:
                return b''
            buf, count = ctypes.create_string_buffer(size), ctypes.c_size_t()
            if k32.ReadProcessMemory(handle, ctypes.c_void_p(address), buf, size, ctypes.byref(count)):
                return buf.raw[:count.value]
            return b''
        # Only read the account's cfgDword and wxid; never extract/persist a master DB key.
        for pid in pids:
            if time.monotonic() >= deadline:
                break
            found = vendor._find_weixin_module(pid)
            if not found:
                continue
            base, size, _ = found
            handle = k32.OpenProcess(0x0010 | 0x0400, False, pid)
            if not handle:
                continue
            try:
                image = read(handle, base, size)
                offset = image.find(b'global_config')
                while offset >= 0 and time.monotonic() < deadline:
                    pos = offset + 16
                    if pos + 12 <= len(image) and struct.unpack_from('<I', image, pos)[0] == 13 and struct.unpack_from('<I', image, pos + 8)[0] in range(1, 16):
                        first = read(handle, base + pos - vendor.CFG_PTR_BACK, 8)
                        second = read(handle, struct.unpack('<Q', first)[0] + vendor.CFG_OFFSET, 8) if len(first) == 8 else b''
                        address = struct.unpack('<Q', second)[0] if len(second) == 8 else 0
                        if 0x10000 <= address < 0x800000000000:
                            dword_bytes = read(handle, address + vendor.CFG_DWORD_OFF, 4)
                            identity = vendor._read_remote_string(handle, lambda a, n: read(handle, a, n), address + vendor.CFG_WXID_OFF)
                            if len(dword_bytes) == 4 and identity == db.wxid:
                                dword = struct.unpack('<I', dword_bytes)[0]
                                key = hashlib.md5((str(dword) + identity).encode()).hexdigest()[:16].encode()
                                if valid_aes_key(probe, key):
                                    self.key, self.xor_key = key, dword & 0xFF
                                    return self.key, self.xor_key
                    offset = image.find(b'global_config', offset + 1)
            finally:
                k32.CloseHandle(handle)
        # Fallback: bounded read-only process scan, with no polling/UI activation or key files.
        ascii_pattern = re.compile(rb'(?<![a-zA-Z0-9])([a-zA-Z0-9]{32})(?![a-zA-Z0-9])')
        wide_pattern = re.compile(rb'(?:[a-zA-Z0-9]\x00){32}')
        tested, scanned = set(), 0
        for pid in pids:
            if time.monotonic() >= deadline:
                break
            handle = k32.OpenProcess(0x0010 | 0x0400, False, pid)
            if not handle:
                continue
            try:
                address = 0
                while time.monotonic() < deadline and scanned < 512 * 1024 * 1024:
                    info = vendor._MBI()
                    if not k32.VirtualQueryEx(handle, ctypes.c_void_p(address), ctypes.byref(info), ctypes.sizeof(info)):
                        break
                    base, size = info.BaseAddress or 0, info.RegionSize
                    if info.State == 0x1000 and (info.Protect & 0xFF) & 0xE6 and not info.Protect & 0x100 and 0 < size < 32 * 1024 * 1024:
                        data = read(handle, base, size)
                        scanned += len(data)
                        candidates = (match.group(1)[:16] for match in ascii_pattern.finditer(data))
                        wide = (match.group()[::2][:16] for match in wide_pattern.finditer(data))
                        for stream in (candidates, wide):
                            for key in stream:
                                if time.monotonic() >= deadline or len(tested) >= 50000:
                                    break
                                if key in tested:
                                    continue
                                tested.add(key)
                                if valid_aes_key(probe, key):
                                    self.key, self.xor_key = key, None
                                    return key, None
                    next_address = base + size
                    if next_address <= address:
                        break
                    address = next_address
            finally:
                k32.CloseHandle(handle)
        raise MediaError('IMAGE_KEY_UNAVAILABLE', '无法读取图片密钥；请保持微信登录并打开一张图片后重试')

    def _months(self, base):
        if not base.exists():
            return []
        checked_path(self.account_root, base)
        return [checked_path(self.account_root, path) for path in base.iterdir() if re.fullmatch(r'\d{4}-\d{2}', path.name) and path.is_dir()]

    def _image(self, row, content, group):
        base = self.account_root / 'msg' / 'attach' / hashlib.md5(group.encode()).hexdigest()
        hashes = message_image_hashes(row, content)
        matches, has_thumb = [], False
        for month in self._months(base):
            image_dir = month / 'Img'
            if not image_dir.exists():
                continue
            checked_path(self.account_root, image_dir)
            for digest in hashes:
                for suffix, quality in (('_h.dat', 'original'), ('.dat', 'compressed'), ('_t.dat', 'thumbnail')):
                    path = image_dir / (digest + suffix)
                    if path.exists():
                        checked_path(self.account_root, path)
                        if quality == 'thumbnail':
                            has_thumb = True
                        else:
                            matches.append((digest, quality, path))
        if not matches:
            detail = '本机只有缩略图，请在微信打开完整图片后重试' if has_thumb else '图片尚未下载到电脑微信，请在微信打开图片后重试'
            raise MediaError('NOT_DOWNLOADED', detail)
        if len({item[0] for item in matches}) != 1:
            raise MediaError('AMBIGUOUS', '无法唯一确认该消息的本机图片，请手动核对')
        matches.sort(key=lambda item: (item[1] != 'original', str(item[2])))
        last_error = None
        for _, quality, path in matches:
            try:
                encrypted = bounded_read(self.account_root, path, MAX_BYTES + 512)
                key, xor = self._keys(encrypted[15:31]) if encrypted.startswith(V2_MAGIC) else (None, None)
                data = decrypt_dat(encrypted, key, xor)
                if data.startswith(b'wxgf'):
                    data = self._convert_wxgf(data)
                data, extension = complete_image(data)
                return data, '微信群图片.' + extension, quality
            except MediaError as error:
                last_error = error
        raise last_error

    def _convert_wxgf(self, data):
        executable = Path(sys.executable).parent / 'ffmpeg.exe'
        if not executable.is_file() or is_reparse(executable):
            raise MediaError('UNSUPPORTED', '该微信图片需要本机图像解码组件，当前组件尚未就绪')
        start = data.find(b'\x00\x00\x00\x01')
        if start < 0:
            raise MediaError('UNSUPPORTED', '该微信图片容器暂不支持')
        try:
            result = subprocess.run([str(executable), '-v', 'error', '-nostdin', '-threads', '1', '-max_alloc', '67108864', '-protocol_whitelist', 'pipe', '-f', 'hevc', '-i', 'pipe:0', '-frames:v', '1', '-vf', 'scale=w=min(4096\\,iw):h=min(4096\\,ih):force_original_aspect_ratio=decrease', '-f', 'image2pipe', '-vcodec', 'mjpeg', 'pipe:1'], input=data[start:], capture_output=True, timeout=20, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        except (OSError, subprocess.TimeoutExpired):
            raise MediaError('UNSUPPORTED', '微信图片解码失败，请在微信查看或另存为常规图片后导入') from None
        if result.returncode or len(result.stdout) > MAX_BYTES:
            raise MediaError('READ_FAILED', '微信图片解码失败，请在微信查看后重试')
        return complete_image(result.stdout)[0]

    def _resource_name(self, server_id):
        if not server_id:
            return None
        for rel, path, _ in self.db._db_files:
            if Path(path).name != 'message_resource.db':
                continue
            conn = self.db._open(rel)
            try:
                rows = conn.execute('SELECT d.packed_info FROM MessageResourceDetail d JOIN MessageResourceInfo i ON d.message_id=i.message_id WHERE i.message_svr_id=?', (server_id,)).fetchall()
            finally:
                conn.close()
            names = set()
            for row in rows:
                raw = row['packed_info']
                if isinstance(raw, bytes):
                    raw = raw.decode('utf-8', 'strict')
                if isinstance(raw, str):
                    name = safe_name(raw.strip('\x00\r\n'))
                    if name:
                        names.add(name)
            return next(iter(names)) if len(names) == 1 else None
        return None

    def _file(self, row, content):
        description = attachment_description(row['local_type'], content)
        if not description or description['kind'] != 'file':
            raise MediaError('VALIDATION', '该消息不是文件附件')
        root = parse_xml(content)
        name = safe_name(root.findtext('.//appmsg/title')) or self._resource_name(row['server_id'])
        if not name:
            raise MediaError('UNSUPPORTED', '无法确认该微信文件的名称')
        expected_size = description['size']
        if expected_size is not None and expected_size > MAX_BYTES:
            raise MediaError('TOO_LARGE', '附件超过 25 MB 自动分析上限')
        digest = root.findtext('.//appattach/md5') or root.findtext('.//appmsg/md5') or ''
        digest = digest.lower() if HEX_MD5.fullmatch(digest) else None
        if not digest and not expected_size:
            raise MediaError('AMBIGUOUS', '缺少文件大小或校验信息，无法安全匹配同名附件')
        base = self.account_root / 'msg' / 'file'
        candidates = []
        for month in self._months(base):
            path = month / name
            if path.exists():
                checked_path(self.account_root, path)
                if expected_size is None or path.stat().st_size == expected_size:
                    candidates.append(path)
        if not candidates:
            raise MediaError('NOT_DOWNLOADED', '文件尚未完整下载到电脑微信，请下载后重试')
        if not digest and len(candidates) != 1:
            raise MediaError('AMBIGUOUS', '本机存在多个同名同大小文件，无法确认原附件')
        for path in candidates:
            data = bounded_read(self.account_root, path)
            if digest and hashlib.md5(data).hexdigest() != digest:
                continue
            if expected_size is not None and len(data) != expected_size:
                continue
            return data, name, 'file'
        raise MediaError('NOT_DOWNLOADED', '本机文件与消息校验信息不符，请重新下载原附件后重试')

    def materialize(self, row, content, group, kind):
        if kind == 'image':
            data, name, quality = self._image(row, content, group)
        elif kind == 'file':
            data, name, quality = self._file(row, content)
        else:
            raise MediaError('VALIDATION', '只支持读取图片和文件附件')
        if not data or len(data) > MAX_BYTES:
            raise MediaError('TOO_LARGE', '附件为空或超过 25 MB 自动分析上限')
        extension = Path(name).suffix.lower()
        if not re.fullmatch(r'\.[a-z0-9]{1,16}', extension):
            extension = '.bin'
        path = self.output_dir / (uuid.uuid4().hex + extension)
        checked_path(self.output_dir, self.output_dir)
        with path.open('xb') as stream:
            stream.write(data)
        checked_path(self.output_dir, path)
        return {'path': str(path), 'name': name, 'size': len(data), 'status': 'ready', 'sha256': hashlib.sha256(data).hexdigest(), 'quality': quality}
