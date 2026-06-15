# Platform documentation (Mintlify)

The public developer docs for the S-Tier Utilities capability platform. The
**capability reference is generated** from the single source of truth
(`src/platform/service-catalog.js`); hand-authored guides live here as MDX.

## Layout

```
docs-site/
  docs.json              # Mintlify config + navigation  (GENERATED — do not hand-edit)
  index.mdx              # welcome / mental model         (authored)
  concepts/authoring.mdx # how to author a tool           (authored)
  reference/
    overview.mdx         # capabilities at a glance       (GENERATED)
    <capability>.mdx     # one page per capability        (GENERATED)
```

Authored pages are listed in `STATIC_GROUPS` at the top of
`scripts/generate-docs.mjs`; add new guides there so they appear in the nav.

## Regenerate the reference

After changing a capability or its `CAPABILITY_DOCS` entry:

```bash
npm run docs:gen
```

This rewrites `reference/*.mdx` and `docs.json`. The `service-catalog` test
fails if a capability has no docs, so the reference can't silently drift.

## Preview locally

```bash
npx mint dev        # run from this docs-site/ directory
```

(Installs the Mintlify CLI on first run; opens a local preview at http://localhost:3000.)

## Deploy

1. Create a project at [mintlify.com](https://mintlify.com) and connect this GitHub repo.
2. Set the docs directory to `docs-site`.
3. Add a logo/favicon and a custom domain in the Mintlify dashboard.

Mintlify redeploys on every push to the default branch. Add `npm run docs:gen`
to CI (and fail the build if it produces a diff) so the published reference is
always in sync with the code.

## Cutover from the in-app page

The app currently ships an in-app Services page (header **Docs** button). Once
this site is live, point that button at the published URL and remove the in-app
`services` view — see `src/main.js` (`renderServicesPage`, the `"services"`
view, and the sidebar entry). `src/platform/service-catalog.js` stays — it's the
generator's source of truth.
