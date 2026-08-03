const TAB_GROUP_ID_NONE = -1;
const INACTIVE_GROUP_TITLE = "Inactive";
const INACTIVE_GROUP_COLOR = "grey";
const CONTEXT_MENU_IDS = {
  saveDomainRule: "save-domain-rule",
  saveUrlRule: "save-url-rule"
};
const STORAGE_KEYS = {
  tabMetadata: "tabMetadata",
  closeHistory: "closeHistory",
  domainGroupRules: "domainGroupRules",
  urlGroupRules: "urlGroupRules",
  settings: "settings"
};
const DEFAULT_SETTINGS = {
  inactiveThresholdMs: 24 * 60 * 60 * 1000,
  scanIntervalMinutes: 15,
  inferredOpenerWindowMs: 2000,
  closeHistoryLimit: 200,
  excludedUrlPatterns: []
};

let lastActiveByWindow = new Map();
let pendingDomainRuleByTab = new Map();
let skipDomainRuleByTab = new Map();

chrome.runtime.onInstalled.addListener(() => {
  void initialize();
});

chrome.runtime.onStartup.addListener(() => {
  void initialize();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "scanInactiveTabs") {
    void groupInactiveTabs();
  }
});

chrome.tabs.onActivated.addListener((activeInfo) => {
  void handleTabActivated(activeInfo);
});

chrome.tabs.onCreated.addListener((tab) => {
  void handleTabCreated(tab);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  void handleTabUpdated(tabId, changeInfo, tab);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void removeTabMetadata(tabId);
});

registerContextMenuClickHandler();
registerBookmarkNavigationHandlers();

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "getDashboard") {
    handleGetDashboard().then(sendResponse);
    return true;
  }

  if (message?.type === "groupInactiveTabs") {
    groupInactiveTabs().then((result) => sendResponse({ ok: true, result }));
    return true;
  }

  if (message?.type === "closeInactiveTabs") {
    closeInactiveTabs().then((result) => sendResponse({ ok: true, result }));
    return true;
  }

  if (message?.type === "saveDomainRuleForActiveTab") {
    saveDomainRuleForActiveTab().then(sendResponse);
    return true;
  }

  if (message?.type === "applyDomainRules") {
    applyDomainRulesToOpenTabs().then((result) => sendResponse({ ok: true, result }));
    return true;
  }

  if (message?.type === "saveExcludedUrlPattern") {
    saveExcludedUrlPattern(message.pattern).then(sendResponse);
    return true;
  }

  if (message?.type === "removeExcludedUrlPattern") {
    removeExcludedUrlPattern(message.pattern).then(sendResponse);
    return true;
  }

  if (message?.type === "mergeDuplicateGroups") {
    mergeDuplicateGroups().then((result) => sendResponse({ ok: true, result }));
    return true;
  }

  return false;
});

async function initialize() {
  const { settings } = await getState();
  await createContextMenus();
  await chrome.alarms.create("scanInactiveTabs", {
    periodInMinutes: settings.scanIntervalMinutes
  });
  await bootstrapOpenTabs();
  await groupInactiveTabs();
}

async function createContextMenus() {
  const contextMenus = getContextMenusApi();
  if (!contextMenus) {
    console.warn("contextMenus API is unavailable. Check the manifest permission and reload the extension.");
    return;
  }

  await removeAllContextMenus(contextMenus);
  contextMenus.create({
    id: CONTEXT_MENU_IDS.saveDomainRule,
    title: chrome.i18n.getMessage("saveDomainRuleContextMenuTitle") || "このドメインを常にこのグループで開く",
    contexts: ["tab"]
  });
  contextMenus.create({
    id: CONTEXT_MENU_IDS.saveUrlRule,
    title: chrome.i18n.getMessage("saveUrlRuleContextMenuTitle") || "このURLを常にこのグループで開く",
    contexts: ["tab"]
  });
}

function registerContextMenuClickHandler() {
  const contextMenus = getContextMenusApi();
  if (!contextMenus || !contextMenus.onClicked) return;

  contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId === CONTEXT_MENU_IDS.saveDomainRule && tab) {
      void saveDomainRuleForTab(tab).catch((error) => {
        console.warn("Failed to save domain rule from context menu.", error);
      });
    }

    if (info.menuItemId === CONTEXT_MENU_IDS.saveUrlRule && tab) {
      void saveUrlRuleForTab(tab).catch((error) => {
        console.warn("Failed to save URL rule from context menu.", error);
      });
    }
  });
}

function getContextMenusApi() {
  if (typeof chrome === "undefined") return undefined;
  if (!("contextMenus" in chrome)) return undefined;
  return chrome["contextMenus"];
}

function removeAllContextMenus(contextMenus) {
  return new Promise((resolve) => {
    contextMenus.removeAll(() => {
      resolve();
    });
  });
}

function registerBookmarkNavigationHandlers() {
  const webNavigation = getWebNavigationApi();
  if (!webNavigation || !webNavigation.onCommitted) return;

  webNavigation.onCommitted.addListener((details) => {
    if (details.frameId !== 0 || details.tabId < 0) return;
    if (details.transitionType !== "auto_bookmark") return;
    void focusExistingTabForBookmarkNavigation(details).catch((error) => {
      console.warn("Failed to handle bookmark navigation.", error);
    });
  });
}

function getWebNavigationApi() {
  if (typeof chrome === "undefined") return undefined;
  if (!("webNavigation" in chrome)) return undefined;
  return chrome["webNavigation"];
}

async function focusExistingTabForBookmarkNavigation(details) {
  const currentTab = await safeGetTab(details.tabId);
  if (!currentTab) return;

  const { settings } = await getState();
  if (isExcludedUrl(details.url, settings.excludedUrlPatterns)) return;

  const existingTab = await findExistingTabByUrl(details.url, details.tabId);
  if (!existingTab || !Number.isInteger(existingTab.id)) return;

  markSkipDomainRule(details.tabId);
  await focusExistingTab(existingTab);
  await goBackReplacedTab(details.tabId);
}

async function focusExistingTabForNewTab(tabId) {
  const tab = await safeGetTab(tabId);
  if (!tab || !Number.isInteger(tab.id)) return false;

  const { settings } = await getState();
  if (isExcludedUrl(tab.url || tab.pendingUrl || "", settings.excludedUrlPatterns)) {
    return false;
  }

  const existingTab = await findExistingTabByUrl(tab.url || tab.pendingUrl || "", tab.id);
  if (!existingTab || !Number.isInteger(existingTab.id)) return false;

  markSkipDomainRule(tab.id);
  await focusExistingTab(existingTab);
  await closeDuplicateTab(tab.id);
  return true;
}

async function findExistingTabByUrl(url, excludedTabId) {
  const targetUrl = normalizeUrlForComparison(url);
  if (!targetUrl) return undefined;

  const tabs = await chrome.tabs.query({});
  return tabs.find((tab) => {
    if (!Number.isInteger(tab.id) || tab.id === excludedTabId) return false;
    return normalizeUrlForComparison(tab.url || tab.pendingUrl || "") === targetUrl;
  });
}

async function focusExistingTab(existingTab) {
  await focusWindow(existingTab.windowId);
  await chrome.tabs.update(existingTab.id, { active: true });
}

function markSkipDomainRule(tabId) {
  skipDomainRuleByTab.set(tabId, Date.now());
}

function shouldSkipDomainRule(tabId) {
  const markedAt = skipDomainRuleByTab.get(tabId);
  if (!markedAt) return false;

  if (Date.now() - markedAt > 5000) {
    skipDomainRuleByTab.delete(tabId);
    return false;
  }

  skipDomainRuleByTab.delete(tabId);
  return true;
}

async function goBackReplacedTab(tabId) {
  const tabs = getTabsApi();
  if (!tabs || !tabs.goBack) return;

  try {
    await tabs.goBack(tabId);
  } catch (_error) {
    // Some tabs have no previous history entry. Focusing the existing tab is still useful.
  }
}

async function closeDuplicateTab(tabId) {
  try {
    await chrome.tabs.remove(tabId);
  } catch (_error) {
    // The duplicate tab may already be closed by the browser or the user.
  }
}

function getTabsApi() {
  if (typeof chrome === "undefined") return undefined;
  if (!("tabs" in chrome)) return undefined;
  return chrome["tabs"];
}

async function focusWindow(windowId) {
  const windows = getWindowsApi();
  if (!Number.isInteger(windowId) || !windows || !windows.update) return;

  try {
    await windows.update(windowId, { focused: true });
  } catch (_error) {
    // The matching tab can still be activated even if focusing its window fails.
  }
}

function getWindowsApi() {
  if (typeof chrome === "undefined") return undefined;
  if (!("windows" in chrome)) return undefined;
  return chrome["windows"];
}

async function bootstrapOpenTabs() {
  const tabs = await chrome.tabs.query({});
  const { tabMetadata } = await getState();
  const now = Date.now();

  for (const tab of tabs) {
    if (!Number.isInteger(tab.id)) continue;
    const existing = tabMetadata[String(tab.id)];
    tabMetadata[String(tab.id)] = normalizeMetadata({
      ...existing,
      tabId: tab.id,
      windowId: tab.windowId,
      url: tab.url || tab.pendingUrl || existing?.url,
      title: tab.title || existing?.title,
      createdAt: existing?.createdAt || now,
      lastActiveAt: tab.active ? now : existing?.lastActiveAt || now,
      groupId: tab.groupId
    });

    if (tab.active) {
      lastActiveByWindow.set(tab.windowId, {
        tabId: tab.id,
        at: now
      });
    }
  }

  await chrome.storage.local.set({ [STORAGE_KEYS.tabMetadata]: tabMetadata });
}

async function handleTabActivated(activeInfo) {
  const tab = await safeGetTab(activeInfo.tabId);
  if (!tab) return;

  lastActiveByWindow.set(activeInfo.windowId, {
    tabId: activeInfo.tabId,
    at: Date.now()
  });

  await upsertTabMetadata(activeInfo.tabId, {
    ...tab,
    lastActiveAt: Date.now()
  });

  await collapseInactiveGroupsForActiveTab(tab);
}

async function handleTabCreated(tab) {
  if (!Number.isInteger(tab.id)) return;

  const now = Date.now();
  const opener = getOpenerCandidate(tab, now);
  await upsertTabMetadata(tab.id, {
    ...tab,
    createdAt: now,
    lastActiveAt: now,
    openerTabId: opener?.tabId,
    rootTabId: opener?.tabId,
    confidence: opener?.confidence
  });

  await delay(500);
  const ruleApplied = await applyDomainRuleToTab(tab.id);
  if (ruleApplied || !opener) return;

  await groupSpawnedTab(tab.id, opener.tabId);
}

async function handleTabUpdated(tabId, changeInfo, tab) {
  await upsertTabMetadata(tabId, tab);
  if (changeInfo.status === "complete" && (tab.url || tab.pendingUrl)) {
    scheduleDomainRuleForUpdatedTab(tabId);
  }
}

function scheduleDomainRuleForUpdatedTab(tabId) {
  const existingTimer = pendingDomainRuleByTab.get(tabId);
  if (existingTimer) {
    clearTimeout(existingTimer);
  }

  const timer = setTimeout(() => {
    pendingDomainRuleByTab.delete(tabId);
    void applyDomainRuleToUpdatedTab(tabId);
  }, 800);

  pendingDomainRuleByTab.set(tabId, timer);
}

async function applyDomainRuleToUpdatedTab(tabId) {
  if (shouldSkipDomainRule(tabId)) return;
  if (await focusExistingTabForNewTab(tabId)) return;
  await applyDomainRuleToTab(tabId);
}

function getOpenerCandidate(tab, now) {
  if (Number.isInteger(tab.openerTabId)) {
    return {
      tabId: tab.openerTabId,
      confidence: "explicit"
    };
  }

  const recent = lastActiveByWindow.get(tab.windowId);
  if (!recent) return undefined;
  if (recent.tabId === tab.id) return undefined;
  if (now - recent.at > DEFAULT_SETTINGS.inferredOpenerWindowMs) return undefined;

  return {
    tabId: recent.tabId,
    confidence: "inferred"
  };
}

async function groupSpawnedTab(tabId, openerTabId) {
  const [tab, opener] = await Promise.all([
    safeGetTab(tabId),
    safeGetTab(openerTabId)
  ]);

  if (!tab || !opener) return;
  const { settings } = await getState();
  if (isExcludedUrl(tab.url || tab.pendingUrl || "", settings.excludedUrlPatterns)) return;
  if (!canGroupTab(tab) || !canGroupTab(opener)) return;
  if (isAlreadyGrouped(tab)) return;
  if (tab.windowId !== opener.windowId) return;

  let groupId = opener.groupId;
  if (groupId === TAB_GROUP_ID_NONE) {
    groupId = await chrome.tabs.group({ tabIds: [opener.id, tab.id] });
  } else {
    await chrome.tabs.group({ tabIds: tab.id, groupId });
  }

  await chrome.tabGroups.update(groupId, {
    title: buildTopicGroupTitle(opener),
    color: "blue",
    collapsed: false
  });
  await collapseOtherGroups(opener.windowId, groupId);
  await refreshMetadataForTabs([opener.id, tab.id]);
}

async function groupInactiveTabs() {
  const tabs = await chrome.tabs.query({});
  const { tabMetadata, settings } = await getState();
  const now = Date.now();
  const byWindow = new Map();

  for (const tab of tabs) {
    if (!Number.isInteger(tab.id)) continue;
    const meta = tabMetadata[String(tab.id)];
    const lastActiveAt = meta?.lastActiveAt || meta?.createdAt || now;

    if (!isInactiveCandidate(tab, lastActiveAt, now, settings.inactiveThresholdMs)) {
      continue;
    }

    if (isExcludedUrl(tab.url || tab.pendingUrl || "", settings.excludedUrlPatterns)) {
      continue;
    }

    const list = byWindow.get(tab.windowId) || [];
    list.push(tab);
    byWindow.set(tab.windowId, list);
  }

  let groupedCount = 0;
  for (const [windowId, windowTabs] of byWindow.entries()) {
    const tabIds = [];
    for (const tab of windowTabs) {
      if (!(await hasDomainRule(tab))) {
        tabIds.push(tab.id);
      }
    }
    if (tabIds.length === 0) continue;

    const groupId = await findOrCreateInactiveGroup(windowId, tabIds);
    await chrome.tabGroups.update(groupId, {
      title: INACTIVE_GROUP_TITLE,
      color: INACTIVE_GROUP_COLOR,
      collapsed: true
    });
    groupedCount += tabIds.length;
    await refreshMetadataForTabs(tabIds);
  }

  return { groupedCount };
}

async function saveDomainRuleForActiveTab() {
  const [tab] = await chrome.tabs.query({
    active: true,
    currentWindow: true
  });

  if (!tab || !Number.isInteger(tab.id)) {
    return { ok: false, error: "No active tab found." };
  }

  return saveDomainRuleForTab(tab);
}

async function saveDomainRuleForTab(tab) {
  const domain = getDomain(tab.url || tab.pendingUrl || "");
  if (!domain || !canGroupTab(tab)) {
    return { ok: false, error: "This tab cannot be saved as a domain rule." };
  }

  if (tab.groupId === TAB_GROUP_ID_NONE) {
    return { ok: false, error: "Group this tab manually first, then save the domain rule." };
  }

  const group = await chrome.tabGroups.get(tab.groupId);
  const groupTitle = (group.title || domain).trim();
  if (!groupTitle) {
    return { ok: false, error: "The current tab group needs a name." };
  }

  const { domainGroupRules } = await getState();
  const now = Date.now();
  domainGroupRules[domain] = {
    domain,
    groupTitle,
    color: group.color || "blue",
    createdAt: domainGroupRules[domain]?.createdAt || now,
    updatedAt: now
  };

  await chrome.storage.local.set({ [STORAGE_KEYS.domainGroupRules]: domainGroupRules });
  const result = await applyDomainRule(domain, domainGroupRules[domain]);
  return { ok: true, rule: domainGroupRules[domain], result };
}

async function saveUrlRuleForTab(tab) {
  const normalizedUrl = normalizeUrlForComparison(tab.url || tab.pendingUrl || "");
  if (!normalizedUrl || !canGroupTab(tab)) {
    return { ok: false, error: "This tab cannot be saved as a URL rule." };
  }

  if (tab.groupId === TAB_GROUP_ID_NONE) {
    return { ok: false, error: "Group this tab manually first, then save the URL rule." };
  }

  const group = await chrome.tabGroups.get(tab.groupId);
  const groupTitle = (group.title || getDomain(normalizedUrl) || "URL").trim();
  if (!groupTitle) {
    return { ok: false, error: "The current tab group needs a name." };
  }

  const { urlGroupRules } = await getState();
  const now = Date.now();
  urlGroupRules[normalizedUrl] = {
    url: normalizedUrl,
    groupTitle,
    color: group.color || "blue",
    createdAt: urlGroupRules[normalizedUrl]?.createdAt || now,
    updatedAt: now
  };

  await chrome.storage.local.set({ [STORAGE_KEYS.urlGroupRules]: urlGroupRules });
  const result = await applyUrlRule(normalizedUrl, urlGroupRules[normalizedUrl]);
  return { ok: true, rule: urlGroupRules[normalizedUrl], result };
}

async function saveExcludedUrlPattern(rawPattern) {
  const pattern = normalizeExcludedUrlPattern(rawPattern);
  if (!pattern) {
    return { ok: false, error: "Enter a valid http(s) URL." };
  }

  const { settings } = await getState();
  if (settings.excludedUrlPatterns.includes(pattern)) {
    return { ok: false, error: "This URL is already excluded." };
  }

  const excludedUrlPatterns = [...settings.excludedUrlPatterns, pattern];
  await chrome.storage.local.set({
    [STORAGE_KEYS.settings]: {
      ...settings,
      excludedUrlPatterns
    }
  });
  return { ok: true, excludedUrlPatterns };
}

async function removeExcludedUrlPattern(rawPattern) {
  const pattern = normalizeExcludedUrlPattern(rawPattern);
  if (!pattern) {
    return { ok: false, error: "The excluded URL is invalid." };
  }

  const { settings } = await getState();
  const excludedUrlPatterns = settings.excludedUrlPatterns.filter(
    (candidate) => candidate !== pattern
  );
  await chrome.storage.local.set({
    [STORAGE_KEYS.settings]: {
      ...settings,
      excludedUrlPatterns
    }
  });
  return { ok: true, excludedUrlPatterns };
}

async function applyDomainRulesToOpenTabs() {
  const { domainGroupRules, urlGroupRules } = await getState();
  let groupedCount = 0;

  for (const [url, rule] of Object.entries(urlGroupRules)) {
    const result = await applyUrlRule(url, rule);
    groupedCount += result.groupedCount;
  }

  for (const [domain, rule] of Object.entries(domainGroupRules)) {
    const result = await applyDomainRule(domain, rule);
    groupedCount += result.groupedCount;
  }

  return { groupedCount };
}

async function applyUrlRule(url, rule) {
  const tabs = await chrome.tabs.query({});
  const { settings } = await getState();
  let groupedCount = 0;

  for (const tab of tabs) {
    if (!Number.isInteger(tab.id)) continue;
    if (normalizeUrlForComparison(tab.url || tab.pendingUrl || "") !== url) continue;
    if (!(await moveTabToRuleGroup(tab, rule, settings.excludedUrlPatterns))) continue;
    groupedCount += 1;
  }

  return { groupedCount };
}

async function applyDomainRule(domain, rule) {
  const tabs = await chrome.tabs.query({});
  const { settings } = await getState();
  let groupedCount = 0;

  for (const tab of tabs) {
    if (!Number.isInteger(tab.id)) continue;
    if (getDomain(tab.url || tab.pendingUrl || "") !== domain) continue;
    if (!(await moveTabToRuleGroup(tab, rule, settings.excludedUrlPatterns))) continue;
    groupedCount += 1;
  }

  return { groupedCount };
}

async function applyDomainRuleToTab(tabId) {
  const tab = await safeGetTab(tabId);
  if (!tab) return false;

  const { domainGroupRules, urlGroupRules, settings } = await getState();
  const normalizedUrl = normalizeUrlForComparison(tab.url || tab.pendingUrl || "");
  if (isExcludedUrl(tab.url || tab.pendingUrl || "", settings.excludedUrlPatterns)) {
    return false;
  }
  const urlRule = urlGroupRules[normalizedUrl];
  if (urlRule) {
    return moveTabToRuleGroup(tab, urlRule, settings.excludedUrlPatterns);
  }

  const domain = getDomain(tab.url || tab.pendingUrl || "");
  const rule = domainGroupRules[domain];
  if (!rule) return false;

  return moveTabToRuleGroup(tab, rule, settings.excludedUrlPatterns);
}

async function moveTabToRuleGroup(tab, rule, excludedUrlPatterns = []) {
  if (!canGroupTab(tab)) return false;
  if (isExcludedUrl(tab.url || tab.pendingUrl || "", excludedUrlPatterns)) return false;
  if (tab.pinned) return false;
  if (isAlreadyGrouped(tab)) return false;

  const existingGroupId = await findGroupByTitle(tab.windowId, rule.groupTitle);
  let groupId = existingGroupId;
  if (groupId === undefined) {
    groupId = await chrome.tabs.group({
      tabIds: tab.id,
      createProperties: { windowId: tab.windowId }
    });
  } else if (tab.groupId !== groupId) {
    await chrome.tabs.group({ tabIds: tab.id, groupId });
  } else {
    return false;
  }

  await chrome.tabGroups.update(groupId, {
    title: rule.groupTitle,
    color: rule.color || "blue",
    collapsed: false
  });
  await collapseOtherGroups(tab.windowId, groupId);
  await refreshMetadataForTabs([tab.id]);
  return true;
}

async function collapseInactiveGroupsForActiveTab(tab) {
  if (!Number.isInteger(tab.windowId)) return;
  if (!isAlreadyGrouped(tab)) {
    await collapseOtherGroups(tab.windowId, undefined);
    return;
  }

  await collapseOtherGroups(tab.windowId, tab.groupId);
}

async function collapseOtherGroups(windowId, expandedGroupId) {
  const groups = await chrome.tabGroups.query({ windowId });
  await Promise.all(
    groups.map((group) => {
      const shouldExpand = group.id === expandedGroupId;
      const desiredCollapsed = !shouldExpand;
      if (group.collapsed === desiredCollapsed) return Promise.resolve();
      return chrome.tabGroups.update(group.id, {
        collapsed: desiredCollapsed
      });
    })
  );
}

async function mergeDuplicateGroups() {
  const groups = await chrome.tabGroups.query({});
  const groupsByWindowAndTitle = new Map();

  for (const group of groups) {
    const title = normalizeGroupTitle(group.title);
    if (!title) continue;

    const key = `${group.windowId}:${title}`;
    const list = groupsByWindowAndTitle.get(key) || [];
    list.push(group);
    groupsByWindowAndTitle.set(key, list);
  }

  let mergedGroupCount = 0;
  let movedTabCount = 0;

  for (const duplicateGroups of groupsByWindowAndTitle.values()) {
    if (duplicateGroups.length < 2) continue;

    const targetGroup = duplicateGroups[0];
    const sourceGroups = duplicateGroups.slice(1);

    for (const sourceGroup of sourceGroups) {
      const tabs = await chrome.tabs.query({
        windowId: sourceGroup.windowId,
        groupId: sourceGroup.id
      });
      const movableTabIds = tabs
        .filter((tab) => Number.isInteger(tab.id) && !tab.pinned)
        .map((tab) => tab.id);

      if (movableTabIds.length === 0) continue;

      await chrome.tabs.group({
        tabIds: movableTabIds,
        groupId: targetGroup.id
      });
      movedTabCount += movableTabIds.length;
      mergedGroupCount += 1;
    }

    await chrome.tabGroups.update(targetGroup.id, {
      title: targetGroup.title || normalizeGroupTitle(targetGroup.title),
      color: targetGroup.color || "blue"
    });
  }

  return { mergedGroupCount, movedTabCount };
}

function normalizeGroupTitle(title) {
  return (title || "").trim();
}

async function findGroupByTitle(windowId, title) {
  const groups = await chrome.tabGroups.query({ windowId });
  const group = groups.find((candidate) => candidate.title === title);
  return group?.id;
}

async function hasDomainRule(tab) {
  const { domainGroupRules, urlGroupRules } = await getState();
  const normalizedUrl = normalizeUrlForComparison(tab.url || tab.pendingUrl || "");
  if (normalizedUrl && urlGroupRules[normalizedUrl]) return true;

  const domain = getDomain(tab.url || tab.pendingUrl || "");
  return Boolean(domain && domainGroupRules[domain]);
}

async function findOrCreateInactiveGroup(windowId, tabIds) {
  const groups = await chrome.tabGroups.query({
    windowId,
    title: INACTIVE_GROUP_TITLE
  });

  if (groups.length > 0) {
    await chrome.tabs.group({ tabIds, groupId: groups[0].id });
    return groups[0].id;
  }

  return chrome.tabs.group({
    tabIds,
    createProperties: { windowId }
  });
}

async function closeInactiveTabs() {
  const tabs = await getInactiveGroupTabs();
  const closableTabs = tabs.filter((tab) => !tab.active && !tab.pinned);
  if (closableTabs.length === 0) {
    return { closedCount: 0 };
  }

  await appendCloseHistory(closableTabs);
  await chrome.tabs.remove(closableTabs.map((tab) => tab.id));
  return { closedCount: closableTabs.length };
}

async function getInactiveGroupTabs() {
  const groups = await chrome.tabGroups.query({ title: INACTIVE_GROUP_TITLE });
  if (groups.length === 0) return [];

  const tabsByGroup = await Promise.all(
    groups.map((group) =>
      chrome.tabs.query({
        groupId: group.id,
        windowId: group.windowId
      })
    )
  );

  return tabsByGroup.flat();
}

async function handleGetDashboard() {
  const [inactiveTabs, activeTab, state] = await Promise.all([
    getInactiveGroupTabs(),
    getActiveTab(),
    getState()
  ]);
  const now = Date.now();

  const tabs = inactiveTabs.map((tab) => {
    const meta = state.tabMetadata[String(tab.id)];
    return {
      id: tab.id,
      title: tab.title || "(untitled)",
      url: tab.url || tab.pendingUrl || "",
      domain: getDomain(tab.url || tab.pendingUrl || ""),
      lastActiveAt: meta?.lastActiveAt || meta?.createdAt || now,
      inactiveMs: now - (meta?.lastActiveAt || meta?.createdAt || now),
      pinned: Boolean(tab.pinned),
      active: Boolean(tab.active)
    };
  });

  return {
    ok: true,
    inactiveThresholdMs: state.settings.inactiveThresholdMs,
    excludedUrlPatterns: state.settings.excludedUrlPatterns,
    activeTab: activeTab
      ? {
          id: activeTab.id,
          title: activeTab.title || "(untitled)",
          domain: getDomain(activeTab.url || activeTab.pendingUrl || ""),
          grouped: activeTab.groupId !== TAB_GROUP_ID_NONE
        }
      : undefined,
    inactiveTabs: tabs,
    domainGroupRules: Object.values(state.domainGroupRules),
    closeHistory: state.closeHistory.slice(0, 20)
  };
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({
    active: true,
    currentWindow: true
  });
  return tab;
}

async function appendCloseHistory(tabs) {
  const { closeHistory, settings } = await getState();
  const closedAt = Date.now();
  const items = tabs.map((tab) => ({
    url: tab.url || tab.pendingUrl || "",
    title: tab.title || "",
    closedAt,
    reason: "inactive_bulk_close"
  }));

  const nextHistory = [...items, ...closeHistory].slice(0, settings.closeHistoryLimit);
  await chrome.storage.local.set({ [STORAGE_KEYS.closeHistory]: nextHistory });
}

async function upsertTabMetadata(tabId, tab) {
  if (!Number.isInteger(tabId)) return;

  const { tabMetadata } = await getState();
  const key = String(tabId);
  const existing = tabMetadata[key];
  const now = Date.now();

  tabMetadata[key] = normalizeMetadata({
    ...existing,
    tabId,
    windowId: tab.windowId ?? existing?.windowId,
    url: tab.url || tab.pendingUrl || existing?.url,
    title: tab.title || existing?.title,
    createdAt: tab.createdAt || existing?.createdAt || now,
    lastActiveAt: tab.lastActiveAt || existing?.lastActiveAt || now,
    openerTabId: tab.openerTabId ?? existing?.openerTabId,
    rootTabId: tab.rootTabId ?? existing?.rootTabId,
    groupId: tab.groupId ?? existing?.groupId,
    confidence: tab.confidence || existing?.confidence
  });

  await chrome.storage.local.set({ [STORAGE_KEYS.tabMetadata]: tabMetadata });
}

async function removeTabMetadata(tabId) {
  const { tabMetadata } = await getState();
  delete tabMetadata[String(tabId)];
  await chrome.storage.local.set({ [STORAGE_KEYS.tabMetadata]: tabMetadata });
}

async function refreshMetadataForTabs(tabIds) {
  const tabs = await Promise.all(tabIds.map((tabId) => safeGetTab(tabId)));
  for (const tab of tabs) {
    if (tab && Number.isInteger(tab.id)) {
      await upsertTabMetadata(tab.id, tab);
    }
  }
}

async function getState() {
  const state = await chrome.storage.local.get({
    [STORAGE_KEYS.tabMetadata]: {},
    [STORAGE_KEYS.closeHistory]: [],
    [STORAGE_KEYS.domainGroupRules]: {},
    [STORAGE_KEYS.urlGroupRules]: {},
    [STORAGE_KEYS.settings]: DEFAULT_SETTINGS
  });

  const storedSettings = state[STORAGE_KEYS.settings] || {};
  const excludedUrlPatterns = Array.isArray(storedSettings.excludedUrlPatterns)
    ? storedSettings.excludedUrlPatterns.map(normalizeExcludedUrlPattern).filter(Boolean)
    : [];

  return {
    tabMetadata: state[STORAGE_KEYS.tabMetadata] || {},
    closeHistory: state[STORAGE_KEYS.closeHistory] || [],
    domainGroupRules: state[STORAGE_KEYS.domainGroupRules] || {},
    urlGroupRules: state[STORAGE_KEYS.urlGroupRules] || {},
    settings: {
      ...DEFAULT_SETTINGS,
      ...storedSettings,
      excludedUrlPatterns
    }
  };
}

async function safeGetTab(tabId) {
  try {
    return await chrome.tabs.get(tabId);
  } catch (_error) {
    return undefined;
  }
}

function isInactiveCandidate(tab, lastActiveAt, now, thresholdMs) {
  if (!canGroupTab(tab)) return false;
  if (tab.active || tab.pinned || tab.audible || tab.incognito || isAlreadyGrouped(tab)) return false;
  return now - lastActiveAt >= thresholdMs;
}

function canGroupTab(tab) {
  if (!Number.isInteger(tab.id)) return false;
  if (tab.pinned || tab.incognito) return false;
  return !isInternalUrl(tab.url || tab.pendingUrl || "");
}

function isAlreadyGrouped(tab) {
  return Number.isInteger(tab.groupId) && tab.groupId !== TAB_GROUP_ID_NONE;
}

function isInternalUrl(url) {
  if (!url) return false;
  return /^(edge|chrome|chrome-extension|about|devtools):/i.test(url);
}

function buildTopicGroupTitle(tab) {
  const title = (tab.title || "").trim();
  if (title) return limitText(title, 36);

  const domain = getDomain(tab.url || tab.pendingUrl || "");
  return domain ? limitText(domain, 36) : "Topic";
}

function getDomain(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch (_error) {
    return "";
  }
}

function normalizeUrlForComparison(url) {
  if (!url || isInternalUrl(url)) return "";

  try {
    const parsed = new URL(url);
    parsed.hash = "";
    return parsed.href;
  } catch (_error) {
    return "";
  }
}

function normalizeExcludedUrlPattern(rawPattern) {
  if (typeof rawPattern !== "string") return "";

  const value = rawPattern.trim().replace(/\*$/, "");
  if (!value) return "";

  try {
    const parsed = new URL(value);
    if (!["http:", "https:"].includes(parsed.protocol)) return "";
    parsed.hash = "";
    return parsed.href;
  } catch (_error) {
    return "";
  }
}

function isExcludedUrl(url, excludedUrlPatterns = []) {
  const normalizedUrl = normalizeUrlForComparison(url);
  if (!normalizedUrl || !Array.isArray(excludedUrlPatterns)) return false;

  return excludedUrlPatterns.some((rawPattern) => {
    const pattern = normalizeExcludedUrlPattern(rawPattern);
    if (!pattern) return false;
    if (normalizedUrl === pattern) return true;
    if (pattern.endsWith("/")) return normalizedUrl.startsWith(pattern);

    return ["/", "?", "&"].some((separator) =>
      normalizedUrl.startsWith(`${pattern}${separator}`)
    );
  });
}

function limitText(value, maxLength) {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}...`;
}

function normalizeMetadata(metadata) {
  return {
    tabId: metadata.tabId,
    windowId: metadata.windowId,
    url: metadata.url,
    title: metadata.title,
    createdAt: metadata.createdAt,
    lastActiveAt: metadata.lastActiveAt,
    openerTabId: metadata.openerTabId,
    rootTabId: metadata.rootTabId,
    groupId: metadata.groupId,
    confidence: metadata.confidence
  };
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
