# Edge Tab Auto Organizer Design

## 1. Architecture

Manifest V3の拡張機能として実装する。

```text
manifest.json
  -> background service worker
       - tab activity tracking
       - inactive tab detection
       - spawned tab grouping
       - domain rule grouping
       - tab context menu handling
       - close history persistence
  -> popup
       - inactive candidates review
       - manual grouping trigger
       - domain rule save trigger
       - bulk close trigger
```

## 2. Browser APIs

Use:

- `chrome.tabs`
  - query tabs
  - listen to tab activation, creation, update, removal
  - group tabs
  - close selected tabs
- `chrome.tabGroups`
  - update group title and color
  - find existing groups
- `chrome.storage.local`
  - persist tab metadata
  - persist close history
- `chrome.alarms`
  - periodic inactive tab scan
- `chrome.contextMenus`
  - add tab right-click actions
- `chrome.webNavigation`
  - detect bookmark/history navigations

Required permissions:

- `tabs`
- `tabGroups`
- `storage`
- `alarms`
- `contextMenus`
- `webNavigation`

## 3. Data Model

### TabMetadata

```ts
type TabMetadata = {
  tabId: number;
  windowId: number;
  url?: string;
  title?: string;
  createdAt: number;
  lastActiveAt: number;
  openerTabId?: number;
  rootTabId?: number;
  groupId?: number;
  confidence?: "explicit" | "inferred";
};
```

### CloseHistoryItem

```ts
type CloseHistoryItem = {
  url?: string;
  title?: string;
  closedAt: number;
  reason: "inactive_bulk_close";
};
```

### DomainGroupRule

```ts
type DomainGroupRule = {
  domain: string;
  groupTitle: string;
  color: chrome.tabGroups.ColorEnum;
  createdAt: number;
  updatedAt: number;
};
```

### UrlGroupRule

```ts
type UrlGroupRule = {
  url: string;
  groupTitle: string;
  color: chrome.tabGroups.ColorEnum;
  createdAt: number;
  updatedAt: number;
};
```

## 4. Inactive Tab Flow

1. Service worker receives tab activity events.
2. `lastActiveAt` is updated when a tab becomes active.
3. Alarm runs every 15 minutes.
4. Service worker queries all tabs.
5. It excludes:
   - active tabs
   - pinned tabs
   - audible tabs
   - internal browser pages
   - extension pages
6. Tabs older than the threshold are grouped into `Inactive`.
7. Popup shows current inactive group tabs and lets the user close them in bulk.

## 5. Spawned Tab Flow

1. New tab is created.
2. Service worker checks `openerTabId`.
3. If `openerTabId` exists:
   - If opener already belongs to a group, add the new tab to that group.
   - Otherwise create a group with opener and spawned tab.
4. Group title is generated from opener title or opener domain.
5. If explicit opener is unavailable, MVP may infer from the most recently active tab in the same window, but only within a short time window.

## 6. Safety Rules

- The extension never closes tabs automatically.
- Bulk close must be triggered by a user action.
- Bulk close excludes pinned and active tabs.
- Closed tab information is saved before closing.

## 7. Domain Rule Flow

1. User manually groups tabs in Edge.
2. User right-clicks a tab in that group.
3. User chooses `このドメインを常にこのグループで開く`.
4. The service worker stores `domain -> groupTitle`.
5. When a tab is created or its URL changes, the service worker checks for a matching domain rule.
6. If a rule exists, the tab is moved to a same-title group in the same window.
7. If no same-title group exists in the window, one is created.

The popup can call the same rule-saving behavior for the active tab, but the tab context menu is the primary user flow.

Domain rules take precedence over spawned-tab topic grouping.
URL rules take precedence over domain rules and use normalized URL exact matching without fragments.

Already-grouped tabs are never moved automatically. Manual groups and groups created by other tools are treated as intentional ownership boundaries.

When a tab is automatically moved by a domain rule or spawned-tab grouping, the destination group is expanded so the tab does not disappear into a collapsed group. Browser tab-strip scrolling is not directly controlled because the extension APIs do not expose a scroll operation for the native tab UI.

## 8. Single Expanded Group Flow

1. When the active tab changes, the service worker reads the active tab group.
2. If the active tab belongs to a group, that group is expanded.
3. Other groups in the same window are collapsed.
4. If the active tab is ungrouped, all groups in the same window are collapsed.
5. Domain/URL rule grouping and spawned-tab grouping also collapse other groups after expanding their destination group.

## 9. Duplicate Group Cleanup Flow

1. User clicks `Merge duplicate groups` in the popup.
2. The service worker queries all tab groups.
3. Groups are bucketed by `windowId + normalized title`.
4. For each bucket with multiple groups, tabs from later groups are moved into the first group.
5. Groups with different names are left untouched.

## 10. Duplicate URL Navigation Flow

1. When a top-level navigation commits, the service worker checks `transitionType`.
2. If the transition is `auto_bookmark`, it searches for another open tab with the same URL.
3. If a matching tab exists, that tab and window are focused.
4. The tab that was navigated by the bookmark click is sent back through browser history when possible.
5. When a newly-created tab finishes loading and its final URL is already open, the existing tab is focused and the duplicate new tab is closed.

This is a post-navigation correction. The extension does not rewrite bookmark URLs and does not intercept the bookmark click before Edge starts navigation. It uses browser history back rather than navigating to a stored previous URL.

Domain rule grouping on URL updates is delayed briefly after `status: complete` so duplicate URL handling can run first. Intermediate redirect URLs observed while `status: loading` are ignored. If duplicate handling claims the tab, that URL update does not trigger domain-rule grouping.

## 11. Implementation Plan

1. Create MV3 extension manifest.
2. Implement background service worker.
3. Implement popup UI.
4. Add shared styles.
5. Add README with local install and test steps.
6. Validate extension files and run static syntax checks.

## 12. References

- Microsoft Edge supported extension APIs: https://learn.microsoft.com/en-us/microsoft-edge/extensions/developer-guide/api-support
- Chrome `tabGroups` API reference used by Chromium-based Edge: https://developer.chrome.com/docs/extensions/reference/api/tabGroups
- Chrome `tabs` API reference used by Chromium-based Edge: https://developer.chrome.com/docs/extensions/reference/api/tabs
