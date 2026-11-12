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
  const timeouts = new Map();
  let nextId = 0;
  let now = Date.now();
  let Card;
  class Element {
    constructor(tag = 'custom-card') {
      this.tag = tag; this.children = []; this.style = {setProperty(name, value) { this[name] = value; }};
      this.dataset = {}; this.attributes = {};
      this.listeners = {}; this.events = [];
      this.classList = {add: (...names) => { this.className = `${this.className || ''} ${names.join(' ')}`.trim(); }};
    }
    setAttribute(name, value) { this.attributes[name] = String(value); }
    getAttribute(name) { return this.attributes[name]; }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; this.textContent = ''; }
    addEventListener(type, callback) { (this.listeners[type] ||= []).push(callback); }
    dispatchEvent(event) { this.events.push(event); return true; }
    set innerHTML(value) { throw new Error('Unsafe HTML rendering'); }
  }
  const context = vm.createContext({
    HTMLElement: Element,
    document: {createElement: tag => new Element(tag)},
    customElements: {get: () => undefined, define: (name, cls) => { Card = cls; }},
    CustomEvent: class CustomEvent { constructor(type, options) { this.type = type; Object.assign(this, options); } },
    Date: {now: () => now},
    window: {},
    setInterval: (callback, delay) => { intervals.set(++nextId, {callback, delay}); return nextId; },
    clearInterval: id => intervals.delete(id),
    setTimeout: (callback, delay) => { timeouts.set(++nextId, {callback, delay}); return nextId; },
    clearTimeout: id => timeouts.delete(id),
  });
  vm.runInContext(source, context);
  const card = new Card();
  card.isConnected = true;
  const requests = [];
  const subscriptions = [];
  const unsubscribes = [];
  const connectionListeners = {};
  const hass = {
    callWS: message => new Promise((resolve, reject) => requests.push({message, resolve, reject})),
    connection: {
      subscribeMessage: (callback, message, options) => {
        return new Promise((resolve, reject) => subscriptions.push({callback, message, options, resolve, reject}));
      },
      addEventListener: (type, callback) => { (connectionListeners[type] ||= new Set()).add(callback); },
      removeEventListener: (type, callback) => { connectionListeners[type]?.delete(callback); },
    },
  };
  const fireConnectionEvent = type => { for (const callback of [...(connectionListeners[type] || [])]) callback(); };
  const fireTimeouts = () => { const pending = [...timeouts.values()]; timeouts.clear(); for (const timer of pending) timer.callback(); };
  const advanceTime = milliseconds => { now += milliseconds; };
  return {card, intervals, timeouts, fireTimeouts, advanceTime, requests, subscriptions, unsubscribes, hass,
    connectionListeners, fireConnectionEvent};
}

function descendants(node) {
  return [node, ...node.children.flatMap(descendants)];
}

function resultCells(node) {
  return descendants(node).filter(element => (element.className || '').split(' ').includes('haq-cell'));
}

test('tile grid options reject malformed input without replacing valid configuration', () => {
  const invalid = [null, [], '6', 6, true, {width: 6}, {columns: 6, row: 1}];
  for (const key of ['columns', 'rows']) {
    for (const value of [0, -1, 13, 1.5, '6', true, null, undefined, NaN, Infinity, {}, []]) {
      invalid.push({[key]: value});
    }
  }
  const {card, intervals} = fixture();
  const options = {columns: 6, rows: 2};
  card.setConfig({...config(), tile_grid_options: options});
  const timer = [...intervals.keys()][0];
  for (const tile_grid_options of invalid) {
    assert.throws(() => card.setConfig({...config(), tile_grid_options}), /tile_grid_options/);
    assert.equal(card._config.tile_grid_options, options);
    assert.equal([...intervals.keys()][0], timer);
  }
  for (const tile_grid_options of [{}, {columns: 1}, {columns: 12}, {rows: 1}, {rows: 12}]) {
    card.setConfig({...config(), tile_grid_options});
    assert.equal(card._config.tile_grid_options, tile_grid_options);
  }
});

test('shared tile sizing applies to every group and ungrouped results', async () => {
  for (const group_by of [undefined, 'area']) {
    for (const columns of [1, 4, 6, 12]) {
      const {card, hass, requests} = fixture();
      card.setConfig({...config(), group_by, tile_grid_options: {columns, rows: 2}, grid_options: {columns: 12}});
      card.hass = hass;
      requests[0].resolve({columns: ['entity.name', 'entity.state'], rows: [
        {'area.id': 'kitchen', 'area.name': 'Kitchen', 'entity.name': 'Kitchen', 'entity.state': '20'},
        {'area.id': 'office', 'area.name': 'Office', 'entity.name': 'Office', 'entity.state': '21'},
      ]});
      await tick();
      const grids = descendants(card).filter(node => (node.className || '').includes('haq-grid-sized'));
      assert.equal(grids.length, group_by ? 2 : 1);
      assert(grids.every(grid => grid.style['--haq-tile-columns'] === String(columns)));
      const tiles = descendants(card).filter(node => node.className === 'haq-tile');
      assert.equal(tiles.length, 2);
      assert(tiles.every(tile => tile.style.minHeight === '152px'));
      assert.deepEqual(resultCells(card).map(cell => cell.textContent), ['Kitchen', '20', 'Office', '21']);
      const styles = descendants(card).find(node => node.tag === 'style').textContent;
      assert(styles.includes('.haq-content { min-width: 0; container-type: inline-size; }'));
      assert(styles.includes('.haq-grid-sized { grid-template-columns: repeat(12, minmax(0, 1fr)); }'));
      assert(styles.includes('grid-column: span var(--haq-tile-columns)'));
      assert(styles.includes('@container (max-width: 560px)'));
      assert(styles.includes('.haq-grid-sized > .haq-tile { grid-column: 1 / -1; }'));
    }
  }
});

test('omitted tile sizing preserves automatic layout and config changes remove old sizing', async () => {
  const {card, hass, requests} = fixture();
  card.hass = hass;
  for (const tile_grid_options of [{columns: 12, rows: 12}, {rows: 1}, {columns: 4}, {}, undefined]) {
    card.setConfig({...config(), tile_grid_options});
    requests.at(-1).resolve({columns: ['entity.name'], rows: [{'entity.name': 'Long name and extra content'}]});
    await tick();
    const grid = descendants(card).find(node => (node.className || '').split(' ').includes('haq-grid'));
    const tile = descendants(card).find(node => node.className === 'haq-tile');
    assert.equal(grid.className.includes('haq-grid-sized'), tile_grid_options?.columns !== undefined);
    assert.equal(grid.style['--haq-tile-columns'], tile_grid_options?.columns === undefined ? undefined : String(tile_grid_options.columns));
    assert.equal(tile.style.minHeight, tile_grid_options?.rows === undefined ? undefined
      : `${70 * tile_grid_options.rows + 12 * (tile_grid_options.rows - 1)}px`);
  }
});

test('Masonry sizing accounts for tile height, spans, groups and narrow cards', async () => {
  const {card, hass, requests} = fixture();
  card.hass = hass;
  card.clientWidth = 900;
  const load = async (tile_grid_options, group_by) => {
    card.setConfig({...config(), tile_grid_options, group_by});
    requests.at(-1).resolve({columns: ['entity.name'], rows: [
      {'entity.name': 'One', 'area.id': 'one', 'area.name': 'One'},
      {'entity.name': 'Two', 'area.id': 'two', 'area.name': 'Two'},
      {'entity.name': 'Three', 'area.id': 'two', 'area.name': 'Two'},
    ]});
    await tick();
    return card.getCardSize();
  };
  const standard = await load({columns: 12, rows: 1});
  const tall = await load({columns: 12, rows: 12});
  assert(tall > standard);
  assert(tall >= Math.ceil(3 * 972 / 50));
  const half = await load({columns: 6, rows: 1});
  assert(half < standard);
  const grouped = await load({columns: 6, rows: 1}, 'area');
  assert(grouped > half);
  card.clientWidth = 400;
  assert(card.getCardSize() > grouped);
  card.clientWidth = 900;
  const auto = await load({rows: 2});
  card.clientWidth = 400;
  assert(card.getCardSize() > auto);
});

test('explicit device, state and unit columns render one name and state tile', async () => {
  const {card, hass, requests} = fixture();
  card.setConfig(config());
  card.hass = hass;
  const row = {
    entity_id: 'binary_sensor.window', 'entity.name': 'Window sensor 3',
    'device.name': 'Window sensor 3', 'entity.state': 'off', 'entity.unit': '',
    domain: 'binary_sensor', 'entity.device_class': 'window', 'area.id': 'bedroom', 'area.name': 'Bedroom',
  };
  requests[0].resolve({columns: ['device.name', 'entity.state', 'entity.unit'], rows: [row]});
  await tick();
  const cells = resultCells(card);
  assert.deepEqual(cells.map(node => node.textContent), ['Window sensor 3', 'off']);
  assert(cells[0].className.includes('haq-primary'));
  assert(cells[1].className.includes('haq-value-cell'));
  assert.equal(descendants(card).filter(node => node.className === 'haq-tile').length, 1);
  assert.equal(descendants(card).filter(node => node.getAttribute('role')).length, 0);
});

test('primary names and states lead tiles without changing selected columns', async () => {
  const cases = [
    [['entity_id', 'entity.name', 'entity.state'], ['Window', 'off', 'binary_sensor.window']],
    [['device.id', 'device.name', 'battery.level'], ['Window device', 'device-1', '87']],
    [['entity.state', 'entity.name'], ['Window', 'off']],
    [['device.name', 'entity.name', 'entity.state'], ['Window', 'off', 'Window device']],
  ];
  for (const [columns, expected] of cases) {
    const {card, hass, requests} = fixture();
    card.setConfig(config());
    card.hass = hass;
    requests[0].resolve({columns, rows: [{
      entity_id: 'binary_sensor.window', 'entity.name': 'Window', 'entity.state': 'off',
      'device.id': 'device-1', 'device.name': 'Window device', 'battery.level': 87,
    }]});
    await tick();
    assert.deepEqual(resultCells(card).map(node => node.textContent), expected);
    assert.deepEqual(card._columns, columns);
  }
});

test('state color options accept only booleans without disturbing valid configuration', () => {
  for (const option of ['value_state_color', 'icon_state_color']) {
    const {card, intervals} = fixture();
    card.setConfig({...config(), [option]: true});
    const timer = [...intervals.keys()][0];
    for (const value of ['true', 'false', 0, 1, null, [], {}]) {
      assert.throws(() => card.setConfig({...config(), [option]: value}), new RegExp(option));
      assert.equal(card._config[option], true);
      assert.equal([...intervals.keys()][0], timer);
    }
    card.setConfig({...config(), [option]: false});
    assert.equal(card._config[option], false);
  }
});

test('binary sensor state coloring is opt-in and uses HA theme fallback order', async () => {
  for (const value_state_color of [undefined, false, true]) {
    const {card, hass, requests} = fixture();
    card.setConfig({...config(), value_state_color, group_by: 'area'});
    card.hass = hass;
    requests[0].resolve({columns: ['entity.name', 'entity.state'], rows: ['on', 'off'].map(state => ({
      domain: 'binary_sensor', 'entity.device_class': 'door', 'entity.name': 'Door', 'entity.state': state,
      'area.id': 'hall', 'area.name': 'Hall',
    }))});
    await tick();
    const cells = resultCells(card);
    assert.deepEqual(cells.map(node => node.textContent), ['Door', 'on', 'Door', 'off']);
    assert.equal(cells[0].style.color, undefined);
    for (const [cell, state, active] of [[cells[1], 'on', 'active'], [cells[3], 'off', 'inactive']]) {
      assert.equal(cell.style.color, value_state_color
        ? `var(--state-binary_sensor-door-${state}-color, var(--state-binary_sensor-${state}-color, var(--state-binary_sensor-${active}-color, var(--state-${active}-color, var(--primary-text-color)))))`
        : undefined);
    }
  }
});

test('coloring stays neutral for nonbinary and missing states and rejects CSS injection', async () => {
  const {card, hass, requests} = fixture();
  card.setConfig({...config(), value_state_color: true});
  card.hass = hass;
  const rows = [
    ...['unknown', 'unavailable', null, undefined, true, 1, 'on);color:red'].map(state => ({domain: 'binary_sensor', 'entity.state': state})),
    {domain: 'sensor', 'entity.state': 'on'},
    {'entity.state': 'on'},
    ...[undefined, null, {}, 'door), red); --evil: url(x)', 'x'.repeat(65)].map(deviceClass => ({
      domain: 'binary_sensor', 'entity.state': 'on', 'entity.device_class': deviceClass,
    })),
  ];
  requests[0].resolve({columns: ['entity.state'], rows});
  await tick();
  const cells = resultCells(card);
  assert(cells.slice(0, 9).every(node => node.style.color === ''));
  assert(cells.slice(9).every(node => node.style.color ===
    'var(--state-binary_sensor-on-color, var(--state-binary_sensor-active-color, var(--state-active-color, var(--primary-text-color))))'));
});

test('value and icon state colors are independent and use the query snapshot', async () => {
  for (const value_state_color of [false, true]) {
    for (const icon_state_color of [false, true]) {
      const {card, hass, requests} = fixture();
      hass.states = {
        'binary_sensor.front_door': {entity_id: 'binary_sensor.front_door', state: 'off', attributes: {}},
        'binary_sensor.unknown': {entity_id: 'binary_sensor.unknown', state: 'unknown', attributes: {}},
      };
      card.setConfig({...config(), entity_icons: true, value_state_color, icon_state_color,
        entity_icon_overrides: {'binary_sensor.front_door': 'mdi:door-open'}});
      card.hass = hass;
      requests[0].resolve({columns: ['device.name', 'entity.state'], rows: [{
        entity_id: 'binary_sensor.front_door', domain: 'binary_sensor', 'entity.device_class': 'door',
        'device.name': 'Front door', 'entity.state': 'on',
      }, {
        entity_id: 'binary_sensor.unknown', domain: 'binary_sensor', 'device.name': 'Unknown', 'entity.state': 'unknown',
      }]});
      await tick();
      const cells = resultCells(card).filter(node => node.dataset.label === 'State');
      const icons = descendants(card).filter(node => node.tag === 'ha-state-icon');
      const value = cells[0];
      const icon = icons[0];
      assert(!cells[1].style.color);
      assert(!icons[1].style.color);
      assert.equal(value.style.color?.includes('door-on') || false, value_state_color);
      assert.equal(icon.style.color?.includes('door-on') || false, icon_state_color);
      assert.equal(icon.icon, 'mdi:door-open');
    }
  }
});

test('refreshing state removes active color when sensor becomes unavailable', async () => {
  const {card, hass, requests, intervals} = fixture();
  card.setConfig({...config(), value_state_color: true});
  card.hass = hass;
  requests[0].resolve({columns: ['entity.state', 'entity.unit'], rows: [
    {domain: 'binary_sensor', 'entity.state': 'on', 'entity.device_class': 'motion'},
  ]});
  await tick();
  assert(resultCells(card)[0].style.color.includes('motion-on'));
  [...intervals.values()][0].callback();
  requests[1].resolve({columns: ['entity.state', 'entity.unit'], rows: [
    {domain: 'binary_sensor', 'entity.state': 'unavailable', 'entity.device_class': 'motion'},
  ]});
  await tick();
  const cell = resultCells(card)[0];
  assert.equal(cell.textContent, 'unavailable');
  assert.equal(cell.style.color, '');
});

test('entity_links is strict, opt-in, and preserves name text', async () => {
  for (const entity_links of [undefined, false]) {
    const {card, hass, requests} = fixture();
    card.setConfig({...config(), entity_links});
    card.hass = hass;
    requests[0].resolve({columns: ['entity.name', 'entity.state'], rows: [
      {entity_id: 'binary_sensor.front_door', 'entity.name': 'Front door', 'entity.state': 'on'},
    ]});
    await tick();
    const cells = resultCells(card);
    assert.equal(cells[0].textContent, 'Front door');
    assert.equal(descendants(card).filter(node => node.tag === 'button').length, 0);
    assert.deepEqual(card.events, []);
  }
  const {card, intervals} = fixture();
  card.setConfig({...config(), entity_links: true});
  const timer = [...intervals.keys()][0];
  for (const entity_links of ['true', 'false', 0, 1, null, [], {}]) {
    assert.throws(() => card.setConfig({...config(), entity_links}), /entity_links/);
    assert.equal(card._config.entity_links, true);
    assert.equal([...intervals.keys()][0], timer);
  }
});

test('entity links open HA more-info with keyboard access and no URLs', async () => {
  const {card, hass, requests} = fixture();
  card.setConfig({...config(), entity_links: true});
  card.hass = hass;
  requests[0].resolve({columns: ['entity.name', 'entity.state'], rows: [
    {entity_id: 'binary_sensor.front_door', 'entity.name': '<b>Front door</b>', 'entity.state': 'on'},
  ]});
  await tick();
  const cells = resultCells(card);
  const button = cells[0].children[0];
  assert.equal(button.tag, 'button');
  assert.equal(button.type, 'button');
  assert.equal(button.getAttribute('aria-label'), 'More information: <b>Front door</b>');
  assert.equal(button.title, 'binary_sensor.front_door');
  assert.equal(button.textContent, '<b>Front door</b>');
  assert.equal(cells[0].textContent, '');
  assert.equal(cells[1].children.length, 0);
  assert.equal(descendants(card).filter(node => node.tag === 'b' || node.tag === 'a').length, 0);
  const activate = () => {
    button.listeners.click[0]({});
    const space = {key: ' ', repeat: false, preventDefault: () => { space.prevented = true; }};
    button.listeners.keydown[0](space);
    assert(space.prevented);
    button.listeners.keydown[0]({...space, repeat: true});
    button.listeners.keydown[0]({key: 'Enter'});
  };
  activate();
  assert.equal(card.events.length, 2);
  for (const event of card.events) {
    assert.equal(event.type, 'hass-more-info');
    assert.equal(event.bubbles, true);
    assert.equal(event.composed, true);
    assert.equal(event.detail.entityId, 'binary_sensor.front_door');
    assert.equal(Object.keys(event.detail).length, 1);
  }
});

test('entity link priority is name, then device, then ID with exactly one link', async () => {
  for (const [columns, expectedColumn, expectedText] of [
    [['entity_id', 'device.name', 'entity.name', 'entity.state'], 'Entity', 'Entity name'],
    [['entity_id', 'device.name', 'entity.state'], 'Device', 'Device name'],
    [['entity_id', 'entity.state'], 'Entity ID', 'binary_sensor.front_door'],
    [['device.name', 'entity.state', 'entity.unit'], 'Device', 'Device name'],
  ]) {
    const {card, hass, requests} = fixture();
    card.setConfig({...config(), entity_links: true});
    card.hass = hass;
    requests[0].resolve({columns, rows: [{
      entity_id: 'binary_sensor.front_door', 'entity.name': 'Entity name', 'device.name': 'Device name', 'entity.state': 'off', 'entity.unit': '',
    }]});
    await tick();
    const cells = resultCells(card);
    const linkedCells = cells.filter(cell => cell.children.some(child => child.tag === 'button'));
    assert.equal(linkedCells.length, 1);
    assert.equal(linkedCells[0].dataset.label, expectedColumn);
    assert.equal(linkedCells[0].children[0].textContent, expectedText);
    assert(cells.every(cell => cell.children.filter(child => child.tag === 'button').length <= 1));
  }
});

test('entity ID links are fallback only without entity name column', async () => {
  const {card, hass, requests, intervals} = fixture();
  card.setConfig({...config(), entity_links: true});
  card.hass = hass;
  const rows = [
    {entity_id: 'sensor.valid'},
    {entity_id: 'https://evil.example'},
    {entity_id: 'sensor.'},
    {entity_id: 'sensor.' + 'x'.repeat(248)},
    {entity_id: 'sensor.' + 'x'.repeat(249)},
    {entity_id: 'sensor.valid newline\n'},
    {entity_id: {}},
    {},
  ];
  requests[0].resolve({columns: ['entity_id', 'entity.state'], rows});
  await tick();
  const cells = resultCells(card);
  assert.equal(cells[0].children[0].tag, 'button');
  assert.equal(cells[0].children[0].textContent, 'sensor.valid');
  assert.equal(cells[0].children[0].getAttribute('aria-label'), 'More information: sensor.valid');
  assert.equal(descendants(card).filter(node => node.tag === 'button').length, 2);
  assert.equal(descendants(card).filter(node => node.tag === 'button')[1].title, 'sensor.' + 'x'.repeat(248));
  assert.equal(cells.filter(cell => cell.dataset.label === 'Entity ID').length, rows.length);
  assert.equal(cells.filter(cell => cell.dataset.label === 'State').length, rows.length);
  [...intervals.values()][0].callback();
  requests[1].resolve({columns: ['entity_id', 'entity.name'], rows: [{entity_id: 'sensor.valid', 'entity.name': 'Readable'}]});
  await tick();
  const namedCells = resultCells(card);
  assert.equal(namedCells[0].children[0].tag, 'button');
  assert.equal(namedCells[0].children[0].textContent, 'Readable');
  assert.equal(namedCells[1].children.length, 0);
});

test('refresh replaces links and disables them after entity_links becomes false', async () => {
  const {card, hass, requests} = fixture();
  card.setConfig({...config(), entity_links: true});
  card.hass = hass;
  requests[0].resolve({columns: ['entity.name'], rows: [{entity_id: 'sensor.old', 'entity.name': 'Old'}]});
  await tick();
  card.setConfig({...config(), entity_links: false});
  assert.equal(descendants(card).filter(node => node.tag === 'button').length, 0);
  requests[0].resolve({columns: ['entity.name'], rows: [{entity_id: 'sensor.stale', 'entity.name': 'Stale'}]});
  await tick();
  assert.equal(requests.length, 2);
  requests[1].resolve({columns: ['entity.name'], rows: [{entity_id: 'sensor.new', 'entity.name': 'New'}]});
  await tick();
  assert.equal(descendants(card).filter(node => node.tag === 'button').length, 0);
});

test('display mappings customize binary states and exact entity names only', async () => {
  const {card, hass, requests} = fixture();
  card.setConfig({...config(),
    entity_names: {
      'binary_sensor.front_door': 'Front entrance',
      'binary_sensor.other': 'Other',
      '__proto__': 'Unsafe inherited value',
    },
    state_labels: {on: 'Open', off: 'Closed', unknown: 'No reading', unavailable: 'Offline'},
  });
  card.hass = hass;
  requests[0].resolve({columns: ['entity.name', 'entity.state'], rows: [
    {entity_id: 'binary_sensor.front_door', domain: 'binary_sensor', 'entity.name': 'Old name', 'entity.state': 'on'},
    {entity_id: 'binary_sensor.back_door', domain: 'binary_sensor', 'entity.name': 'Back door', 'entity.state': 'off'},
    {entity_id: 'binary_sensor.unknown', domain: 'binary_sensor', 'entity.name': 'Unknown', 'entity.state': 'unknown'},
    {entity_id: 'binary_sensor.offline', domain: 'binary_sensor', 'entity.name': 'Offline', 'entity.state': 'unavailable'},
    {entity_id: 'binary_sensor.custom', domain: 'binary_sensor', 'entity.name': 'Custom', 'entity.state': 'other'},
    {entity_id: 'sensor.switch', domain: 'sensor', 'entity.name': 'Not binary', 'entity.state': 'on'},
    {entity_id: 'binary_sensor.null', domain: 'binary_sensor', 'entity.name': 'Null', 'entity.state': null},
  ]});
  await tick();
  assert.deepEqual(resultCells(card).map(node => node.textContent), [
    'Front entrance', 'Open', 'Back door', 'Closed', 'Unknown', 'No reading', 'Offline', 'Offline',
    'Custom', 'other', 'Not binary', 'on', 'Null', '-',
  ]);
});

test('display mappings preserve state colors, link targets, and safe accessible text', async () => {
  const {card, hass, requests} = fixture();
  const entityId = 'binary_sensor.front_door';
  card.setConfig({...config(), entity_links: true, value_state_color: true,
    entity_names: {[entityId]: '<b>Front entrance</b>'}, state_labels: {on: '<i>Open</i>'}});
  card.hass = hass;
  requests[0].resolve({columns: ['entity.name', 'entity.state'], rows: [{
    entity_id: entityId, domain: 'binary_sensor', 'entity.device_class': 'door', 'entity.name': 'Original', 'entity.state': 'on',
  }]});
  await tick();
  const cells = resultCells(card);
  const link = cells[0].children[0];
  assert.equal(link.textContent, '<b>Front entrance</b>');
  assert.equal(link.getAttribute('aria-label'), 'More information: <b>Front entrance</b>');
  assert.equal(cells[1].textContent, '<i>Open</i>');
  assert(cells[1].style.color.includes('door-on'));
  assert.equal(descendants(card).filter(node => ['b', 'i'].includes(node.tag)).length, 0);
  link.listeners.click[0]({});
  assert.equal(card.events[0].detail.entityId, entityId);
});

test('display mappings validate shape, keys, values, and bounds atomically', () => {
  const invalid = [
    {entity_names: null}, {entity_names: []}, {entity_names: 'name'}, {entity_names: {sensor: 'Bad ID'}},
    {entity_names: {'sensor.valid\n': 'Newline'}}, {entity_names: {'sensor.valid': ''}},
    {entity_names: {'sensor.valid': 1}}, {entity_names: {'sensor.valid': 'x'.repeat(257)}},
    {state_labels: null}, {state_labels: []}, {state_labels: 'Open'}, {state_labels: {open: 'Open'}},
    {state_labels: {on: ''}}, {state_labels: {on: 1}}, {state_labels: {on: 'x'.repeat(65)}},
  ];
  for (const options of invalid) {
    const {card, intervals} = fixture();
    card.setConfig({...config(), entity_names: {'sensor.valid': 'Valid'}, state_labels: {on: 'Open'}});
    const timer = [...intervals.keys()][0];
    assert.throws(() => card.setConfig({...config(), ...options}));
    assert.equal(card._config.entity_names['sensor.valid'], 'Valid');
    assert.equal(card._config.state_labels.on, 'Open');
    assert.equal([...intervals.keys()][0], timer);
  }
  const {card} = fixture();
  const manyNames = Object.fromEntries(Array.from({length: 501}, (_, i) => [`sensor.e${i}`, `Name ${i}`]));
  assert.throws(() => card.setConfig({...config(), entity_names: manyNames}), /500/);
  card.setConfig({...config(), entity_names: {}, state_labels: {}});
});

test('entity icons are opt-in and use live HA states with exact ID overrides', async () => {
  const {card, hass, requests, intervals} = fixture();
  const front = {entity_id: 'binary_sensor.front_door', state: 'on', attributes: {device_class: 'door', icon: 'mdi:door'}};
  const back = {entity_id: 'binary_sensor.back_door', state: 'off', attributes: {device_class: 'door'}};
  hass.states = {'binary_sensor.front_door': front, 'binary_sensor.back_door': back};
  const overrides = {'binary_sensor.front_door': 'mdi:door-open', 'binary_sensor.other': 'mdi:window-open'};
  const rows = [
    {entity_id: 'binary_sensor.front_door', 'device.name': 'Front door', 'entity.state': 'on'},
    {entity_id: 'binary_sensor.back_door', 'device.name': 'Back door', 'entity.state': 'off'},
    {entity_id: 'binary_sensor.missing', 'device.name': 'Missing state', 'entity.state': 'off'},
  ];
  const response = {columns: ['device.name', 'entity.state'], rows};
  card.setConfig({...config(), entity_links: true, entity_icon_overrides: overrides});
  card.hass = hass;
  requests[0].resolve(response);
  await tick();
  assert.equal(descendants(card).filter(node => node.tag === 'ha-state-icon').length, 0);
  card.setConfig({...config(), entity_icons: true, entity_links: true, entity_icon_overrides: overrides});
  requests[1].resolve(response);
  await tick();
  const icons = descendants(card).filter(node => node.tag === 'ha-state-icon');
  assert.equal(icons.length, 2);
  assert.equal(icons[0].stateObj, front);
  assert.equal(icons[0].icon, 'mdi:door-open');
  assert.equal(icons[1].stateObj, back);
  assert.equal(icons[1].icon, undefined);
  assert(icons.every(icon => icon.hass === hass && icon.getAttribute('aria-hidden') === 'true'));
  assert(icons.every(icon => icon.children.length === 0));
  const tiles = descendants(card).filter(node => node.className === 'haq-tile');
  assert.equal(tiles.length, 3);
  assert.equal(tiles.filter(tile => descendants(tile).some(node => node.tag === 'ha-state-icon')).length, 2);
  assert.equal(descendants(card).filter(node => node.className === 'haq-tile-content').length, 3);
  assert.equal(descendants(card).filter(node => node.tag === 'button').length, 3);
  const replacement = {...front, state: 'off'};
  hass.states['binary_sensor.front_door'] = replacement;
  [...intervals.values()][0].callback();
  requests[2].resolve(response);
  await tick();
  assert.equal(descendants(card).find(node => node.tag === 'ha-state-icon').stateObj, replacement);
  card.setConfig({...config(), entity_icons: false, entity_icon_overrides: overrides});
  assert.equal(descendants(card).filter(node => node.tag === 'ha-state-icon').length, 0);
});

test('entity icons preserve plain text without enabling links', async () => {
  const {card, hass, requests} = fixture();
  const stateObj = {entity_id: 'binary_sensor.front_door', state: 'on', attributes: {device_class: 'door'}};
  hass.states = {'binary_sensor.front_door': stateObj};
  card.setConfig({...config(), entity_icons: true});
  card.hass = hass;
  requests[0].resolve({columns: ['entity.name'], rows: [{
    entity_id: 'binary_sensor.front_door', 'entity.name': 'Front door', 'entity.state': 'on',
  }]});
  await tick();
  const tile = descendants(card).find(node => node.className === 'haq-tile');
  assert.equal(tile.children[0].tag, 'ha-state-icon');
  assert.equal(tile.children[0].stateObj, stateObj);
  assert.equal(tile.children[1].className, 'haq-tile-content');
  assert.equal(tile.children[1].children[0].textContent, 'Front door');
  assert.equal(descendants(card).filter(node => node.tag === 'button').length, 0);
});

test('entity icon options validate booleans, mappings, names, and bounds atomically', () => {
  const invalid = [
    ...['true', 0, null, [], {}].map(entity_icons => ({entity_icons})),
    {entity_icon_overrides: null}, {entity_icon_overrides: []}, {entity_icon_overrides: 'mdi:door'},
    {entity_icon_overrides: {sensor: 'mdi:door'}}, {entity_icon_overrides: {'sensor.valid': ''}},
    {entity_icon_overrides: {'sensor.valid': 1}}, {entity_icon_overrides: {'sensor.valid': 'mdi:door\n'}},
    {entity_icon_overrides: {'sensor.valid': 'https://evil.example'}},
    {entity_icon_overrides: {'sensor.valid': 'mdi:' + 'x'.repeat(125)}},
  ];
  for (const options of invalid) {
    const {card, intervals} = fixture();
    card.setConfig({...config(), entity_icons: true, entity_icon_overrides: {'sensor.valid': 'mdi:door'}});
    const timer = [...intervals.keys()][0];
    assert.throws(() => card.setConfig({...config(), ...options}));
    assert.equal(card._config.entity_icons, true);
    assert.equal(card._config.entity_icon_overrides['sensor.valid'], 'mdi:door');
    assert.equal([...intervals.keys()][0], timer);
  }
  const {card} = fixture();
  const manyIcons = Object.fromEntries(Array.from({length: 501}, (_, i) => [`sensor.e${i}`, 'mdi:door']));
  assert.throws(() => card.setConfig({...config(), entity_icon_overrides: manyIcons}), /500/);
  card.setConfig({...config(), entity_icons: false, entity_icon_overrides: {'sensor.valid': 'hass:custom-icon'}});
});

test('entity queries subscribe to state and registry changes once connected', async () => {
  const {card, hass, requests, subscriptions} = fixture();
  card.setConfig(config());
  card.hass = hass;
  await tick();
  assert.deepEqual(JSON.parse(JSON.stringify(subscriptions.map(item => item.message))), [
    {type: 'subscribe_entities'},
    {type: 'subscribe_events', event_type: 'entity_registry_updated'},
    {type: 'subscribe_events', event_type: 'device_registry_updated'},
    {type: 'subscribe_events', event_type: 'area_registry_updated'},
  ]);
  subscriptions.forEach(item => item.resolve(() => {}));
  await tick();
  assert.equal(requests[0].message.type, 'ha_query/run');
  for (let index = 0; index < 10; index++) card.hass = {...hass};
  assert.equal(subscriptions.length, 4);
  assert.equal(card._unsubscribes.length, 4);
});

test('failed entity subscription retries alone after a bounded delay', async () => {
  const {card, hass, requests, subscriptions, timeouts, fireTimeouts, advanceTime, unsubscribes} = fixture();
  card.setConfig(config());
  card.hass = hass;
  await tick();
  requests[0].resolve({rows: [], columns: []});
  subscriptions[0].reject(new Error('Temporary subscription failure'));
  subscriptions.slice(1).forEach(item => item.resolve(() => unsubscribes.push(item)));
  await tick();
  assert.equal(card._unsubscribes.length, 3);
  assert.equal(card._failedSubscriptions.size, 1);
  assert.equal(timeouts.size, 1);
  assert.equal([...timeouts.values()][0].delay, 60000);
  for (let index = 0; index < 10; index++) card.hass = {...hass};
  assert.equal(subscriptions.length, 4);
  advanceTime(60000);
  fireTimeouts();
  assert.equal(subscriptions.length, 5);
  assert.deepEqual(JSON.parse(JSON.stringify(subscriptions[4].message)), {type: 'subscribe_entities'});
  subscriptions[4].resolve(() => unsubscribes.push(subscriptions[4]));
  await tick();
  assert.equal(card._unsubscribes.length, 4);
  assert.equal(card._failedSubscriptions.size, 0);
  subscriptions[4].callback({});
  assert.equal([...timeouts.values()][0].delay, 250);
  fireTimeouts();
  assert.equal(requests.length, 2);
  requests[1].resolve({rows: [], columns: []});
  await tick();
});

test('disconnect cancels subscription retry and ignores late failures', async () => {
  const {card, hass, requests, subscriptions, timeouts} = fixture();
  card.setConfig(config());
  card.hass = hass;
  await tick();
  requests[0].resolve({rows: [], columns: []});
  subscriptions[0].reject(new Error('Temporary subscription failure'));
  await tick();
  assert.equal(timeouts.size, 1);
  card.isConnected = false;
  card.disconnectedCallback();
  assert.equal(timeouts.size, 0);
  subscriptions.slice(1).forEach(item => item.reject(new Error('Late failure')));
  await tick();
  assert.equal(timeouts.size, 0);
  card.isConnected = true;
  card.connectedCallback();
  assert.equal(subscriptions.length, 8);
  assert.equal(requests.length, 2);
});

test('same-connection reconnect recovers when reestablished subscription fails', async () => {
  const {card, hass, requests, subscriptions, timeouts, fireTimeouts, advanceTime, unsubscribes,
    connectionListeners, fireConnectionEvent} = fixture();
  card.setConfig(config());
  card.hass = hass;
  await tick();
  subscriptions.forEach(item => item.resolve(() => unsubscribes.push(item)));
  await tick();
  requests[0].resolve({rows: [], columns: []});
  await tick();
  assert(subscriptions.every(item => item.options?.resubscribe === false));
  assert.equal(connectionListeners.ready.size, 1);
  fireConnectionEvent('ready');
  assert.equal(subscriptions.length, 8);
  assert.equal(unsubscribes.length, 4);
  assert.equal(connectionListeners.ready.size, 1);
  subscriptions[4].reject(new Error('Reconnect subscription failure'));
  subscriptions.slice(5).forEach(item => item.resolve(() => {}));
  await tick();
  assert.equal(card._failedSubscriptions.size, 1);
  assert.deepEqual([...timeouts.values()].map(timer => timer.delay).sort((a, b) => a - b), [250, 60000]);
  fireTimeouts();
  assert.equal(requests.length, 2);
  assert.equal(subscriptions.length, 8);
  requests[1].resolve({rows: [], columns: []});
  await tick();
  advanceTime(60000);
  fireTimeouts();
  assert.equal(subscriptions.length, 9);
  assert.deepEqual(JSON.parse(JSON.stringify(subscriptions[8].message)), {type: 'subscribe_entities'});
  subscriptions[8].resolve(() => {});
  await tick();
  assert.equal(card._failedSubscriptions.size, 0);
  subscriptions[8].callback({});
  fireTimeouts();
  assert.equal(requests.length, 3);
  requests[2].resolve({rows: [], columns: []});
  await tick();
});

test('events debounce bursts and follow device-history queries too', async () => {
  for (const deviceQuery of [false, true]) {
    const {card, hass, requests, subscriptions, timeouts, fireTimeouts} = fixture();
    card.setConfig({query: deviceQuery ? {from: 'devices', where: {}} : query});
    card.hass = hass;
    await tick();
    subscriptions.forEach(item => item.resolve(() => {}));
    await tick();
    requests[0].resolve({rows: [], columns: []});
    await tick();
    for (const item of subscriptions) item.callback({});
    assert.equal(requests.length, 1);
    assert.equal(timeouts.size, 1);
    assert.equal([...timeouts.values()][0].delay, 250);
    fireTimeouts();
    assert.equal(requests.length, 2);
    requests[1].resolve({rows: [], columns: []});
    await tick();
  }
});

test('history events are rate limited and retain one trailing refresh', async () => {
  const {card, hass, requests, subscriptions, timeouts, fireTimeouts, advanceTime} = fixture();
  card.setConfig({query: {from: 'devices', where: {history: {no_changes_for: '14d'}}}});
  card.hass = hass;
  await tick();
  subscriptions.forEach(item => item.resolve(() => {}));
  await tick();
  requests[0].resolve({rows: [], columns: []});
  await tick();
  for (const item of subscriptions) item.callback({});
  assert.equal(requests.length, 1);
  assert.equal(timeouts.size, 1);
  assert.equal([...timeouts.values()][0].delay, 60000);
  fireTimeouts();
  assert.equal(requests.length, 1);
  assert.equal(timeouts.size, 1);
  advanceTime(60000);
  fireTimeouts();
  assert.equal(requests.length, 2);
  subscriptions[0].callback({});
  assert.equal(timeouts.size, 1);
  requests[1].resolve({rows: [], columns: []});
  await tick();
  advanceTime(60000);
  fireTimeouts();
  assert.equal(requests.length, 3);
  assert.equal(card._pendingRefresh, false);
  requests[2].resolve({rows: [], columns: []});
  await tick();
});

test('event during pending request queues one trailing refresh', async () => {
  const {card, hass, requests, subscriptions, fireTimeouts} = fixture();
  card.setConfig(config());
  card.hass = hass;
  await tick();
  subscriptions.forEach(item => item.resolve(() => {}));
  subscriptions[0].callback({});
  subscriptions[0].callback({});
  fireTimeouts();
  assert.equal(requests.length, 1);
  subscriptions[0].callback({});
  requests[0].resolve({rows: [], columns: []});
  await tick();
  fireTimeouts();
  assert.equal(requests.length, 2);
});

test('debounce expiring during a request preserves one trailing refresh', async () => {
  const {card, hass, requests, subscriptions, fireTimeouts} = fixture();
  card.setConfig(config());
  card.hass = hass;
  await tick();
  subscriptions[0].callback({});
  fireTimeouts();
  assert.equal(requests.length, 1);
  assert.equal(card._pendingRefresh, true);
  requests[0].resolve({rows: [], columns: []});
  await tick();
  assert.equal(requests.length, 1);
  fireTimeouts();
  assert.equal(requests.length, 2);
  assert.equal(card._pendingRefresh, false);
});

test('disconnect unsubscribes and cancels pending event refresh; reconnect resubscribes', async () => {
  const {card, hass, requests, subscriptions, timeouts} = fixture();
  card.setConfig(config());
  card.hass = hass;
  await tick();
  const unsubscribes = [];
  subscriptions.forEach(item => item.resolve(() => unsubscribes.push(item)));
  await tick();
  subscriptions[0].callback({});
  assert.equal(timeouts.size, 1);
  card.isConnected = false;
  card.disconnectedCallback();
  assert.equal(unsubscribes.length, 4);
  assert.equal(timeouts.size, 0);
  assert.equal(card._unsubscribes.length, 0);
  subscriptions.forEach(item => item.callback({}));
  requests[0].resolve({rows: [], columns: []});
  await tick();
  assert.equal(requests.length, 1);
  card.isConnected = true;
  card.connectedCallback();
  assert.equal(subscriptions.length, 8);
  assert.equal(requests.length, 2);
});

test('late subscriptions are cleaned after config change or disconnect', async () => {
  const {card, hass, subscriptions, requests, timeouts} = fixture();
  card.setConfig(config());
  card.hass = hass;
  await tick();
  const oldSubscriptions = [...subscriptions];
  card.setConfig({...config(), title: 'New'});
  assert.equal(subscriptions.length, 8);
  const cleaned = [];
  oldSubscriptions.forEach(item => item.resolve(() => cleaned.push(item)));
  assert.equal(cleaned.length, 0);
  card.isConnected = false;
  card.disconnectedCallback();
  subscriptions.slice(4).forEach(item => item.resolve(() => cleaned.push(item)));
  assert.equal(cleaned.length, 0);
  await tick();
  assert.equal(cleaned.length, 8);
  const requestsBefore = requests.length;
  for (const item of subscriptions) item.callback({});
  assert.equal(timeouts.size, 0);
  assert.equal(requests.length, requestsBefore);
});

test('replacement connection cleans up subscriptions and discards in-flight results', async () => {
  const {card, hass, subscriptions, timeouts, requests, unsubscribes} = fixture();
  card.setConfig(config());
  card.hass = hass;
  await tick();
  subscriptions.forEach(item => item.resolve(() => unsubscribes.push(item)));
  await tick();
  const nextHass = {...hass, connection: {...hass.connection}};
  card.hass = nextHass;
  const oldSubscriptions = subscriptions.slice(0, 4);
  await tick();
  assert.equal(unsubscribes.length, 4);
  for (const item of oldSubscriptions) item.callback({});
  assert.equal(timeouts.size, 0);
  assert.equal(requests.length, 1);
  assert.equal(subscriptions.length, 8);
  requests[0].resolve({columns: ['entity.state'], rows: [{'entity.state': 'stale'}]});
  await tick();
  assert.equal(card._rows.length, 0);
  assert.equal(requests.length, 2);
  requests[1].resolve({columns: ['entity.state'], rows: [{'entity.state': 'current'}]});
  await tick();
  assert.equal(card._rows[0]['entity.state'], 'current');
});

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

test('title is optional and the outer container has no HA card surface', async () => {
  const {card, hass} = fixture();
  card.setConfig(config());
  card.hass = hass;
  assert.equal(descendants(card).filter(node => node.tag === 'h3').length, 0);
  assert.equal(descendants(card).filter(node => node.tag === 'ha-card').length, 0);
  assert.equal(descendants(card).find(node => node.className === 'haq-card').tag, 'div');
  card.setConfig({...config(), title: 'Room temperatures'});
  assert.equal(descendants(card).find(node => node.tag === 'h3').textContent, 'Room temperatures');
  card.setConfig({...config(), title: ''});
  assert.equal(descendants(card).filter(node => node.tag === 'h3').length, 0);
});

test('renders untrusted title, warning and cell as text', async () => {
  const {card, hass, requests} = fixture();
  const payload = '<img src=x onerror=alert(1)>';
  card.setConfig({...config(), title: payload});
  card.hass = hass;
  assert(descendants(card).some(node => node.textContent === 'Loading…'));
  requests[0].resolve({rows: [{[payload]: payload}], columns: [payload], warnings: [payload]});
  await tick();
  assert.equal(descendants(card).filter(node => node.textContent === payload).length, 3);
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
  const cell = resultCells(card)[0];
  assert.equal(cell.textContent, '{"mode":"reading"}');
  assert(cell.className.includes('haq-detail'));
  assert.equal(cell.dataset.label, 'config');
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
  const grids = descendants(card).filter(n => n.className === 'haq-grid');
  assert.equal(grids.length, 3);
  assert.deepEqual(resultCells(grids[0]).map(n => n.textContent), ['3', '-']);
  assert.deepEqual(resultCells(grids[1]).map(n => n.textContent), ['2', '4']);
  assert.equal(card.getCardSize(), 5);
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
  assert.equal(descendants(card).filter(n => n.className === 'haq-grid').length, 4);
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

test('responsive CSS uses auto-fitting tiles and labels extra fields', async () => {
  const {card, hass, requests} = fixture();
  card.setConfig({...config(), group_by: 'area'});
  card.hass = hass;
  requests[0].resolve({columns: ['entity.name', 'device.name'], rows: [
    {'area.id': 'kitchen', 'area.name': 'Kitchen', 'entity.name': 'Door', 'device.name': 'Sensor'},
  ]});
  await tick();
  const styles = descendants(card).find(node => node.tag === 'style').textContent;
  assert(styles.includes('repeat(auto-fit, minmax(min(100%, 280px), 1fr))'));
  assert(styles.includes('.haq-tile {'));
  assert(styles.includes('background: var(--card-background-color)'));
  assert(!styles.includes('background: var(--secondary-background-color)'));
  assert(styles.includes('content: attr(data-label)'));
  assert(styles.includes('overflow-wrap: anywhere'));
  assert(styles.includes('@container (max-width: 560px)'));
  const cells = resultCells(card);
  assert.deepEqual(cells.map(node => node.dataset.label), ['Entity', 'Device']);
  assert(cells[0].className.includes('haq-primary'));
  assert(cells[1].className.includes('haq-detail'));
  assert.equal(descendants(card).filter(node => ['table', 'ha-card'].includes(node.tag)).length, 0);
  assert.equal(descendants(card).filter(node => node.getAttribute('role')).length, 0);
});

test('area sections have accessible names, headings and separate tile grids', async () => {
  const {card, hass, requests} = fixture();
  card.setConfig({...config(), group_by: 'area'});
  card.hass = hass;
  requests[0].resolve({columns: ['entity.state'], rows: [
    {'area.id': 'kitchen', 'area.name': 'Kitchen', 'entity.state': 1},
    {'area.id': 'kitchen', 'area.name': 'Kitchen', 'entity.state': 2},
    {'area.id': 'office', 'area.name': 'Office', 'entity.state': 3},
  ]});
  await tick();
  const sections = descendants(card).filter(node => node.className === 'haq-group');
  assert.equal(sections.length, 2);
  assert.deepEqual(sections.map(node => node.getAttribute('aria-label')), ['Kitchen', 'Office']);
  assert.deepEqual(sections.map(node => descendants(node).filter(n => n.className === 'haq-tile').length), [2, 1]);
  assert.equal(descendants(card).filter(node => node.className === 'haq-count').length, 0);
  assert.equal(descendants(card).filter(node => node.getAttribute('role')).length, 0);
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
  assert.deepEqual(resultCells(card).map(n => n.textContent), ['95%', '10 W', '-']);
  card.setConfig(config());
  requests[1].resolve({columns: ['entity.unit'], rows: [{'entity.unit': 'W'}]});
  await tick();
  const unit = resultCells(card)[0];
  assert.equal(unit.textContent, 'W');
  assert.equal(unit.dataset.label, 'Unit');
  assert(unit.className.includes('haq-detail'));
});

test('no grouping keeps one tile grid; empty grouped card has no headings', async () => {
  const {card, hass, requests} = fixture();
  assert.equal(card.getCardSize(), 2);
  card.setConfig(config());
  card.hass = hass;
  requests[0].resolve({columns: ['entity.state'], rows: [{'area.id': 'one'}, {'area.id': 'two'}]});
  await tick();
  assert.equal(descendants(card).filter(n => n.className === 'haq-grid').length, 1);
  assert.equal(descendants(card).filter(n => n.className === 'haq-tile').length, 2);
  assert.equal(descendants(card).filter(n => n.tag === 'h4').length, 0);
  card.setConfig({...config(), group_by: 'area'});
  requests[1].resolve({rows: [], columns: []});
  await tick();
  assert.equal(descendants(card).filter(n => n.tag === 'h4').length, 0);
});
