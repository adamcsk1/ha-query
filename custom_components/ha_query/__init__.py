"""HA Query: bounded, read-only queries for Home Assistant dashboards."""
from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone
import json
import logging
from math import isfinite
from pathlib import Path
import re
import sqlite3

import voluptuous as vol
from homeassistant.auth.permissions.const import POLICY_READ
from homeassistant.components import websocket_api
from homeassistant.components.http import StaticPathConfig
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers import area_registry as ar, config_validation as cv
from homeassistant.helpers import device_registry as dr, entity_registry as er

from .query_engine import latest_updates, sort_and_limit, sqlite_path, utc_iso
from .query_language import MISSING, matches, validate_query

DOMAIN = 'ha_query'
RESOURCE_URL = '/ha-query/ha-query-card.js'
RESOURCE_PATH = Path(__file__).parent / 'frontend' / 'ha-query-card.js'
_LOGGER = logging.getLogger(__name__)
COLUMNS = {
    'entities': ('entity_id', 'entity.name', 'entity.state', 'entity.unit', 'device.name', 'area.id', 'area.name'),
    'devices': ('device.id', 'device.name', 'battery.level', 'history.last_change',
                'history.days_inactive', 'history.status', 'area.id', 'area.name'),
}
QUERY_SCHEMA = vol.Schema({
    vol.Required('from'): vol.In(['devices', 'entities']),
    vol.Required('where'): dict,
    vol.Optional('columns', default=[]): [cv.string],
    vol.Optional('sort', default={}): vol.Schema({
        vol.Optional('by'): cv.string,
        vol.Optional('descending', default=False): bool,
    }, extra=vol.PREVENT_EXTRA),
    vol.Optional('limit', default=100): vol.All(vol.Coerce(int), vol.Range(min=1, max=500)),
    vol.Optional('parse_state', default=False): bool,
}, extra=vol.PREVENT_EXTRA)
WS_SCHEMA = {vol.Required('type'): 'ha_query/run', vol.Required('query'): QUERY_SCHEMA}


def _validate_where(query: dict) -> int | None:
    _, history = validate_query(query)
    return history['days'] if history else None


def _area(hass: HomeAssistant, areas, device, entry=None) -> dict:
    area_id = (entry.area_id if entry else None) or (dr.async_get_effective_area_id(hass, device) if device else None)
    area = areas.async_get_area(area_id) if area_id else None
    return {'area.id': area.id if area else None, 'area.name': area.name if area else 'Unassigned'}


def _number(state) -> float | None:
    try:
        value = float(state.state)
    except (TypeError, ValueError, OverflowError):
        return None
    return value if isfinite(value) else None


EMBEDDED_NUMBER = re.compile(r'\s*([+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:e[+-]?[0-9]+)?)\s*([^\d\s]\S*)\s*', re.IGNORECASE)


def _embedded_number(value) -> tuple[float, str] | None:
    if not isinstance(value, str):
        return None
    try:
        float(value)
    except (TypeError, ValueError, OverflowError):
        pass
    else:
        return None
    if not (match := EMBEDDED_NUMBER.fullmatch(value)):
        return None
    number = float(match[1])
    return (number, match[2]) if isfinite(number) else None


def _attribute(attributes: dict, field: str):
    value = attributes
    for part in field.split('.')[2:]:
        if not isinstance(value, dict) or part not in value:
            return MISSING
        value = value[part]
    return value


def _device_attribute(device, field: str) -> str:
    # ChildDeviceEntry deliberately has no manufacturer/model compatibility fields.
    if device is None or isinstance(device, dr.ChildDeviceEntry):
        return ''
    return getattr(device, field, None) or ''


def _entity_row(hass: HomeAssistant, state, registry, devices, areas, parse_state=False) -> dict:
    entry = registry.async_get(state.entity_id)
    device = devices.async_get(entry.device_id) if entry and entry.device_id else None
    device_class = state.attributes.get('device_class')
    unit = state.attributes.get('unit_of_measurement', '')
    numeric = _number(state)
    raw_value = state.state
    embedded = _embedded_number(state.state) if parse_state else None
    if embedded:
        numeric, parsed_unit = embedded
        raw_value = numeric
        unit = unit or parsed_unit
    if device_class == 'power':
        value = numeric
    elif device_class == 'battery' and unit == '%':
        value = numeric if numeric is not None and 0 <= numeric <= 100 else None
    else:
        value = raw_value
    return {
        'entity_id': state.entity_id,
        'domain': state.domain,
        'entity.name': state.name,
        'entity.state': value,
        'entity.unit': unit,
        'entity.disabled': bool(entry.disabled_by) if entry else False,
        'entity.platform': entry.platform if entry else '',
        'device.id': device.id if device else None,
        'device.name': (device.name_by_user or device.name or '') if device else '',
        'device.manufacturer': _device_attribute(device, 'manufacturer'),
        'device.model': _device_attribute(device, 'model'),
        **_area(hass, areas, device, entry),
        '_attributes': state.attributes,
    }


def _entities(hass: HomeAssistant, query: dict, user) -> list[dict]:
    expression, _ = validate_query(query)
    registry, devices, areas = er.async_get(hass), dr.async_get(hass), ar.async_get(hass)
    rows = []
    for state in hass.states.async_all():
        if not user.permissions.check_entity(state.entity_id, POLICY_READ):
            continue
        row = _entity_row(hass, state, registry, devices, areas, query.get('parse_state', False))
        if matches(expression, row):
            for field in [*query.get('columns', []), query.get('sort', {}).get('by')]:
                if isinstance(field, str) and field.startswith('entity.attributes.'):
                    value = _attribute(row['_attributes'], field)
                    if value is not MISSING:
                        row[field] = value
            rows.append(row)
    return rows


def _device_entities(registry: er.EntityRegistry) -> dict[str, list[str]]:
    grouped: dict[str, list[str]] = {}
    for entry in registry.entities.values():
        if entry.device_id and entry.disabled_by is None:
            grouped.setdefault(entry.device_id, []).append(entry.entity_id)
    return grouped


def _battery_level(hass: HomeAssistant, entity_ids: list[str]) -> float | None:
    for entity_id in entity_ids:
        state = hass.states.get(entity_id)
        if state and entity_id.startswith('sensor.') and state.attributes.get('device_class') == 'battery' and state.attributes.get('unit_of_measurement') == '%':
            value = _number(state)
            if value is not None and 0 <= value <= 100:
                return value
    return None


def _device_row(hass: HomeAssistant, device_id: str, entity_ids: list[str], areas, last=None, now=None, cutoff=None) -> dict:
    device = dr.async_get(hass).async_get(device_id)
    row = {
        'device.id': device_id,
        'device.name': (device.name_by_user or device.name or device_id) if device else device_id,
        'device.manufacturer': _device_attribute(device, 'manufacturer'),
        'device.model': _device_attribute(device, 'model'),
        'battery.level': _battery_level(hass, entity_ids),
        'history.last_change': utc_iso(last) if last is not None else None,
        'history.days_inactive': int((now - last) / 86400) if last is not None else None,
        'history.status': ('inactive' if last < cutoff else 'active') if last is not None else 'unknown',
        **_area(hass, areas, device),
    }
    return row


async def _history(hass: HomeAssistant, entity_ids: list[str]) -> tuple[dict[str, float], float | None]:
    from homeassistant.components.recorder import get_instance

    if len(entity_ids) > 10000:
        raise ValueError('Query exceeds 10,000 entities')
    path = sqlite_path(str(get_instance(hass).db_url))
    runtime = hass.data[DOMAIN]
    if runtime['history_job'] is not None:
        raise ValueError('A history query is already running; retry later')
    job = hass.async_add_executor_job(latest_updates, path, entity_ids)
    runtime['history_job'] = job

    def finished(future):
        if runtime['history_job'] is future:
            runtime['history_job'] = None
        if not future.cancelled():
            future.exception()  # Consume errors after a cancelled client request.

    job.add_done_callback(finished)
    try:
        return await asyncio.shield(job)
    finally:
        if job.done():
            finished(job)


async def _devices(hass: HomeAssistant, query: dict, user) -> tuple[list[dict], list[str]]:
    from homeassistant.components.recorder import is_entity_recorded

    expression, history = validate_query(query)
    registry = er.async_get(hass)
    devices, areas = dr.async_get(hass), ar.async_get(hass)
    grouped = _device_entities(registry)
    if len({entity_id for entity_ids in grouped.values() for entity_id in entity_ids}) > 10000:
        raise ValueError('Query exceeds 10,000 entities')
    candidates = []
    for device_id, entity_ids in grouped.items():
        if not all(user.permissions.check_entity(entity_id, POLICY_READ) for entity_id in entity_ids):
            continue
        entity_rows = [_entity_row(hass, state, registry, devices, areas, query.get('parse_state', False)) for entity_id in entity_ids
                       if (state := hass.states.get(entity_id)) is not None]
        matched = [row for row in entity_rows if matches(expression, row)]
        if expression.children and not matched:
            continue
        candidates.append((device_id, entity_ids, [row['entity_id'] for row in matched]))
    if history is None:
        return [_device_row(hass, device_id, entity_ids, areas) for device_id, entity_ids, _ in candidates], []
    scope_ids = {
        device_id: (entity_ids if history['scope'] == 'all_entities' else matched)
        for device_id, entity_ids, matched in candidates
    }
    missing_history = False
    recorded = []
    for candidate in candidates:
        selected = scope_ids[candidate[0]]
        if selected and not all(is_entity_recorded(hass, entity_id) for entity_id in selected):
            missing_history = True
        else:
            recorded.append(candidate)
    candidates = recorded
    ids = sorted({entity_id for device_id, _, _ in candidates for entity_id in scope_ids[device_id]})
    if not ids:
        return [], ['Devices with missing entity history were omitted: history is incomplete.'] if missing_history else []
    updates, oldest = await _history(hass, ids)
    now = datetime.now(timezone.utc).timestamp()
    cutoff = now - timedelta(days=history['days']).total_seconds()
    warnings = []
    if oldest is None or oldest > cutoff:
        warnings.append('Recorder has no evidence of a full lookback window; results may be incomplete.')
    rows = []
    for device_id, entity_ids, _ in candidates:
        selected = scope_ids[device_id]
        if not selected or not all(user.permissions.check_entity(entity_id, POLICY_READ) for entity_id in entity_ids):
            continue
        if any(entity_id not in updates or not is_entity_recorded(hass, entity_id) for entity_id in selected):
            missing_history = True
            continue
        last = max(updates[entity_id] for entity_id in selected)
        if last >= cutoff:
            continue
        rows.append(_device_row(hass, device_id, entity_ids, areas, last, now, cutoff))
    if missing_history:
        warnings.append('Devices with missing entity history were omitted: history is incomplete.')
    return rows, warnings


async def _battery(hass: HomeAssistant, days: int, user) -> tuple[list[dict], list[str]]:
    return await _devices(hass, {'from': 'devices', 'where': {'has_entity': {'device_class': 'battery'},
                         'history': {'scope': 'all_entities', 'no_changes_for': f'{days}d'}}}, user)


async def async_setup(hass: HomeAssistant, config: dict) -> bool:
    """Register one WebSocket handler and one static path, once per HA process."""
    hass.data[DOMAIN] = {'active': None, 'history_job': None}

    @websocket_api.websocket_command(WS_SCHEMA)
    @websocket_api.async_response
    async def run_query(hass: HomeAssistant, connection, msg: dict) -> None:
        try:
            active = hass.data[DOMAIN]['active']
            if active is None:
                connection.send_error(msg['id'], 'not_loaded', 'HA Query is not enabled')
                return
            query = msg['query']
            _validate_where(query)
            if query['from'] == 'devices':
                rows, warnings = await _devices(hass, query, connection.user)
            else:
                rows, warnings = _entities(hass, query, connection.user), []
            if hass.data[DOMAIN]['active'] is not active:
                connection.send_error(msg['id'], 'not_loaded', 'HA Query was unloaded during this request')
                return
            if len(rows) > query['limit']:
                warnings.append(f"Showing {query['limit']} of {len(rows)} matching rows; results are truncated.")
            rows = sort_and_limit(rows, query.get('sort', {}).get('by'),
                                  query.get('sort', {}).get('descending', False), query['limit'])
            columns = query['columns'] or list(COLUMNS[query['from']])
            for row in rows:
                attributes = row.pop('_attributes', {})
                for column in columns:
                    if column.startswith('entity.attributes.'):
                        value = _attribute(attributes, column)
                        if value is not MISSING:
                            row[column] = value
                sort_field = query['sort'].get('by')
                if sort_field and sort_field.startswith('entity.attributes.') and sort_field not in columns:
                    row.pop(sort_field, None)
            if len(json.dumps(rows, allow_nan=False).encode('utf-8')) > 4_000_000:
                raise ValueError('Response exceeds 4 MB; select fewer columns or rows')
            connection.send_result(msg['id'], {'columns': columns, 'rows': rows, 'warnings': warnings})
        except (ValueError, TypeError, sqlite3.Error, OSError) as exc:
            _LOGGER.warning('HA Query failed: %s', exc)
            connection.send_error(msg['id'], 'query_failed', str(exc))
        except Exception:
            _LOGGER.exception('HA Query unexpected failure')
            connection.send_error(msg['id'], 'internal_error', 'See Home Assistant logs')

    websocket_api.async_register_command(hass, run_query)
    await hass.http.async_register_static_paths([
        StaticPathConfig(RESOURCE_URL, str(RESOURCE_PATH), cache_headers=False)
    ])
    return True


async def _resources(hass: HomeAssistant):
    # Resources are available only in storage mode. Never mutate YAML resources.
    from homeassistant.components.lovelace import DOMAIN as LOVELACE_DOMAIN
    lovelace = hass.data.get(LOVELACE_DOMAIN)
    resources = getattr(lovelace, 'resources', None)
    if resources is None or not hasattr(resources, 'async_create_item'):
        return None
    await resources.async_get_info()  # Load once, preserving pending resource edits.
    return resources


async def async_setup_entry(hass: HomeAssistant, entry) -> bool:
    try:
        resources = await _resources(hass)
        if resources is None:
            _LOGGER.warning('Automatic Lovelace resource registration unavailable; see README for YAML mode')
        elif not any(item.get('url', '').split('?', 1)[0] == RESOURCE_URL for item in resources.async_items()):
            item = await resources.async_create_item({'url': RESOURCE_URL, 'res_type': 'module'})
            hass.config_entries.async_update_entry(entry, data={**entry.data, 'resource_id': item['id']})
    except (HomeAssistantError, OSError, ValueError):
        _LOGGER.exception('Could not register the Lovelace resource; add it manually')
    hass.data[DOMAIN]['active'] = object()
    return True


async def async_unload_entry(hass: HomeAssistant, entry) -> bool:
    hass.data[DOMAIN]['active'] = None
    return True


async def async_remove_entry(hass: HomeAssistant, entry) -> None:
    if DOMAIN in hass.data:
        hass.data[DOMAIN]['active'] = None
    resource_id = entry.data.get('resource_id')
    if resource_id is None:
        return
    try:
        resources = await _resources(hass)
        if resources is None:
            return
        for item in resources.async_items():
            if item['id'] == resource_id and item.get('url') == RESOURCE_URL and item.get('type') == 'module':
                await resources.async_delete_item(item['id'])
    except (HomeAssistantError, OSError, ValueError):
        _LOGGER.exception('Could not remove the owned Lovelace resource; remove it manually')
