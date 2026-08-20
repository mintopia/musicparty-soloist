# CI runs on GitHub Actions; semver tags publish the image to GHCR

Two workflows under `.github/workflows/`. `ci.yml` runs on every push and pull
request with three jobs: **lint** (`tsc --noEmit`), **test** (`npm test` — build
plus the `selftest.ts` self-check), and **hadolint** on the `Dockerfile`.
`publish.yml` fires only on a pushed semver tag (`v[0-9]+.[0-9]+.[0-9]+`) and
buildx-builds a multi-arch image, pushing it to `ghcr.io/<owner>/<repo>`.

## Considered Options

- **`tsc --noEmit` as the linter** (chosen): no linter was installed and the code
  is small. Type-checking under `strict` is the lint gate; adding ESLint/Prettier
  is a separate opt-in if style rules are wanted later.
- **hadolint for the Dockerfile** (chosen): standard Dockerfile linter, runs as a
  pinned action with no repo dependency.
- **GHCR over Docker Hub** (chosen): the built-in `GITHUB_TOKEN` authenticates the
  push with `packages: write`, so no external registry credentials to manage.
- **Publish on semver tag, not every push** (chosen): images are cut from an
  explicit `vX.Y.Z` tag; `docker/metadata-action` derives the `X.Y.Z`, `X.Y`, `X`,
  and `latest` tags from it.

## Consequences

Multi-arch is `linux/amd64,linux/arm64` — the `Dockerfile` also handles `arm`
(armhf), but arm32 is left out of CI builds to keep them fast; add the platform if
a 32-bit target is needed. The `lint` job overlaps the `test` job's build step;
kept separate so a type error surfaces as a distinct failing check. The first
push must be to a GitHub remote for either workflow to run.
