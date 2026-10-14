Vendored copy of uisfx 0.4.0 (https://github.com/romainsimon/uisfx), runtime only: dist/index.js and index.d.ts, unchanged except
that the source-map comment is removed. Code is MIT (LICENSE). The sounds are synthesised in the page by this code, so no audio file
ships; the audio files of the upstream package are CC0 (LICENSE-AUDIO). It is vendored, not a dependency, so package.json and the
lockfile do not change. Check before updating: it must stay free of eval, fetch and data: URLs (test/ui-sounds-vendor.test.ts).
