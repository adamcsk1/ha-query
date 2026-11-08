# Configuration

Card options sit beside `type`. Query options sit inside `query`. See [Query language and history](query-language.md) for filter syntax and available fields.

## Card options

| Option | Type | Default | Purpose |
| --- | --- | --- | --- |
| `type` | string | required | Use `custom:ha-query-card` |
| `title` | string | `HA Query` | Card heading |
| `query` | mapping | required | Query source, filters, columns, sorting, and limits |
| `group_by` | string | omitted | Set to `area` to group results into area panels |
| `refresh_seconds` | number | `300` | Periodic refresh fallback, from 60 through 2,147,483 seconds |
| `entity_links` | boolean | `false` | Make the displayed entity field open More Information |
| `entity_icons` | boolean | `false` | Show the current Home Assistant entity icon |
| `value_state_color` | boolean | `false` | Color binary-sensor state values |
| `icon_state_color` | boolean | `false` | Color binary-sensor icons; requires `entity_icons` |
| `entity_names` | mapping | omitted | Override names for exact entity IDs |
| `entity_icon_overrides` | mapping | omitted | Override icons for exact entity IDs |
| `state_labels` | mapping | omitted | Replace binary-sensor state text |

## Query options

These options belong inside `query`:

| Option | Type | Default | Purpose |
| --- | --- | --- | --- |
| `from` | string | required | Use `entities` or `devices` |
| `where` | mapping | required | Entity filters, or device selection and history settings |
| `columns` | list | source defaults | Select up to 32 unique fields |
| `sort` | mapping | omitted | Sort with `by` and optional `descending: false` |
| `limit` | number | `100` | Return 1 through 500 rows |
| `parse_state` | boolean | `false` | Parse numbers and units embedded in entity states |

An explicit column list replaces all default UI columns. For example, `device.name`, `entity.state`, and `entity.unit` display only **Device** and **State**, with the unit combined into the state value. Metadata used for grouping, links, icons, and colors does not create extra columns.

## Grouping and updates

`group_by: area` renders separate responsive panels. Narrow cards use labeled rows without horizontal scrolling. The backend sorts and applies `limit` before grouping. A warning appears when matching results are truncated.

The card subscribes to permission-filtered entity updates and entity, device, and area registry changes. These events refresh every query type. Bursts are combined with a 250 ms delay, and an event during a request schedules one trailing refresh.

Event-driven device history queries are limited to one per minute to avoid repeated Recorder reads. Disconnected cards stop subscriptions. Reconnecting or changing the Home Assistant connection establishes fresh subscriptions. Failed subscriptions retry after 60 seconds without replacing healthy subscriptions.

`refresh_seconds` remains a periodic fallback for time-based history cutoffs, Recorder commits, missed events, and failed subscriptions. Ordinary entity updates do not wait for this timer when event subscriptions are working.

## Icons and links

Icons and links use the highest-priority selected field:

1. `entity.name`
2. `device.name`
3. `entity_id`

Only that field receives the icon or link. Device-query results have no entity links. Rows without a current entity state have no icon, but can still have a link.

Links open Home Assistant's More Information dialog, never an arbitrary external URL. Buttons support keyboard activation and have an accessible More Information label.

Use `entity_icon_overrides` for up to 500 exact entity IDs. Icon names such as `mdi:door` and `mdi:window-open` are limited to 128 characters:

```yaml
entity_icons: true
entity_icon_overrides:
  binary_sensor.front_door: mdi:door
  binary_sensor.kitchen_window: mdi:window-closed
```

Overrides do not change entity metadata, filtering, sorting, or link targets.

## Names and state labels

`entity_names` maps up to 500 exact entity IDs to nonempty labels of at most 256 characters. Only a selected `entity.name` cell changes. Device names, grouping, sorting, and filtering are unaffected.

`state_labels` maps any of `on`, `off`, `unknown`, and `unavailable` to nonempty labels of at most 64 characters. Quote the `on` and `off` keys so YAML does not parse them as booleans. Omitted states keep their raw text.

```yaml
entity_names:
  binary_sensor.front_door: Front entrance
state_labels:
  "on": Open
  "off": Closed
  unknown: Unknown
  unavailable: Offline
```

Labels apply only to binary-sensor state cells. Colors still use the original `on` or `off` state, and links still target the original authorized entity ID. Custom names are also used in the accessible More Information label. All values are rendered as plain text.

## Binary-sensor state colors

Value and icon colors are independent:

```yaml
entity_icons: true
value_state_color: false
icon_state_color: true
```

Colors follow Home Assistant's theme fallback order: device class and state, binary-sensor state, binary-sensor active/inactive, then general active/inactive color. For example, `state-binary_sensor-door-on-color` sets the open-door color.

Colors use the same query snapshot as the text and update whenever the card refreshes. Unknown, unavailable, and missing states keep their normal colors. Device-class metadata is included automatically and does not need to be selected as a column. Missing or malformed device classes fall back to domain colors; `entity.device_class` is null for non-text values or strings longer than 64 characters.
