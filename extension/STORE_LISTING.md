# Chrome Web Store Listing

## Visibility

Unlisted

## Name

Homepage New Tab

## Summary

Opens homepage.romaine.life and selected homepage links in Chrome tabs.

## Description

Homepage New Tab connects Chrome tab behavior to `homepage.romaine.life`.

It provides a keyboard shortcut for opening the homepage and lets the homepage open selected links in Chrome tabs using extension APIs:

- `Ctrl+Shift+H` opens `homepage.romaine.life`.
- `Ctrl+Enter` opens the selected homepage link in a background tab.
- `Ctrl+Shift+Enter` opens the selected homepage link in an active tab.

The extension is scoped to `homepage.romaine.life` and does not collect data.

## Permission Justification

`tabs`: Required to create Chrome tabs in the same browser window as the active homepage tab.

`https://homepage.romaine.life/*`: Required for the content script that receives selected-link open requests from the homepage page.

## Privacy

The extension does not collect, store, transmit, sell, or share user data.

