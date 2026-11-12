/* HA Query Lovelace card. No third-party JS dependencies. */
const CARD_STYLES = `
  :host { display: block; }
  .haq-content { min-width: 0; container-type: inline-size; }
  .haq-title { margin: 0 0 12px; font-size: 1.25rem; line-height: 1.4; font-weight: 400; }
  .haq-notice { margin: 0 0 12px; }
  .haq-warning { color: var(--warning-color, #b8860b); }
  .haq-error { color: var(--error-color); }
  .haq-empty { margin: 0; color: var(--secondary-text-color); }
  .haq-groups { display: grid; gap: 20px; }
  .haq-group { min-width: 0; }
  .haq-area-title { min-width: 0; margin: 0 0 8px; overflow-wrap: anywhere;
    font-size: 1rem; line-height: 1.5; font-weight: 500; }
  .haq-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 280px), 1fr));
    gap: 12px; min-width: 0; }
  .haq-grid-sized { grid-template-columns: repeat(12, minmax(0, 1fr)); }
  .haq-grid-sized > .haq-tile { grid-column: span var(--haq-tile-columns); }
  @container (max-width: 560px) {
    .haq-grid-sized > .haq-tile { grid-column: 1 / -1; }
  }
  .haq-tile { display: flex; align-items: center; gap: 12px; min-width: 0; min-height: 70px;
    box-sizing: border-box; padding: 12px 16px; overflow: hidden;
    border: var(--ha-card-border-width, 1px) solid var(--ha-card-border-color, var(--divider-color));
    border-radius: var(--ha-card-border-radius, 12px); background: var(--card-background-color); }
  .haq-tile > ha-state-icon { flex: none; width: 24px; height: 24px;
    color: var(--state-icon-color, var(--secondary-text-color)); }
  .haq-tile-content { display: grid; gap: 2px; min-width: 0; }
  .haq-cell { min-width: 0; overflow-wrap: anywhere; color: var(--primary-text-color); line-height: 1.4; }
  .haq-primary { font-weight: 500; }
  .haq-value-cell { font-variant-numeric: tabular-nums; }
  .haq-detail { font-size: .875rem; }
  .haq-detail::before { content: attr(data-label) ": "; color: var(--secondary-text-color); }
  .haq-entity-link { padding: 0; border: 0; background: none; color: inherit;
    font: inherit; font-weight: inherit; text-align: inherit; overflow-wrap: anywhere; cursor: pointer; }
  .haq-entity-link:hover { color: var(--primary-color); }
  .haq-entity-link:focus-visible { outline: 2px solid var(--primary-color); outline-offset: 2px; }
`;
const EVENT_REFRESH_MS = 250;
const HISTORY_EVENT_REFRESH_MS = 60_000;
const SUBSCRIPTION_RETRY_MS = 60_000;
const REGISTRY_EVENTS = ['entity_registry_updated', 'device_registry_updated', 'area_registry_updated'];
const FIELD_LABELS = {
  entity_id: 'Entity ID', 'entity.name': 'Entity', 'entity.state': 'State', 'entity.unit': 'Unit',
  'device.id': 'Device ID', 'device.name': 'Device', 'device.manufacturer': 'Manufacturer', 'device.model': 'Model',
  'area.id': 'Area ID', 'area.name': 'Area', 'battery.level': 'Battery',
  'history.last_change': 'Last change', 'history.days_inactive': 'Days inactive', 'history.status': 'Status',
};

class HaQueryCard extends HTMLElement {
  setConfig(config) {
    if (!config?.query || !config.query.from || !config.query.where) {
      throw new Error('ha-query-card requires query.from and query.where');
    }
    if (config.group_by !== undefined && config.group_by !== 'area') {
      throw new Error('group_by must be area when specified');
    }
    if (config.tile_grid_options !== undefined) {
      const options = config.tile_grid_options;
      if (!options || typeof options !== 'object' || Array.isArray(options)
          || Object.keys(options).some(key => !['columns', 'rows'].includes(key))) {
        throw new Error('tile_grid_options must be a mapping containing only columns and rows');
      }
      for (const key of ['columns', 'rows']) {
        if (Object.hasOwn(options, key) && (!Number.isInteger(options[key]) || options[key] < 1 || options[key] > 12)) {
          throw new Error(`tile_grid_options.${key} must be an integer between 1 and 12`);
        }
      }
    }
    for (const option of ['value_state_color', 'icon_state_color', 'entity_links', 'entity_icons']) {
      if (config[option] !== undefined && typeof config[option] !== 'boolean') {
        throw new Error(`${option} must be a boolean`);
      }
    }
    if (config.entity_names !== undefined) {
      const names = config.entity_names;
      if (!names || typeof names !== 'object' || Array.isArray(names) || Object.keys(names).length > 500) {
        throw new Error('entity_names must be a mapping of at most 500 entity IDs to labels');
      }
      for (const [entityId, label] of Object.entries(names)) {
        if (entityId.length > 255 || !/^[a-z0-9_]+\.[a-z0-9_]+$/.test(entityId)
            || /[\n\r\u2028\u2029]/.test(entityId) || typeof label !== 'string' || !label || label.length > 256) {
          throw new Error('entity_names requires valid entity IDs and nonempty labels of at most 256 characters');
        }
      }
    }
    if (config.entity_icon_overrides !== undefined) {
      const overrides = config.entity_icon_overrides;
      if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides) || Object.keys(overrides).length > 500) {
        throw new Error('entity_icon_overrides must be a mapping of at most 500 entity IDs to icons');
      }
      for (const [entityId, icon] of Object.entries(overrides)) {
        if (entityId.length > 255 || !/^[a-z0-9_]+\.[a-z0-9_]+$/.test(entityId)
            || /[\n\r\u2028\u2029]/.test(entityId) || typeof icon !== 'string' || icon.length > 128
            || !/^[a-z][a-z0-9_]*:[a-z0-9_-]+$/.test(icon) || /[\n\r\u2028\u2029]/.test(icon)) {
          throw new Error('entity_icon_overrides requires valid entity IDs and icon names such as mdi:door');
        }
      }
    }
    if (config.state_labels !== undefined) {
      const labels = config.state_labels;
      if (!labels || typeof labels !== 'object' || Array.isArray(labels)
          || Object.keys(labels).some(state => !['on', 'off', 'unknown', 'unavailable'].includes(state))
          || Object.values(labels).some(label => typeof label !== 'string' || !label || label.length > 64)) {
        throw new Error('state_labels supports on/off/unknown/unavailable with nonempty labels of at most 64 characters');
      }
    }
    const seconds = config.refresh_seconds ?? 300;
    if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 60 || seconds > 2147483) {
      throw new Error('refresh_seconds must be a number between 60 and 2147483');
    }
    this._config = config;
    this._generation = (this._generation || 0) + 1;
    this._refreshMs = seconds * 1000;
    this._lastRefresh = 0;
    this._pendingRefresh = false;
    this._stopSubscriptions();
    this._stopEventTimer();
    this._rows = [];
    this._columns = [];
    this._error = '';
    this._warnings = [];
    this._stopTimer();
    this._render();
    this._startTimer();
    this._startSubscriptions();
    this._fetch();
  }
  set hass(hass) {
    const connectionChanged = this._hass?.connection !== hass?.connection;
    this._hass = hass;
    if (connectionChanged) {
      this._generation = (this._generation || 0) + 1;
      this._stopSubscriptions();
      this._stopEventTimer();
      this._pendingRefresh = false;
    }
    this._startSubscriptions();
    if (!this._config || this._loading) return;
    if (Date.now() - this._lastRefresh >= this._refreshMs) this._fetch();
  }
  connectedCallback() {
    this._startSubscriptions();
    if (this._hass && this._config) this._fetch();
    this._startTimer();
  }
  disconnectedCallback() {
    this._generation = (this._generation || 0) + 1;
    this._pendingRefresh = false;
    this._stopTimer();
    this._stopEventTimer();
    this._stopSubscriptions();
  }
  _stopEventTimer() {
    if (this._eventTimer) clearTimeout(this._eventTimer);
    this._eventTimer = null;
  }
  _eventRefreshDelay() {
    if (this._config.query.from !== 'devices' || !this._config.query.where.history) return 0;
    return Math.max(0, HISTORY_EVENT_REFRESH_MS - (Date.now() - this._lastRefresh));
  }
  _queueRefresh() {
    if (!this.isConnected || !this._config) return;
    this._pendingRefresh = true;
    if (this._eventTimer) return;
    this._eventTimer = setTimeout(() => {
      this._eventTimer = null;
      if (this._eventRefreshDelay() > 0) {
        this._queueRefresh();
        return;
      }
      if (!this._loading) this._pendingRefresh = false;
      this._fetch();
    }, Math.max(EVENT_REFRESH_MS, this._eventRefreshDelay()));
  }
  _resetSubscriptions() {
    for (const unsubscribe of this._unsubscribes || []) unsubscribe();
    this._unsubscribes = [];
    this._failedSubscriptions = new Set();
    this._subscriptionRetryAt = 0;
    if (this._subscriptionRetryTimer) clearTimeout(this._subscriptionRetryTimer);
    this._subscriptionRetryTimer = null;
    this._subscriptionsConnection = null;
    this._subscriptionsStarting = false;
    this._subscriptionsGeneration = null;
  }
  _stopSubscriptions() {
    this._resetSubscriptions();
    if (this._readyConnection && this._readyListener) {
      this._readyConnection.removeEventListener('ready', this._readyListener);
    }
    this._readyConnection = null;
    this._readyListener = null;
  }
  _scheduleSubscriptionRetry() {
    if (this._subscriptionRetryTimer) return;
    this._subscriptionRetryTimer = setTimeout(() => {
      this._subscriptionRetryTimer = null;
      if (Date.now() < this._subscriptionRetryAt) {
        this._scheduleSubscriptionRetry();
        return;
      }
      this._startSubscriptions();
    }, Math.max(0, this._subscriptionRetryAt - Date.now()));
  }
  _startSubscriptions() {
    const connection = this._hass?.connection;
    const failed = this._failedSubscriptions || new Set();
    const retry = failed.size > 0 && Date.now() >= this._subscriptionRetryAt;
    if (this._subscriptionsStarting || (this._subscriptionsConnection === connection && !retry)
        || !connection?.subscribeMessage || !this.isConnected || !this._config) return;
    if (this._readyConnection !== connection) {
      const ready = () => {
        if (this._hass?.connection !== connection || !this.isConnected || !this._config) return;
        this._generation = (this._generation || 0) + 1;
        this._resetSubscriptions();
        this._startSubscriptions();
        this._queueRefresh();
      };
      connection.addEventListener('ready', ready);
      this._readyConnection = connection;
      this._readyListener = ready;
    }
    const generation = this._generation;
    this._subscriptionsStarting = true;
    this._subscriptionsGeneration = generation;
    const active = () => this._subscriptionsConnection === connection && this._subscriptionsGeneration === generation
      && this.isConnected && this._hass?.connection === connection;
    const subscribe = message => {
      const key = message.event_type || message.type;
      failed.delete(key);
      connection.subscribeMessage(() => { if (active()) this._queueRefresh(); }, message, {resubscribe: false}).then(unsubscribe => {
        if (!active()) { unsubscribe(); return; }
        this._unsubscribes.push(unsubscribe);
      }).catch(error => {
        if (!active()) return;
        failed.add(key);
        this._subscriptionRetryAt = Date.now() + SUBSCRIPTION_RETRY_MS;
        this._scheduleSubscriptionRetry();
        console.warn('HA Query event subscription failed; periodic refresh remains active', error);
      });
    };
    const messages = [{type: 'subscribe_entities'},
      ...REGISTRY_EVENTS.map(event_type => ({type: 'subscribe_events', event_type}))];
    for (const message of messages) {
      if (this._subscriptionsConnection !== connection || failed.has(message.event_type || message.type)) {
        subscribe(message);
      }
    }
    this._subscriptionsConnection = connection;
    this._subscriptionsStarting = false;
  }
  _stopTimer() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }
  _startTimer() {
    if (this._timer || !this.isConnected || !this._config) return;
    this._timer = setInterval(() => this._fetch(), this._refreshMs);
  }
  async _fetch() {
    if (this._loading || !this._hass || !this._config || !this.isConnected) return;
    const generation = this._generation;
    this._loading = true;
    this._lastRefresh = Date.now();
    this._render();
    try {
      const result = await this._hass.callWS({type: 'ha_query/run', query: this._config.query});
      if (generation !== this._generation) return;
      this._rows = result.rows || [];
      this._columns = result.columns || [];
      this._warnings = result.warnings || [];
      this._error = '';
    } catch (err) {
      if (generation === this._generation) this._error = String(err?.message || err);
    } finally {
      this._loading = false;
      if (generation === this._generation) this._render();
      else this._fetch();
      if (this._pendingRefresh && !this._eventTimer) this._queueRefresh();
    }
  }
  _render() {
    if (!this._config) return;
    this.replaceChildren();
    const style = document.createElement('style');
    style.textContent = CARD_STYLES;
    const card = document.createElement('div');
    card.className = 'haq-card';
    const container = document.createElement('div');
    container.className = 'haq-content';
    if (this._config.title) {
      const title = document.createElement('h3');
      title.className = 'haq-title';
      title.textContent = this._config.title;
      container.append(title);
    }
    for (const warning of this._warnings || []) {
      container.append(this._notice(warning, 'haq-warning'));
    }
    if (this._error) {
      container.append(this._notice(this._error, 'haq-error'));
    } else if (!this._rows.length) {
      const empty = document.createElement('p');
      empty.className = 'haq-empty';
      empty.textContent = this._loading ? 'Loading…' : 'No matching results (or insufficient history).';
      container.append(empty);
    } else {
      const groups = document.createElement('div');
      groups.className = 'haq-groups';
      for (const group of this._groups()) groups.append(this._renderGroup(group));
      container.append(groups);
    }
    card.append(container); this.append(style, card);
  }
  _notice(text, type) {
    const note = document.createElement('p');
    note.className = `haq-notice ${type}`;
    note.textContent = text;
    return note;
  }
  _groups() {
    if (this._config?.group_by !== 'area') return [{id: 'all', name: 'Results', rows: this._rows || []}];
    const groups = new Map();
    for (const row of this._rows || []) {
      const id = row['area.id'] ?? null;
      if (!groups.has(id)) groups.set(id, {id, name: id === null ? 'Unassigned' : row['area.name'], rows: []});
      groups.get(id).rows.push(row);
    }
    return [...groups.values()].sort((a, b) => {
      if (a.id === null) return 1;
      if (b.id === null) return -1;
      return a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
    });
  }
  _displayColumns() {
    const columns = (this._columns || []).filter(column => column !== 'entity.unit' || !this._columns.includes('entity.state'));
    const ordered = [this._entityColumn(), 'entity.state', ...columns];
    return [...new Set(ordered.filter(column => columns.includes(column)))];
  }
  _label(column) {
    return FIELD_LABELS[column] || column.split('.').at(-1).replaceAll('_', ' ');
  }
  _value(row, column) {
    const value = row[column];
    if (column === 'entity.name' && Object.hasOwn(this._config.entity_names || {}, row.entity_id)) {
      return this._config.entity_names[row.entity_id];
    }
    if (column === 'entity.state' && row.domain === 'binary_sensor'
        && Object.hasOwn(this._config.state_labels || {}, value)) {
      return this._config.state_labels[value];
    }
    if (column === 'entity.state' && this._columns.includes('entity.unit')) {
      if (value == null) return '-';
      const unit = row['entity.unit'] || '';
      return `${value}${unit === '%' ? '%' : unit ? ` ${unit}` : ''}`;
    }
    return value == null ? '-' : typeof value === 'object' ? JSON.stringify(value) : String(value);
  }
  _stateColor(row) {
    const state = row['entity.state'];
    if (row.domain !== 'binary_sensor' || !['on', 'off'].includes(state)) return '';
    const active = state === 'on' ? 'active' : 'inactive';
    // Match HA's state_color.ts fallback order without inserting arbitrary CSS.
    let color = `var(--state-binary_sensor-${state}-color, var(--state-binary_sensor-${active}-color, var(--state-${active}-color, var(--primary-text-color))))`;
    const deviceClass = row['entity.device_class'];
    if (typeof deviceClass === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(deviceClass)) {
      color = `var(--state-binary_sensor-${deviceClass}-${state}-color, ${color})`;
    }
    return color;
  }
  _renderGroup(group) {
    const section = document.createElement('section');
    section.className = 'haq-group';
    section.setAttribute('aria-label', group.name);
    if (this._config.group_by === 'area') {
      const heading = document.createElement('h4');
      heading.className = 'haq-area-title';
      heading.textContent = group.name;
      section.append(heading);
    }
    section.append(this._renderGrid(group));
    return section;
  }
  _renderGrid(group) {
    const grid = document.createElement('div');
    grid.className = 'haq-grid';
    const columns = this._config.tile_grid_options?.columns;
    if (columns !== undefined) {
      grid.classList.add('haq-grid-sized');
      grid.style.setProperty('--haq-tile-columns', String(columns));
    }
    for (const row of group.rows) grid.append(this._renderTile(row));
    return grid;
  }
  _renderTile(row) {
    const tile = document.createElement('div');
    tile.className = 'haq-tile';
    const rows = this._config.tile_grid_options?.rows;
    if (rows !== undefined) tile.style.minHeight = `${70 * rows + 12 * (rows - 1)}px`;
    const entityColumn = this._entityColumn();
    if (this._config.entity_icons && entityColumn) {
      const icon = this._entityIcon(row);
      if (icon) tile.append(icon);
    }
    const content = document.createElement('div');
    content.className = 'haq-tile-content';
    for (const column of this._displayColumns()) {
      const cell = this._cell(this._value(row, column), column, column === entityColumn);
      if (column === 'entity.state' && this._config.value_state_color) cell.style.color = this._stateColor(row);
      if (this._isEntityLink(row, column)) cell.replaceChildren(this._entityLink(row, cell.textContent));
      content.append(cell);
    }
    tile.append(content);
    return tile;
  }
  _cell(value, column, primary) {
    const cell = document.createElement('div');
    cell.className = 'haq-cell';
    if (primary) cell.classList.add('haq-primary');
    else if (column !== 'entity.state') cell.classList.add('haq-detail');
    if (['entity.state', 'battery.level', 'history.days_inactive'].includes(column)) cell.classList.add('haq-value-cell');
    cell.dataset.label = this._label(column);
    cell.textContent = value;
    return cell;
  }
  _entityColumn() {
    return ['entity.name', 'device.name', 'entity_id'].find(field => this._columns.includes(field));
  }
  _entityIcon(row) {
    const states = this._hass?.states;
    if (!states || typeof row.entity_id !== 'string' || !Object.hasOwn(states, row.entity_id)) return null;
    const icon = document.createElement('ha-state-icon');
    icon.hass = this._hass;
    icon.stateObj = states[row.entity_id];
    if (this._config.icon_state_color) icon.style.color = this._stateColor(row);
    icon.setAttribute('aria-hidden', 'true');
    if (Object.hasOwn(this._config.entity_icon_overrides || {}, row.entity_id)) {
      icon.icon = this._config.entity_icon_overrides[row.entity_id];
    }
    return icon;
  }
  _isEntityLink(row, column) {
    return this._config.entity_links && column === this._entityColumn()
      && typeof row.entity_id === 'string' && row.entity_id.length <= 255
      && /^[a-z0-9_]+\.[a-z0-9_]+$/.test(row.entity_id)
      && !/[\n\r\u2028\u2029]/.test(row.entity_id);
  }
  _entityLink(row, value) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = value;
    button.className = 'haq-entity-link';
    const name = Object.hasOwn(this._config.entity_names || {}, row.entity_id)
      ? this._config.entity_names[row.entity_id] : row['entity.name'];
    button.setAttribute('aria-label', `More information: ${name || row.entity_id}`);
    button.title = row.entity_id;
    const openEntity = () => this.dispatchEvent(new CustomEvent('hass-more-info', {
      bubbles: true, composed: true, detail: {entityId: row.entity_id},
    }));
    button.addEventListener('click', openEntity);
    button.addEventListener('keydown', event => {
      // Native buttons activate on Enter; handle Space like HA keyboard controls.
      if (event.key === ' ' && !event.repeat) {
        event.preventDefault();
        openEntity();
      }
    });
    return button;
  }
  getCardSize() {
    const headings = this._config?.group_by === 'area' ? this._groups().length : 0;
    const options = this._config?.tile_grid_options;
    if (options?.columns !== undefined || options?.rows !== undefined) {
      const width = this.clientWidth || 0;
      const perRow = options.columns === undefined ? Math.max(1, Math.floor((width + 12) / 292))
        : width <= 560 ? 1 : Math.floor(12 / options.columns);
      const tileRows = this._groups().reduce((count, group) => count + Math.ceil(group.rows.length / perRow), 0);
      const height = tileRows * 82 * (options.rows ?? 1) + headings * 32 + (this._config.title ? 40 : 0);
      return Math.max(2, Math.ceil(height / 50));
    }
    return Math.max(2, Math.ceil(((this._rows?.length || 0) + headings + 2) / 2));
  }
}
if (!customElements.get('ha-query-card')) customElements.define('ha-query-card', HaQueryCard);
window.customCards = window.customCards || [];
window.customCards.push({type:'ha-query-card', name:'HA Query Card', description:'Responsive read-only queries for Home Assistant'});
