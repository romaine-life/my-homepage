# my-homepage

Bookmark manager web app hosted at homepage.romaine.life.

## Change Log

### 2026-03-23

- **Migrated backend to shared API** — extracted all backend routes (OAuth multi-provider auth, local auth, bookmarks, settings, profile pictures) into `@nelsong6/my-homepage-routes` npm package (`packages/routes/`). Routes mounted at `/homepage` prefix in the shared API at `api.romaine.life`. Deleted `backend/` directory, `backend.tf`, `container-app-build.yml`, `backend-deploy.yml`. Old `homepage-api` Container App destroyed along with its custom domain, certificate, and DNS records. Frontend deploy workflow rewritten to frontend-only. Auth0 Apple callback URLs updated to use `api.romaine.life/homepage/auth/apple/callback`. OAuth callback URLs are now domain-agnostic using `req.get('host')` for GitHub, Google, and Microsoft providers. Homepage uses its own JWT signing secret (`my-homepage-jwt-signing-secret`) separate from the shared API's. Storage blob role assignment for shared API identity managed by tofu after fixing OIDC principal permissions in infra-bootstrap.

### 2026-03-25

- **Restored bypass-mode auth for auto-generated SWA URL** — after the shared API migration, the `allowedRedirectUris` list lost the dynamic `SWA_DEFAULT_HOSTNAME` entry that the old per-app backend had. OAuth login from the Azure Static Web Apps auto-generated URL (used to bypass work firewall restrictions) silently redirected back to `homepage.romaine.life` instead, breaking bookmark saves. Fix: SWA default hostname is now stored in Azure App Configuration via tofu (`appconfig.tf`), read by the shared API's `appConfig.js`, and passed through `config.swaDefaultHostname` to `createHomepageApp()` which dynamically adds it to `allowedRedirectUris`. The `publish-routes` workflow now chains after the Infrastructure workflow (via `workflow_run`) when both tofu and routes change in the same push, ensuring the App Config key exists before the API redeploys.

### 2026-03-15
- Added `ensureAbsoluteUrl()` helper in `frontend/script.js` to fix bare-domain bookmarks (e.g. `romaine.life`) being treated as relative URLs. Without a protocol prefix, the browser navigated to `https://homepage.romaine.life/romaine.life` instead of `https://romaine.life`. Applied to both the anchor `href` and the row click handler.
