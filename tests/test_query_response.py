"""Response limits tested against Home Assistant's real wire encoder."""
from dataclasses import dataclass
from datetime import date, datetime, time, timezone
import importlib.util
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

from homeassistant.helpers.json import json_bytes

MODULE = Path(__file__).resolve().parents[1] / 'custom_components/ha_query/query_response.py'
spec = importlib.util.spec_from_file_location('query_response', MODULE)
response = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = response
spec.loader.exec_module(response)


class QueryResponseTests(unittest.TestCase):
    def prepare(self, value, **kwargs):
        return response.prepare_response([{'value': value}], ['value'], [], None, **kwargs)

    def test_projection_preserves_metadata_missing_and_input(self):
        prefix = 'entity.attributes.'
        attributes = {'nested': {'value': None}, 'sort': 12, 'list': [1]}
        row = {'entity_id': 'sensor.test', 'area.name': 'Kitchen', '_attributes': attributes,
               prefix + 'sort': 12}
        columns = [prefix + 'nested.value', prefix + 'missing', prefix + 'list.0']
        result = response.prepare_response([row], columns, ['warning'], prefix + 'sort')
        self.assertEqual(result, {'columns': columns, 'warnings': ['warning'], 'rows': [
            {'entity_id': 'sensor.test', 'area.name': 'Kitchen', prefix + 'nested.value': None}]})
        self.assertIs(row['_attributes'], attributes)
        self.assertEqual(row[prefix + 'sort'], 12)
        self.assertIsNot(result['columns'], columns)

    def test_native_ha_types_match_wire(self):
        @dataclass
        class Reading:
            measured: datetime
            values: tuple

        value = {'datetime': datetime(2026, 11, 7, tzinfo=timezone.utc),
                 'date': date(2026, 11, 7), 'time': time(12, 30), 'set': {'one', 'two'},
                 'nested': [None, True, 1.25, {'tuple': (1, 'two'), 42: 'number key', None: 'null key'}],
                 'reading': Reading(datetime(2026, 11, 7), (1, 2))}
        expected = json.loads(json_bytes(value))
        self.assertEqual(self.prepare(value)['rows'][0]['value'], expected)

    def test_rejects_unsupported_and_nonfinite_without_repr(self):
        class Unsupported:
            def __repr__(self):
                raise AssertionError('must not call repr')

            def as_dict(self):
                raise AssertionError('must not run arbitrary hooks')

        for value in (Unsupported(), object(), float('nan'), float('inf'), -float('inf')):
            with self.subTest(type=type(value)), self.assertRaises((TypeError, ValueError)):
                self.prepare({'nested': [value]})

    def test_cycles_and_depth_fail_bounded(self):
        cycle = []
        cycle.append(cycle)
        with self.assertRaisesRegex(ValueError, 'nesting'):
            self.prepare(cycle)
        deep = 1
        for _ in range(response.MAX_DEPTH + 1):
            deep = [deep]
        with self.assertRaisesRegex(ValueError, 'nesting'):
            self.prepare(deep)

    def test_exact_unicode_budget_including_columns_warnings_and_envelope(self):
        rows = [{'value': 'é😀\n\x00"\\' * 1500}]
        columns = ['value', 'é']
        warnings = ['注意\n']
        result = response.prepare_response(rows, columns, warnings, None, message_id=123)
        size = len(json_bytes({'id': 123, 'type': 'result', 'success': True, 'result': result}))
        with patch.object(response, 'MAX_RESPONSE_BYTES', size):
            self.assertEqual(response.prepare_response(rows, columns, warnings, None, message_id=123), result)
        with patch.object(response, 'MAX_RESPONSE_BYTES', size - 1):
            with self.assertRaisesRegex(ValueError, '4 MB'):
                response.prepare_response(rows, columns, warnings, None, message_id=123)

    def test_oversized_scalar_never_encoded(self):
        value = 'x' * response.MAX_RESPONSE_BYTES
        encoded_lengths = []

        def encode(item):
            if isinstance(item, str):
                encoded_lengths.append(len(item))
            return json_bytes(item)

        with patch.object(response, 'json_bytes', side_effect=encode):
            with self.assertRaisesRegex(ValueError, '4 MB'):
                self.prepare(value)
        self.assertLess(max(encoded_lengths), 4097)

    def test_escaped_scalar_encoding_stops_at_budget(self):
        value = '\x00' * 10000
        chunks = []

        def encode(item):
            if isinstance(item, str) and item.startswith('\x00'):
                chunks.append(len(item))
            return json_bytes(item)

        with patch.object(response, 'MAX_RESPONSE_BYTES', 15000), patch.object(response, 'json_bytes', side_effect=encode):
            with self.assertRaisesRegex(ValueError, '4 MB'):
                self.prepare(value)
        self.assertEqual(chunks, [4096])

    def test_collection_stops_before_traversing_tail(self):
        class ObservedList(list):
            visited = 0

            def __iter__(self):
                for value in super().__iter__():
                    self.visited += 1
                    yield value

        values = ObservedList(['é' * 1000] * 10000)
        with patch.object(response, 'MAX_RESPONSE_BYTES', 5000):
            with self.assertRaisesRegex(ValueError, '4 MB'):
                self.prepare(values)
        self.assertLess(values.visited, 4)
        values = ObservedList([None] * 1000)
        with patch.object(response, 'MAX_VALUES', 20):
            with self.assertRaisesRegex(ValueError, 'value limit'):
                self.prepare(values)
        self.assertLess(values.visited, 20)


if __name__ == '__main__':
    unittest.main()
