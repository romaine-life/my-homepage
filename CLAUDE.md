# my-homepage

Bookmark manager web app hosted at homepage.romaine.life.

## Change Log

### 2026-03-23

- **Migrated backend to shared API** — extracted all backend routes (OAuth multi-provider auth, local auth, bookmarks, settings, profile pictures) into `@nelsong6/my-homepage-routes` npm package (`packages/routes/`). Routes mounted at `/homepage` prefix in the shared API at `api.romaine.life`. Deleted `backend/` directory, `backend.tf`, `container-app-build.yml`, `backend-deploy.yml`. Old `homepage-api` Container App destroyed along with its custom domain, certificate, and DNS records. Frontend deploy workflow rewritten to frontend-only. Auth0 Apple callback URLs updated to use `api.romaine.life/homepage/auth/apple/callback`. OAuth callback URLs are now domain-agnostic using `req.get('host')` for GitHub, Google, and Microsoft providers. Homepage uses its own JWT signing secret (`my-homepage-jwt-signing-secret`) separate from the shared API's. Storage blob role assignment for shared API identity managed by tofu after fixing OIDC principal permissions in infra-bootstrap.

### 2026-03-15
- Added `ensureAbsoluteUrl()` helper in `frontend/script.js` to fix bare-domain bookmarks (e.g. `romaine.life`) being treated as relative URLs. Without a protocol prefix, the browser navigated to `https://homepage.romaine.life/romaine.life` instead of `https://romaine.life`. Applied to both the anchor `href` and the row click handler.
