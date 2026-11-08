# Troubleshooting

## Changes do not appear after an update

1. Update the installed integration and restart Home Assistant.
2. Hard-refresh the browser to load the current card script.
3. Check dashboard resources for an old or duplicate HA Query entry. The normal resource URL is `/ha-query/ha-query-card.js`.

Restarting only the dashboard or refreshing the browser does not update the Python query service. An old card script can show default columns or miss recently added display options.

## Entity values only change on the timer

Check the browser console for:

```text
HA Query event subscription failed; periodic refresh remains active
```

Failed subscriptions retry after 60 seconds. Home Assistant reconnects also establish fresh subscriptions. If failures continue, check the accompanying browser error and the Home Assistant logs.

The card must remain connected to receive events. Periodic refresh remains the fallback for missed events and failed subscriptions.

## Icons or links are missing

- Set `entity_icons: true` or `entity_links: true` at card level, beside `query`.
- Select `entity.name`, `device.name`, or `entity_id`. Only the highest-priority selected field receives the icon or link.
- Icons require a matching current entity in Home Assistant. Device-query results and missing states remain text-only.
- Device-query results do not have entity links.
- After adding these options to an older installation, update and restart HA, then hard-refresh the browser.

## YAML is rejected or options do not apply

Card options belong beside `type`. Query options, including `sort`, belong inside `query`.

Quote the `on` and `off` keys in `state_labels` so YAML does not parse them as booleans. Quote wildcard values that begin with `*`. Single and double quotes are both valid:

```yaml
state_labels:
  'on': Open
  'off': Closed
query:
  from: entities
  where:
    entity_id: "binary_sensor.*door*_contact"
  sort:
    by: entity.state
```

`state_labels` accepts only `on`, `off`, `unknown`, and `unavailable`, not wildcard keys.

## History results are empty or incomplete

History requires `from: devices` and `where.history`. Omit `history` for live device queries without Recorder access.

Recorder must be running and recording, use SQLite, and retain enough history. Missing or excluded history is not proof of inactivity, so affected devices are omitted. See [Device queries and history](query-language.md#device-queries-and-history) for retention and scope details.

Only one history database job runs at a time. Concurrent history requests can fail with an already-running error; retry after the current request finishes.
