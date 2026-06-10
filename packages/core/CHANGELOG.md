# Changelog

## [0.18.1](https://github.com/andymai/ecsia/compare/core-v0.18.0...core-v0.18.1) (2026-06-10)


### Miscellaneous

* **core:** Synchronize ecsia versions


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @ecsia/schema bumped to 0.18.1

## [0.18.0](https://github.com/andymai/ecsia/compare/core-v0.17.0...core-v0.18.0) (2026-06-10)


### Miscellaneous

* **core:** Synchronize ecsia versions


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @ecsia/schema bumped to 0.18.0

## [0.17.0](https://github.com/andymai/ecsia/compare/core-v0.16.0...core-v0.17.0) (2026-06-09)


### Features

* dev guards for stale pooled views — pair accessors and topic events ([#100](https://github.com/andymai/ecsia/issues/100)) ([960ceea](https://github.com/andymai/ecsia/commit/960ceeafc98d9c9378aeb418cccdcdbc66b55cc3))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @ecsia/schema bumped to 0.17.0

## [0.16.0](https://github.com/andymai/ecsia/compare/core-v0.15.1...core-v0.16.0) (2026-06-09)


### Features

* dev guard for structural mutation during query iteration ([#98](https://github.com/andymai/ecsia/issues/98)) ([cb00a8f](https://github.com/andymai/ecsia/commit/cb00a8fb8de9e4846125e0c0d9cd90ead40e32ff))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @ecsia/schema bumped to 0.16.0

## [0.15.1](https://github.com/andymai/ecsia/compare/core-v0.15.0...core-v0.15.1) (2026-06-09)


### Miscellaneous

* **core:** Synchronize ecsia versions


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @ecsia/schema bumped to 0.15.1

## [0.15.0](https://github.com/andymai/ecsia/compare/core-v0.14.0...core-v0.15.0) (2026-06-09)


### Features

* actionable error messages, wave 2 (threading, workers, versions) ([#94](https://github.com/andymai/ecsia/issues/94)) ([4a642ca](https://github.com/andymai/ecsia/commit/4a642ca0e3848e653631febf93729fb4b43df53e))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @ecsia/schema bumped to 0.15.0

## [0.14.0](https://github.com/andymai/ecsia/compare/core-v0.13.0...core-v0.14.0) (2026-06-09)


### Features

* clearer, actionable error messages across the public API ([#92](https://github.com/andymai/ecsia/issues/92)) ([58e1cd1](https://github.com/andymai/ecsia/commit/58e1cd13e0069d94139753517a19d9d773051d15))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @ecsia/schema bumped to 0.14.0

## [0.13.0](https://github.com/andymai/ecsia/compare/core-v0.12.1...core-v0.13.0) (2026-06-08)


### Features

* compile() — the ergonomic .each path, codegen'd to bindColumns speed ([#86](https://github.com/andymai/ecsia/issues/86)) ([fb1317c](https://github.com/andymai/ecsia/commit/fb1317c255be9bcc3e3a6ee61fd2308b6d2c547e))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @ecsia/schema bumped to 0.13.0

## [0.12.1](https://github.com/andymai/ecsia/compare/core-v0.12.0...core-v0.12.1) (2026-06-08)


### Performance

* **core:** codegen bindColumns runners — beat bitECS, no post-growth penalty ([#82](https://github.com/andymai/ecsia/issues/82)) ([ec50962](https://github.com/andymai/ecsia/commit/ec509621958d5b9b5383e45936caabadb668ec5b))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @ecsia/schema bumped to 0.12.1

## [0.12.0](https://github.com/andymai/ecsia/compare/core-v0.11.0...core-v0.12.0) (2026-06-08)


### Features

* **core:** expose per-spec strides on bindColumns meta ([#80](https://github.com/andymai/ecsia/issues/80)) ([a690bff](https://github.com/andymai/ecsia/commit/a690bffbd421c9d168f7aec30c5eeadd3cb8bff0))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @ecsia/schema bumped to 0.12.0

## [0.11.0](https://github.com/andymai/ecsia/compare/core-v0.10.0...core-v0.11.0) (2026-06-08)


### Features

* **core:** deferred-dead-row hold closes the numeric observer-window boundary (PR2/2) ([#79](https://github.com/andymai/ecsia/issues/79)) ([8f8867d](https://github.com/andymai/ecsia/commit/8f8867d821fbfa3f8b22c983ed30e396939a28c8))
* **core:** generation-aware numeric reads in the observer window (PR1/2) ([#77](https://github.com/andymai/ecsia/issues/77)) ([abd8ceb](https://github.com/andymai/ecsia/commit/abd8cebe1a4cbee33883bf9437ed76c1b83a87c5))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @ecsia/schema bumped to 0.11.0

## [0.10.0](https://github.com/andymai/ecsia/compare/core-v0.9.0...core-v0.10.0) (2026-06-08)


### Features

* relation-level pair observers + useTarget/useTargets react hooks ([#75](https://github.com/andymai/ecsia/issues/75)) ([5f66a58](https://github.com/andymai/ecsia/commit/5f66a58d6fc1a1a34b79b5da48eaad58c6218fc4))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @ecsia/schema bumped to 0.10.0

## [0.9.0](https://github.com/andymai/ecsia/compare/core-v0.8.0...core-v0.9.0) (2026-06-07)


### Features

* worker-side topic consume — consumers ride workers, TopicRingGrown completes the notice fence ([#73](https://github.com/andymai/ecsia/issues/73)) ([8857488](https://github.com/andymai/ecsia/commit/8857488117cc4558243f274e1cf74fe9aee0a95d))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @ecsia/schema bumped to 0.9.0

## [0.8.0](https://github.com/andymai/ecsia/compare/core-v0.7.12...core-v0.8.0) (2026-06-06)


### Miscellaneous

* **core:** Synchronize ecsia versions


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @ecsia/schema bumped to 0.8.0

## [0.7.12](https://github.com/andymai/ecsia/compare/core-v0.7.11...core-v0.7.12) (2026-06-06)


### Bug Fixes

* held accessor views fail loud in dev — the docs' fail-loud claim is now true ([#53](https://github.com/andymai/ecsia/issues/53)) ([de3dac3](https://github.com/andymai/ecsia/commit/de3dac3f81dfd4ba19faff0a9c8f0248293bfefd))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @ecsia/schema bumped to 0.7.12

## [0.7.11](https://github.com/andymai/ecsia/compare/core-v0.7.10...core-v0.7.11) (2026-06-06)


### Bug Fixes

* FrameDelta spawned/despawned count real entity lifecycle, not component churn ([#51](https://github.com/andymai/ecsia/issues/51)) ([33f7a2d](https://github.com/andymai/ecsia/commit/33f7a2d16415d3863f5741cec15ed31e9c27d12f))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @ecsia/schema bumped to 0.7.11

## [0.7.10](https://github.com/andymai/ecsia/compare/core-v0.7.9...core-v0.7.10) (2026-06-06)


### Miscellaneous

* **core:** Synchronize ecsia versions


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @ecsia/schema bumped to 0.7.10

## [0.7.9](https://github.com/andymai/ecsia/compare/core-v0.7.8...core-v0.7.9) (2026-06-06)


### Bug Fixes

* a discarded undrained spill now surfaces as OVERFLOW_SENTINEL, never silent loss ([#47](https://github.com/andymai/ecsia/issues/47)) ([dd159da](https://github.com/andymai/ecsia/commit/dd159da0e2c8912de9dfc9ea66ebad158acd2643))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @ecsia/schema bumped to 0.7.9

## [0.7.8](https://github.com/andymai/ecsia/compare/core-v0.7.7...core-v0.7.8) (2026-06-06)


### Miscellaneous

* **core:** Synchronize ecsia versions


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @ecsia/schema bumped to 0.7.8

## [0.7.7](https://github.com/andymai/ecsia/compare/core-v0.7.6...core-v0.7.7) (2026-06-06)


### Miscellaneous

* **core:** Synchronize ecsia versions


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @ecsia/schema bumped to 0.7.7

## [0.7.6](https://github.com/andymai/ecsia/compare/core-v0.7.5...core-v0.7.6) (2026-06-06)


### Miscellaneous

* **core:** Synchronize ecsia versions


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @ecsia/schema bumped to 0.7.6

## [0.7.5](https://github.com/andymai/ecsia/compare/core-v0.7.4...core-v0.7.5) (2026-06-06)


### Bug Fixes

* guard one-word log packing against componentId overflow; type vec defaults as arrays ([#38](https://github.com/andymai/ecsia/issues/38)) ([6acdefe](https://github.com/andymai/ecsia/commit/6acdefe99bc5d237edd7228a5bac4f762c4a386d))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @ecsia/schema bumped to 0.7.5

## [0.7.4](https://github.com/andymai/ecsia/compare/core-v0.7.3...core-v0.7.4) (2026-06-06)


### Bug Fixes

* cold-archetype residents now survive serialization — snapshot, clearAll, delta, and the receiver write path ([#36](https://github.com/andymai/ecsia/issues/36)) ([9ddec6c](https://github.com/andymai/ecsia/commit/9ddec6cc0f6ad88fd7ab2bfcf3192e5f1b810a0b))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @ecsia/schema bumped to 0.7.4

## [0.7.3](https://github.com/andymai/ecsia/compare/core-v0.7.2...core-v0.7.3) (2026-06-06)


### Miscellaneous

* **core:** Synchronize ecsia versions


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @ecsia/schema bumped to 0.7.3

## [0.7.2](https://github.com/andymai/ecsia/compare/core-v0.7.1...core-v0.7.2) (2026-06-06)


### Bug Fixes

* storage and scheduler correctness — row-reuse defaults, maxEntities ceiling, empty spawnWith, worker reservation ordering ([#30](https://github.com/andymai/ecsia/issues/30)) ([5dfc142](https://github.com/andymai/ecsia/commit/5dfc1423c1cbb1148531e658c2ccdf60174fe25b))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @ecsia/schema bumped to 0.7.2

## [0.7.1](https://github.com/andymai/ecsia/compare/core-v0.7.0...core-v0.7.1) (2026-06-06)


### Bug Fixes

* generation-correct rich reads in observer windows ([#27](https://github.com/andymai/ecsia/issues/27)) ([ce8ae17](https://github.com/andymai/ecsia/commit/ce8ae170ab9ebaafc65830fdf9867e855c361c42))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @ecsia/schema bumped to 0.7.1

## [0.7.0](https://github.com/andymai/ecsia/compare/core-v0.6.0...core-v0.7.0) (2026-06-06)


### Miscellaneous

* **core:** Synchronize ecsia versions


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @ecsia/schema bumped to 0.7.0

## [0.6.0](https://github.com/andymai/ecsia/compare/core-v0.5.0...core-v0.6.0) (2026-06-06)


### Miscellaneous

* **core:** Synchronize ecsia versions


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @ecsia/schema bumped to 0.6.0

## [0.5.0](https://github.com/andymai/ecsia/compare/core-v0.4.0...core-v0.5.0) (2026-06-06)


### Features

* prefab templates and IsA inheritance on integer pairs ([#20](https://github.com/andymai/ecsia/issues/20)) ([de8de13](https://github.com/andymai/ecsia/commit/de8de13360e8397507b2e74a7ab0019dc9e947e2))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @ecsia/schema bumped to 0.5.0

## [0.4.0](https://github.com/andymai/ecsia/compare/core-v0.3.0...core-v0.4.0) (2026-06-06)


### Features

* topics — typed inter-system events, byte-identical under any worker count ([#18](https://github.com/andymai/ecsia/issues/18)) ([0702984](https://github.com/andymai/ecsia/commit/0702984e30cffbbc6cc85ad79eab9159fe3a721f))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @ecsia/schema bumped to 0.4.0

## [0.3.0](https://github.com/andymai/ecsia/compare/core-v0.2.0...core-v0.3.0) (2026-06-05)


### Features

* field-level serialization control (persist flags) + schemaHash-gated deltas ([#16](https://github.com/andymai/ecsia/issues/16)) ([37df715](https://github.com/andymai/ecsia/commit/37df71551bbda819dc81de7171869d912fc67935))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @ecsia/schema bumped to 0.3.0

## [0.2.0](https://github.com/andymai/ecsia/compare/core-v0.1.0...core-v0.2.0) (2026-06-05)


### Features

* derive narrower queries from an existing query ([#10](https://github.com/andymai/ecsia/issues/10)) ([1ba68fe](https://github.com/andymai/ecsia/commit/1ba68fe7e9a0865df51d9a28ec192c0d1e114f8e))
* pinned-columns API (bindColumns) — bind-once loops that out-iterate bitECS ([#8](https://github.com/andymai/ecsia/issues/8)) ([2ff5b5a](https://github.com/andymai/ecsia/commit/2ff5b5a039b4201f15bbcad9bfada70ed3c9deb4))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @ecsia/schema bumped to 0.2.0

## [0.1.0](https://github.com/andymai/ecsia/compare/core-v0.1.0...core-v0.1.0) (2026-06-05)


### Features

* derive narrower queries from an existing query ([#10](https://github.com/andymai/ecsia/issues/10)) ([1ba68fe](https://github.com/andymai/ecsia/commit/1ba68fe7e9a0865df51d9a28ec192c0d1e114f8e))
* pinned-columns API (bindColumns) — bind-once loops that out-iterate bitECS ([#8](https://github.com/andymai/ecsia/issues/8)) ([2ff5b5a](https://github.com/andymai/ecsia/commit/2ff5b5a039b4201f15bbcad9bfada70ed3c9deb4))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @ecsia/schema bumped to 0.1.0

## [0.1.0](https://github.com/andymai/ecsia/compare/core-v0.1.0...core-v0.1.0) (2026-06-05)


### Features

* pinned-columns API (bindColumns) — bind-once loops that out-iterate bitECS ([#8](https://github.com/andymai/ecsia/issues/8)) ([2ff5b5a](https://github.com/andymai/ecsia/commit/2ff5b5a039b4201f15bbcad9bfada70ed3c9deb4))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @ecsia/schema bumped to 0.1.0

## [0.1.0](https://github.com/andymai/ecsia/compare/core-v0.1.0...core-v0.1.0) (2026-06-05)


### Features

* pinned-columns API (bindColumns) — bind-once loops that out-iterate bitECS ([#8](https://github.com/andymai/ecsia/issues/8)) ([2ff5b5a](https://github.com/andymai/ecsia/commit/2ff5b5a039b4201f15bbcad9bfada70ed3c9deb4))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @ecsia/schema bumped to 0.1.0

## [0.1.0](https://github.com/andymai/ecsia/compare/core-v0.1.0...core-v0.1.0) (2026-06-05)


### ⚠ BREAKING CHANGES

* rename scheduler.workers 'postMessage-fallback' to 'no-sab'
* rename umbrella package to 'ecsia'; prepare 0.1.0
* API polish — naming unification and ergonomics

### Features

* @ecsia/devtools — world inspector and schedule explainer ([2049f5b](https://github.com/andymai/ecsia/commit/2049f5b9f424207939957cdf35b04f96c3ad35d3))
* API polish — naming unification and ergonomics ([53df674](https://github.com/andymai/ecsia/commit/53df6740f2240921a90b63b5cbb7b5942975eed8))
* batteries-included umbrella package and examples ([ab7c12a](https://github.com/andymai/ecsia/commit/ab7c12ac6b52440c630bed189e92879d604ed6d7))
* **core:** archetype storage and membership index ([ac6b6b8](https://github.com/andymai/ecsia/commit/ac6b6b86675a236b1f153eeab45b0bc7d58eeb81))
* **core:** change tracking and deferred observers ([5393d3e](https://github.com/andymai/ecsia/commit/5393d3ef912aeafd3a0192339d5e701f45c54bb3))
* **core:** first-class string and object component fields ([ee0ab69](https://github.com/andymai/ecsia/commit/ee0ab69fec7b0ce288ddd25a72fb38df2226325d))
* **core:** memory buffers, defineComponent, typed accessors ([844bdb4](https://github.com/andymai/ecsia/commit/844bdb4b824f6a82ec861bc212a31e8344633254))
* **core:** query DSL and live queries ([74ba6ad](https://github.com/andymai/ecsia/commit/74ba6ad561032f7b91655a277896eb327e64efdb))
* project scaffold and entity layer ([fc93556](https://github.com/andymai/ecsia/commit/fc93556dc1783ca6c294a290e78adda706f1c09e))
* **reactivity:** observer-safe structural mutation under the scheduler ([338fbc7](https://github.com/andymai/ecsia/commit/338fbc74cb2e377c4955dafe2a40d9ad2efae7e0))
* **relations:** first-class entity relationships ([0874b91](https://github.com/andymai/ecsia/commit/0874b914b37230ebc11deada67f89d7a27e39fa9))
* rename scheduler.workers 'postMessage-fallback' to 'no-sab' ([69b6acb](https://github.com/andymai/ecsia/commit/69b6acb3f3059210fa45754489432cf65f744b78))
* **scheduler:** worker-thread parallel execution ([83d1cf1](https://github.com/andymai/ecsia/commit/83d1cf1a0b74be72aca7f074a1edc7224bd6bc2f))
* **schema:** query arity inference hardening ([3ad790f](https://github.com/andymai/ecsia/commit/3ad790fa3f96de9ed194d3d9b180470baa54352f))
* **serialization:** snapshots, deltas, and worker bootstrap ([566057e](https://github.com/andymai/ecsia/commit/566057eeb64d418f101d1a6b1c9ad0a1fb0507fd))
* **serialization:** structural change section in deltas ([47915af](https://github.com/andymai/ecsia/commit/47915af5311e48dc7ba597e5bf180c71ab8728b6))


### Bug Fixes

* **core:** avoid module-scope SharedArrayBuffer references ([142b54f](https://github.com/andymai/ecsia/commit/142b54ffbae553ef36fc9cf6cc596d2d60235271))
* guard remaining SharedArrayBuffer references ([38c44ae](https://github.com/andymai/ecsia/commit/38c44ae6c48684c7ad5d47867b42a0e9695cef0b))
* portable dev-mode detection; require Node &gt;=22.13 ([35a109e](https://github.com/andymai/ecsia/commit/35a109e43a7631f7f86ac75195e56f3d6b1de654))
* **scheduler:** rebind worker column views after column re-backing ([004cf34](https://github.com/andymai/ecsia/commit/004cf346123a22908fe1bcf3ba9ffdc816b7407d))


### Performance

* **core:** cut .each overhead in half ([1329889](https://github.com/andymai/ecsia/commit/1329889cdc3cfc4c6fa805693fe4113d94b4280e))
* iteration tuning, worker benchmark, column-growth aliasing fix ([d875ce8](https://github.com/andymai/ecsia/commit/d875ce803ceeeee213e25aa5fee9bbd12c00ddc9))


### Miscellaneous

* rename umbrella package to 'ecsia'; prepare 0.1.0 ([546ffc5](https://github.com/andymai/ecsia/commit/546ffc58f0bf3825b85d21cf559525c2dcc63cd3))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @ecsia/schema bumped to 0.1.0
