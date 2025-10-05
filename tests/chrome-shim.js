import { vi } from "vitest";

function createEventBus() {
  const listeners = new Set();
  const bus = {
    addListener(listener) {
      if (typeof listener === "function") {
        listeners.add(listener);
      }
    },
    removeListener(listener) {
      listeners.delete(listener);
    },
    hasListener(listener) {
      return listeners.has(listener);
    },
    dispatch(...args) {
      for (const listener of Array.from(listeners)) {
        try {
          listener(...args);
        } catch (error) {
          // Tests can assert on thrown errors if needed.
          console.error("Chrome shim listener error", error);
        }
      }
    },
    clear() {
      listeners.clear();
    },
  };
  return bus;
}

function createStorageArea(areaName, onChanged) {
  const store = new Map();

  const emitChanges = (changes) => {
    if (!changes || Object.keys(changes).length === 0) {
      return;
    }
    onChanged.dispatch(changes, areaName);
  };

  const getAll = () => {
    const result = {};
    for (const [key, value] of store.entries()) {
      result[key] = value;
    }
    return result;
  };

  const area = {
    get: vi.fn(async (keys) => {
      if (keys === undefined || keys === null) {
        return getAll();
      }
      if (typeof keys === "string") {
        return { [keys]: store.get(keys) };
      }
      if (Array.isArray(keys)) {
        const result = {};
        for (const key of keys) {
          result[key] = store.get(key);
        }
        return result;
      }
      if (typeof keys === "object") {
        const result = { ...keys };
        for (const key of Object.keys(result)) {
          if (store.has(key)) {
            result[key] = store.get(key);
          }
        }
        return result;
      }
      return getAll();
    }),
    set: vi.fn(async (items) => {
      const changes = {};
      for (const [key, value] of Object.entries(items || {})) {
        const oldValue = store.has(key) ? store.get(key) : undefined;
        store.set(key, value);
        changes[key] = { oldValue, newValue: value };
      }
      emitChanges(changes);
    }),
    remove: vi.fn(async (keys) => {
      const list = Array.isArray(keys) ? keys : [keys];
      const changes = {};
      for (const key of list) {
        if (!store.has(key)) {
          continue;
        }
        const oldValue = store.get(key);
        store.delete(key);
        changes[key] = { oldValue, newValue: undefined };
      }
      emitChanges(changes);
    }),
    clear: vi.fn(async () => {
      if (!store.size) {
        return;
      }
      const changes = {};
      for (const [key, value] of store.entries()) {
        changes[key] = { oldValue: value, newValue: undefined };
      }
      store.clear();
      emitChanges(changes);
    }),
    _store: store,
  };

  return area;
}

export function createChromeStub() {
  const runtimeMessageBus = createEventBus();
  const runtimeInstalledBus = createEventBus();
  const storageChangedBus = createEventBus();

  const runtime = {
    onMessage: runtimeMessageBus,
    onInstalled: runtimeInstalledBus,
    sendMessage: vi.fn(async () => ({})),
    lastError: null,
  };

  const tabs = {
    sendMessage: vi.fn(async () => ({})),
    query: vi.fn(async () => []),
    create: vi.fn(async () => ({})),
    onRemoved: createEventBus(),
    onUpdated: createEventBus(),
  };

  const action = {
    setBadgeText: vi.fn(async () => {}),
    setBadgeBackgroundColor: vi.fn(async () => {}),
    setTitle: vi.fn(async () => {}),
  };

  const contextMenus = {
    create: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
    removeAll: vi.fn(),
    onClicked: createEventBus(),
  };

  const alarms = {
    create: vi.fn(),
    clear: vi.fn(),
    onAlarm: createEventBus(),
  };

  const commands = {
    onCommand: createEventBus(),
  };

  const storage = {
    local: createStorageArea("local", storageChangedBus),
    sync: createStorageArea("sync", storageChangedBus),
    onChanged: storageChangedBus,
  };

  const scripting = {
    executeScript: vi.fn(async () => {}),
  };

  const shim = {
    runtime,
    tabs,
    action,
    contextMenus,
    commands,
    alarms,
    storage,
    scripting,
    __resetMocks() {
      runtime.sendMessage.mockClear();
      runtime.onInstalled.clear();
      tabs.sendMessage.mockClear();
      tabs.query.mockClear();
      tabs.create.mockClear();
      tabs.onRemoved.clear();
      tabs.onUpdated.clear();
      action.setBadgeText.mockClear();
      action.setBadgeBackgroundColor.mockClear();
      action.setTitle.mockClear();
      contextMenus.create.mockClear();
      contextMenus.update.mockClear();
      contextMenus.remove.mockClear();
      contextMenus.removeAll.mockClear();
      contextMenus.onClicked.clear();
      alarms.create.mockClear();
      alarms.clear.mockClear();
      commands.onCommand.clear();
      storage.local.get.mockClear();
      storage.local.set.mockClear();
      storage.local.remove.mockClear();
      storage.local.clear.mockClear();
      storage.sync.get.mockClear();
      storage.sync.set.mockClear();
      storage.sync.remove.mockClear();
      storage.sync.clear.mockClear();
      scripting.executeScript.mockClear();
    },
    __clearStorage() {
      storage.local._store.clear();
      storage.sync._store.clear();
    },
    __resetEvents() {
      runtime.onMessage.clear();
      runtime.onInstalled.clear();
      contextMenus.onClicked.clear();
      tabs.onRemoved.clear();
      tabs.onUpdated.clear();
      storage.onChanged.clear();
      alarms.onAlarm.clear();
      commands.onCommand.clear();
    },
  };

  return shim;
}

export function resetChromeStub(chromeInstance) {
  if (!chromeInstance || typeof chromeInstance !== "object") {
    return;
  }
  if (typeof chromeInstance.__resetMocks === "function") {
    chromeInstance.__resetMocks();
  }
  if (typeof chromeInstance.__clearStorage === "function") {
    chromeInstance.__clearStorage();
  }
  if (typeof chromeInstance.__resetEvents === "function") {
    chromeInstance.__resetEvents();
  }
}
