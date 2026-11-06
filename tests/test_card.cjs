const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const {join} = require('node:path');
const {test} = require('node:test');
const vm = require('node:vm');

const source = readFileSync(join(__dirname, '../custom_components/ha_query/frontend/ha-query-card.js'), 'utf8');
const query = {from: 'entities', where: {device_class: 'power'}};
const config = (seconds = 60) => ({query, refresh_seconds: seconds});
const tick = () => new Promise(resolve => setImmediate(resolve));

function fixture() {
  const intervals = new Map();
  let nextId = 0;
  let Card;
  class Element {
    constructor(tag = 'custom-card') {
      this.tag = tag; this.children = []; this.style = {}; this.dataset = {}; this.attributes = {};
      this.classList = {add: (...names) => { this.className = `${this.className || ''} ${names.join(' ')}`.trim(); }};
    }
    setAttribute(name, value) { this.attributes[name] = String(value); }
    getAttribute(name) { return this.attributes[name]; }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; }
    set innerHTML(value) { throw new Error('Unsafe HTML rendering'); }
  }
  const context = vm.createContext({
    HTMLElement: Element,
    document: {createElement: tag => new Element(tag)},
    customElements: {get: () => undefined, define: (name, cls) => { Card = cls; }},
    window: {},
    setInterval: (callback, delay) => { intervals.set(++nextId, {callback, delay}); return nextId; },
    clearInterval: id => intervals.delete(id),
  });
  vm.runInContext(source, context);
  const card = new Card();
  card.isConnected = true;
  const requests = [];
  const hass = {callWS: message => new Promise((resolve, reject) => requests.push({message, resolve, reject}))};
  return {card, intervals, requests, hass};
}

function descendants(node) {
  return [node, ...node.children.flatMap(descendants)];
}

test('refresh settings are finite, bounded numbers', () => {
  for (const value of ['oops', '60', NaN, Infinity, -Infinity, 0, -1, 59, 2147484, true]) {
    const {card, intervals} = fixture();
    assert.throws(() => card.setConfig(config(value)), /refresh_seconds/);
    assert.equal(intervals.size, 0);
  }
  const {card, intervals} = fixture();
  card.setConfig({query});
  assert.equal([...intervals.values()][0].delay, 300000);
  card.setConfig(config(2147483));
  assert.equal([...intervals.values()][0].delay, 2147483000);
});

test('changing refresh replaces timer and rejected config leaves old timer intact', () => {
  const {card, intervals} = fixture();
  card.setConfig(config());
  card.setConfig(config(21600));
  assert.equal(intervals.size, 1);
  assert.equal([...intervals.values()][0].delay, 21600000);
  assert.throws(() => card.setConfig(config('bad')));
  assert.equal(intervals.size, 1);
  assert.equal([...intervals.values()][0].delay, 21600000);
});

test('no request before configuration or while disconnected', () => {
  const {card, hass, requests, intervals} = fixture();
  card.hass = hass;
  assert.equal(requests.length, 0);
  card.isConnected = false;
  card.setConfig(config());
  card.hass = hass;
  assert.equal(requests.length, 0);
  assert.equal(intervals.size, 0);
  card.isConnected = true;
  card.connectedCallback();
  assert.equal(requests.length, 1);
  assert.equal(intervals.size, 1);
});

test('only one request in flight despite state updates and timer ticks', async () => {
  const {card, hass, requests, intervals} = fixture();
  card.setConfig(config());
  card.hass = hass;
  for (let i = 0; i < 10; i++) {
    card.hass = hass;
    [...intervals.values()][0].callback();
  }
  assert.equal(requests.length, 1);
  requests[0].resolve({rows: [], columns: []});
  await tick();
  [...intervals.values()][0].callback();
  assert.equal(requests.length, 2);
});

test('new config discards old response and automatically fetches newest query', async () => {
  const {card, hass, requests} = fixture();
  card.setConfig(config());
  card.hass = hass;
  const replacement = {from: 'devices', where: {has_entity: {device_class: 'battery'}}};
  card.setConfig({query: replacement});
  assert.equal(requests.length, 1);
  requests[0].resolve({rows: [{old: true}], columns: ['old']});
  await tick();
  assert.equal(card._rows.length, 0);
  assert.equal(requests.length, 2);
  assert.equal(requests[1].message.query, replacement);
  requests[1].resolve({rows: [{current: true}], columns: ['current']});
  await tick();
  assert.equal(card._rows[0].current, true);
});

test('old errors cannot replace new configuration', async () => {
  const {card, hass, requests} = fixture();
  card.setConfig(config());
  card.hass = hass;
  card.setConfig({...config(), title: 'New config'});
  requests[0].reject(new Error('Old failure'));
  await tick();
  assert.equal(card._error, '');
  assert.equal(requests.length, 2);
});

test('disconnect stops timer, ignores late result and reconnect fetches', async () => {
  const {card, hass, requests, intervals} = fixture();
  card.setConfig(config());
  card.hass = hass;
  card.isConnected = false;
  card.disconnectedCallback();
  assert.equal(intervals.size, 0);
  requests[0].resolve({rows: [{stale: true}], columns: ['stale']});
  await tick();
  assert.equal(card._rows.length, 0);
  assert.equal(requests.length, 1);
  card.isConnected = true;
  card.connectedCallback();
  assert.equal(requests.length, 2);
  assert.equal(intervals.size, 1);
});

test('reconnect during old request starts new fetch after completion', async () => {
  const {card, hass, requests} = fixture();
  card.setConfig(config());
  card.hass = hass;
  card.isConnected = false;
  card.disconnectedCallback();
  card.isConnected = true;
  card.connectedCallback();
  requests[0].resolve({rows: [{stale: true}]});
  await tick();
  assert.equal(requests.length, 2);
  assert.equal(card._rows.length, 0);
});

test('renders untrusted title, warning, header and cell as text', async () => {
  const {card, hass, requests} = fixture();
  const payload = '<img src=x onerror=alert(1)>';
  card.setConfig({...config(), title: payload});
  card.hass = hass;
  assert(descendants(card).some(node => node.textContent === 'Loading…'));
  requests[0].resolve({rows: [{[payload]: payload}], columns: [payload], warnings: [payload]});
  await tick();
  assert.equal(descendants(card).filter(node => node.textContent === payload).length, 4);
  assert.equal(descendants(card).filter(node => node.tag === 'img').length, 0);
});

test('generic object attributes render as JSON text', async () => {
  const {card, hass, requests} = fixture();
  card.setConfig({...config(), group_by: 'area'});
  card.hass = hass;
  requests[0].resolve({columns: ['entity.attributes.config'], rows: [
    {'area.id': 'office', 'area.name': 'Office', 'entity.attributes.config': {mode: 'reading'}},
  ]});
  await tick();
  assert(descendants(card).some(node => node.getAttribute('role') === 'cell' && node.textContent === '{"mode":"reading"}'));
});

test('current failure shows error and successful retry clears it', async () => {
  const {card, hass, requests, intervals} = fixture();
  card.setConfig(config());
  card.hass = hass;
  requests[0].reject(new Error('Failed'));
  await tick();
  assert.equal(card._error, 'Failed');
  assert.equal(card._loading, false);
  [...intervals.values()][0].callback();
  requests[1].resolve({rows: [], columns: []});
  await tick();
  assert.equal(card._error, '');
});

test('unsupported grouping fails without starting polling', () => {
  for (const group_by of ['device', '', null, true, {}]) {
    const {card, intervals} = fixture();
    assert.throws(() => card.setConfig({...config(), group_by}), /group_by/);
    assert.equal(intervals.size, 0);
  }
});

test('area groups are alphabetical, unassigned last, with row ordering preserved', async () => {
  const {card, hass, requests} = fixture();
  card.setConfig({...config(), group_by: 'area'});
  card.hass = hass;
  requests[0].resolve({columns: ['entity.state'], rows: [
    {'area.id': null, 'area.name': 'Unassigned', 'entity.state': 1},
    {'area.id': 'office', 'area.name': 'Office', 'entity.state': 2},
    {'area.id': 'kitchen', 'area.name': 'Kitchen', 'entity.state': 3},
    {'area.id': 'office', 'area.name': 'Office', 'entity.state': 4},
    {'area.id': 'kitchen', 'area.name': 'Kitchen', 'entity.state': null},
  ]});
  await tick();
  assert.deepEqual(descendants(card).filter(n => n.tag === 'h4').map(n => n.textContent), ['Kitchen', 'Office', 'Unassigned']);
  const tables = descendants(card).filter(n => n.getAttribute('role') === 'table');
  assert.equal(tables.length, 3);
  assert.deepEqual(descendants(tables[0]).filter(n => n.getAttribute('role') === 'cell').map(n => n.textContent), ['3', '-']);
  assert.deepEqual(descendants(tables[1]).filter(n => n.getAttribute('role') === 'cell').map(n => n.textContent), ['2', '4']);
  assert.equal(card.getCardSize(), 4);
});

test('area identity prevents duplicate names and Unassigned names merging', async () => {
  const {card, hass, requests} = fixture();
  card.setConfig({...config(), group_by: 'area'});
  card.hass = hass;
  requests[0].resolve({columns: ['entity.state'], rows: [
    {'area.id': 'b', 'area.name': 'Room'},
    {'area.id': '__proto__', 'area.name': 'Room'},
    {'area.id': 'real-area', 'area.name': 'Unassigned'},
    {},
  ]});
  await tick();
  assert.equal(descendants(card).filter(n => n.getAttribute('role') === 'table').length, 4);
  assert.equal(card._groups().at(-1).id, null);
});

test('area headings render as plain text and truncation warnings remain visible', async () => {
  const {card, hass, requests} = fixture();
  const payload = '<script>alert(1)</script>';
  card.setConfig({...config(), group_by: 'area'});
  card.hass = hass;
  requests[0].resolve({columns: ['entity.state'], warnings: ['Results truncated'], rows: [
    {'area.id': 'area', 'area.name': payload, 'entity.state': 5},
  ]});
  await tick();
  assert(descendants(card).some(n => n.tag === 'h4' && n.textContent === payload));
  assert(descendants(card).some(n => n.textContent === 'Results truncated'));
  assert(!descendants(card).some(n => n.tag === 'script'));
});

test('responsive CSS uses contained grids and labeled narrow rows', async () => {
  const {card, hass, requests} = fixture();
  card.setConfig({...config(), group_by: 'area'});
  card.hass = hass;
  requests[0].resolve({columns: ['entity.name', 'device.name'], rows: [
    {'area.id': 'kitchen', 'area.name': 'Kitchen', 'entity.name': 'Door', 'device.name': 'Sensor'},
  ]});
  await tick();
  const styles = descendants(card).find(node => node.tag === 'style').textContent;
  assert(styles.includes('repeat(auto-fit, minmax(min(100%, 320px), 1fr))'));
  assert(styles.includes('@container (max-width: 440px)'));
  const mobile = styles.split('@container (max-width: 440px)')[1];
  assert(mobile.includes('.haq-grid { display: block; }'));
  assert(mobile.includes('.haq-grid-header { display: none; }'));
  assert(styles.includes('content: attr(data-label)'));
  assert(styles.includes('overflow-wrap: anywhere'));
  const cells = descendants(card).filter(node => node.getAttribute('role') === 'cell');
  assert.deepEqual(cells.map(node => node.dataset.label), ['Entity', 'Device']);
  assert.equal(descendants(card).filter(node => node.tag === 'table').length, 0);
  assert.equal(descendants(card).find(node => node.getAttribute('role') === 'table').style.gridTemplateColumns,
    'repeat(2, minmax(0, 1fr))');
});

test('area panels have accessible names and separate result counts', async () => {
  const {card, hass, requests} = fixture();
  card.setConfig({...config(), group_by: 'area'});
  card.hass = hass;
  requests[0].resolve({columns: ['entity.state'], rows: [
    {'area.id': 'kitchen', 'area.name': 'Kitchen', 'entity.state': 1},
    {'area.id': 'kitchen', 'area.name': 'Kitchen', 'entity.state': 2},
    {'area.id': 'office', 'area.name': 'Office', 'entity.state': 3},
  ]});
  await tick();
  const panels = descendants(card).filter(node => node.className === 'haq-group');
  assert.equal(panels.length, 2);
  assert.deepEqual(panels.map(node => node.getAttribute('aria-label')), ['Kitchen', 'Office']);
  assert.deepEqual(panels.map(node => descendants(node).find(n => n.className === 'haq-count').textContent), ['2', '1']);
  assert.equal(descendants(card).filter(node => node.getAttribute('role') === 'columnheader').length, 2);
  assert.equal(descendants(card).filter(node => node.getAttribute('role') === 'row').length, 5);
});

test('state and unit share one value cell without losing unit-only queries', async () => {
  const {card, hass, requests} = fixture();
  card.setConfig(config());
  card.hass = hass;
  requests[0].resolve({columns: ['entity.state', 'entity.unit'], rows: [
    {'entity.state': 95, 'entity.unit': '%'}, {'entity.state': 10, 'entity.unit': 'W'},
    {'entity.state': null, 'entity.unit': '%'},
  ]});
  await tick();
  assert.deepEqual(descendants(card).filter(node => node.getAttribute('role') === 'columnheader').map(n => n.textContent), ['State']);
  assert.deepEqual(descendants(card).filter(node => node.getAttribute('role') === 'cell').map(n => n.textContent), ['95%', '10 W', '-']);
  card.setConfig(config());
  requests[1].resolve({columns: ['entity.unit'], rows: [{'entity.unit': 'W'}]});
  await tick();
  assert.deepEqual(descendants(card).filter(node => node.getAttribute('role') === 'columnheader').map(n => n.textContent), ['Unit']);
});

test('no grouping keeps one table; empty grouped card has no headings', async () => {
  const {card, hass, requests} = fixture();
  assert.equal(card.getCardSize(), 2);
  card.setConfig(config());
  card.hass = hass;
  requests[0].resolve({columns: ['entity.state'], rows: [{'area.id': 'one'}, {'area.id': 'two'}]});
  await tick();
  assert.equal(descendants(card).filter(n => n.getAttribute('role') === 'table').length, 1);
  assert.equal(descendants(card).filter(n => n.tag === 'h4').length, 0);
  card.setConfig({...config(), group_by: 'area'});
  requests[1].resolve({rows: [], columns: []});
  await tick();
  assert.equal(descendants(card).filter(n => n.tag === 'h4').length, 0);
});
