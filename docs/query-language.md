# Query language and history

Queries use structured YAML filters. They never accept raw SQL, Jinja, regular expressions, or executable code. See [Configuration](configuration.md) for card and query option tables.

## Filters

Each explicit condition has a `field`, `op`, and usually a `value`:

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

| Operator | Meaning |
| --- | --- |
| `eq`, `ne` | Equal or not equal, case-sensitive |
| `gt`, `gte`, `lt`, `lte` | Finite numeric comparison; nonnumeric and missing values do not match |
| `in` | Match any item in a list of 1 to 100 scalar values |
| `contains` | Substring in text, or an equal item in a list |
| `starts_with`, `ends_with` | Case-sensitive text matching |
| `exists` | Boolean check for a present, non-null value |

Missing values do not match ordinary comparisons, including `ne`. Use `exists: false` or `not` when needed. `all` and `any` accept nonempty lists of up to 100 filters; `not` accepts exactly one filter. Filters allow up to 100 conditions, 256 filter nodes including empty mappings and groups, and 8 nested group levels. An empty `where: {}` matches all readable entities.

## Shorthand

Scalar values mean `eq`; lists mean `in`:

```yaml
where:
  domain: sensor
  device_class: power
  state:
    gt: 0
```

Aliases:

| Alias | Field |
| --- | --- |
| `state` | `entity.state` |
| `device_class` | `entity.attributes.device_class` |
| `unit` | `entity.unit` |
| `name`, `entity_name` | `entity.name` |

Domain, state, entity ID, entity/device/area metadata, and `entity.attributes.*` paths can also be used directly. Multiple device classes are supported with a list such as `device_class: [power, battery]`.

For `entity_id`, `name`, and `entity_name`, `*` matches zero or more characters. Matching is case-sensitive and covers the whole value. Other characters, including regex and glob metacharacters, are literal. Patterns are limited to 256 characters. Multiple values or patterns in one list use OR, while separate filter fields use AND:

```yaml
where:
  entity_id: [sensor.kitchen_*, sensor.office_*]
  entity_name: ["*Temperature*", "*Humidity*"]
```

Add `exclude` beside any entity filter to reject matching entity IDs or names. It accepts scalar values or arrays; any matching entry excludes the entity. Exclusions can be combined with shorthand or boolean groups, or used alone:

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

## Embedded state units

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

## Fields and results

| Source | Fields |
| --- | --- |
| Entities | `entity_id`, `domain`, `entity.name`, `entity.state`, `entity.unit`, `entity.device_class`, `entity.disabled`, `entity.platform` |
| Nested entity attributes | `entity.attributes.<name>`, such as `entity.attributes.config.zone` |
| Device metadata | `device.id`, `device.name`, `device.manufacturer`, `device.model` |
| Areas | `area.id`, `area.name` |
| Device results | `battery.level` |
| Device history results | `history.last_change`, `history.days_inactive`, `history.status` |

Sort by any supported field, including an attribute that is not selected as a column. Arrays and objects selected as columns display as JSON text. Date/time attributes use Home Assistant's ISO formatting; sets and tuples become arrays, and dataclass attributes become objects. Unsupported objects and nonfinite numbers are rejected.

Responses are limited to 500 rows and 4 MB, including the WebSocket result envelope. Response preparation stops when the byte budget is exceeded instead of encoding an oversized result in full. Nested output is also bounded to 32 levels and 100,000 traversal steps across values and fields; select smaller attribute paths if these limits are exceeded.

## Device queries and history

Use `from: devices`. `has_entity` accepts the same generic entity filters, including a single `field`/`op`/`value` condition, boolean groups, wildcards, and exclusions. A nonempty selector requires at least one matching loaded entity. Omitting it or using `has_entity: {}` selects all readable registered devices with enabled entities. Additional device conditions belong in `has_entity` when they describe the matching entity. With `history.scope: matching_entities`, history uses only entities remaining after exclusions; device permission checks still cover every participating entity.

```yaml
query:
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

| History option | Values | Default |
| --- | --- | --- |
| `scope` | `all_entities` or `matching_entities` | `all_entities` |
| `no_changes_for` | `1d` through `365d` | `14d` |

- `all_entities`: require inactivity across every enabled registered entity on the device.
- `matching_entities`: evaluate only entities matching `has_entity`.

Omit `history` entirely for live device queries without Recorder access. Event-driven history refreshes are limited to one per minute per card; see [Configuration](configuration.md#grouping-and-updates).

Recorder must retain enough history. Home Assistant normally purges detailed state history after about 10 days. For the default window, retain at least 30 days:

```yaml
recorder:
  purge_keep_days: 30
  auto_purge: true
```

Increasing retention does not restore purged history. Devices with missing or excluded history are omitted rather than marked inactive. History queries require Recorder to be running and recording, and reject inactivity when a selected entity has a recent live state or attribute update, even if that update has not reached the database yet. Devices whose enabled entity membership changes during a history read are omitted until the next query.

Recorder interruptions and past exclusions can leave gaps that retained timestamps cannot prove absent. Re-enabling recording does not fill those gaps. Results describe the retained change evidence, not a guarantee of uninterrupted monitoring. `last_updated_ts` tracks state or attribute changes; it does not prove radio communication.
