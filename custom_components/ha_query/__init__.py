"""HA Query: bounded, read-only queries for Home Assistant dashboards."""
from __future__ import annotations

import logging
from pathlib import Path
import sqlite3

import voluptuous as vol
from homeassistant.components import websocket_api
from homeassistant.components.http import StaticPathConfig
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers import config_validation as cv

from .query_engine import sort_and_limit
from .query_execution import _devices, _entities
from .query_language import validate_query
from .query_response import prepare_response

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
            expression, history = validate_query(query)
            if query['from'] == 'devices':
                rows, warnings = await _devices(hass, query, connection.user, expression, history)
            else:
                rows, warnings = _entities(hass, query, connection.user, expression), []
            if hass.data[DOMAIN]['active'] is not active:
                connection.send_error(msg['id'], 'not_loaded', 'HA Query was unloaded during this request')
                return
            if len(rows) > query['limit']:
                warnings.append(f"Showing {query['limit']} of {len(rows)} matching rows; results are truncated.")
            rows = sort_and_limit(rows, query.get('sort', {}).get('by'),
                                  query.get('sort', {}).get('descending', False), query['limit'])
            columns = query['columns'] or list(COLUMNS[query['from']])
            result = prepare_response(rows, columns, warnings, query['sort'].get('by'), message_id=msg['id'])
            connection.send_result(msg['id'], result)
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
