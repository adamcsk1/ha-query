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
      this.tag = tag; this.children = []; this.style = {}; this.dataset = {}; this.attributes = {};
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
  const hass = {
    callWS: message => new Promise((resolve, reject) => requests.push({message, resolve, reject})),
    connection: {
      subscribeMessage: (callback, message) => {
        return new Promise((resolve, reject) => subscriptions.push({callback, message, resolve, reject}));
      },
    },
  };
  const fireTimeouts = () => { const pending = [...timeouts.values()]; timeouts.clear(); for (const timer of pending) timer.callback(); };
  const advanceTime = milliseconds => { now += milliseconds; };
  return {card, intervals, timeouts, fireTimeouts, advanceTime, requests, subscriptions, unsubscribes, hass};
}

function descendants(node) {
  return [node, ...node.children.flatMap(descendants)];
}

test('explicit device, state and unit columns show only Device and State', async () => {
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
  assert.deepEqual(descendants(card).filter(node => node.getAttribute('role') === 'columnheader')
    .map(node => node.textContent), ['Device', 'State']);
  assert.deepEqual(descendants(card).filter(node => node.getAttribute('role') === 'cell')
    .map(node => node.textContent), ['Window sensor 3', 'off']);
});

test('state_color accepts only booleans without disturbing valid configuration', () => {
  const {card, intervals} = fixture();
  card.setConfig({...config(), state_color: true});
  const timer = [...intervals.keys()][0];
  for (const state_color of ['true', 'false', 0, 1, null, [], {}]) {
    assert.throws(() => card.setConfig({...config(), state_color}), /state_color/);
    assert.equal(card._config.state_color, true);
    assert.equal([...intervals.keys()][0], timer);
  }
  card.setConfig({...config(), state_color: false});
  assert.equal(card._config.state_color, false);
});

test('binary sensor state coloring is opt-in and uses HA theme fallback order', async () => {
  for (const state_color of [undefined, false, true]) {
    const {card, hass, requests} = fixture();
    card.setConfig({...config(), state_color, group_by: 'area'});
    card.hass = hass;
    requests[0].resolve({columns: ['entity.name', 'entity.state'], rows: ['on', 'off'].map(state => ({
      domain: 'binary_sensor', 'entity.device_class': 'door', 'entity.name': 'Door', 'entity.state': state,
      'area.id': 'hall', 'area.name': 'Hall',
    }))});
    await tick();
    const cells = descendants(card).filter(node => node.getAttribute('role') === 'cell');
    assert.deepEqual(cells.map(node => node.textContent), ['Door', 'on', 'Door', 'off']);
    assert.equal(cells[0].style.color, undefined);
    for (const [cell, state, active] of [[cells[1], 'on', 'active'], [cells[3], 'off', 'inactive']]) {
      assert.equal(cell.style.color, state_color
        ? `var(--state-binary_sensor-door-${state}-color, var(--state-binary_sensor-${state}-color, var(--state-binary_sensor-${active}-color, var(--state-${active}-color, var(--primary-text-color)))))`
        : '');
    }
    assert(descendants(card).filter(node => node.getAttribute('role') === 'columnheader').every(node => !node.style.color));
  }
});

test('coloring stays neutral for nonbinary and missing states and rejects CSS injection', async () => {
  const {card, hass, requests} = fixture();
  card.setConfig({...config(), state_color: true});
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
  const cells = descendants(card).filter(node => node.getAttribute('role') === 'cell');
  assert(cells.slice(0, 9).every(node => node.style.color === ''));
  assert(cells.slice(9).every(node => node.style.color ===
    'var(--state-binary_sensor-on-color, var(--state-binary_sensor-active-color, var(--state-active-color, var(--primary-text-color))))'));
});

test('refreshing state removes active color when sensor becomes unavailable', async () => {
  const {card, hass, requests, intervals} = fixture();
  card.setConfig({...config(), state_color: true});
  card.hass = hass;
  requests[0].resolve({columns: ['entity.state', 'entity.unit'], rows: [
    {domain: 'binary_sensor', 'entity.state': 'on', 'entity.device_class': 'motion'},
  ]});
  await tick();
  assert(descendants(card).find(node => node.getAttribute('role') === 'cell').style.color.includes('motion-on'));
  [...intervals.values()][0].callback();
  requests[1].resolve({columns: ['entity.state', 'entity.unit'], rows: [
    {domain: 'binary_sensor', 'entity.state': 'unavailable', 'entity.device_class': 'motion'},
  ]});
  await tick();
  const cell = descendants(card).find(node => node.getAttribute('role') === 'cell');
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
    const cells = descendants(card).filter(node => node.getAttribute('role') === 'cell');
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
  const cells = descendants(card).filter(node => node.getAttribute('role') === 'cell');
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
    const cells = descendants(card).filter(node => node.getAttribute('role') === 'cell');
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
  const cells = descendants(card).filter(node => node.getAttribute('role') === 'cell');
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
  const namedCells = descendants(card).filter(node => node.getAttribute('role') === 'cell');
  assert.equal(namedCells[0].children.length, 0);
  assert.equal(namedCells[1].children[0].tag, 'button');
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
  assert.deepEqual(descendants(card).filter(node => node.getAttribute('role') === 'cell').map(node => node.textContent), [
    'Front entrance', 'Open', 'Back door', 'Closed', 'Unknown', 'No reading', 'Offline', 'Offline',
    'Custom', 'other', 'Not binary', 'on', 'Null', '-',
  ]);
});

test('display mappings preserve state colors, link targets, and safe accessible text', async () => {
  const {card, hass, requests} = fixture();
  const entityId = 'binary_sensor.front_door';
  card.setConfig({...config(), entity_links: true, state_color: true,
    entity_names: {[entityId]: '<b>Front entrance</b>'}, state_labels: {on: '<i>Open</i>'}});
  card.hass = hass;
  requests[0].resolve({columns: ['entity.name', 'entity.state'], rows: [{
    entity_id: entityId, domain: 'binary_sensor', 'entity.device_class': 'door', 'entity.name': 'Original', 'entity.state': 'on',
  }]});
  await tick();
  const cells = descendants(card).filter(node => node.getAttribute('role') === 'cell');
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
  card.setConfig({query: {from: 'devices', where: {}, history: {}}});
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
  const nextHass = {...hass, connection: {subscribeMessage: hass.connection.subscribeMessage}};
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
