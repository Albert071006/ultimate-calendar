"""Offline tests: synthetic SQLite shards only; never loads the WeChat vendor reader."""
import base64
import importlib.util
import json
import os
from pathlib import Path
import sqlite3
import tempfile
import types
import unittest
from unittest.mock import Mock


spec = importlib.util.spec_from_file_location(
    'wechat_worker_under_test', Path(__file__).resolve().parents[1] / 'scripts/wechat/worker.py')
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)


class Shards:
    def __init__(self):
        self.connections = []
        self.labels = {}

    def add(self, label, rows):
        conn = sqlite3.connect(':memory:')
        conn.row_factory = sqlite3.Row
        conn.execute('CREATE TABLE Msg_fixture (local_id INTEGER PRIMARY KEY, local_type INTEGER, real_sender_id INTEGER, create_time INTEGER, message_content TEXT, source TEXT, packed_info_data BLOB, compress_content BLOB, server_id INTEGER, sort_seq INTEGER)')
        for local_id, seq in rows:
            conn.execute('INSERT INTO Msg_fixture VALUES (?,1,7,1800000000,?,NULL,NULL,NULL,?,?)',
                         (local_id, 'fictional message ' + str(local_id), local_id + 5000, seq))
        self.connections.append(conn)
        self.labels[id(conn)] = label
        return conn

    def tables(self):
        return [(conn, 'Msg_fixture') for conn in self.connections]

    def label(self, conn):
        return self.labels[id(conn)]

    def close(self):
        for conn in self.connections:
            conn.close()


class PaginationTests(unittest.TestCase):
    def setUp(self):
        self.shards = Shards()
        self.a = self.shards.add('message_0', [(1, 9), (2, 10), (3, 10)])
        self.b = self.shards.add('message_1', [(1, 10), (2, 10), (3, 8)])

    def tearDown(self):
        self.shards.close()

    @staticmethod
    def key(row):
        return (row['sort_seq'], row['shard'], row['local_id'])

    def page(self, cursor=None, limit=2):
        return worker.strict_rows(self.shards.tables(), cursor, limit, self.shards.label)

    def test_same_sequence_and_local_id_across_shards_are_not_lost(self):
        cursor, found = None, []
        for _ in range(10):
            rows, more = self.page(cursor)
            found.extend(self.key(row) for row in rows)
            if not rows:
                break
            cursor = self.key(rows[-1])
        expected = [(10, 'message_1', 2), (10, 'message_1', 1),
                    (10, 'message_0', 3), (10, 'message_0', 2),
                    (9, 'message_0', 1), (8, 'message_1', 3)]
        self.assertEqual(found, expected)
        self.assertEqual(len(found), len(set(found)))

    def test_new_messages_between_pages_do_not_shift_older_frontier(self):
        first, _ = self.page()
        self.b.execute('INSERT INTO Msg_fixture VALUES (4,1,7,1800000001,?,NULL,NULL,NULL,5004,11)', ('new fictional notice',))
        second, _ = self.page(self.key(first[-1]))
        self.assertEqual([self.key(row) for row in second], [(10, 'message_0', 3), (10, 'message_0', 2)])
        newest, _ = self.page()
        self.assertEqual(self.key(newest[0]), (11, 'message_1', 4))

    def test_exact_full_page_is_followed_by_empty_exhaustion(self):
        rows, more = self.page(limit=6)
        self.assertEqual(len(rows), 6)
        self.assertFalse(more)
        following, more = self.page(self.key(rows[-1]), 6)
        self.assertEqual(following, [])
        self.assertFalse(more)

    def test_missing_shard_table_fails_instead_of_returning_partial_history(self):
        self.b.execute('DROP TABLE Msg_fixture')
        with self.assertRaises(sqlite3.DatabaseError):
            self.page()

    def test_table_identifier_rejects_sql_injection(self):
        with self.assertRaises(worker.ReaderError):
            worker.strict_rows([(self.a, 'Msg_fixture; DROP TABLE Msg_fixture')], None, 2, self.shards.label)
        self.assertEqual(self.a.execute('SELECT count(*) FROM Msg_fixture').fetchone()[0], 3)


class CursorTests(unittest.TestCase):
    def test_round_trip_preserves_large_sequence(self):
        key = (18446744073709551, 'message__message_17.db', 123456)
        self.assertEqual(worker.parse_cursor(worker.encode_cursor(key)), key)

    def test_none_is_the_only_absent_cursor(self):
        self.assertIsNone(worker.parse_cursor(None))
        for cursor in ('', '!!', 123, 'a' * 1001):
            with self.subTest(cursor=repr(cursor)[:30]), self.assertRaises(worker.ReaderError):
                worker.parse_cursor(cursor)

    def test_malformed_shapes_and_boolean_numbers_rejected(self):
        for key in ([1, 'shard'], [1, 'shard', 1, 1], [True, 'shard', 1], [1, 'shard', False], ['1', 'shard', 1], [1, 123, 1], [1, 'x' * 201, 1], {'a': 1}):
            with self.subTest(key=key), self.assertRaises(worker.ReaderError):
                worker.parse_cursor(base64.urlsafe_b64encode(json.dumps(key).encode()).decode())


class FakeDB:
    wxid = 'wxid_fictional'

    def _msg_row_to_dict(self, row, maps):
        return {'sender_username': 'wxid_friend', 'content': row['message_content'],
                'type': '图片' if row['local_type'] == 3 else '文件/链接/卡片'}


class NormalizationTests(unittest.TestCase):
    def row(self, **overrides):
        return dict(local_id=1, shard='message__message_0.db', local_type=1,
                    create_time=1800000000, server_id=0, source='',
                    message_content='明天下午开会', **overrides)

    def normalize(self, row):
        return worker.normalize_row(FakeDB(), row, {}, 'fixture@chatroom', {'wxid_friend': '虚构成员'})

    def test_original_timestamp_and_sender_are_preserved(self):
        result = self.normalize(self.row())
        self.assertEqual(result['time'], 1800000000)
        self.assertEqual(result['user_id'], 'wechat:wxid_friend')
        self.assertEqual(result['sender']['nickname'], '虚构成员')
        self.assertEqual(result['message'][0]['data']['text'], '明天下午开会')

    def test_fallback_message_id_namespaces_shard(self):
        first = self.row()
        second = {**first, 'shard': 'message__message_1.db'}
        self.assertNotEqual(self.normalize(first)['message_id'], self.normalize(second)['message_id'])
        self.assertEqual(self.normalize(first)['message_id'], self.normalize(dict(first))['message_id'])

    def test_server_id_stays_stable_across_shard_movement(self):
        first = {**self.row(), 'server_id': 9007199254740993}
        second = {**first, 'shard': 'message__message_1.db', 'local_id': 100}
        self.assertEqual(self.normalize(first)['message_id'], 's:9007199254740993')
        self.assertEqual(self.normalize(first)['message_id'], self.normalize(second)['message_id'])

    def test_mentions_use_explicit_source_ids_and_all_marker(self):
        row = {**self.row(), 'source': '<msgsource><atuserlist>wxid_fictional,notify@all</atuserlist></msgsource>'}
        result = self.normalize(row)
        self.assertEqual([segment['data']['wechat'] for segment in result['message'][1:]], ['wechat:wxid_fictional', 'all'])

    def test_missing_media_is_explicit_and_raw_xml_is_not_displayed(self):
        row = {**self.row(), 'local_type': 3, 'message_content': '<msg><img aeskey="not-a-real-secret"/></msg>'}
        text = self.normalize(row)['message'][0]['data']['text']
        self.assertIn('未读取附件内容', text)
        self.assertNotIn('aeskey', text)

    def test_xml_entity_expansion_is_rejected(self):
        self.assertIsNone(worker.xml_root('<!DOCTYPE a [<!ENTITY value "fake">]><a>&value;</a>'))

    def test_malformed_xml_after_whitespace_does_not_expose_media_keys(self):
        row = {**self.row(), 'local_type': 3, 'message_content': ' \n<?xml version="1.0"?><msg><img aeskey="not-a-real-secret"/></msg>'}
        text = self.normalize(row)['message'][0]['data']['text']
        self.assertNotIn('aeskey', text)
        self.assertNotIn('not-a-real-secret', text)


class BoundDatabaseTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        class SyntheticVendorBase:
            wxid = 'wxid_fictional'
            def __init__(self, account, workdir):
                self.workdir = workdir
                self.account = account
            def _open(self, rel):
                self.last_connection = Mock()
                return self.last_connection
            def _find_weixin_pids(self):
                return [12345]
        self.reader = worker.Reader.__new__(worker.Reader)
        self.reader.module = types.SimpleNamespace(
            WeChatDB=SyntheticVendorBase,
            list_accounts=lambda: [{'wxid': 'wxid_fictional', 'account': 'wxid_fictional_0000'}])
        self.reader.temp = self.temp
        self.reader.refresh_groups = Mock()
        self.reader.connect('wechat:wxid_fictional')
        self.rel = os.path.join('message', 'message_0.db')
        self.stamp = Path(self.temp.name) / (self.rel.replace(os.sep, '__') + '.stamp')

    def tearDown(self):
        self.temp.cleanup()

    def test_failed_wal_merge_closes_connection_and_requests_retry(self):
        self.stamp.write_text('3,1,4096,2,8192,-1')
        database = self.stamp.with_suffix('')
        database.write_bytes(b'fictional cache data')
        with self.assertRaises(worker.ReaderError) as caught:
            self.reader.db._open(self.rel)
        self.assertEqual(caught.exception.code, 'READ_PENDING')
        self.reader.db.last_connection.close.assert_called_once()
        self.assertFalse(self.stamp.exists())
        self.assertEqual(database.read_bytes(), b'fictional cache data')

    def test_successful_wal_merge_keeps_connection_and_stamp(self):
        self.stamp.write_text('3,1,4096,2,8192,8')
        conn = self.reader.db._open(self.rel)
        conn.close.assert_not_called()
        self.assertTrue(self.stamp.exists())

    def test_keys_and_account_fallback_stay_disabled(self):
        db = self.reader.db
        self.assertEqual(db._load_key_cache('not-a-real-key-path'), {})
        self.assertIsNone(db._save_keys())
        self.assertIsNone(db._stable_key_file())
        self.assertFalse(db._try_other_accounts())
        self.assertFalse(db._select_account_by_keys({'fake-key'}))
        self.assertIsNone(db.extract_master_key())
        self.assertEqual(list(Path(self.temp.name).iterdir()), [])


class RequestTests(unittest.TestCase):
    def setUp(self):
        self.reader = worker.Reader.__new__(worker.Reader)
        self.reader.db = FakeDB()
        self.reader.groups = {'fixture@chatroom': '虚构测试群'}
        self.reader.names = {}
        self.reader.verify = Mock(return_value='wechat:wxid_fictional')

    def test_send_and_arbitrary_arguments_rejected_before_any_database_read(self):
        for request in ({'id': 1, 'action': 'send'}, {'id': 1, 'action': 'status', 'script': 'anything'}, [], None):
            with self.subTest(request=request), self.assertRaises(worker.ReaderError):
                self.reader.handle(request)
        self.reader.verify.assert_not_called()

    def test_history_requires_explicit_account_binding(self):
        with self.assertRaises(worker.ReaderError):
            self.reader.handle({'id': 1, 'action': 'history', 'groupId': 'fixture@chatroom'})

    def test_unknown_group_rejected(self):
        with self.assertRaises(worker.ReaderError):
            self.reader.handle({'id': 1, 'action': 'history', 'accountId': 'wechat:wxid_fictional', 'groupId': 'unrelated@chatroom'})

    def test_invalid_page_limits_rejected(self):
        for limit in (0, -1, 101, True, 1.5, '100'):
            with self.subTest(limit=limit), self.assertRaises(worker.ReaderError):
                self.reader.handle({'id': 1, 'action': 'history', 'accountId': 'wechat:wxid_fictional', 'groupId': 'fixture@chatroom', 'limit': limit})

    def test_changed_account_is_rejected_by_verify(self):
        reader = worker.Reader.__new__(worker.Reader)
        reader.db = FakeDB()
        with self.assertRaises(worker.ReaderError) as caught:
            reader.verify('wechat:wxid_different')
        self.assertEqual(caught.exception.code, 'ACCOUNT_CHANGED')


if __name__ == '__main__':
    unittest.main()
