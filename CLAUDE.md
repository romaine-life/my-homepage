# my-homepage

Bookmark manager web app hosted at homepage.romaine.life.

## Change Log

### 2026-03-15
- Added `ensureAbsoluteUrl()` helper in `frontend/script.js` to fix bare-domain bookmarks (e.g. `romaine.life`) being treated as relative URLs. Without a protocol prefix, the browser navigated to `https://homepage.romaine.life/romaine.life` instead of `https://romaine.life`. Applied to both the anchor `href` and the row click handler.
