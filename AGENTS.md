# my-homepage

Read `CLAUDE.md` for the project architecture and domain notes.

## Container Build Verification

Agent pods are not expected to have Docker. Do not report missing local Docker
as a blocker. Run available repo checks first (`ci-check` runs the suites' local
checks), then use PR CI as the container build gate: the web-app suite builds the
image and runs its `--self-test` on a pull request. Only a merge to `main` publishes,
pins and deploys an image.
