# Releasing evopi

evopi is distributed through **GitHub Pages only**: the `gh-pages` branch of this
repository is served at `https://sunwoo95.github.io/oh-my-evopi` and holds

```
install.sh                      templated installer (curl | sh entry point)
stable                          channel pointer, e.g. "v0.11.0"
latest.json                     manifest of the current stable release
releases/vX.Y.Z/                immutable per-version assets
  evopi-X.Y.Z.tgz               the CLI package (bin: evopi)
  evopi-{ai,core,tui,hashline,mnemopi,natives-loader}-X.Y.Z.tgz
  SHA256SUMS                    sha256sum-format checksums of the 7 tarballs
  latest.json                   copy of the manifest for this version
.nojekyll
```

Nothing is published to the npm registry and no GitHub Release object is
created. The internal `@evopi/*` dependencies inside the tarballs are rewritten
to `<base>/releases/vX.Y.Z/<artifact>.tgz` URLs by
`scripts/pack-evopi-release.mjs`, so a released version is self-contained.

Two pieces implement the release:

| Piece | Runs where | Does |
| --- | --- | --- |
| `scripts/release.mjs` (`npm run release:patch\|minor\|major`) | operator machine | version bump, changelog aggregation, `Release vX.Y.Z` commit, lightweight tag `vX.Y.Z`, push branch then push **only that tag** |
| `.github/workflows/release.yml` | GitHub Actions, on `push` of a `v*.*.*` tag (or `workflow_dispatch`) | guards, `npm ci`, `npm run build`, `npm run release:pack`, assemble the Pages tree, commit + push to `gh-pages` |

`scripts/compare-release-artifacts.mjs` compares a locally built release (or a
dry-run artifact) with a published version; see "Dry-run rehearsal".

## 1. The tag path (canonical)

Preconditions on the operator machine:

- on `main`, clean working tree, `origin/main` up to date;
- CI green for `HEAD` (the tag path does not wait for CI itself);
- no `vX.Y.Z` tag for the target version, locally or on origin;
- `.changes/*.md` fragments written for anything that should land in the
  package changelogs.

Preview first (writes nothing):

```sh
node scripts/release.mjs patch --dry-run
```

Cut the release:

```sh
npm run release:patch          # or release:minor / release:major
# or an explicit version:
node scripts/release.mjs 0.12.0
```

`scripts/release.mjs` then:

1. refuses if the tree is dirty, the branch is not `main`, or the tag exists;
2. bumps every `package.json` with `npm version -ws --include-workspace-root`
   (exit code advisory, files verified), runs `scripts/sync-versions.js` and a
   fresh `npm install` to rebuild the lockfile;
3. aggregates `.changes/*.md` fragments into each package `CHANGELOG.md` and
   `git rm`s the consumed fragments;
4. commits `Release vX.Y.Z` (the husky pre-commit hook runs `npm run check`) and
   creates a plain lightweight tag `vX.Y.Z` on that commit;
5. **skips the npm registry** unless you opt in with `--npm-publish` or
   `EVOPI_RELEASE_NPM_PUBLISH=1` (then it runs `npm run publish`);
6. pushes `main`, then pushes only `refs/tags/vX.Y.Z` (never `--tags`).

The tag push starts the `Release` workflow, which:

1. resolves the version from the tag and applies three guards before building:
   - the version must be plain semver `X.Y.Z` — a pre-release tag such as
     `v0.12.0-rc.1` fails instead of moving the `stable` pointer;
   - the version must equal the root `package.json` **and**
     `packages/coding-agent/package.json` versions, i.e. the tag must sit on the
     bump commit (the pack step rewrites the tarball version from the tag, so an
     un-bumped commit would otherwise ship a CHANGELOG/self-eval that lag
     `evopi --version`);
   - `releases/vX.Y.Z` must not already exist on `gh-pages` — releases are
     immutable, bump instead of overwriting;
2. `npm ci`, `npm run build`, `npm run release:pack -- --channel stable --version X.Y.Z --base-url <Pages> --out-dir packages/coding-agent/release/publish`;
3. assembles the Pages tree (`releases/vX.Y.Z/*`, `stable`, `latest.json`,
   templated `install.sh`, `.nojekyll`) and prints `SHA256SUMS` in the job
   summary;
4. overlays the tree onto a shallow clone of `gh-pages` (older versions are
   preserved), commits as `github-actions[bot]` and pushes without `--force`.
   A concurrent manual push makes this fail non-fast-forward rather than
   corrupting the branch. The `release-pages` concurrency group serialises
   workflow runs.

Verify after the run is green (Pages propagation takes ~10-60 s):

```sh
base=https://sunwoo95.github.io/oh-my-evopi
curl -fsSL "$base/stable"; curl -fsSL "$base/latest.json" | head -3
curl -fsSL "$base/releases/vX.Y.Z/SHA256SUMS"
# isolated install, never touching the real prefix:
prefix=$(mktemp -d)
NPM_CONFIG_PREFIX="$prefix" sh -c "curl -fsSL $base/install.sh | sh"
"$prefix/bin/evopi" --version      # must print X.Y.Z
```

Rules of thumb:

- exactly one path per version — never run the manual overlay (section 4) for a
  version the workflow published, or vice versa;
- if a run fails at a guard, fix the cause and push a **new** version; do not
  delete and re-push tags;
- the workflow needs `contents: write` (declared at workflow level, which
  overrides the repository default of read-only workflow permissions) and the
  `gh-pages` branch must not be protected against the `GITHUB_TOKEN`.

## 2. Dry-run rehearsal (no side effects)

`workflow_dispatch` with `dry_run=true` runs the identical build → pack →
site-assembly steps on the real runner and uploads the assembled tree as the
workflow artifact `evopi-site-vX.Y.Z` instead of pushing to `gh-pages`. The
semver and package.json guards still apply; the "already published" guard only
warns, so an already-released version can be rebuilt and compared. The workflow
file is read from `main`, so the hardened `release.yml` must be committed there
first.

```sh
gh workflow run release.yml -f dry_run=true                 # version defaults to root package.json
gh workflow run release.yml -f dry_run=true -f version=0.11.0
gh run list --workflow=release.yml --limit 1                # note the run id
gh run download <run-id> -n evopi-site-v0.11.0 -D /tmp/evopi-site
node scripts/compare-release-artifacts.mjs /tmp/evopi-site 0.11.0
```

The comparison script (Node built-ins only) accepts either the site layout
(`releases/vX.Y.Z/SHA256SUMS`) or a pack `artifacts/` directory, downloads the
published `SHA256SUMS` from Pages (or reads `--published-dir`, e.g. a `gh-pages`
checkout) and prints one line per tarball:

```
MATCH     evopi-ai-0.11.0.tgz              66abab5e…(full sha)
MISMATCH  evopi-0.11.0.tgz                 local d9713752…  published 444ede1d…
            content: 1509 identical, 35 changed, 12 only-local, 0 only-published
              changed         package/dist/core/kernel/repl-manager.js  (67387 -> published 63447 bytes)
              only-local      package/dist/core/kernel-cell-timeout.js
            package.json: identical
MISSING   …   published but not built      EXTRA   …   built but not published
Summary: 6 match, 1 mismatch, 0 missing, 0 extra
```

Exit code 0 means every tarball is byte-identical, 1 means at least one
difference, 2 means usage/I/O error. For every MISMATCH it unpacks both tarballs
in memory and diffs the entry list (path, size, mode, sha256) plus
`package/package.json` key by key, so the nondeterministic input is named rather
than guessed. `--no-content` skips that step.

Acceptance for adopting the tag path: the six dependency tarballs MATCH and the
`evopi-X.Y.Z.tgz` differences are confined to `package/dist/bundle/` with an
identical `package.json` (see below). Anything else differing must be explained
before the next real release.

## 3. Reproducibility: what byte-identical output to expect

`npm pack` output is deterministic for identical inputs. pacote creates the
tarball with a fixed entry mtime (`1985-10-26T08:15:00Z`), `portable: true`
(no uid/gid/uname, normalised modes), gzip level 9 and a zeroed gzip header
mtime (`npm/node_modules/pacote/lib/util/tar-create-options.js`). Verified on
2026-09-03: packing the same `dist/` twice produced identical `SHA256SUMS`, and a
local pack matched the published v0.11.0 byte-for-byte for
`evopi-ai`, `evopi-core`, `evopi-tui`, `evopi-hashline`, `evopi-mnemopi` and
`evopi-natives-loader`, even though it was built at a different time.

Two inputs are **not** reproducible across machines or commits:

- `evopi-X.Y.Z.tgz`: `packages/coding-agent/scripts/bundle.mjs` bakes
  `__PI_BUILD_ID__` = `git describe --tags --always --dirty` into the esbuild
  bundle. The published v0.11.0 bundle literally contains `"3ba45d1-dirty"`
  (built from a dirty tree before the bump commit); a CI build at the tag embeds
  `v0.11.0`, and a tagless checkout embeds the short commit SHA. Because esbuild
  chunk names are content hashes, this changes `dist/bundle/cli.js` and renames
  one or more `chunk-*.js`. The compare script prints a hint when all differences
  are under `package/dist/bundle/`; treat that as expected and compare the
  content listing + `package.json` instead of the tarball sha.
- `evopi-ai-X.Y.Z.tgz`: `packages/ai`'s build runs `generate-models`, which
  fetches the OpenRouter and Prime Inference catalogs and rewrites
  `src/models.generated.ts`. Two builds separated in time can therefore differ in
  `dist/models.generated.*` when the upstream catalogs changed; the diff will
  name exactly those files.

Everything else (tsgo output, copied assets, the rewritten `package.json`) is
expected to be identical for the same source commit.

## 4. Manual fallback (gh-pages overlay)

This is the procedure used for every release up to v0.11.0 (REVIEW.md,
"[배포완료]" entries). Use it only when the workflow cannot run; never for a
version the workflow already published.

```sh
# 1. bump + lockfile + changelog, commit on main (or let release.mjs do 1-2 and stop before the tag push)
npm run version:patch                     # npm version -ws + sync-versions + npm install
git add -A && git commit -m "Bump version to X.Y.Z"

# 2. build and pack against the Pages base URL
npm run build
npm run release:pack -- --channel stable --version X.Y.Z \
  --base-url https://sunwoo95.github.io/oh-my-evopi \
  --out-dir packages/coding-agent/release/publish

# 3. assemble the site tree (identical to the workflow's "Assemble Pages tree" step)
a=packages/coding-agent/release/publish/artifacts; site=$(mktemp -d)
mkdir -p "$site/releases/vX.Y.Z"
cp "$a"/*.tgz "$a/SHA256SUMS" "$a"/*.json "$site/releases/vX.Y.Z/"
cp "$a/stable" "$site/stable"; cp "$a/latest.json" "$site/latest.json"
sed -e 's#__EVOPI_DOWNLOAD_BASE_URL__#https://sunwoo95.github.io/oh-my-evopi#g' \
    -e 's#__EVOPI_DEFAULT_RELEASE_CHANNEL__#stable#g' install.sh > "$site/install.sh"
touch "$site/.nojekyll"

# 4. overlay onto gh-pages (older releases/v* are preserved) and push
git worktree add /tmp/gh-pages origin/gh-pages
cp -a "$site"/. /tmp/gh-pages/
git -C /tmp/gh-pages add -A
git -C /tmp/gh-pages commit -m "Publish evopi vX.Y.Z (stable)"
git -C /tmp/gh-pages push origin HEAD:gh-pages
git worktree remove /tmp/gh-pages
git push origin main

# 5. verify exactly as in section 1 (latest.json, SHA256SUMS, isolated curl | sh, evopi --version)
```

Only the two contiguous `install.sh` sentinels are replaced; the split guard
sentinels (`"__EVOPI_DOWNLOAD_BASE""_URL__"`) stay intact so an unconfigured
copy still refuses to run. If you also want the git tag for a manually
published version, expect a `Release` run for that tag to stop at the
"already exists" guard — that red run is the guard doing its job.

## 5. Troubleshooting

| Symptom | Cause / action |
| --- | --- |
| `Release version must be plain semver` | pre-release or malformed tag; delete nothing, push a proper `vX.Y.Z` on a bump commit |
| `Version X does not match package.json` | tag not on the bump commit, or `version` input differs from the checked-out ref; run `scripts/release.mjs` instead of tagging by hand |
| `releases/vX already exists on gh-pages` | version already published (probably via the manual overlay); bump to the next version |
| `git push origin gh-pages` rejected (non-fast-forward) | someone pushed `gh-pages` during the run; re-run the workflow (it re-clones) |
| `npm ci` / `npm run build` fails only in CI | runner differences (Node 22, apt libs for `canvas`); reproduce with a dry run before tagging |
| dry-run artifact missing `.nojekyll` | `include-hidden-files: true` is set on the upload step; check the action version pin |
