# Edge Tab Auto Organizer

Microsoft Edge extension that groups inactive tabs and tabs opened from the same source tab.

## MVP Features

- Track tab activation time locally
- Group tabs inactive for 24 hours into an `Inactive` tab group
- Group tabs opened from another tab with their source topic
- Save a manually grouped tab's domain as a reusable grouping rule
- Save a manually grouped tab's URL as a reusable grouping rule
- Focus an existing matching tab when a bookmark, history item, or new tab opens a URL that is already open
- Exclude configured URL prefixes from automatic grouping and duplicate-tab handling
- Keep at most one tab group expanded per window based on the active tab
- Merge duplicate same-name tab groups from the popup

## Group Cleanup

`Merge duplicate groups` merges tab groups that have the same title in the same window. Groups with different names are not merged automatically.

Old-looking groups usually remain because they still contain tabs. Collapsed groups can look unused, but Edge keeps them as long as their tabs exist.
- Review inactive tabs in the popup
- Close inactive grouped tabs only after user confirmation
- Save local close history before bulk close

## Local Install

1. Open `edge://extensions`.
2. Enable developer mode.
3. Choose `Load unpacked`.
4. Select this repository directory.

## Development Notes

- Manifest version: MV3
- Required permissions: `tabs`, `tabGroups`, `storage`, `alarms`, `contextMenus`, `webNavigation`
- Tab URLs, titles, activity metadata, and close history are stored only in `chrome.storage.local`.
- The extension does not send browsing data to external services.

## Domain Rules

1. Manually place a tab into a named Edge tab group.
2. Right-click that tab.
3. Click `このドメインを常にこのグループで開く`.
4. Future tabs from the same domain are moved into a same-name group automatically.

The popup button `Always use this group for domain` performs the same action for the active tab.

Use `このURLを常にこのグループで開く` to save a stricter URL rule. URL rules match the normalized URL exactly, ignoring fragments, and take precedence over domain rules.

Domain rules are stored locally and take precedence over spawned-tab topic grouping.

## Auto-group URL Exclusions

Use `Auto-group URL exclusions` in the popup to add an `http` or `https` URL. The URL itself and its path descendants are excluded from automatic grouping, domain/URL rules, inactive-tab grouping, and duplicate-tab focusing/closing. A URL ending with `/` can be used to exclude an entire host, for example `https://safelinks.example/`.

The entries are stored locally in `chrome.storage.local`. Removing an entry enables the normal automatic behavior again.

## Duplicate URL Deduplication

When a bookmark or history item navigates the current tab to a URL that is already open, the extension focuses the existing matching tab instead. It then asks Edge to go back in the replaced tab when possible.

When a new tab finishes loading a URL that is already open, the extension focuses the existing matching tab and closes the duplicate new tab. Intermediate redirect URLs are ignored.

The extension does not modify bookmark URLs.

## Tests

Run the regression tests with Node.js 18 or later:

```sh
node --test test/background.test.js
```

## Specs

- Requirements: `docs/requirements.md`
- Design: `docs/design.md`
