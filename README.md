# HA Query

[![CI](https://github.com/adamcsk1/ha-query/actions/workflows/tests.yml/badge.svg)](https://github.com/adamcsk1/ha-query/actions/workflows/tests.yml)

A read-only [Home Assistant](https://www.home-assistant.io/) integration with a bundled dashboard card. Query live entities and registered devices using structured YAML filters, then group results by area.

Query any loaded entity domain, compare state and nested attributes, combine conditions, and include device or area metadata. This is a bounded query language, not raw SQL, Jinja, or arbitrary code execution.

## Requirements

- Home Assistant **2026.11.0 or newer**
- SQLite Recorder database for history queries; MariaDB and PostgreSQL are not supported
- Dashboard resources managed through the UI for automatic registration; YAML-managed resources need one manual entry

## Features

- Generic filters across all loaded entity domains
- Boolean `all`, `any`, and `not` groups
- Numeric, text, membership, containment, and existence operators
- Multi-value device-class filters, entity ID/name wildcards, and exclusions
- Optional parsing of numeric states with embedded units
- Nested state attributes, registry, device, and area fields
- Generic device selection through matching entities
- Device inactivity across all enabled entities or only matching entities
- Entity-area overrides and inherited child-device areas
- Respects Home Assistant entity read permissions
- Read-only, parameter-bound SQLite queries run outside the event loop
- Automatic bundled Lovelace card registration for storage-mode resources

## Install with HACS

1. In [HACS](https://www.hacs.xyz/), add `https://github.com/adamcsk1/ha-query` as a custom **Integration** repository.
2. Install **HA Query** and restart Home Assistant.
3. Go to **Settings - Devices & services - Add integration**, then select **HA Query**.
4. Add a **Manual** dashboard card using one of the [examples](examples/).

The integration registers its `/ha-query/ha-query-card.js` dashboard resource automatically where supported. **Restart Home Assistant after every update to load backend changes, then hard-refresh the browser.** Restarting only the dashboard or refreshing the browser does not update the Python query service.

To uninstall, remove dashboard cards and the integration first. HA Query removes only the unchanged resource it created; pre-existing or user-modified resources are preserved. Deleting files through HACS alone cannot perform resource cleanup.

### Manual install

Copy `custom_components/ha_query/` into `/config/custom_components/ha_query/`, restart Home Assistant, then add the integration through **Settings - Devices & services**.

For YAML-managed dashboard resources, add this entry under your existing `lovelace:` section:

```yaml
lovelace:
  resource_mode: yaml
  resources:
    - url: /ha-query/ha-query-card.js
      type: module
```

## Example cards

- [Battery levels by area](examples/battery-levels-by-area.yaml): readable battery `sensor` entities with `%` unit, lowest reading first.
- [Inactive battery devices](examples/inactive-battery-devices.yaml): devices whose enabled registered entities have no recorded changes for 14 days.
- [Current power usage](examples/current-power-usage.yaml): live power readings above zero.
- [Lights on by area](examples/lights-on-by-area.yaml): generic filter combining domain and state conditions.
- [Door sensors by area](examples/door-sensors-by-area.yaml): binary sensor states with opt-in Home Assistant theme colors.
- [Filtered sensors by area](examples/filtered-sensors-by-area.yaml): entity ID/name wildcards and exclusions.
- [Unavailable power and battery sensors](examples/unavailable-power-and-battery.yaml): generic state filters that preserve `unknown` and `unavailable` readings.

These are complete card configurations. Copy an example into a **Manual** dashboard card and adjust it as needed.

## Generic queries

Each condition has a `field`, `op`, and usually a `value`:

```yaml
query:
  from: entities
  where:
    all:
      - field: domain
        op: in
        value: [sensor, binary_sensor]
      - field: area.name
        op: eq
        value: Kitchen
      - any:
          - field: entity.state
            op: lt
            value: 20
          - field: entity.attributes.config.critical
            op: eq
            value: true
      - not:
          - field: entity.disabled
            op: eq
            value: true
  columns:
    - entity_id
    - entity.name
    - entity.state
    - entity.attributes.config.critical
  sort:
    by: entity.state
    descending: false
  limit: 100
```

Operators:

| Operator | Meaning |
| --- | --- |
| `eq`, `ne` | Equal or not equal, case-sensitive |
| `gt`, `gte`, `lt`, `lte` | Finite numeric comparison; nonnumeric and missing values do not match |
| `in` | Match any item in a list of 1-100 scalar values |
| `contains` | Substring in text, or an equal item in a list |
| `starts_with`, `ends_with` | Case-sensitive text matching |
| `exists` | Boolean check for a present, non-null value |

Missing values do not match ordinary comparisons, including `ne`. Use `exists: false` or `not` when needed. `all` and `any` accept non-empty lists of up to 100 filters; `not` accepts exactly one filter. Filters allow up to 100 conditions, 256 filter nodes (including empty mappings and groups), and 8 nested group levels. An empty `where: {}` matches all readable entities.

### Shorthand

The original examples remain valid. Scalar values mean `eq`; lists mean `in`:

```yaml
where:
  domain: sensor
  device_class: power
  state:
    gt: 0
```

Aliases: `state` means `entity.state`, `device_class` means `entity.attributes.device_class`, `unit` means `entity.unit`, and `name`/`entity_name` means `entity.name`. Domain, state, entity ID, entity/device/area metadata, and `entity.attributes.*` paths can also be used directly. Multiple device classes are supported with a list such as `device_class: [power, battery]`.

For `entity_id`, `name`, and `entity_name`, `*` matches zero or more characters. Matching is case-sensitive and covers the whole value; other characters, including regex and glob metacharacters, are literal. Patterns are limited to 256 characters. Multiple values or patterns in one list use OR, while separate filter fields use AND:

```yaml
where:
  entity_id: [sensor.kitchen_*, sensor.office_*]
  entity_name: ["*Temperature*", "*Humidity*"]
```

Add `exclude` beside any entity filter to reject matching entity IDs or names. It accepts scalar values or arrays; any matching entry excludes the entity. Exclusions can be combined with shorthand, boolean groups, or used alone:

```yaml
where:
  device_class: [power, battery]
  exclude:
    entity_id:
      - sensor.kitchen_test
      - sensor.*_calibration
    entity_name:
      - "*Test*"
      - "*Disabled*"
```

The original power and battery shorthand retains its sensor-domain, unit, and missing-reading behavior. Lists containing those classes apply the same requirements per class. Generic filters preserve raw states, including `unknown` and `unavailable`; only `parse_state: true` converts embedded numeric readings. Use explicit `entity.attributes.device_class` conditions for unrestricted generic power and battery queries.

### Embedded state units

Set `parse_state: true` beside `from` and `where` when an integration stores a number and its unit together in the state:

```yaml
query:
  from: entities
  parse_state: true
  where:
    state:
      gte: 0
```

States such as `"0W"`, `"0 W"`, `"-2.5 kW"`, `"21.5°C"`, and `"98.6%"` become numeric `entity.state` values with the suffix available as `entity.unit`. An existing `unit_of_measurement` attribute takes precedence over the parsed suffix. Parsing supports optional whitespace and decimal or scientific notation, but not decimal commas or unit conversion.

The option defaults to `false`. Plain numeric states keep their existing representation, while unknown, unavailable, nonfinite, and malformed states remain unchanged and do not match numeric comparisons. A parsed zero still does not match `state: {gt: 0}`; use `gte: 0` or remove the threshold when zero readings should appear. Device `has_entity` filters support the same option.

### Fields and results

Available fields include:

- `entity_id`, `domain`, `entity.name`, `entity.state`, `entity.unit`, `entity.device_class`, `entity.disabled`, `entity.platform`
- `entity.attributes.<name>` with nested paths such as `entity.attributes.config.zone`
- `device.id`, `device.name`, `device.manufacturer`, `device.model`
- `area.id`, `area.name`
- `battery.level` for device results
- `history.last_change`, `history.days_inactive`, `history.status` for device history results

Select up to 32 unique columns. **An explicit column list replaces all default UI columns.** For example, `device.name`, `entity.state`, and `entity.unit` display only **Device** and **State** (the unit is combined into the state value). Internal metadata needed for grouping, links, and colors does not create extra UI columns. If explicit columns still show the default headings after an update, restart HA and hard-refresh the browser to load matching backend and card versions.

Sort by any supported field, including an attribute that is not selected as a column. Arrays and objects selected as columns display as JSON text. Date/time attributes use Home Assistant's ISO formatting; sets and tuples become arrays, and dataclass attributes become objects. Unsupported objects and nonfinite numbers are rejected.

Responses are limited to 500 rows and 4 MB, including the WebSocket result envelope. Response preparation stops when the byte budget is exceeded instead of encoding an oversized result in full. Nested output is also bounded to 32 levels and 100,000 traversal steps across values and fields; select smaller attribute paths if these limits are exceeded.

### Group by area

Add `group_by: area` to the card configuration. Areas render as separate responsive panels; narrow cards use labeled rows without horizontal scrolling. State and unit columns display together, such as `95%`. The backend sorts and applies `limit` before grouping; `limit` defaults to 100. A warning appears when matching results are truncated.

The default refresh interval is five minutes. Set `refresh_seconds` to a number from 60 through 2,147,483 to change it.

### Binary sensor state colors

Set `state_color: true` at the card level, alongside `query`, to color binary sensor `entity.state` cells. It defaults to `false` and accepts only a boolean. Other domains, columns, and device-query results keep their normal text color.

Colors follow Home Assistant's theme fallback order: device class and state, binary sensor state, binary sensor active/inactive, then general active/inactive color. Custom themes can override these variables; for example, `state-binary_sensor-door-on-color` sets the open-door color. Unknown, unavailable, and missing states keep the normal text color.

State text remains unchanged: a door sensor displays `on` for open and `off` for closed. Colors use the same query snapshot as the text and update on the card's normal refresh interval. Device class metadata is included automatically, so it does not need to be selected as a column. Missing or malformed device classes fall back to the domain colors; `entity.device_class` is null for non-text values or strings longer than 64 characters.

### Entity links

Set `entity_links: true` at the card level, alongside `query`, to make displayed entity names clickable. Each button opens Home Assistant's **More information** dialog for its entity; it never opens an arbitrary external URL. When `entity.name` is not selected, a selected `entity_id` column becomes the link instead. Entity metadata is included automatically, so `entity_id` need not be selected when names are shown.

The option defaults to `false` and accepts only a boolean. Names and IDs remain plain text without this option. Device-query results have no entity links. Only syntactically valid entity IDs become buttons; buttons support native keyboard activation and include an accessible "More information" label.

## Device queries and history

Use `from: devices`. `has_entity` accepts the same generic entity filters, including a single `field`/`op`/`value` condition, boolean groups, wildcards, and exclusions. A non-empty selector requires at least one matching loaded entity. Omitting it or using `has_entity: {}` selects all readable registered devices with enabled entities. Additional device conditions belong in `has_entity` when they describe the matching entity. With `history.scope: matching_entities`, history uses only entities remaining after exclusions; device permission checks still cover every participating entity.

```yaml
from: devices
where:
  has_entity:
    all:
      - field: domain
        op: eq
        value: climate
      - field: entity.state
        op: ne
        value: "off"
  history:
    scope: matching_entities
    no_changes_for: 14d
```

History scopes:

- `all_entities`: require inactivity across every enabled registered entity on the device.
- `matching_entities`: evaluate only entities matching `has_entity`.

`history.scope` defaults to `all_entities`; `no_changes_for` defaults to **14 days** and accepts `1d` through `365d`. Omit `history` entirely for live device queries without Recorder access.

Recorder must retain enough history. Home Assistant normally purges detailed state history after about 10 days. For the default window, retain at least 30 days:

```yaml
recorder:
  purge_keep_days: 30
  auto_purge: true
```

Increasing retention does not restore purged history. Devices with missing or excluded history are omitted rather than marked inactive. History queries require Recorder to be running and recording, and reject inactivity when a selected entity has a recent live state or attribute update, even if that update has not reached the database yet. Devices whose enabled entity membership changes during a history read are omitted until the next query.

Recorder interruptions and past exclusions can leave gaps that retained timestamps cannot prove absent. Re-enabling recording does not fill those gaps. Results describe the retained change evidence, not a guarantee of uninterrupted monitoring. `last_updated_ts` tracks state or attribute changes; it does not prove radio communication.

## Development

Use Python 3.14.2+ in a virtual environment and Node.js 22.13+:

```bash
python -m pip install -r requirements-test.txt
npm ci
python -m ruff check .
npm run lint
python -m unittest discover -s tests -v
python -m compileall -q custom_components
npm test
```

GitHub Actions runs Python and JavaScript lint and tests on Linux. Tests cover the generic filter language, legacy examples, API contracts, permissions, area resolution, resource ownership, query lifecycle, SQLite read-only behavior, and card timers/rendering.

## Security

Queries require an authenticated Home Assistant session and respect entity read permissions. Device queries require access to every participating entity. Users cannot supply SQL, templates, regular expressions, or executable code. Attribute access is dictionary-only, with validated field paths and bounded filters.

Only one history database job runs at a time. Excess requests fail promptly instead of building an unlimited queue. Disabling or removing the integration stops query access immediately.

## License

[MIT](LICENSE)
