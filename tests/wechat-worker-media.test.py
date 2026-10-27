"""Offline media/RPC regressions using fabricated files and SQLite rows only."""
import base64
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import sqlite3
import struct
import subprocess
import sys
import tempfile
import types
import unittest
from unittest.mock import Mock, patch

spec = importlib.util.spec_from_file_location('wechat_media_worker_test', Path(__file__).resolve().parents[1] / 'scripts/wechat/worker.py')
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)
media = worker.local_media


def file_xml(name, body, *, digest=True, file_type='6'):
    return '<msg><appmsg><title>' + name + '</title><type>' + file_type + '</type><appattach><totallen>' + str(len(body)) + '</totallen>' + ('<md5>' + hashlib.md5(body).hexdigest() + '</md5>' if digest else '') + '</appattach></appmsg></msg>'


class CryptoTests(unittest.TestCase):
    def setUp(self):
        self.key = b'0123456789abcdef'
        self.image = b'\xff\xd8\xff\xe0' + b'fictional-jpeg-body' * 4 + b'\xff\xd9'

    def v2(self, data, aes_length=32, xor_length=12, xor_key=0x39):
        from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
        head = data[:aes_length]
        pad = 16 - len(head) % 16
        encryptor = Cipher(algorithms.AES(self.key), modes.ECB()).encryptor()
        encrypted = encryptor.update(head + bytes([pad]) * pad) + encryptor.finalize()
        tail = bytes(value ^ xor_key for value in data[-xor_length:]) if xor_length else b''
        middle = data[aes_length:len(data) - xor_length if xor_length else len(data)]
        return media.V2_MAGIC + struct.pack('<II', aes_length, xor_length) + b'\x00' + encrypted + middle + tail

    def test_v2_aes_raw_and_xor_parts_round_trip(self):
        self.assertEqual(media.decrypt_dat(self.v2(self.image), self.key, 0x39), self.image)

    def test_v2_zero_xor_does_not_duplicate_input(self):
        self.assertEqual(media.decrypt_dat(self.v2(self.image, xor_length=0), self.key, None), self.image)

    def test_v2_can_recover_xor_only_from_same_image_end_marker(self):
        self.assertEqual(media.decrypt_dat(self.v2(self.image), self.key, None), self.image)

    def test_wrong_aes_key_and_truncated_container_fail(self):
        with self.assertRaises(media.MediaError):
            media.decrypt_dat(self.v2(self.image), b'fedcba9876543210', 0x39)
        with self.assertRaises(media.MediaError):
            media.decrypt_dat(self.v2(self.image)[:35], self.key, 0x39)

    def test_legacy_xor_and_v1_are_supported_without_process_scan(self):
        encrypted = bytes(value ^ 0x37 for value in self.image)
        self.assertEqual(media.decrypt_dat(encrypted), self.image)
        self.assertEqual(media.decrypt_dat(media.V1_MAGIC + b'0' * 16 + encrypted), self.image)

    def test_truncated_image_never_reported_complete(self):
        with self.assertRaises(media.MediaError):
            media.complete_image(self.image[:-2])


class LocalFilesTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.account = self.root / 'account'
        self.account.mkdir()
        self.reader = media.LocalMedia(types.SimpleNamespace(account_dir=str(self.account), _db_files=[]), None, self.root / 'cache' / 'media')
        self.body = b'fictional training document, no private content'
        self.row = {'local_type': 49, 'server_id': 13}
        self.group = 'fictional@chatroom'

    def tearDown(self):
        self.temp.cleanup()

    def put(self, month, name, data=None):
        folder = self.account / 'msg' / 'file' / month
        folder.mkdir(parents=True, exist_ok=True)
        path = folder / name
        path.write_bytes(self.body if data is None else data)
        return path

    def test_file_digest_selects_correct_file_not_first_same_name(self):
        self.put('2026-09', 'fixture.pdf', b'x' * len(self.body))
        original = self.put('2026-10', 'fixture.pdf')
        result = self.reader.materialize(self.row, file_xml('fixture.pdf', self.body), self.group, 'file')
        self.assertEqual(Path(result['path']).read_bytes(), self.body)
        self.assertEqual(result['sha256'], hashlib.sha256(self.body).hexdigest())
        self.assertEqual(result['size'], len(self.body))
        self.assertNotEqual(Path(result['path']), original)

    def test_wrong_file_digest_and_size_fail(self):
        self.put('2026-10', 'fixture.pdf', b'x' * len(self.body))
        with self.assertRaises(media.MediaError):
            self.reader.materialize(self.row, file_xml('fixture.pdf', self.body), self.group, 'file')
        with self.assertRaises(media.MediaError):
            self.reader.materialize(self.row, file_xml('fixture.pdf', self.body + b'longer'), self.group, 'file')

    def test_same_name_without_digest_is_ambiguous(self):
        self.put('2026-09', 'fixture.pdf')
        self.put('2026-10', 'fixture.pdf')
        with self.assertRaises(media.MediaError) as caught:
            self.reader.materialize(self.row, file_xml('fixture.pdf', self.body, digest=False), self.group, 'file')
        self.assertEqual(caught.exception.code, 'AMBIGUOUS')

    def test_unsafe_names_and_link_cards_are_not_read(self):
        for name in ('../secret.pdf', 'C:\\secret.pdf', 'secret.pdf:stream', 'NUL.pdf'):
            self.assertIsNone(media.safe_name(name))
        self.assertIsNone(media.attachment_description(49, file_xml('fixture.pdf', self.body, file_type='5')))
        self.assertIsNone(media.attachment_description(49, '<!DOCTYPE a [<!ENTITY x SYSTEM "file:///secret">]><a/>'))

    def test_group_sender_prefix_and_container_suffix_keep_file_card(self):
        content = 'wxid_fictional_sender:\n' + file_xml('fixture.pdf', self.body) + '\x00\x01'
        description = media.attachment_description((6 << 32) + 49, content)
        self.assertEqual(description['kind'], 'file')
        self.assertEqual(description['name'], 'fixture.pdf')
        self.put('2026-10', 'fixture.pdf')
        self.assertEqual(self.reader.materialize(self.row, content, self.group, 'file')['size'], len(self.body))

    def test_unsafe_xml_declarations_remain_rejected_outside_msg_slice(self):
        for prefix in ('<!DOCTYPE a [<!ENTITY x "fake">]>', '<!ENTITY secret SYSTEM "file:///secret">'):
            self.assertIsNone(media.parse_xml(prefix + file_xml('fixture.pdf', self.body)))
        self.assertIsNone(media.parse_xml('x' * 513 + file_xml('fixture.pdf', self.body)))

    def test_missing_file_can_be_read_after_download_without_reset(self):
        request = file_xml('fixture.pdf', self.body)
        with self.assertRaises(media.MediaError) as caught:
            self.reader.materialize(self.row, request, self.group, 'file')
        self.assertEqual(caught.exception.code, 'NOT_DOWNLOADED')
        self.put('2026-10', 'fixture.pdf')
        self.assertEqual(self.reader.materialize(self.row, request, self.group, 'file')['status'], 'ready')

    def test_oversize_refused_before_materializing(self):
        content = '<msg><appmsg><type>6</type><title>fixture.pdf</title><appattach><totallen>26214401</totallen></appattach></appmsg></msg>'
        with self.assertRaises(media.MediaError) as caught:
            self.reader.materialize(self.row, content, self.group, 'file')
        self.assertEqual(caught.exception.code, 'TOO_LARGE')
        self.assertEqual(list(self.reader.output_dir.iterdir()), [])

    def test_traversal_and_reparse_point_refused(self):
        outside = self.root / 'outside.pdf'
        outside.write_bytes(self.body)
        with self.assertRaises(media.MediaError):
            media.checked_path(self.account, outside)
        with patch.object(media, 'is_reparse', return_value=True), self.assertRaises(media.MediaError):
            media.bounded_read(self.account, self.account)

    def image_path(self, digest, suffix, payload):
        image_dir = self.account / 'msg' / 'attach' / hashlib.md5(self.group.encode()).hexdigest() / '2026-10' / 'Img'
        image_dir.mkdir(parents=True, exist_ok=True)
        path = image_dir / (digest + suffix)
        path.write_bytes(payload)
        return path

    def test_thumbnail_only_is_not_silently_used_as_original(self):
        digest = 'a' * 32
        self.image_path(digest, '_t.dat', b'\xff\xd8\xffdata\xff\xd9')
        with self.assertRaises(media.MediaError) as caught:
            self.reader.materialize({'local_type': 3}, '<msg><img md5="' + digest + '"/></msg>', self.group, 'image')
        self.assertEqual(caught.exception.code, 'NOT_DOWNLOADED')

    def test_original_preferred_and_output_is_private_copy(self):
        digest = 'a' * 32
        self.image_path(digest, '.dat', b'\xff\xd8\xffcompressed\xff\xd9')
        original = b'\xff\xd8\xfforiginal fictional image\xff\xd9'
        self.image_path(digest, '_h.dat', original)
        result = self.reader.materialize({'local_type': 3}, '<msg><img md5="' + digest + '"/></msg>', self.group, 'image')
        self.assertEqual(result['quality'], 'original')
        self.assertEqual(Path(result['path']).read_bytes(), original)
        self.assertTrue(Path(result['path']).is_relative_to(self.reader.output_dir))

    def test_packed_cache_hash_can_differ_from_xml_transfer_hash(self):
        cached = 'b' * 32
        image = b'\xff\xd8\xfffictional image\xff\xd9'
        self.image_path(cached, '.dat', image)
        result = self.reader.materialize({'local_type': 3, 'packed_info_data': b'\x0a\x20' + cached.encode() + b'\x00'}, '<msg><img md5="' + 'a' * 32 + '"/></msg>', self.group, 'image')
        self.assertEqual(Path(result['path']).read_bytes(), image)

    def test_two_distinct_local_image_hashes_are_not_guessed(self):
        for digest in ('a' * 32, 'b' * 32):
            self.image_path(digest, '.dat', b'\xff\xd8\xfffictional image\xff\xd9')
        with self.assertRaises(media.MediaError) as caught:
            self.reader.materialize({'local_type': 3, 'packed_info_data': b'\x0a\x20' + b'b' * 32 + b'\x00'}, '<msg><img md5="' + 'a' * 32 + '"/></msg>', self.group, 'image')
        self.assertEqual(caught.exception.code, 'AMBIGUOUS')


class MediaRpcTests(unittest.TestCase):
    def setUp(self):
        self.conn = sqlite3.connect(':memory:')
        self.conn.row_factory = sqlite3.Row
        self.conn.execute('CREATE TABLE Msg_fixture (local_id INTEGER PRIMARY KEY,local_type INTEGER,real_sender_id INTEGER,create_time INTEGER,message_content TEXT,source TEXT,packed_info_data BLOB,compress_content BLOB,server_id INTEGER,sort_seq INTEGER)')
        self.conn.execute('INSERT INTO Msg_fixture VALUES (1,3,7,1800000000,?,NULL,NULL,NULL,111,200)', ('<msg><img md5="' + 'a' * 32 + '"/></msg>',))
        self.reader = worker.Reader.__new__(worker.Reader)
        self.reader.verify = Mock(return_value='wechat:wxid_fictional')
        self.reader.groups = {'fictional@chatroom': '虚构群'}
        self.reader.db = types.SimpleNamespace(
            _shard_label=lambda conn: 'message__message_0.db',
            _run_msg_query=lambda group, callback: callback([(self.conn, 'Msg_fixture')]),
            _msg_row_to_dict=lambda row, maps: {'content': row['message_content']})
        self.reader.media = types.SimpleNamespace(materialize=Mock(return_value={'status': 'ready'}))
        self.request = {'id': 1, 'action': 'media', 'accountId': 'wechat:wxid_fictional', 'groupId': 'fictional@chatroom', 'messageId': 's:111', 'locatorId': worker.media_locator({'shard': 'message__message_0.db', 'local_id': 1}), 'kind': 'image'}

    def tearDown(self):
        self.conn.close()

    def test_original_row_is_revalidated_before_materializing(self):
        self.assertEqual(self.reader.handle(self.request), {'status': 'ready'})
        self.reader.media.materialize.assert_called_once()
        actual = self.reader.media.materialize.call_args.args[0]
        self.assertEqual(actual['server_id'], 111)

    def test_changed_message_id_wrong_kind_and_cross_shard_rejected(self):
        for changes in ({'messageId': 's:112'}, {'kind': 'file'}, {'locatorId': worker.media_locator({'shard': 'message__message_1.db', 'local_id': 1})}):
            with self.subTest(changes=changes), self.assertRaises(worker.ReaderError):
                self.reader.handle({**self.request, **changes})
        self.reader.media.materialize.assert_not_called()

    def test_arbitrary_path_locator_or_direct_path_request_rejected(self):
        for locator in ('file:///secret', 'wm1:' + base64.urlsafe_b64encode(json.dumps(['../secret', 1]).encode()).decode()):
            with self.assertRaises(worker.ReaderError):
                self.reader.handle({**self.request, 'locatorId': locator})
        with self.assertRaises(worker.ReaderError):
            self.reader.handle({**self.request, 'path': 'C:\\secret'})
        self.reader.media.materialize.assert_not_called()


class WxgfConversionTests(unittest.TestCase):
    def test_synthetic_hevc_decodes_through_pipe_only(self):
        executable = Path(sys.executable).parent / 'ffmpeg.exe'
        if not executable.is_file():
            self.skipTest('Optional fixed-path FFmpeg runtime is not installed')
        result = subprocess.run([str(executable), '-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=64x64:d=0.1', '-frames:v', '1', '-c:v', 'libx265', '-x265-params', 'pools=1:frame-threads=1:log-level=error', '-f', 'hevc', 'pipe:1'], capture_output=True, timeout=20, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        self.assertEqual(result.returncode, 0)
        reader = media.LocalMedia.__new__(media.LocalMedia)
        decoded = reader._convert_wxgf(b'wxgf-fictional-container' + result.stdout)
        self.assertEqual(media.complete_image(decoded)[1], 'jpg')
        self.assertLess(len(decoded), media.MAX_BYTES)


if __name__ == '__main__':
    unittest.main()
