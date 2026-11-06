"""Generic query parsing, bounds, type semantics and compatibility."""
from copy import deepcopy
import unittest

from custom_components.ha_query.query_language import matches, parse_filter, validate_query


def entity_query(where, **changes):
    return {'from': 'entities', 'where': where, 'columns': [], 'sort': {}, 'limit': 100, **changes}


def condition(field, op, value=None, has_value=True):
    return parse_filter({'field': field, 'op': op, **({'value': value} if has_value else {})})


class QueryLanguageTests(unittest.TestCase):
    def test_shorthand_aliases_and_boolean_groups(self):
        where = {'all': [
            {'domain': {'in': ['light', 'switch']}},
            {'any': [
                {'entity.state': {'eq': 'on'}},
                {'entity.attributes.brightness': {'gte': 200}},
            ]},
            {'not': [{'area.name': {'eq': 'Garage'}}]},
        ]}
        expression, _ = validate_query(entity_query(where))
        self.assertTrue(matches(expression, {'domain': 'light', 'entity.state': 'off',
                                '_attributes': {'brightness': 255}, 'area.name': 'Kitchen'}))
        self.assertFalse(matches(expression, {'domain': 'light', 'entity.state': 'off',
                                 '_attributes': {'brightness': 100}, 'area.name': 'Kitchen'}))
        self.assertFalse(matches(expression, {'domain': 'light', 'entity.state': 'on', 'area.name': 'Garage'}))

    def test_all_operators(self):
        cases = [
            ('eq', '20', True), ('eq', 20, True), ('ne', 21, True),
            ('gt', 19, True), ('gte', 20, True), ('lt', 21, True), ('lte', 20, True),
            ('in', ['19', 20], True), ('in', ['19'], False),
            ('contains', '2', True), ('starts_with', '2', True), ('ends_with', '0', True),
        ]
        for op, value, expected in cases:
            with self.subTest(op=op, value=value):
                self.assertEqual(matches(condition('entity.state', op, value), {'entity.state': '20'}), expected)

    def test_equality_does_not_coerce_booleans(self):
        for actual, expected in [(True, 1), (1, True), (False, 0), (0, False)]:
            self.assertFalse(matches(condition('entity.state', 'eq', expected), {'entity.state': actual}))
        self.assertTrue(matches(condition('entity.state', 'eq', True), {'entity.state': True}))

    def test_numeric_comparisons_reject_bad_actual_values(self):
        for actual in [None, True, False, '', 'NaN', 'inf', '-inf', [], {}, 'unknown']:
            with self.subTest(actual=repr(actual)):
                self.assertFalse(matches(condition('entity.state', 'gt', 0), {'entity.state': actual}))
        self.assertTrue(matches(condition('entity.state', 'gt', 0), {'entity.state': 0.1}))

    def test_missing_fields_and_exists(self):
        self.assertFalse(matches(condition('entity.attributes.missing', 'ne', 'x'), {'_attributes': {}}))
        self.assertFalse(matches(condition('entity.attributes.missing', 'exists', True), {'_attributes': {}}))
        self.assertTrue(matches(condition('entity.attributes.missing', 'exists', False), {'_attributes': {}}))
        self.assertFalse(matches(condition('entity.attributes.missing', 'exists', True), {'_attributes': {'missing': None}}))
        self.assertTrue(matches(condition('entity.attributes.missing', 'exists', False), {'_attributes': {'missing': None}}))
        self.assertTrue(matches(parse_filter({'not': [{'field': 'entity.attributes.missing', 'op': 'eq', 'value': 'x'}]}), {}))

    def test_nested_attributes_and_collection_contains(self):
        expression = condition('entity.attributes.options.levels', 'contains', 'high')
        self.assertTrue(matches(expression, {'_attributes': {'options': {'levels': ['low', 'high']}}}))
        self.assertFalse(matches(expression, {'_attributes': {'options': {'levels': ['low']}}}))
        self.assertFalse(matches(expression, {'_attributes': {'options': 'invalid'}}))

    def test_device_fields_and_history_config(self):
        query = {'from': 'devices', 'where': {
            'has_entity': {'all': [{'domain': 'climate'}, {'state': {'ne': 'off'}}]},
            'history': {'scope': 'matching_entities', 'no_changes_for': '7d'},
        }, 'columns': ['device.manufacturer', 'history.last_change'], 'sort': {'by': 'history.days_inactive'}, 'limit': 500}
        expression, history = validate_query(query)
        self.assertTrue(matches(expression, {'domain': 'climate', 'entity.state': 'heat'}))
        self.assertEqual(history, {'scope': 'matching_entities', 'no_changes_for': '7d', 'days': 7})

    def test_device_query_without_history_needs_no_recorder(self):
        _, history = validate_query({'from': 'devices', 'where': {'has_entity': {'domain': 'light'}}})
        self.assertIsNone(history)

    def test_validation_does_not_mutate_query(self):
        query = entity_query({'device_class': 'battery'}, columns=['entity.attributes.device_class'])
        original = deepcopy(query)
        validate_query(query)
        validate_query(query)
        self.assertEqual(query, original)
        device_query = {'from': 'devices', 'where': {'has_entity': {'device_class': 'battery'}, 'history': {'scope': 'all_entities'}}}
        original = deepcopy(device_query)
        validate_query(device_query)
        validate_query(device_query)
        self.assertEqual(device_query, original)

    def test_invalid_conditions(self):
        cases = [
            {'field': 'domain', 'op': 'bad', 'value': 'sensor'},
            {'field': 'domain', 'op': 'eq'}, {'field': 'domain'},
            {'field': 'domain', 'op': 'eq', 'value': 'sensor', 'extra': True},
            {'field': 'domain', 'op': 'in', 'value': []},
            {'field': 'domain', 'op': 'in', 'value': 'sensor'},
            {'field': 'domain', 'op': 'in', 'value': [{}]},
            {'field': 'entity.state', 'op': 'gt', 'value': 'NaN'},
            {'field': 'entity.state', 'op': 'gt', 'value': True},
            {'field': 'entity.state', 'op': 'contains', 'value': []},
            {'field': 'entity.state', 'op': 'exists', 'value': 1},
            {'field': 'entity.state', 'op': 'eq', 'value': {}},
            {'field': 'entity.state', 'op': 'eq', 'value': []},
            {'field': 'history.status', 'op': 'eq', 'value': 'inactive'},
            {'field': 'entity.attributes..bad', 'op': 'exists'},
            {'field': 'entity.state.__class__', 'op': 'exists'},
        ]
        for where in cases:
            with self.subTest(where=where), self.assertRaises(ValueError):
                parse_filter(where)

    def test_groups_must_be_well_formed(self):
        for where in [{'all': []}, {'all': {}}, {'not': []}, {'not': [{'domain': 'light'}, {'domain': 'switch'}]},
                      {'all': [{'domain': 'light'}], 'domain': 'sensor'}, []]:
            with self.subTest(where=where), self.assertRaises(ValueError):
                parse_filter(where)

    def test_condition_count_and_nesting_bounds(self):
        parse_filter({'all': [{'domain': {'eq': 'sensor'}} for _ in range(100)]})
        with self.assertRaisesRegex(ValueError, '100 conditions'):
            parse_filter({'all': [{'domain': {'eq': 'sensor'}} for _ in range(101)]})
        nested = {'domain': 'sensor'}
        for _ in range(8):
            nested = {'not': [nested]}
        parse_filter(nested)
        with self.assertRaisesRegex(ValueError, 'nesting'):
            parse_filter({'not': [nested]})

    def test_device_fields_are_limited_to_device_rows(self):
        for field in ['entity.state', 'entity.attributes.battery', 'domain', 'history.bad']:
            with self.subTest(field=field), self.assertRaises(ValueError):
                validate_query({'from': 'devices', 'where': {}, 'columns': [field]})
        for field in ['device.id', 'device.name', 'device.manufacturer', 'device.model', 'area.name', 'history.status']:
            validate_query({'from': 'devices', 'where': {}, 'columns': [field]})

    def test_history_validation(self):
        for history in [[], {'scope': 'invalid'}, {'scope': 'all_entities', 'extra': 1},
                        {'scope': 'all_entities', 'no_changes_for': '0d'},
                        {'scope': 'all_entities', 'no_changes_for': '366d'},
                        {'scope': 'all_entities', 'no_changes_for': 14}]:
            with self.subTest(history=history), self.assertRaises(ValueError):
                validate_query({'from': 'devices', 'where': {'history': history}})
