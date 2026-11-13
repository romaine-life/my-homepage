# my-homepage

Read `CLAUDE.md` for the project architecture and domain notes.

## Container Build Verification

Agent pods are not expected to have Docker. Do not report missing local Docker
as a blocker. Run available repo checks first, then use PR CI as the normal
container build gate: on a pull request, the `image` job in `.forgejo/workflows/ci.yml`
builds and smoke-tests the image with `push: false`. Pushes to `main` and manual
dispatches of CI publish the image; only a push to `main` pins and deploys it.
