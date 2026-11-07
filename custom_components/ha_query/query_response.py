"""Prepare bounded, JSON-safe query results without encoding an entire payload."""
from dataclasses import fields, is_dataclass
from datetime import date, datetime, time
import json
from math import isfinite

from homeassistant.helpers.json import json_bytes

MAX_RESPONSE_BYTES = 4_000_000
MAX_DEPTH = 32
MAX_VALUES = 100_000
_ATTRIBUTE_PREFIX = 'entity.attributes.'


def prepare_response(rows, columns, warnings, sort_field, *, message_id=None) -> dict:
    """Copy results, preserving metadata and omitting missing attribute columns.

    Pass the WebSocket message id to budget its exact result envelope too.
    Supports JSON containers, dates/times, sets, tuples and dataclasses; arbitrary
    as_dict/json_fragment hooks are deliberately not executed.
    """
    remaining = MAX_RESPONSE_BYTES
    work = MAX_VALUES

    def charge(size):
        nonlocal remaining
        remaining -= size
        if remaining < 0:
            raise ValueError('Response exceeds 4 MB; select fewer columns or rows')

    def visit(depth):
        nonlocal work
        work -= 1
        if depth > MAX_DEPTH or work < 0:
            raise ValueError('Response exceeds nesting or value limit')

    def string(value):
        # UTF-8 JSON needs at least one byte per character, plus quotes.
        if len(value) + 2 > remaining:
            charge(len(value) + 2)
        charge(2)
        for offset in range(0, len(value), 4096):
            charge(len(json_bytes(value[offset:offset + 4096])) - 2)
        return value

    def mapping(items, depth):
        charge(2)
        result = {}
        for index, (key, value) in enumerate(items):
            visit(depth)
            if not isinstance(key, str):
                if key is not None and not isinstance(key, (bool, int, float)):
                    raise TypeError('Unsupported response dictionary key type')
                if isinstance(key, float) and not isfinite(key):
                    raise ValueError('Non-finite numbers are not supported in responses')
                if isinstance(key, int) and key.bit_length() > 64:
                    raise ValueError('Response integer exceeds JSON wire range')
                key = next(iter(json.loads(json_bytes({key: None}))))
            charge(1 + bool(index))  # Colon and optional comma.
            string(key)
            result[key] = normalize(value, depth + 1)
        return result

    def sequence(items, depth):
        charge(2)
        result = []
        for index, value in enumerate(items):
            charge(bool(index))
            result.append(normalize(value, depth + 1))
        return result

    def normalize(value, depth):
        visit(depth)
        if isinstance(value, str):
            return string(value)
        if value is None or isinstance(value, (bool, int, float)):
            if isinstance(value, float) and not isfinite(value):
                raise ValueError('Non-finite numbers are not supported in responses')
            if isinstance(value, int) and value.bit_length() > 64:
                raise ValueError('Response integer exceeds JSON wire range')
            charge(len(json_bytes(value)))
            return value
        if isinstance(value, (datetime, date, time)):
            # Use HA's native encoder for its exact datetime formatting.
            return string(json.loads(json_bytes(value)))
        if isinstance(value, dict):
            return mapping(value.items(), depth)
        if isinstance(value, (list, tuple, set)):
            return sequence(value, depth)
        if is_dataclass(value) and not isinstance(value, type):
            if len(value.__dataclass_fields__) > work:
                raise ValueError('Response exceeds value limit')
            return mapping(((field.name, getattr(value, field.name))
                            for field in fields(value) if not field.name.startswith('_')), depth)
        raise TypeError('Unsupported response value type')

    def row_items(row):
        for key, value in row.items():
            visit(2)
            if key == '_attributes' or key in dynamic_columns:
                continue
            if key == sort_field and key.startswith(_ATTRIBUTE_PREFIX) and key not in columns:
                continue
            yield key, value
        for column in dynamic_columns:
            value = row.get('_attributes', {})
            for part in column.split('.')[2:]:
                if not isinstance(value, dict) or part not in value:
                    break
                value = value[part]
            else:
                yield column, value

    if message_id is not None:
        if type(message_id) is not int or message_id.bit_length() > 64:
            raise ValueError('Invalid WebSocket message id')
        charge(len(json_bytes({'id': message_id, 'type': 'result', 'success': True, 'result': None})) - 4)
    charge(len(json_bytes({'columns': None, 'rows': None, 'warnings': None})) - 12)
    result = {'columns': normalize(columns, 1)}
    dynamic_columns = dict.fromkeys(column for column in result['columns'] if column.startswith(_ATTRIBUTE_PREFIX))
    charge(2)
    prepared_rows = []
    for index, row in enumerate(rows):
        visit(2)
        charge(bool(index))
        prepared_rows.append(mapping(row_items(row), 2))
    result['rows'] = prepared_rows
    result['warnings'] = normalize(warnings, 1)
    return result
