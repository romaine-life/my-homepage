# Homepage New Tab

Chrome extension for `homepage.romaine.life`.

## Behavior

- Chrome's New Tab page is overridden with a small local page that immediately
  navigates to `https://homepage.romaine.life`.
- `Ctrl+T`, the new-tab button, and the browser's New Tab menu item all use the
  homepage without an AutoHotkey remap or another background process.
- On `homepage.romaine.life`, `Ctrl+Enter` opens the selected homepage link in a background tab.
- On `homepage.romaine.life`, `Ctrl+Shift+Enter` opens the selected homepage link in an active tab.

## Permissions

- `tabs`: creates Chrome tabs in the same window as the current homepage tab.
- `https://homepage.romaine.life/*`: listens only on the homepage site for selected-link open requests.

## Web Store Listing

Recommended visibility: unlisted.

Suggested short description:

> Uses homepage.romaine.life for new tabs and opens selected homepage links in Chrome tabs.

