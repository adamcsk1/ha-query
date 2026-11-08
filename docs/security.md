# Security

HA Query exposes read-only Home Assistant data through an authenticated WebSocket session.

## Permissions

- Entity results require `POLICY_READ` access to each entity.
- Device results require access to every participating enabled registered entity.
- Permissions are checked again after Recorder reads.
- Device membership, Recorder exclusions, and recent live activity are also checked after database reads.
- Disabling or unloading the integration stops query access without returning stale results.

## Query and database boundaries

Users cannot supply SQL, Jinja, regular expressions, Python, or arbitrary JavaScript. Attribute access is dictionary-only with validated, bounded paths. Filters, groups, columns, rows, and nesting have fixed limits.

SQLite entity IDs are parameter-bound. Recorder connections are read-only, run outside the event loop, and have execution and concurrency limits. Only one history database job runs at a time; excess requests fail promptly instead of building an unlimited queue.

Responses are limited to 500 rows and 4 MB. Serialization stops when response size, depth, or traversal limits are exceeded. Internal row attributes are not exposed unless explicitly selected through a supported field path.

## Dashboard rendering

Remote names, attributes, warnings, and errors are rendered as text, not HTML. Entity links open Home Assistant's More Information dialog rather than arbitrary URLs. Display mappings are bounded and validated. CSS state colors use validated device classes and fixed theme-variable patterns.

The integration removes only an unchanged dashboard resource that it created and still owns. Pre-existing or user-modified resources are preserved.
