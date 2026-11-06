"""Dependency-free tests for the Recorder SQLite query and sort semantics."""
import importlib.util
from contextlib import closing
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

MODULE = Path(__file__).resolve().parents[1] / 'custom_components/ha_query/query_engine.py'
spec = importlib.util.spec_from_file_location('query_engine', MODULE)
engine = importlib.util.module_from_spec(spec)
spec.loader.exec_module(engine)


class QueryEngineTests(unittest.TestCase):
    def database(self, folder, count=1, indexes=True):
        db = Path(folder) / 'history.db'
        with closing(sqlite3.connect(db)) as conn:
            conn.executescript('''
                CREATE TABLE states_meta (metadata_id INTEGER PRIMARY KEY, entity_id TEXT UNIQUE);
                CREATE TABLE states (metadata_id INTEGER, last_updated_ts REAL);
            ''')
            if indexes:
                conn.executescript('''
                    CREATE INDEX ix_states_metadata_id_last_updated_ts ON states(metadata_id, last_updated_ts);
                    CREATE INDEX ix_states_last_updated_ts ON states(last_updated_ts);
                ''')
            conn.executemany('INSERT INTO states_meta VALUES (?, ?)', [(i, f'sensor.e{i}') for i in range(count)])
            conn.executemany('INSERT INTO states VALUES (?, ?)', [(i, 1000 + i) for i in range(count)])
            conn.commit()
        return db

    def test_latest_includes_changes_older_than_45_days(self):
        with tempfile.TemporaryDirectory() as folder:
            db = Path(folder) / 'history.db'
            with closing(sqlite3.connect(db)) as conn:
                conn.executescript('''
                    CREATE TABLE states_meta (metadata_id INTEGER PRIMARY KEY, entity_id TEXT);
                    CREATE TABLE states (metadata_id INTEGER, last_updated_ts REAL);
                    INSERT INTO states_meta VALUES (1, 'sensor.battery'), (2, 'sensor.lqi');
                    INSERT INTO states VALUES (1, 1000), (1, 2000), (2, 3000);
                ''')
            results, oldest = engine.latest_updates(str(db), ['sensor.battery', 'sensor.lqi', 'sensor.missing'])
            self.assertEqual(results, {'sensor.battery': 2000, 'sensor.lqi': 3000})
            self.assertEqual(oldest, 1000)

    def test_numeric_sort_not_lexical(self):
        rows = [{'n': 9}, {'n': 100}, {'n': 38}, {'n': None}]
        self.assertEqual([r['n'] for r in engine.sort_and_limit(rows, 'n', True, 4)], [100, 38, 9, None])
        self.assertEqual([r['n'] for r in engine.sort_and_limit(rows, 'n', False, 4)], [9, 38, 100, None])

    def test_numeric_strings_sort_numerically_with_other_text_last(self):
        rows = [{'n': '100'}, {'n': 'unknown'}, {'n': '9'}, {'n': 'NaN'}, {'n': '38'}]
        self.assertEqual([r['n'] for r in engine.sort_and_limit(rows, 'n', False, 5)],
                         ['9', '38', '100', 'NaN', 'unknown'])

    def test_sqlite_url(self):
        self.assertEqual(engine.sqlite_path('sqlite:////config/home-assistant_v2.db'), '/config/home-assistant_v2.db')
        with self.assertRaises(ValueError):
            engine.sqlite_path('mysql://server/db')

    def test_percent_in_filename_is_literal_like_sqlalchemy(self):
        with tempfile.TemporaryDirectory() as folder:
            db = self.database(folder)
            renamed = db.with_name('history%20file.db')
            db.rename(renamed)
            path = engine.sqlite_path('sqlite:///' + str(renamed))
            self.assertEqual(path, str(renamed))
            self.assertEqual(engine.latest_updates(path, ['sensor.e0'])[0], {'sensor.e0': 1000})

    def test_batches_and_parameter_binding_preserve_database(self):
        with tempfile.TemporaryDirectory() as folder:
            db = self.database(folder, 601)
            original = db.read_bytes()
            ids = [f'sensor.e{i}' for i in range(601)]
            ids.append("sensor.e0') OR 1=1; DROP TABLE states; --")
            results, oldest = engine.latest_updates(str(db), ids)
            self.assertEqual(len(results), 601)
            self.assertEqual(results['sensor.e600'], 1600)
            self.assertEqual(oldest, 1000)
            self.assertEqual(db.read_bytes(), original)
            self.assertEqual(engine.latest_updates(str(db), [ids[-1]])[0], {})

    def test_read_only_connection_rejects_writes(self):
        with tempfile.TemporaryDirectory() as folder:
            db = self.database(folder)
            connect = sqlite3.connect
            checked = []

            def open_readonly(*args, **kwargs):
                conn = connect(*args, **kwargs)
                try:
                    with self.assertRaises(sqlite3.OperationalError):
                        conn.execute('DELETE FROM states')
                    checked.append(True)
                except BaseException:
                    conn.close()
                    raise
                return conn

            with patch.object(engine.sqlite3, 'connect', side_effect=open_readonly):
                engine.latest_updates(str(db), ['sensor.e0'])
            self.assertEqual(checked, [True])

    def test_nonexistent_database_is_not_created(self):
        with tempfile.TemporaryDirectory() as folder:
            db = Path(folder) / 'missing.db'
            with self.assertRaises(sqlite3.OperationalError):
                engine.latest_updates(str(db), ['sensor.e0'])
            self.assertFalse(db.exists())
            self.assertEqual(engine.latest_updates(str(db), []), ({}, None))

    def test_execution_budget_interrupts_sql_and_closes_connection(self):
        with tempfile.TemporaryDirectory() as folder:
            db = self.database(folder, 2000, indexes=False)
            with patch.object(engine, 'monotonic', side_effect=[0, 11]):
                with self.assertRaisesRegex(sqlite3.OperationalError, 'interrupted'):
                    engine.latest_updates(str(db), ['sensor.e0'])
            db.unlink()  # Fails on Windows if the interrupted connection leaked.

    def test_execution_budget_checked_between_statements(self):
        with tempfile.TemporaryDirectory() as folder:
            db = self.database(folder)
            with patch.object(engine, 'monotonic', side_effect=[0, 11]):
                with self.assertRaises(TimeoutError):
                    engine.latest_updates(str(db), ['sensor.e0'])
            db.unlink()

    def test_invalid_database_closes_connection(self):
        with tempfile.TemporaryDirectory() as folder:
            db = Path(folder) / 'empty.db'
            db.touch()
            with self.assertRaises(sqlite3.OperationalError):
                engine.latest_updates(str(db), ['sensor.e0'])
            db.unlink()

    def test_sort_missing_casefold_and_limit(self):
        rows = [{'n': 'Zulu'}, {'n': None}, {'n': 'alpha'}, {}]
        self.assertEqual(engine.sort_and_limit(rows, 'n', False, 2), [{'n': 'alpha'}, {'n': 'Zulu'}])
        self.assertEqual(engine.sort_and_limit(rows, 'n', True, 4)[-2:], [{'n': None}, {}])
        self.assertEqual(engine.sort_and_limit(rows, None, False, 1), rows[:1])

    def test_memory_urls_rejected(self):
        for url in ['sqlite:///', 'sqlite:///:memory:', 'postgresql://host/db']:
            with self.subTest(url=url), self.assertRaises(ValueError):
                engine.sqlite_path(url)


if __name__ == '__main__':
    unittest.main()
