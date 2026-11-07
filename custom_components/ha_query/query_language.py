"""Bounded, declarative filters for live HA data; never evaluate user code."""
from __future__ import annotations

from dataclasses import dataclass
from math import isfinite
from typing import Any

MISSING = object()
MAX_FILTER_NODES = 256
MAX_GROUP_CHILDREN = 100
GROUPS = {'all', 'any', 'not'}
OPERATORS = {'eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'in', 'contains', 'starts_with', 'ends_with', 'exists'}
ALIASES = {'domain': 'domain', 'device_class': 'entity.attributes.device_class', 'state': 'entity.state',
           'unit': 'entity.unit', 'name': 'entity.name', 'entity_name': 'entity.name'}
WILDCARD_FIELDS = {'entity_id', 'entity.name'}
BASE_FIELDS = {
    'entity_id', 'domain', 'entity.name', 'entity.state', 'entity.unit', 'entity.disabled', 'entity.platform',
    'device.id', 'device.name', 'device.manufacturer', 'device.model', 'area.id', 'area.name', 'battery.level',
    'history.last_change', 'history.days_inactive', 'history.status',
}


@dataclass(frozen=True)
class Condition:
    field: str
    op: str
    value: Any = None


@dataclass(frozen=True)
class Group:
    op: str
    children: tuple[Expression, ...]


type Expression = Condition | Group


def valid_field(field: Any, source: str = 'entities') -> bool:
    if not isinstance(field, str) or not 1 <= len(field) <= 160:
        return False
    if field.startswith('entity.attributes.'):
        parts = field.split('.')
        return 3 <= len(parts) <= 7 and all(parts) and source == 'entities'
    if field not in BASE_FIELDS:
        return False
    if source == 'devices':
        return field.startswith(('device.', 'area.', 'battery.', 'history.'))
    return not field.startswith('history.')


def validate_field(field: Any, source: str = 'entities') -> str:
    if not valid_field(field, source):
        raise ValueError(f'Unsupported field for {source}: {field!r}')
    return field


def _number(value: Any) -> float | None:
    if isinstance(value, bool) or value is None:
        return None
    try:
        result = float(value)
    except (TypeError, ValueError, OverflowError):
        return None
    return result if isfinite(result) else None


def _condition(field: Any, op: Any, value: Any = None, *, has_value: bool = True) -> Condition:
    validate_field(field)
    if op not in OPERATORS:
        raise ValueError(f'Unsupported operator: {op!r}')
    if op == 'exists':
        if has_value and not isinstance(value, bool):
            raise ValueError('exists requires a boolean value')
        return Condition(field, op, value if has_value else True)
    if not has_value:
        raise ValueError(f'{op} requires a value')
    if op == 'in':
        if not isinstance(value, list) or not 1 <= len(value) <= 100 or any(not _scalar(item) for item in value):
            raise ValueError('in requires a list of 1-100 scalar values')
    elif op in {'gt', 'gte', 'lt', 'lte'}:
        if _number(value) is None:
            raise ValueError(f'{op} requires a finite numeric value')
    elif op in {'contains', 'starts_with', 'ends_with'} and not _scalar(value):
        raise ValueError(f'{op} requires a scalar value')
    elif not _scalar(value):
        raise ValueError(f'{op} requires a scalar value')
    patterns = value if op == 'in' else [value]
    if field in WILDCARD_FIELDS and op in {'eq', 'in'} and any(
            isinstance(pattern, str) and '*' in pattern and len(pattern) > 256 for pattern in patterns):
        raise ValueError('Wildcard patterns must contain at most 256 characters')
    return Condition(field, op, value)


def _scalar(value: Any) -> bool:
    return value is None or isinstance(value, (str, int, float, bool))


def _exclusions(value: Any, budget: list[int]) -> Group:
    if not isinstance(value, dict) or not value:
        raise ValueError('exclude must be a non-empty mapping of entity_id or entity_name patterns')
    result = []
    for field, operand in value.items():
        field = ALIASES.get(field, field)
        if field not in WILDCARD_FIELDS:
            raise ValueError('exclude supports only entity_id and entity_name')
        result.append(_condition(field, 'in' if isinstance(operand, list) else 'eq', operand))
        budget[0] += 1
        if budget[0] > 100:
            raise ValueError('Filter exceeds 100 conditions')
    return Group('not', (Group('any', tuple(result)),))


def parse_filter(value: Any, depth: int = 0, budget: list[int] | None = None) -> Expression:
    if budget is None:
        budget = [0, 0]
    budget[1] += 1
    if budget[1] > MAX_FILTER_NODES:
        raise ValueError(f'Filter exceeds {MAX_FILTER_NODES} nodes')
    if depth > 8:
        raise ValueError('Filter nesting exceeds 8 levels')
    if not isinstance(value, dict):
        raise ValueError('Filter must be a mapping')
    if 'exclude' in value:
        positive = {key: operand for key, operand in value.items() if key != 'exclude'}
        return Group('all', (parse_filter(positive, depth, budget), _exclusions(value['exclude'], budget)))
    if len(value) == 1 and (group := next(iter(value))) in GROUPS:
        children = value[group]
        if not isinstance(children, list) or not children or (group == 'not' and len(children) != 1):
            raise ValueError(f'{group} requires {"exactly one" if group == "not" else "a non-empty list of"} filter(s)')
        if len(children) > MAX_GROUP_CHILDREN:
            raise ValueError(f'Filter group exceeds {MAX_GROUP_CHILDREN} children (at most 100 conditions)')
        return Group(group, tuple(parse_filter(child, depth + 1, budget) for child in children))
    if 'field' in value or 'op' in value:
        if set(value) - {'field', 'op', 'value'} or not {'field', 'op'} <= set(value):
            raise ValueError('Condition requires field and op, with an optional value')
        budget[0] += 1
        if budget[0] > 100:
            raise ValueError('Filter exceeds 100 conditions')
        return _condition(value['field'], value['op'], value.get('value'), has_value='value' in value)
    result = []
    for shorthand, operand in value.items():
        if shorthand in GROUPS or shorthand in {'has_entity', 'history'}:
            raise ValueError(f'Mixed filter shorthand is not supported: {shorthand}')
        field = ALIASES.get(shorthand, shorthand)
        if isinstance(operand, dict) and len(operand) == 1:
            op, expected = next(iter(operand.items()))
            result.append(_condition(field, op, expected))
        elif isinstance(operand, list):
            result.append(_condition(field, 'in', operand))
        else:
            result.append(_condition(field, 'eq', operand))
        budget[0] += 1
        if budget[0] > 100:
            raise ValueError('Filter exceeds 100 conditions')
    return Group('all', tuple(result))


def uses_legacy_state(query: dict) -> bool:
    """Keep numeric/null state output only for the original sensor shorthand."""
    where = query['where']
    classes = where.get('device_class')
    class_list = classes if isinstance(classes, list) else [classes]
    return query['from'] == 'entities' and set(where) - {'exclude'} <= {'device_class', 'state'} and any(
        isinstance(device_class, str) and device_class in {'power', 'battery'} for device_class in class_list)


def validate_query(query: dict) -> tuple[Expression, dict | None]:
    if not isinstance(query.get('where'), dict):
        raise ValueError('where must be a mapping')
    source = query['from']
    where = dict(query['where'])
    history = None
    if source == 'devices':
        selector = where.pop('has_entity', {})
        history = where.pop('history', None)
        if where:
            raise ValueError('Device where supports only has_entity and history')
        where = selector
        if history is not None:
            if not isinstance(history, dict):
                raise ValueError('history must be a mapping')
            history = dict(history)
            if set(history) - {'scope', 'no_changes_for'}:
                raise ValueError('Invalid history configuration')
            if history.get('scope', 'all_entities') not in {'all_entities', 'matching_entities'}:
                raise ValueError('history.scope must be all_entities or matching_entities')
            history['scope'] = history.get('scope', 'all_entities')
            duration = history.get('no_changes_for', '14d')
            if not isinstance(duration, str) or not duration[:-1].isdigit() or not duration.endswith('d') or not 1 <= int(duration[:-1]) <= 365:
                raise ValueError('no_changes_for must be a duration from 1d through 365d')
            history['days'] = int(duration[:-1])
    expression = parse_filter(where)
    # Preserve the original examples' sensor/unit/missing-value semantics.
    # Explicit entity.attributes.* filters use the unrestricted generic path.
    classes = where.get('device_class')
    class_list = classes if isinstance(classes, list) else [classes]
    if uses_legacy_state(query):
        legacy = []
        for device_class in class_list:
            branch = [Condition('entity.attributes.device_class', 'eq', device_class)]
            if device_class in {'power', 'battery'}:
                branch.append(Condition('domain', 'eq', 'sensor'))
                branch.append(Condition('entity.unit' if device_class == 'battery' else 'entity.state',
                                        'eq' if device_class == 'battery' else 'exists',
                                        '%' if device_class == 'battery' else True))
            legacy.append(Group('all', tuple(branch)))
        expression = Group('all', (*expression.children, Group('any', tuple(legacy))))
    columns = query.get('columns', [])
    if not 0 <= len(columns) <= 32 or len(set(columns)) != len(columns):
        raise ValueError('Columns must contain at most 32 unique fields')
    for field in columns:
        validate_field(field, source)
    if 'by' in query.get('sort', {}):
        validate_field(query['sort']['by'], source)
    return expression, history


def _equal(actual: Any, expected: Any) -> bool:
    if isinstance(actual, (dict, list)) or isinstance(expected, (dict, list)):
        return actual == expected
    if isinstance(actual, bool) or isinstance(expected, bool):
        return type(actual) is type(expected) and actual == expected
    if isinstance(actual, (int, float)) and isinstance(expected, (int, float)):
        return actual == expected
    return str(actual) == str(expected)


def _wildcard_match(actual: str, pattern: str) -> bool:
    actual_index = pattern_index = 0
    star = retry = -1
    while actual_index < len(actual):
        if pattern_index < len(pattern) and pattern[pattern_index] == actual[actual_index] and pattern[pattern_index] != '*':
            actual_index += 1
            pattern_index += 1
        elif pattern_index < len(pattern) and pattern[pattern_index] == '*':
            star = pattern_index
            retry = actual_index
            pattern_index += 1
        elif star >= 0:
            pattern_index = star + 1
            retry += 1
            actual_index = retry
        else:
            return False
    while pattern_index < len(pattern) and pattern[pattern_index] == '*':
        pattern_index += 1
    return pattern_index == len(pattern)


def _text_equal(condition: Condition, actual: Any, expected: Any) -> bool:
    if condition.field in WILDCARD_FIELDS and isinstance(actual, str) and isinstance(expected, str) and '*' in expected:
        return _wildcard_match(actual, expected)
    return _equal(actual, expected)


def evaluate_condition(condition: Condition, row: dict) -> bool:
    actual = row.get(condition.field, MISSING)
    if actual is MISSING and condition.field.startswith('entity.attributes.'):
        actual = row.get('_attributes', {})
        for part in condition.field.split('.')[2:]:
            if not isinstance(actual, dict) or part not in actual:
                actual = MISSING
                break
            actual = actual[part]
    op, expected = condition.op, condition.value
    if op == 'exists':
        return (actual is not MISSING and actual is not None) == expected
    if actual is MISSING or actual is None:
        return False
    if op == 'eq':
        return _text_equal(condition, actual, expected)
    if op == 'ne':
        return not _equal(actual, expected)
    if op == 'in':
        return any(_text_equal(condition, actual, item) for item in expected)
    if op in {'gt', 'gte', 'lt', 'lte'}:
        left, right = _number(actual), _number(expected)
        if left is None or right is None:
            return False
        return {'gt': left > right, 'gte': left >= right, 'lt': left < right, 'lte': left <= right}[op]
    if op == 'contains':
        if isinstance(actual, str):
            return isinstance(expected, str) and expected in actual
        if isinstance(actual, (list, tuple)):
            return any(_equal(item, expected) for item in actual)
        return False
    if op == 'starts_with':
        return isinstance(actual, str) and isinstance(expected, str) and actual.startswith(expected)
    if op == 'ends_with':
        return isinstance(actual, str) and isinstance(expected, str) and actual.endswith(expected)
    raise AssertionError('Validated operator is not implemented')


def matches(expression: Expression, row: dict) -> bool:
    if isinstance(expression, Condition):
        return evaluate_condition(expression, row)
    if expression.op == 'all':
        return all(matches(child, row) for child in expression.children)
    if expression.op == 'any':
        return any(matches(child, row) for child in expression.children)
    return not matches(expression.children[0], row)
