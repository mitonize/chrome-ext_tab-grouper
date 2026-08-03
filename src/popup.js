const elements = {
  summary: document.getElementById("summary"),
  refreshButton: document.getElementById("refreshButton"),
  groupButton: document.getElementById("groupButton"),
  closeButton: document.getElementById("closeButton"),
  mergeGroupsButton: document.getElementById("mergeGroupsButton"),
  saveDomainRuleButton: document.getElementById("saveDomainRuleButton"),
  domainRuleStatus: document.getElementById("domainRuleStatus"),
  domainRuleList: document.getElementById("domainRuleList"),
  excludedUrlInput: document.getElementById("excludedUrlInput"),
  addExcludedUrlButton: document.getElementById("addExcludedUrlButton"),
  excludedUrlStatus: document.getElementById("excludedUrlStatus"),
  excludedUrlList: document.getElementById("excludedUrlList"),
  emptyState: document.getElementById("emptyState"),
  tabList: document.getElementById("tabList")
};

elements.refreshButton.addEventListener("click", () => {
  void render();
});

elements.groupButton.addEventListener("click", async () => {
  await withBusyState(async () => {
    await chrome.runtime.sendMessage({ type: "groupInactiveTabs" });
  });
  await render();
});

elements.closeButton.addEventListener("click", async () => {
  const dashboard = await chrome.runtime.sendMessage({ type: "getDashboard" });
  const count = dashboard?.inactiveTabs?.filter((tab) => !tab.active && !tab.pinned).length || 0;
  if (count === 0) return;

  const confirmed = window.confirm(`${count} inactive tabs will be closed. Continue?`);
  if (!confirmed) return;

  await withBusyState(async () => {
    await chrome.runtime.sendMessage({ type: "closeInactiveTabs" });
  });
  await render();
});

elements.mergeGroupsButton.addEventListener("click", async () => {
  const confirmed = window.confirm("Duplicate groups with the same title will be merged. Continue?");
  if (!confirmed) return;

  await withBusyState(async () => {
    await chrome.runtime.sendMessage({ type: "mergeDuplicateGroups" });
  });
  await render();
});

elements.saveDomainRuleButton.addEventListener("click", async () => {
  const response = await withBusyState(async () => {
    return chrome.runtime.sendMessage({ type: "saveDomainRuleForActiveTab" });
  });
  await render();
  elements.domainRuleStatus.textContent = response?.ok
    ? `Saved ${response.rule.domain} -> ${response.rule.groupTitle}`
    : response?.error || "Unable to save domain rule.";
});

elements.addExcludedUrlButton.addEventListener("click", async () => {
  const pattern = elements.excludedUrlInput.value.trim();
  if (!pattern) {
    elements.excludedUrlStatus.textContent = "Enter a URL first.";
    return;
  }

  const response = await withBusyState(async () => {
    return chrome.runtime.sendMessage({
      type: "saveExcludedUrlPattern",
      pattern
    });
  });
  elements.excludedUrlStatus.textContent = response?.ok
    ? "URL exclusion saved."
    : response?.error || "Unable to save URL exclusion.";
  if (response?.ok) elements.excludedUrlInput.value = "";
  await render();
});

void render();

async function render() {
  const dashboard = await chrome.runtime.sendMessage({ type: "getDashboard" });
  if (!dashboard?.ok) {
    elements.summary.textContent = "Unable to load tabs.";
    elements.closeButton.disabled = true;
    return;
  }

  const tabs = dashboard.inactiveTabs || [];
  const rules = dashboard.domainGroupRules || [];
  const excludedUrlPatterns = dashboard.excludedUrlPatterns || [];
  const activeTab = dashboard.activeTab;
  elements.summary.textContent = `${tabs.length} inactive tabs grouped`;
  elements.closeButton.disabled = tabs.length === 0;
  elements.saveDomainRuleButton.disabled = !activeTab?.domain || !activeTab?.grouped;
  elements.domainRuleStatus.textContent =
    activeTab?.domain && activeTab?.grouped
      ? `Current domain: ${activeTab.domain}`
      : "Group the active tab first to save a domain rule.";
  elements.emptyState.hidden = tabs.length !== 0;
  elements.domainRuleList.replaceChildren(...rules.map(renderRule));
  elements.excludedUrlList.replaceChildren(...excludedUrlPatterns.map(renderExcludedUrl));
  elements.tabList.replaceChildren(...tabs.map(renderTab));
}

function renderRule(rule) {
  const item = document.createElement("li");
  item.className = "ruleItem";

  const domain = document.createElement("span");
  domain.textContent = rule.domain;

  const group = document.createElement("span");
  group.textContent = rule.groupTitle;

  item.append(domain, group);
  return item;
}

function renderExcludedUrl(pattern) {
  const item = document.createElement("li");
  item.className = "ruleItem";

  const value = document.createElement("span");
  value.textContent = pattern;
  value.title = pattern;

  const removeButton = document.createElement("button");
  removeButton.type = "button";
  removeButton.className = "removeRuleButton";
  removeButton.textContent = "Remove";
  removeButton.addEventListener("click", async () => {
    const response = await withBusyState(async () => {
      return chrome.runtime.sendMessage({
        type: "removeExcludedUrlPattern",
        pattern
      });
    });
    elements.excludedUrlStatus.textContent = response?.ok
      ? "URL exclusion removed."
      : response?.error || "Unable to remove URL exclusion.";
    await render();
  });

  item.append(value, removeButton);
  return item;
}

function renderTab(tab) {
  const item = document.createElement("li");

  const title = document.createElement("div");
  title.className = "title";
  title.textContent = tab.title || "(untitled)";

  const meta = document.createElement("div");
  meta.className = "meta";

  const domain = document.createElement("span");
  domain.className = "domain";
  domain.textContent = tab.domain || "unknown";

  const age = document.createElement("span");
  age.textContent = formatDuration(tab.inactiveMs);

  meta.append(domain, age);
  item.append(title, meta);
  return item;
}

async function withBusyState(action) {
  setDisabled(true);
  try {
    return await action();
  } finally {
    setDisabled(false);
  }
}

function setDisabled(disabled) {
  elements.refreshButton.disabled = disabled;
  elements.groupButton.disabled = disabled;
  elements.closeButton.disabled = disabled;
  elements.mergeGroupsButton.disabled = disabled;
  elements.saveDomainRuleButton.disabled = disabled;
  elements.excludedUrlInput.disabled = disabled;
  elements.addExcludedUrlButton.disabled = disabled;
}

function formatDuration(ms) {
  const hours = Math.floor(ms / (60 * 60 * 1000));
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}
