const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const backgroundSource = fs.readFileSync(
  path.join(__dirname, "..", "src", "background.js"),
  "utf8"
);

function createEvent() {
  return {
    addListener(listener) {
      this.listener = listener;
    }
  };
}

function createHarness(initialTabs) {
  const tabsById = new Map(initialTabs.map((tab) => [tab.id, { ...tab }]));
  const removedTabIds = [];
  const storage = {};
  const events = {
    created: createEvent(),
    updated: createEvent()
  };

  const chrome = {
    runtime: {
      onInstalled: createEvent(),
      onStartup: createEvent(),
      onMessage: createEvent()
    },
    alarms: {
      onAlarm: createEvent(),
      async create() {}
    },
    tabs: {
      onActivated: createEvent(),
      onCreated: events.created,
      onUpdated: events.updated,
      onRemoved: createEvent(),
      async get(tabId) {
        const tab = tabsById.get(tabId);
        if (!tab) throw new Error("Tab not found");
        return { ...tab };
      },
      async query() {
        return [...tabsById.values()].map((tab) => ({ ...tab }));
      },
      async update() {},
      async remove(tabId) {
        removedTabIds.push(tabId);
        tabsById.delete(tabId);
      },
      async group() {
        return 10;
      }
    },
    tabGroups: {
      async query() {
        return [];
      },
      async update() {}
    },
    storage: {
      local: {
        async get(defaults) {
          return { ...defaults, ...storage };
        },
        async set(values) {
          Object.assign(storage, values);
        }
      }
    },
    i18n: {
      getMessage() {
        return "";
      }
    }
  };

  const context = vm.createContext({
    chrome,
    console,
    clearTimeout,
    setTimeout(callback) {
      callback();
      return 1;
    },
    Date,
    Promise,
    URL
  });
  vm.runInContext(backgroundSource, context);

  return {
    events,
    removedTabIds,
    setTab(tab) {
      tabsById.set(tab.id, { ...tab });
    }
  };
}

test("does not deduplicate a newly created tab while it is on a redirect URL", async () => {
  const redirectUrl = "https://search.example/redirect?id=123";
  const harness = createHarness([
    {
      id: 1,
      windowId: 1,
      url: redirectUrl,
      active: false,
      pinned: false,
      incognito: false,
      groupId: -1
    },
    {
      id: 2,
      windowId: 1,
      url: redirectUrl,
      pendingUrl: redirectUrl,
      active: true,
      pinned: false,
      incognito: false,
      groupId: -1
    }
  ]);

  harness.events.created.listener({
    id: 2,
    windowId: 1,
    pendingUrl: redirectUrl,
    active: true,
    pinned: false,
    incognito: false,
    groupId: -1
  });
  await new Promise(setImmediate);
  await new Promise(setImmediate);

  assert.deepEqual(harness.removedTabIds, []);
});

test("ignores intermediate URL updates and deduplicates only after loading completes", async () => {
  const redirectUrl = "https://search.example/redirect?id=123";
  const finalUrl = "https://destination.example/article";
  const harness = createHarness([
    {
      id: 1,
      windowId: 1,
      url: redirectUrl,
      active: false,
      pinned: false,
      incognito: false,
      groupId: -1
    },
    {
      id: 2,
      windowId: 1,
      url: redirectUrl,
      active: true,
      pinned: false,
      incognito: false,
      groupId: -1
    }
  ]);

  harness.events.updated.listener(
    2,
    { status: "loading", url: redirectUrl },
    {
      id: 2,
      windowId: 1,
      url: redirectUrl,
      active: true,
      pinned: false,
      incognito: false,
      groupId: -1
    }
  );
  await new Promise(setImmediate);
  assert.deepEqual(harness.removedTabIds, []);

  harness.setTab({
    id: 2,
    windowId: 1,
    url: finalUrl,
    active: true,
    pinned: false,
    incognito: false,
    groupId: -1
  });
  harness.events.updated.listener(
    2,
    { status: "complete" },
    {
      id: 2,
      windowId: 1,
      url: finalUrl,
      active: true,
      pinned: false,
      incognito: false,
      groupId: -1
    }
  );
  await new Promise(setImmediate);
  await new Promise(setImmediate);

  assert.deepEqual(harness.removedTabIds, []);
});

test("still closes a genuinely duplicate tab after loading completes", async () => {
  const finalUrl = "https://destination.example/article";
  const harness = createHarness([
    {
      id: 1,
      windowId: 1,
      url: finalUrl,
      active: false,
      pinned: false,
      incognito: false,
      groupId: -1
    },
    {
      id: 2,
      windowId: 1,
      url: finalUrl,
      active: true,
      pinned: false,
      incognito: false,
      groupId: -1
    }
  ]);

  harness.events.updated.listener(
    2,
    { status: "complete" },
    {
      id: 2,
      windowId: 1,
      url: finalUrl,
      active: true,
      pinned: false,
      incognito: false,
      groupId: -1
    }
  );
  await new Promise(setImmediate);
  await new Promise(setImmediate);

  assert.deepEqual(harness.removedTabIds, [2]);
});
