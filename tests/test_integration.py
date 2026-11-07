"""HA 2026.11 contracts with in-memory state, resources and executor fixtures.

Uses real HA schemas and WebSocket decorators, without starting an HA server.
"""
import asyncio
from datetime import datetime, timezone
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace as NS
import unittest
from unittest.mock import AsyncMock, Mock, patch

from homeassistant.components import recorder, websocket_api
from homeassistant.exceptions import HomeAssistantError
from homeassistant.core import HomeAssistant
from homeassistant.components.lovelace.resources import ResourceStorageCollection

from custom_components import ha_query as integration
from custom_components.ha_query import query_execution as execution
from custom_components.ha_query.config_flow import HaQueryConfigFlow
from custom_components.ha_query.query_language import validate_query


def validate_where(q):
    _, history = validate_query(q)
    return history['days'] if history else None


def entities(hass, q, user):
    expression, _ = validate_query(q)
    return execution._entities(hass, q, user, expression)


async def battery(hass, days, user):
    q = query('devices')
    q['where']['history']['no_changes_for'] = f'{days}d'
    expression, history = validate_query(q)
    return await execution._devices(hass, q, user, expression, history)


def query(source='entities', **changes):
    where = {'device_class': 'power'} if source == 'entities' else {
        'has_entity': {'device_class': 'battery'},
        'history': {'scope': 'all_entities'},
    }
    return integration.QUERY_SCHEMA({'from': source, 'where': where, **changes})


class ValidationTests(unittest.TestCase):
    def test_supported_shapes_and_defaults(self):
        self.assertIsNone(validate_where(query()))
        self.assertEqual(validate_where(query('devices')), 14)
        self.assertEqual(query()['limit'], 100)
        self.assertFalse(query()['parse_state'])

    def test_nonfinite_and_boolean_thresholds_rejected(self):
        for threshold in ['NaN', 'inf', '-inf', True, False, None, [], {}, 10**400]:
            with self.subTest(threshold=repr(threshold)), self.assertRaises(ValueError):
                validate_where(query(where={'device_class': 'power', 'state': {'gt': threshold}}))
        for threshold in [-1, 0, 0.5, '2']:
            self.assertIsNone(validate_where(query(where={'device_class': 'power', 'state': {'gt': threshold}})))

    def test_columns_and_sort_are_shape_specific(self):
        for changes in [
            {'columns': ['entity.states']}, {'columns': ['history.status']},
            {'columns': ['entity.name'] * 2}, {'columns': ['entity.name'] * 33},
            {'sort': {'by': 'typo'}}, {'sort': {'by': ''}},
        ]:
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                validate_where(query(**changes))
        self.assertIsNone(validate_where(query(columns=['entity.name'], sort={'by': 'entity.state'})))

    def test_invalid_filters_and_durations(self):
        for where in [{'device_class': {'bad': 'energy'}}, {'device_class': 'power', 'extra': 1},
                      {'device_class': 'power', 'state': {'lt': 1, 'gt': 0}}]:
            with self.subTest(where=where), self.assertRaises(ValueError):
                validate_where(query(where=where))
        for duration in ['0d', '366d', '-1d', '1h', '1.5d', None, {}]:
            q = query('devices')
            q['where']['history']['no_changes_for'] = duration
            with self.subTest(duration=duration), self.assertRaises(ValueError):
                validate_where(q)
        for duration in ['1d', '365d']:
            q = query('devices')
            q['where']['history']['no_changes_for'] = duration
            self.assertEqual(validate_where(q), int(duration[:-1]))

    def test_schema_rejects_invalid_envelope(self):
        for changes in [{'limit': 0}, {'limit': 501}, {'extra': True}, {'sort': {'extra': True}}, {'parse_state': []}]:
            with self.subTest(changes=changes), self.assertRaises(integration.vol.Invalid):
                query(**changes)

    def test_release_contract(self):
        root = Path(__file__).resolve().parents[1]
        manifest = json.loads((root / 'custom_components/ha_query/manifest.json').read_text())
        self.assertRegex(manifest['version'], r'^\d+\.\d+\.\d+$')
        self.assertEqual(manifest['documentation'], 'https://github.com/adamcsk1/ha-query')
        self.assertEqual(manifest['issue_tracker'], 'https://github.com/adamcsk1/ha-query/issues')
        self.assertTrue({'recorder', 'http', 'websocket_api', 'lovelace'} <= set(manifest['dependencies']))
        self.assertEqual(json.loads((root / 'hacs.json').read_text())['homeassistant'], '2026.11.0')
        self.assertEqual(HaQueryConfigFlow.VERSION, 1)

class HomeAssistantContractTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        folder = self.enterContext(tempfile.TemporaryDirectory())
        self.hass = HomeAssistant(folder)
        self.addAsyncCleanup(self.hass.async_stop, force=True)

    async def test_real_registration_state_and_task_scheduling(self):
        self.hass.http = NS(async_register_static_paths=AsyncMock())
        self.hass.config_entries = NS(async_wait_initialized=AsyncMock())
        execution.dr.async_setup(self.hass)
        await execution.dr.async_load(self.hass, load_empty=True)
        await execution.er.async_load(self.hass, load_empty=True)
        await integration.async_setup(self.hass, {})
        handler, schema = self.hass.data['websocket_api']['ha_query/run']
        self.hass.data[integration.DOMAIN]['active'] = object()
        self.hass.states.async_set('sensor.visible', '12', {'device_class': 'power'})
        self.hass.states.async_set('sensor.hidden', '99', {'device_class': 'power'})
        connection = NS(user=NS(permissions=NS(check_entity=lambda eid, policy: eid in {'sensor.visible', 'light.office'})),
                        send_result=Mock(), send_error=Mock(), async_handle_exception=Mock())
        handler(self.hass, connection, schema({'id': 1, 'type': 'ha_query/run', 'query': query()}))
        await self.hass.async_block_till_done(wait_background_tasks=True)
        connection.async_handle_exception.assert_not_called()
        connection.send_error.assert_not_called()
        self.assertEqual([r['entity_id'] for r in connection.send_result.call_args.args[1]['rows']], ['sensor.visible'])
        self.hass.states.async_set('light.office', 'on', {'brightness': 128})
        generic = query(where={'all': [{'domain': 'light'}, {'entity.attributes.brightness': {'gte': 100}}]},
                        columns=['entity_id', 'entity.attributes.brightness'])
        handler(self.hass, connection, schema({'id': 2, 'type': 'ha_query/run', 'query': generic}))
        await self.hass.async_block_till_done(wait_background_tasks=True)
        connection.async_handle_exception.assert_not_called()
        self.assertEqual(connection.send_result.call_args.args[1]['rows'][0]['entity.attributes.brightness'], 128)

    async def test_real_resource_collection_loads_once_and_preserves_pending_edits(self):
        resources = ResourceStorageCollection(self.hass, NS(async_load=AsyncMock(return_value={})))
        self.hass.data['lovelace'] = NS(resources=resources)
        with patch.object(resources, '_async_load_data', AsyncMock(return_value={'items': []})) as load:
            with patch.object(resources.store, 'async_delay_save'):
                self.assertIs(await integration._resources(self.hass), resources)
                created = await resources.async_create_item({'url': '/manual.js', 'res_type': 'module'})
                self.assertIs(await integration._resources(self.hass), resources)
                load.assert_awaited_once()
                self.assertEqual(resources.async_items(), [created])

    async def test_real_recorder_health_contract(self):
        from homeassistant.components.recorder.core import Recorder

        self.hass.data['recorder'] = NS(db_connected=self.hass.loop.create_future())
        instance = Recorder(self.hass, True, True, 10, 5, 'sqlite://', 1, 1, None, set())
        self.assertFalse(instance.is_running)
        self.assertFalse(instance.recording)
        instance.is_running = True
        instance._event_listener = lambda: None
        self.assertTrue(instance.is_running and instance.recording)
        instance._event_listener = None
        self.assertFalse(instance.recording)


class IntegrationTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.states = {}
        self.entities = {}
        self.devices = {}
        self.areas = {'kitchen': NS(id='kitchen', name='Kitchen'), 'office': NS(id='office', name='Office')}
        self.denied = set()
        self.excluded = set()
        self.user = NS(permissions=NS(check_entity=lambda eid, policy: eid not in self.denied))
        self.connection = NS(user=self.user, send_result=Mock(), send_error=Mock())
        self.hass = NS(
            data={}, states=NS(get=self.states.get, async_all=lambda domain=None: [
                state for eid, state in self.states.items() if domain is None or eid.startswith(domain + '.')]),
            http=NS(async_register_static_paths=AsyncMock()),
            config_entries=NS(async_update_entry=lambda entry, data: setattr(entry, 'data', data)),
        )
        self.entry = NS(data={})
        self.now = datetime.now(timezone.utc).timestamp()
        self.old = self.now - 40 * 86400
        self.updates = {}
        self.oldest = self.old

        def executor(*args):
            future = asyncio.get_running_loop().create_future()
            future.set_result((self.updates.copy(), self.oldest))
            return future

        self.hass.async_add_executor_job = Mock(side_effect=executor)
        self.enterContext(patch.object(execution.er, 'async_get', return_value=NS(entities=self.entities, async_get=self.entities.get)))
        self.enterContext(patch.object(execution.dr, 'async_get', return_value=NS(async_get=lambda device_id, **kwargs: self.devices.get(device_id))))
        self.enterContext(patch.object(execution.ar, 'async_get', return_value=NS(async_get_area=self.areas.get)))
        self.recorder = NS(db_url='sqlite:////config/history.db', recording=True, is_running=True)
        self.enterContext(patch.object(recorder, 'get_instance', return_value=self.recorder))
        self.enterContext(patch.object(recorder, 'is_entity_recorded', side_effect=lambda hass, eid: eid not in self.excluded))
        register = self.enterContext(patch.object(websocket_api, 'async_register_command'))
        await integration.async_setup(self.hass, {})
        self.handler = register.call_args.args[1]
        self.hass.data[integration.DOMAIN]['active'] = object()

    def add_entity(self, eid, device_class, value='50', device='dev', disabled=None, name=None):
        self.entities[eid] = NS(entity_id=eid, device_id=device, disabled_by=disabled, area_id=None, platform='test')
        self.states[eid] = NS(entity_id=eid, domain=eid.split('.')[0], name=name or eid, state=value,
                              last_updated=datetime.fromtimestamp(self.old, timezone.utc),
                              attributes={'device_class': device_class, 'unit_of_measurement': '%' if device_class == 'battery' else 'W'})
        self.devices[device] = NS(id=device, name='Device', name_by_user=None, area_id=None, manufacturer='Test', model='Model')

    def battery_fixture(self):
        self.add_entity('sensor.battery', 'battery')
        self.add_entity('sensor.other', 'temperature')
        self.updates = {'sensor.battery': self.old, 'sensor.other': self.old}

    async def run_query(self, q=None):
        msg = self.handler._ws_schema({'id': 1, 'type': 'ha_query/run', 'query': q or query()})
        # Unwrap only the task scheduler; exercise the real validated handler.
        await self.handler.__wrapped__(self.hass, self.connection, msg)

    async def test_setup_uses_real_websocket_contract(self):
        self.assertEqual(self.handler._ws_command, 'ha_query/run')
        self.hass.http.async_register_static_paths.assert_awaited_once()
        await self.run_query()
        result = self.connection.send_result.call_args.args[1]
        self.assertEqual(result['columns'], list(integration.COLUMNS['entities']))
        self.assertEqual(result['rows'], [])

    async def test_power_permissions_finite_values_and_sort(self):
        for eid, value in [('sensor.small', '9'), ('sensor.big', '100'), ('sensor.secret', '900'),
                           ('sensor.inf', 'inf'), ('sensor.nan', 'NaN'), ('sensor.off', 'unavailable')]:
            self.add_entity(eid, 'power', value)
        self.denied.add('sensor.secret')
        await self.run_query(query(sort={'by': 'entity.state', 'descending': True}, limit=1))
        rows = self.connection.send_result.call_args.args[1]['rows']
        self.assertEqual([row['entity_id'] for row in rows], ['sensor.big'])
        self.assertEqual(len(entities(self.hass, query(), self.user)), 2)

    async def test_websocket_compiles_query_once(self):
        self.battery_fixture()
        for q in (query(), query('devices')):
            with self.subTest(source=q['from']), patch.object(integration, 'validate_query', wraps=validate_query) as validate:
                await self.run_query(q)
                validate.assert_called_once()
                self.connection.send_error.assert_not_called()

    async def test_explicit_columns_replace_all_default_headers(self):
        self.add_entity('binary_sensor.window', 'window', 'off')
        columns = ['device.name', 'entity.state', 'entity.unit']
        await self.run_query(query(where={'domain': 'binary_sensor'}, columns=columns))
        result = self.connection.send_result.call_args.args[1]
        self.assertEqual(result['columns'], columns)
        self.assertEqual(len(result['rows']), 1)
        self.assertNotIn('entity_id', result['columns'])
        self.assertNotIn('entity.name', result['columns'])
        self.assertNotIn('area.id', result['columns'])
        self.assertNotIn('area.name', result['columns'])

    async def test_generic_power_and_battery_states_remain_raw(self):
        self.add_entity('sensor.power', 'power', 'unknown')
        self.add_entity('sensor.battery', 'battery', '101')
        self.add_entity('sensor.numeric', 'power', '12')
        for where in ({'domain': 'sensor'}, {'all': [{'device_class': ['power', 'battery']}]},
                      {'entity.state': {'in': ['unknown', '101', '12']}}):
            with self.subTest(where=where):
                await self.run_query(query(where=where))
                self.assertEqual([row['entity.state'] for row in self.connection.send_result.call_args.args[1]['rows']],
                                 ['unknown', '101', '12'])
        await self.run_query(query(where={'device_class': 'power'}))
        self.assertEqual([row['entity.state'] for row in self.connection.send_result.call_args.args[1]['rows']], [12])

    async def test_device_class_metadata_is_authorized_and_independent_of_columns(self):
        self.add_entity('binary_sensor.door', 'door', 'on')
        self.add_entity('binary_sensor.secret', 'motion', 'off')
        self.denied.add('binary_sensor.secret')
        await self.run_query(query(where={'domain': 'binary_sensor'}, columns=['entity.name', 'entity.state']))
        result = self.connection.send_result.call_args.args[1]
        self.assertEqual(result['columns'], ['entity.name', 'entity.state'])
        self.assertEqual(len(result['rows']), 1)
        self.assertEqual(result['rows'][0]['entity.device_class'], 'door')
        self.assertEqual(result['rows'][0]['domain'], 'binary_sensor')
        self.assertNotIn('_attributes', result['rows'][0])
        await self.run_query(query(where={'entity.device_class': 'door'}, columns=['entity.device_class']))
        self.assertEqual(self.connection.send_result.call_args.args[1]['rows'][0]['entity.device_class'], 'door')

    async def test_malformed_device_class_metadata_does_not_break_unrelated_columns(self):
        self.add_entity('binary_sensor.door', 'door', 'off')
        for device_class in (None, {}, 'x' * 65):
            with self.subTest(device_class=device_class):
                self.states['binary_sensor.door'].attributes['device_class'] = device_class
                await self.run_query(query(where={'domain': 'binary_sensor'}, columns=['entity.state']))
                self.connection.send_error.assert_not_called()
                self.assertIsNone(self.connection.send_result.call_args.args[1]['rows'][0]['entity.device_class'])

    async def test_battery_percentages_include_unavailable_exclude_binary_and_wrong_units(self):
        for eid, value in [('sensor.full', '100'), ('sensor.empty', '0'), ('sensor.offline', 'unavailable'),
                           ('sensor.nan', 'NaN'), ('sensor.high', '101'), ('sensor.low', '-1'),
                           ('sensor.secret', '25'), ('binary_sensor.low', 'on'), ('sensor.voltage', '3.1')]:
            self.add_entity(eid, 'battery', value)
        self.states['sensor.voltage'].attributes['unit_of_measurement'] = 'V'
        self.denied.add('sensor.secret')
        await self.run_query(query(where={'device_class': 'battery'}, sort={'by': 'entity.state'}))
        rows = self.connection.send_result.call_args.args[1]['rows']
        self.assertEqual([r['entity.state'] for r in rows], [0, 100, None, None, None, None])
        self.assertTrue(all(r['entity.unit'] == '%' for r in rows))
        self.assertTrue(all(r['area.name'] == 'Unassigned' for r in rows))
        self.hass.async_add_executor_job.assert_not_called()

    async def test_battery_threshold_omits_missing_values(self):
        self.add_entity('sensor.low', 'battery', '10')
        self.add_entity('sensor.high', 'battery', '90')
        self.add_entity('sensor.unknown', 'battery', 'unknown')
        await self.run_query(query(where={'device_class': 'battery', 'state': {'gt': 10}}))
        rows = self.connection.send_result.call_args.args[1]['rows']
        self.assertEqual([r['entity_id'] for r in rows], ['sensor.high'])

    async def test_multiple_device_classes_keep_power_and_battery_guards(self):
        self.add_entity('sensor.power', 'power', '10')
        self.add_entity('binary_sensor.power', 'power', 'on')
        self.add_entity('sensor.battery', 'battery', '80')
        self.add_entity('sensor.battery_volts', 'battery', '12')
        self.states['sensor.battery_volts'].attributes['unit_of_measurement'] = 'V'
        self.add_entity('sensor.temperature', 'temperature', '20')
        await self.run_query(query(where={'device_class': ['power', 'battery', 'temperature']}))
        rows = self.connection.send_result.call_args.args[1]['rows']
        self.assertEqual([row['entity_id'] for row in rows], ['sensor.power', 'sensor.battery', 'sensor.temperature'])

    async def test_parse_state_extracts_general_embedded_units(self):
        values = {
            'sensor.spaced': '12.5 W',
            'sensor.compact': '98.6%',
            'sensor.zero': '0W',
            'sensor.negative': '-2.5 kW',
            'sensor.exponent': '1e3 W',
            'sensor.invalid': 'unknown',
            'sensor.nonfinite': '1e999 W',
            'sensor.malformed': '12 W extra',
            'sensor.comma': '1,5 kW',
            'sensor.plain': '12',
            'sensor.precedence': '7 kW',
        }
        for eid, value in values.items():
            self.add_entity(eid, 'none', value)
            self.states[eid].attributes['unit_of_measurement'] = ''
        self.states['sensor.precedence'].attributes['unit_of_measurement'] = 'W'
        q = query(where={'domain': 'sensor'}, parse_state=True,
                  columns=['entity_id', 'entity.state', 'entity.unit'], sort={'by': 'entity_id'})
        await self.run_query(q)
        rows = self.connection.send_result.call_args.args[1]['rows']
        self.assertEqual({row['entity_id']: row['entity.state'] for row in rows}, {
            'sensor.spaced': 12.5, 'sensor.compact': 98.6, 'sensor.zero': 0,
            'sensor.negative': -2.5, 'sensor.exponent': 1000, 'sensor.invalid': 'unknown',
            'sensor.nonfinite': '1e999 W', 'sensor.malformed': '12 W extra', 'sensor.comma': '1,5 kW',
            'sensor.plain': '12', 'sensor.precedence': 7,
        })
        self.assertEqual({row['entity_id']: row['entity.unit'] for row in rows}, {
            'sensor.spaced': 'W', 'sensor.compact': '%', 'sensor.zero': 'W',
            'sensor.negative': 'kW', 'sensor.exponent': 'W', 'sensor.invalid': '',
            'sensor.nonfinite': '', 'sensor.malformed': '', 'sensor.comma': '',
            'sensor.plain': '', 'sensor.precedence': 'W',
        })

    async def test_parse_state_is_opt_in_and_supports_numeric_filters(self):
        self.add_entity('sensor.embedded', 'none', '12.5 W')
        self.states['sensor.embedded'].attributes['unit_of_measurement'] = ''
        where = {'all': [{'entity_id': 'sensor.embedded'}, {'state': {'gt': 0}}]}
        await self.run_query(query(where=where))
        self.assertEqual(self.connection.send_result.call_args.args[1]['rows'], [])
        await self.run_query(query(where=where, parse_state=True, columns=['entity.state', 'entity.unit']))
        rows = self.connection.send_result.call_args.args[1]['rows']
        self.assertEqual([{key: row[key] for key in ('entity.state', 'entity.unit')} for row in rows],
                         [{'entity.state': 12.5, 'entity.unit': 'W'}])

    async def test_parse_state_preserves_power_and_battery_conversion(self):
        self.add_entity('sensor.power', 'power', '12.5 W')
        self.add_entity('sensor.battery', 'battery', '98%')
        await self.run_query(query(where={'device_class': ['power', 'battery']}, parse_state=True,
                                   columns=['entity_id', 'entity.state'], sort={'by': 'entity_id'}))
        rows = self.connection.send_result.call_args.args[1]['rows']
        self.assertEqual([{key: row[key] for key in ('entity_id', 'entity.state')} for row in rows],
                         [{'entity_id': 'sensor.battery', 'entity.state': 98},
                          {'entity_id': 'sensor.power', 'entity.state': 12.5}])

    async def test_entity_id_name_patterns_exclusions_and_permissions(self):
        self.add_entity('sensor.kitchen_temperature', 'temperature', name='Kitchen Temperature')
        self.add_entity('sensor.office_temperature', 'temperature', name='Office Temperature')
        self.add_entity('sensor.kitchen_test', 'temperature', name='Kitchen Test Temperature')
        self.add_entity('sensor.kitchen_humidity', 'humidity', name='Kitchen Humidity')
        self.add_entity('sensor.kitchen_secret', 'temperature', name='Kitchen Secret Temperature')
        self.denied.add('sensor.kitchen_secret')
        await self.run_query(query(where={
            'entity_id': ['sensor.kitchen_*', 'sensor.office_*'],
            'entity_name': '*Temperature*',
            'exclude': {'entity_id': 'sensor.*_test', 'entity_name': '*Humidity*'},
        }))
        rows = self.connection.send_result.call_args.args[1]['rows']
        self.assertEqual([row['entity_id'] for row in rows], ['sensor.kitchen_temperature', 'sensor.office_temperature'])

    async def test_exclusion_combines_with_boolean_filters(self):
        self.add_entity('light.office', 'none', 'on', name='Office')
        self.add_entity('light.test', 'none', 'on', name='Office Test')
        self.add_entity('switch.office', 'none', 'on', name='Office Switch')
        await self.run_query(query(where={
            'all': [{'domain': {'in': ['light', 'switch']}}, {'state': 'on'}],
            'exclude': {'entity_name': '*Test*'},
        }))
        rows = self.connection.send_result.call_args.args[1]['rows']
        self.assertEqual([row['entity_id'] for row in rows], ['light.office', 'switch.office'])

    async def test_entity_area_override_device_fallback_and_unassigned(self):
        self.add_entity('sensor.power', 'power')
        self.devices['dev'].area_id = 'kitchen'
        row = entities(self.hass, query(), self.user)[0]
        self.assertEqual(row['area.name'], 'Kitchen')
        self.entities['sensor.power'].area_id = 'office'
        row = entities(self.hass, query(), self.user)[0]
        self.assertEqual(row['area.name'], 'Office')
        self.entities['sensor.power'].device_id = None
        self.assertEqual(entities(self.hass, query(), self.user)[0]['area.id'], 'office')
        self.entities['sensor.power'].area_id = 'deleted'
        self.assertIsNone(entities(self.hass, query(), self.user)[0]['area.id'])
        del self.entities['sensor.power']
        self.assertEqual(entities(self.hass, query(), self.user)[0]['area.name'], 'Unassigned')

    async def test_default_fourteen_days_override_and_device_area(self):
        self.battery_fixture()
        self.updates = {eid: self.now - 15 * 86400 for eid in self.updates}
        self.devices['dev'].area_id = 'kitchen'
        self.entities['sensor.battery'].area_id = 'office'
        await self.run_query(query('devices'))
        rows = self.connection.send_result.call_args.args[1]['rows']
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]['area.name'], 'Kitchen')
        q = query('devices')
        q['where']['history']['no_changes_for'] = '30d'
        await self.run_query(q)
        self.assertEqual(self.connection.send_result.call_args.args[1]['rows'], [])

    async def test_child_device_inherits_parent_area(self):
        self.add_entity('sensor.child', 'battery', device='child')
        self.devices['parent'] = NS(area_id='kitchen')
        self.devices['child'] = execution.dr.ChildDeviceEntry(config_entry_id='test', parent_device_id='parent')
        rows = entities(self.hass, query(where={'device_class': 'battery'}), self.user)
        self.assertEqual(rows[0]['area.id'], 'kitchen')

    async def test_device_battery_level_skips_binary_and_invalid_sensors(self):
        self.add_entity('binary_sensor.low', 'battery', 'on')
        self.add_entity('sensor.invalid', 'battery', '101')
        self.add_entity('sensor.actual', 'battery', '35')
        self.updates = {eid: self.old for eid in self.entities}
        rows, _ = await battery(self.hass, 14, self.user)
        self.assertEqual(rows[0]['battery.level'], 35)

    async def test_truncation_warning_counts_only_authorized_rows(self):
        for i in range(3):
            self.add_entity(f'sensor.b{i}', 'battery')
        self.denied.add('sensor.b2')
        await self.run_query(query(where={'device_class': 'battery'}, limit=1))
        result = self.connection.send_result.call_args.args[1]
        self.assertEqual(len(result['rows']), 1)
        self.assertEqual(result['warnings'], ['Showing 1 of 2 matching rows; results are truncated.'])
        await self.run_query(query(where={'device_class': 'battery'}, limit=2))
        self.assertEqual(self.connection.send_result.call_args.args[1]['warnings'], [])

    async def test_battery_missing_history_is_not_inactive(self):
        self.battery_fixture()
        del self.updates['sensor.other']
        rows, warnings = await battery(self.hass, 30, self.user)
        self.assertEqual(rows, [])
        self.assertTrue(any('missing entity history' in warning for warning in warnings))

    async def test_no_retained_history_has_coverage_warning(self):
        self.battery_fixture()
        self.updates = {}
        self.oldest = None
        rows, warnings = await battery(self.hass, 30, self.user)
        self.assertEqual(rows, [])
        self.assertTrue(any('lookback' in warning for warning in warnings))

    async def test_battery_complete_history_and_recent_change(self):
        self.battery_fixture()
        rows, warnings = await battery(self.hass, 30, self.user)
        self.assertEqual(rows[0]['history.status'], 'inactive')
        self.assertEqual(warnings, [])
        self.updates['sensor.other'] = self.now
        rows, _ = await battery(self.hass, 30, self.user)
        self.assertEqual(rows, [])

    async def test_battery_nonfinite_level_is_null(self):
        self.battery_fixture()
        self.states['sensor.battery'].state = 'NaN'
        rows, _ = await battery(self.hass, 30, self.user)
        self.assertIsNone(rows[0]['battery.level'])

    async def test_disabled_entities_are_not_required(self):
        self.battery_fixture()
        self.entities['sensor.other'].disabled_by = 'user'
        del self.updates['sensor.other']
        rows, _ = await battery(self.hass, 30, self.user)
        self.assertEqual(len(rows), 1)

    async def test_denied_device_never_reaches_database(self):
        self.battery_fixture()
        self.denied.add('sensor.other')
        self.assertEqual(await battery(self.hass, 30, self.user), ([], []))
        self.hass.async_add_executor_job.assert_not_called()

    async def test_excluded_entity_omits_device_even_with_old_rows(self):
        self.battery_fixture()
        self.excluded.add('sensor.other')
        rows, warnings = await battery(self.hass, 30, self.user)
        self.assertEqual(rows, [])
        self.assertTrue(warnings)
        self.hass.async_add_executor_job.assert_not_called()

    def pending_executor(self):
        future = asyncio.get_running_loop().create_future()
        self.hass.async_add_executor_job.side_effect = None
        self.hass.async_add_executor_job.return_value = future
        return future

    async def test_permissions_rechecked_after_database_read(self):
        self.battery_fixture()
        future = self.pending_executor()
        task = asyncio.create_task(battery(self.hass, 30, self.user))
        await asyncio.sleep(0)
        self.denied.add('sensor.other')
        future.set_result((self.updates, self.old))
        rows, _ = await task
        self.assertEqual(rows, [])

    async def test_recorder_exclusions_rechecked_after_database_read(self):
        self.battery_fixture()
        future = self.pending_executor()
        task = asyncio.create_task(battery(self.hass, 30, self.user))
        await asyncio.sleep(0)
        self.excluded.add('sensor.other')
        future.set_result((self.updates, self.old))
        rows, warnings = await task
        self.assertEqual(rows, [])
        self.assertTrue(warnings)

    async def test_unhealthy_recorder_never_reports_inactive(self):
        self.battery_fixture()
        for field in ('recording', 'is_running'):
            with self.subTest(field=field):
                setattr(self.recorder, field, False)
                rows, warnings = await battery(self.hass, 30, self.user)
                self.assertEqual(rows, [])
                self.assertTrue(any('history is incomplete' in warning for warning in warnings))
                self.hass.async_add_executor_job.assert_not_called()
                setattr(self.recorder, field, True)

    async def test_recorder_health_rechecked_after_database_read(self):
        self.battery_fixture()
        for field in ('recording', 'is_running'):
            with self.subTest(field=field):
                future = self.pending_executor()
                task = asyncio.create_task(battery(self.hass, 30, self.user))
                await asyncio.sleep(0)
                setattr(self.recorder, field, False)
                future.set_result((self.updates, self.old))
                rows, warnings = await task
                self.assertEqual(rows, [])
                self.assertTrue(any('history is incomplete' in warning for warning in warnings))
                setattr(self.recorder, field, True)

    async def test_live_updates_override_stale_recorder_rows(self):
        self.battery_fixture()
        self.states['sensor.other'].last_updated = datetime.now(timezone.utc)
        rows, _ = await battery(self.hass, 30, self.user)
        self.assertEqual(rows, [])
        q = query('devices')
        q['where']['history']['scope'] = 'matching_entities'
        await self.run_query(q)
        self.assertEqual(len(self.connection.send_result.call_args.args[1]['rows']), 1)

    async def test_live_update_during_database_read_omits_device(self):
        self.battery_fixture()
        future = self.pending_executor()
        task = asyncio.create_task(battery(self.hass, 30, self.user))
        await asyncio.sleep(0)
        self.states['sensor.battery'].last_updated = datetime.now(timezone.utc)
        future.set_result((self.updates, self.old))
        rows, _ = await task
        self.assertEqual(rows, [])

    async def test_registry_membership_rechecked_after_database_read(self):
        for change in ('removed', 'moved', 'added', 'disabled', 'enabled'):
            with self.subTest(change=change):
                self.entities.clear()
                self.battery_fixture()
                if change == 'enabled':
                    self.add_entity('sensor.extra', 'temperature', disabled='user')
                future = self.pending_executor()
                task = asyncio.create_task(battery(self.hass, 30, self.user))
                await asyncio.sleep(0)
                if change == 'removed':
                    del self.entities['sensor.other']
                elif change == 'moved':
                    self.entities['sensor.other'].device_id = 'other'
                elif change == 'added':
                    self.add_entity('sensor.extra', 'temperature')
                elif change == 'disabled':
                    self.entities['sensor.other'].disabled_by = 'user'
                else:
                    self.entities['sensor.extra'].disabled_by = None
                future.set_result((self.updates, self.old))
                rows, warnings = await task
                self.assertEqual(rows, [])
                self.assertTrue(any('history is incomplete' in warning for warning in warnings))

    async def test_concurrent_and_cancelled_requests_keep_executor_bounded(self):
        self.battery_fixture()
        future = self.pending_executor()
        task = asyncio.create_task(battery(self.hass, 30, self.user))
        await asyncio.sleep(0)
        with self.assertRaisesRegex(ValueError, 'already running'):
            await battery(self.hass, 30, self.user)
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        self.assertFalse(future.cancelled())
        with self.assertRaisesRegex(ValueError, 'already running'):
            await battery(self.hass, 30, self.user)
        self.hass.async_add_executor_job.assert_called_once()
        future.set_result((self.updates, self.old))
        await asyncio.sleep(0)
        self.assertIsNone(self.hass.data[integration.DOMAIN]['history_job'])
        rows, _ = await battery(self.hass, 30, self.user)
        self.assertEqual(len(rows), 1)

    async def test_database_error_releases_slot_and_returns_error(self):
        self.battery_fixture()
        future = self.pending_executor()
        future.set_exception(OSError('database unavailable'))
        await self.run_query(query('devices'))
        self.assertEqual(self.connection.send_error.call_args.args[1], 'query_failed')
        self.assertIsNone(self.hass.data[integration.DOMAIN]['history_job'])

    async def test_unload_and_reenable(self):
        await integration.async_unload_entry(self.hass, self.entry)
        await self.run_query()
        self.connection.send_result.assert_not_called()
        self.assertEqual(self.connection.send_error.call_args.args[1], 'not_loaded')
        with patch.object(integration, '_resources', AsyncMock(return_value=None)):
            await integration.async_setup_entry(self.hass, self.entry)
        await self.run_query()
        self.connection.send_result.assert_called_once()

    async def test_unload_reload_during_query_does_not_release_stale_result(self):
        self.battery_fixture()
        future = self.pending_executor()
        task = asyncio.create_task(self.run_query(query('devices')))
        await asyncio.sleep(0)
        await integration.async_unload_entry(self.hass, self.entry)
        with patch.object(integration, '_resources', AsyncMock(return_value=None)):
            await integration.async_setup_entry(self.hass, self.entry)
        future.set_result((self.updates, self.old))
        await task
        self.connection.send_result.assert_not_called()
        self.assertEqual(self.connection.send_error.call_args.args[1], 'not_loaded')

    async def test_entity_limit_is_enforced_before_io(self):
        self.battery_fixture()
        with patch.object(execution, '_device_entities', return_value={'dev': [f'sensor.e{i}' for i in range(10001)]}):
            with self.assertRaisesRegex(ValueError, '10,000'):
                await battery(self.hass, 30, self.user)
        self.hass.async_add_executor_job.assert_not_called()

    async def test_bad_query_returns_error_without_io(self):
        await self.run_query(query(columns=['typo']))
        self.connection.send_result.assert_not_called()
        self.assertEqual(self.connection.send_error.call_args.args[1], 'query_failed')
        self.hass.async_add_executor_job.assert_not_called()

    async def test_generic_domains_nested_attributes_and_dynamic_columns(self):
        self.add_entity('light.office', 'none', 'on', device='lamp')
        self.states['light.office'].attributes.update({'brightness': 128, 'config': {'zone': 'desk'}, 'tags': ['work', 'reading']})
        self.add_entity('switch.office', 'none', 'off', device='switch')
        self.add_entity('climate.office', 'none', '21.5', device='thermostat')
        self.add_entity('device_tracker.phone', 'none', 'home', device='phone')
        self.add_entity('person.adam', 'none', 'home', device=None)
        where = {'all': [
            {'domain': {'in': ['light', 'switch', 'climate', 'device_tracker', 'person']}},
            {'any': [
                {'field': 'entity.attributes.config.zone', 'op': 'eq', 'value': 'desk'},
                {'field': 'entity.state', 'op': 'eq', 'value': 'home'},
            ]},
            {'not': [{'field': 'entity.state', 'op': 'eq', 'value': 'off'}]},
        ]}
        await self.run_query(query(where=where, columns=['entity_id', 'entity.attributes.config.zone', 'entity.attributes.tags', 'device.manufacturer']))
        result = self.connection.send_result.call_args.args[1]
        self.assertEqual([row['entity_id'] for row in result['rows']], ['light.office', 'device_tracker.phone', 'person.adam'])
        self.assertEqual(result['rows'][0]['entity.attributes.config.zone'], 'desk')
        self.assertEqual(result['rows'][0]['entity.attributes.tags'], ['work', 'reading'])
        self.assertNotIn('_attributes', result['rows'][0])
        self.hass.async_add_executor_job.assert_not_called()

    async def test_generic_filters_do_not_inherit_legacy_battery_restrictions(self):
        self.add_entity('binary_sensor.low', 'battery', 'on')
        self.add_entity('sensor.voltage', 'battery', '3.1')
        self.states['sensor.voltage'].attributes['unit_of_measurement'] = 'V'
        await self.run_query(query(where={'all': [{'field': 'entity.attributes.device_class', 'op': 'eq', 'value': 'battery'}]}))
        rows = self.connection.send_result.call_args.args[1]['rows']
        self.assertEqual([row['entity_id'] for row in rows], ['binary_sensor.low', 'sensor.voltage'])

    async def test_dynamic_attribute_sort_does_not_require_selected_column(self):
        for eid, level in [('sensor.high', '100'), ('sensor.low', '9'), ('sensor.medium', '38'), ('sensor.unknown', 'bad')]:
            self.add_entity(eid, 'none')
            self.states[eid].attributes['level'] = level
        await self.run_query(query(where={'domain': 'sensor'}, columns=['entity_id'],
                                   sort={'by': 'entity.attributes.level'}))
        rows = self.connection.send_result.call_args.args[1]['rows']
        self.assertEqual([row['entity_id'] for row in rows],
                         ['sensor.low', 'sensor.medium', 'sensor.high', 'sensor.unknown'])
        self.assertNotIn('entity.attributes.level', rows[0])

    async def test_generic_device_selection_without_history(self):
        self.add_entity('climate.office', 'none', 'heat', device='thermostat')
        self.add_entity('light.office', 'none', 'on', device='lamp')
        self.add_entity('sensor.denied', 'battery', device='denied')
        self.denied.add('sensor.denied')
        q = {'from': 'devices', 'where': {'has_entity': {'all': [{'domain': 'climate'}, {'state': {'eq': 'heat'}}]}},
             'columns': ['device.name', 'device.manufacturer'], 'sort': {}, 'limit': 100}
        await self.run_query(q)
        result = self.connection.send_result.call_args.args[1]
        self.assertEqual([{key: row[key] for key in result['columns']} for row in result['rows']],
                         [{'device.name': 'Device', 'device.manufacturer': 'Test'}])
        self.hass.async_add_executor_job.assert_not_called()

    async def test_device_entity_filters_support_parse_state(self):
        self.add_entity('sensor.embedded', 'none', '12.5 W', device='meter')
        q = {'from': 'devices', 'parse_state': True, 'where': {'has_entity': {'state': {'gt': 0}}},
             'columns': ['device.id'], 'sort': {}, 'limit': 100}
        await self.run_query(q)
        self.assertEqual([row['device.id'] for row in self.connection.send_result.call_args.args[1]['rows']], ['meter'])
        q['parse_state'] = False
        await self.run_query(q)
        self.assertEqual(self.connection.send_result.call_args.args[1]['rows'], [])
        self.hass.async_add_executor_job.assert_not_called()

    async def test_device_empty_query_lists_readable_registered_devices(self):
        self.add_entity('light.office', 'none', 'on', device='lamp')
        self.add_entity('sensor.denied', 'battery', device='denied')
        self.denied.add('sensor.denied')
        await self.run_query({'from': 'devices', 'where': {}, 'columns': ['device.id'], 'sort': {}, 'limit': 100})
        self.assertEqual([row['device.id'] for row in self.connection.send_result.call_args.args[1]['rows']], ['lamp'])
        self.hass.async_add_executor_job.assert_not_called()

    async def test_device_direct_condition_uses_raw_state(self):
        self.add_entity('sensor.offline', 'power', 'unknown', device='offline')
        self.add_entity('sensor.online', 'power', '12', device='online')
        for selector in ({'field': 'entity.state', 'op': 'eq', 'value': 'unknown'},
                         {'field': 'entity.state', 'op': 'ne', 'value': '12'}):
            with self.subTest(selector=selector):
                await self.run_query(query('devices', where={'has_entity': selector}))
                self.connection.send_error.assert_not_called()
                self.assertEqual([row['device.id'] for row in self.connection.send_result.call_args.args[1]['rows']], ['offline'])

    async def test_device_empty_selector_preserves_unloaded_members(self):
        self.add_entity('sensor.unloaded', 'power')
        self.states.clear()
        for where in ({}, {'has_entity': {}}):
            with self.subTest(where=where):
                await self.run_query(query('devices', where=where))
                self.assertEqual([row['device.id'] for row in self.connection.send_result.call_args.args[1]['rows']], ['dev'])

    async def test_history_matching_scope_ignores_other_entities(self):
        self.battery_fixture()
        self.updates = {'sensor.battery': self.old, 'sensor.other': self.now}
        q = query('devices')
        q['where']['history']['scope'] = 'matching_entities'
        await self.run_query(q)
        rows = self.connection.send_result.call_args.args[1]['rows']
        self.assertEqual(rows[0]['history.status'], 'inactive')
        await self.run_query(query('devices'))
        self.assertEqual(self.connection.send_result.call_args.args[1]['rows'], [])

    async def test_device_exclusions_apply_to_matching_history_not_permissions(self):
        self.battery_fixture()
        self.updates = {'sensor.battery': self.now, 'sensor.other': self.old}
        q = query('devices', where={
            'has_entity': {'entity_id': 'sensor.*', 'exclude': {'entity_id': 'sensor.battery'}},
            'history': {'scope': 'matching_entities'},
        })
        await self.run_query(q)
        rows = self.connection.send_result.call_args.args[1]['rows']
        self.assertEqual(rows[0]['history.status'], 'inactive')
        q['where']['history']['scope'] = 'all_entities'
        await self.run_query(q)
        self.assertEqual(self.connection.send_result.call_args.args[1]['rows'], [])
        self.denied.add('sensor.battery')
        q['where']['history']['scope'] = 'matching_entities'
        await self.run_query(q)
        self.assertEqual(self.connection.send_result.call_args.args[1]['rows'], [])

    async def test_custom_history_duration_status_uses_cutoff(self):
        self.battery_fixture()
        self.updates = {eid: self.now - 15 * 86400 for eid in self.updates}
        q = query('devices')
        q['where']['history']['no_changes_for'] = '7d'
        await self.run_query(q)
        row = self.connection.send_result.call_args.args[1]['rows'][0]
        self.assertEqual(row['history.status'], 'inactive')
        self.assertEqual(row['history.days_inactive'], 15)

    async def test_generic_attribute_output_is_bounded_and_serializable(self):
        self.add_entity('sensor.attr', 'none')
        self.states['sensor.attr'].attributes['bad'] = object()
        await self.run_query(query(where={'domain': 'sensor'}, columns=['entity.attributes.bad']))
        self.assertEqual(self.connection.send_error.call_args.args[1], 'query_failed')

    async def test_native_datetime_attribute_uses_ha_json_contract(self):
        from homeassistant.helpers.json import json_bytes

        self.add_entity('sensor.attr', 'none')
        value = datetime.now(timezone.utc)
        self.states['sensor.attr'].attributes['updated'] = value
        await self.run_query(query(where={'domain': 'sensor'}, columns=['entity.attributes.updated']))
        self.connection.send_error.assert_not_called()
        result = self.connection.send_result.call_args.args[1]
        self.assertEqual(result['rows'][0]['entity.attributes.updated'], json.loads(json_bytes(value)))
        self.assertEqual(result['rows'][0]['entity_id'], 'sensor.attr')
        self.assertNotIn('_attributes', result['rows'][0])

    async def test_response_size_is_bounded(self):
        for i in range(300):
            eid = f'sensor.large{i}'
            self.add_entity(eid, 'none')
            self.states[eid].attributes['payload'] = 'x' * 16000
        await self.run_query(query(where={'domain': 'sensor'}, columns=['entity.attributes.payload'], limit=500))
        self.assertEqual(self.connection.send_error.call_args.args[1], 'query_failed')
        self.assertIn('4 MB', self.connection.send_error.call_args.args[2])

    def resource_fixture(self, items):
        async def create(data):
            item = {'id': 'owned', 'url': data['url'], 'type': data['res_type']}
            items.append(item)
            return item

        resources = NS(async_get_info=AsyncMock(), async_items=lambda: items.copy(),
                       async_create_item=AsyncMock(side_effect=create),
                       async_delete_item=AsyncMock(side_effect=lambda item_id: items.remove(next(i for i in items if i['id'] == item_id))))
        self.hass.data['lovelace'] = NS(resources=resources)
        return resources

    async def test_owned_resource_survives_reload_and_is_removed_by_id(self):
        items = []
        resources = self.resource_fixture(items)
        await integration.async_setup_entry(self.hass, self.entry)
        self.assertEqual(self.entry.data['resource_id'], 'owned')
        await integration.async_unload_entry(self.hass, self.entry)
        await integration.async_setup_entry(self.hass, self.entry)
        resources.async_create_item.assert_awaited_once()
        items.append({'id': 'manual', 'url': integration.RESOURCE_URL + '?v=manual', 'type': 'module'})
        await integration.async_remove_entry(self.hass, self.entry)
        self.assertEqual([item['id'] for item in items], ['manual'])
        self.assertIsNone(self.hass.data[integration.DOMAIN]['active'])

    async def test_preexisting_resource_is_never_owned_or_deleted(self):
        items = [{'id': 'manual', 'url': integration.RESOURCE_URL, 'type': 'module'}]
        resources = self.resource_fixture(items)
        await integration.async_setup_entry(self.hass, self.entry)
        self.assertEqual(self.entry.data, {})
        await integration.async_remove_entry(self.hass, self.entry)
        resources.async_create_item.assert_not_awaited()
        resources.async_delete_item.assert_not_awaited()

    async def test_remove_disabled_entry_after_restart_without_setup(self):
        self.entry.data = {'resource_id': 'owned'}
        items = [{'id': 'owned', 'url': integration.RESOURCE_URL, 'type': 'module'}]
        self.resource_fixture(items)
        del self.hass.data[integration.DOMAIN]
        await integration.async_remove_entry(self.hass, self.entry)
        self.assertEqual(items, [])

    async def test_user_modified_owned_resource_is_preserved(self):
        for changes in [{'url': integration.RESOURCE_URL + '?custom'}, {'type': 'css'}]:
            items = []
            resources = self.resource_fixture(items)
            await integration.async_setup_entry(self.hass, self.entry)
            items[0].update(changes)
            await integration.async_remove_entry(self.hass, self.entry)
            resources.async_delete_item.assert_not_awaited()

    async def test_yaml_resources_are_not_mutated(self):
        self.hass.data['lovelace'] = NS(resources=NS(async_items=lambda: []))
        self.assertIsNone(await integration._resources(self.hass))
        self.assertTrue(await integration.async_setup_entry(self.hass, self.entry))

    async def test_resource_storage_failure_does_not_disable_queries(self):
        resources = self.resource_fixture([])
        resources.async_get_info.side_effect = HomeAssistantError('storage failed')
        with self.assertLogs(integration._LOGGER, 'ERROR'):
            self.assertTrue(await integration.async_setup_entry(self.hass, self.entry))
        await self.run_query()
        self.connection.send_result.assert_called_once()


if __name__ == '__main__':
    unittest.main()
