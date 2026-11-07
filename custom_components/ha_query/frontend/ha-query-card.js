/* HA Query Lovelace card. No third-party JS dependencies. */
const CARD_STYLES = `
  :host { display: block; }
  .haq-card { container-type: inline-size; }
  .haq-content { padding: 16px; }
  .haq-title { margin: 0 0 16px; font-size: 1.25rem; font-weight: 400; }
  .haq-notice { margin: 0 0 12px; padding: 10px 12px; border-radius: 8px;
    background: var(--secondary-background-color); }
  .haq-warning { color: var(--warning-color, #b8860b); }
  .haq-error { color: var(--error-color); }
  .haq-empty { margin: 0; color: var(--secondary-text-color); }
  .haq-groups { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 320px), 1fr));
    gap: 12px; align-items: start; }
  .haq-group { min-width: 0; overflow: hidden; border: 1px solid var(--divider-color);
    border-radius: 10px; background: var(--secondary-background-color); }
  .haq-area-header { display: flex; align-items: center; justify-content: space-between; gap: 12px;
    padding: 12px 14px; background: var(--card-background-color); }
  .haq-area-title { min-width: 0; margin: 0; overflow-wrap: anywhere; font-size: 1rem; font-weight: 600; }
  .haq-count { flex: none; padding: 2px 8px; border-radius: 999px;
    background: var(--secondary-background-color); color: var(--secondary-text-color); font-size: .8rem; }
  .haq-grid { display: grid; min-width: 0; }
  .haq-grid-header, .haq-row { display: contents; }
  .haq-cell { min-width: 0; padding: 10px 12px; border-top: 1px solid var(--divider-color);
    overflow-wrap: anywhere; color: var(--primary-text-color); }
  .haq-column-header { padding-top: 9px; padding-bottom: 9px; color: var(--secondary-text-color);
    background: var(--card-background-color); font-size: .75rem; font-weight: 600; }
  .haq-value-cell { text-align: right; }
  .haq-entity-link { padding: 0; border: 0; background: none; color: var(--primary-color);
    font: inherit; font-weight: inherit; text-align: inherit; overflow-wrap: anywhere; cursor: pointer; }
  .haq-entity-link:hover { text-decoration: underline; }
  .haq-entity-link:focus-visible { outline: 2px solid var(--primary-color); outline-offset: 2px; }
  .haq-cell:first-child { font-weight: 500; }
  @container (max-width: 440px) {
    .haq-grid { display: block; }
    .haq-grid-header { display: none; }
    .haq-row { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 8px 12px; padding: 12px; border-top: 1px solid var(--divider-color); }
    .haq-cell { display: flex; flex-direction: column; gap: 2px; padding: 0; border: 0; text-align: left; }
    .haq-cell::before { content: attr(data-label); color: var(--secondary-text-color);
      font-size: .7rem; font-weight: 500; }
    .haq-cell:first-child { grid-column: 1 / -1; font-size: 1rem; font-weight: 600; }
    .haq-cell:first-child::before { display: none; }
  }
`;
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
    for (const option of ['state_color', 'entity_links']) {
      if (config[option] !== undefined && typeof config[option] !== 'boolean') {
        throw new Error(`${option} must be a boolean`);
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
    this._rows = [];
    this._columns = [];
    this._error = '';
    this._warnings = [];
    this._stopTimer();
    this._render();
    this._startTimer();
    this._fetch();
  }
  set hass(hass) {
    this._hass = hass;
    if (!this._config || this._loading) return;
    if (Date.now() - this._lastRefresh >= this._refreshMs) this._fetch();
  }
  connectedCallback() {
    if (this._hass && this._config) this._fetch();
    this._startTimer();
  }
  disconnectedCallback() {
    this._generation = (this._generation || 0) + 1;
    this._stopTimer();
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
    }
  }
  _render() {
    if (!this._config) return;
    this.replaceChildren();
    const style = document.createElement('style');
    style.textContent = CARD_STYLES;
    const card = document.createElement('ha-card');
    card.className = 'haq-card';
    const container = document.createElement('div');
    container.className = 'haq-content';
    const title = document.createElement('h3');
    title.className = 'haq-title';
    title.textContent = this._config.title || 'HA Query';
    container.append(title);
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
    return (this._columns || []).filter(column => column !== 'entity.unit' || !this._columns.includes('entity.state'));
  }
  _label(column) {
    return FIELD_LABELS[column] || column.split('.').at(-1).replaceAll('_', ' ');
  }
  _value(row, column) {
    const value = row[column];
    if (column === 'entity.state' && this._columns.includes('entity.unit')) {
      if (value == null) return '-';
      const unit = row['entity.unit'] || '';
      return `${value}${unit === '%' ? '%' : unit ? ` ${unit}` : ''}`;
    }
    return value == null ? '-' : typeof value === 'object' ? JSON.stringify(value) : String(value);
  }
  _stateColor(row) {
    const state = row['entity.state'];
    if (!this._config.state_color || row.domain !== 'binary_sensor' || !['on', 'off'].includes(state)) return '';
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
      const header = document.createElement('div');
      header.className = 'haq-area-header';
      const heading = document.createElement('h4');
      heading.className = 'haq-area-title';
      heading.textContent = group.name;
      const count = document.createElement('span');
      count.className = 'haq-count';
      count.textContent = String(group.rows.length);
      count.setAttribute('aria-label', `${group.rows.length} results`);
      header.append(heading, count); section.append(header);
    }
    section.append(this._renderGrid(group));
    return section;
  }
  _renderGrid(group) {
    const columns = this._displayColumns();
    const grid = document.createElement('div');
    grid.className = 'haq-grid';
    grid.setAttribute('role', 'table');
    grid.setAttribute('aria-label', `${group.name} results`);
    grid.style.gridTemplateColumns = `repeat(${columns.length}, minmax(0, 1fr))`;
    const header = document.createElement('div');
    header.className = 'haq-grid-header';
    header.setAttribute('role', 'row');
    for (const column of columns) header.append(this._cell(this._label(column), column, 'columnheader'));
    grid.append(header);
    for (const row of group.rows) {
      const element = document.createElement('div');
      element.className = 'haq-row';
      element.setAttribute('role', 'row');
      for (const column of columns) {
        const cell = this._cell(this._value(row, column), column, 'cell');
        if (column === 'entity.state') cell.style.color = this._stateColor(row);
        if (this._isEntityLink(row, column)) cell.replaceChildren(this._entityLink(row, cell.textContent));
        element.append(cell);
      }
      grid.append(element);
    }
    return grid;
  }
  _cell(value, column, role) {
    const cell = document.createElement('div');
    cell.className = 'haq-cell';
    if (role === 'columnheader') cell.classList.add('haq-column-header');
    if (['entity.state', 'battery.level', 'history.days_inactive'].includes(column)) cell.classList.add('haq-value-cell');
    cell.setAttribute('role', role);
    cell.dataset.label = this._label(column);
    cell.textContent = value;
    return cell;
  }
  _isEntityLink(row, column) {
    return this._config.entity_links
      && (column === 'entity.name' || (column === 'entity_id' && !this._columns.includes('entity.name')))
      && typeof row.entity_id === 'string' && row.entity_id.length <= 255
      && /^[a-z0-9_]+\.[a-z0-9_]+$/.test(row.entity_id)
      && !/[\n\r\u2028\u2029]/.test(row.entity_id);
  }
  _entityLink(row, value) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = value;
    button.className = 'haq-entity-link';
    button.setAttribute('aria-label', `More information: ${row['entity.name'] || row.entity_id}`);
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
    return Math.max(2, Math.ceil(((this._rows?.length || 0) + headings + 2) / 3));
  }
}
if (!customElements.get('ha-query-card')) customElements.define('ha-query-card', HaQueryCard);
window.customCards = window.customCards || [];
window.customCards.push({type:'ha-query-card', name:'HA Query Card', description:'Responsive read-only queries for Home Assistant'});
