# vendor/

Committed builds, so the site keeps no build step. Each is a single
minified ES module made once with esbuild from the npm package:

    npx esbuild node_modules/three/build/three.module.js \
        --bundle --minify --format=esm --outfile=vendor/three.min.js
    npx esbuild node_modules/@dimforge/rapier3d-compat/dist/rapier.mjs \
        --bundle --minify --format=esm --outfile=vendor/rapier.min.js

- three.min.js   three 0.186.0                      ~740 KB (~190 KB gzip)
- rapier.min.js  @dimforge/rapier3d-compat 0.20.0   ~2.8 MB (~1.1 MB gzip)

The -compat build carries its WASM inline as base64, which is what
lets it load without a bundler, and why it is the heavy one.
To upgrade: reinstall the packages, rerun the two lines, commit.

three-addons.min.js bundles the two three.js add-ons the tally needs
(GLTFLoader, RoomEnvironment), with "three" left external so it uses
the same three.min.js through the importmap:

    npx esbuild addons.js --bundle --minify --format=esm \
        --external:three --outfile=vendor/three-addons.min.js

where addons.js re-exports them by relative path from
node_modules/three/examples/jsm/ (a relative path, so esbuild bundles
them instead of treating them as part of the external "three").
