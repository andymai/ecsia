# Changelog

## [0.18.3](https://github.com/andymai/ecsia/compare/kit-v0.18.2...kit-v0.18.3) (2026-06-10)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @ecsia/core bumped to 0.18.2
    * @ecsia/schema bumped to 0.18.2
    * @ecsia/relations bumped to 0.18.2
    * @ecsia/scheduler bumped to 0.18.2
    * @ecsia/serialization bumped to 0.18.2

## [0.18.2](https://github.com/andymai/ecsia/compare/kit-v0.18.1...kit-v0.18.2) (2026-06-10)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @ecsia/core bumped to 0.18.1
    * @ecsia/schema bumped to 0.18.1
    * @ecsia/relations bumped to 0.18.1
    * @ecsia/scheduler bumped to 0.18.1
    * @ecsia/serialization bumped to 0.18.1

## [0.18.1](https://github.com/andymai/ecsia/compare/kit-v0.18.0...kit-v0.18.1) (2026-06-10)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @ecsia/core bumped to 0.18.0
    * @ecsia/schema bumped to 0.18.0
    * @ecsia/relations bumped to 0.18.0
    * @ecsia/scheduler bumped to 0.18.0
    * @ecsia/serialization bumped to 0.18.0

## [0.18.0](https://github.com/andymai/ecsia/compare/kit-v0.17.0...kit-v0.18.0) (2026-06-09)


### ⚠ BREAKING CHANGES

* rename umbrella package to 'ecsia'; prepare 0.1.0
* API polish — naming unification and ergonomics

### Features

* API polish — naming unification and ergonomics ([53df674](https://github.com/andymai/ecsia/commit/53df6740f2240921a90b63b5cbb7b5942975eed8))
* auto-dispatch — scheduler.update() drives the threaded loop through a scheduler-owned pool ([#55](https://github.com/andymai/ecsia/issues/55)) ([57eb853](https://github.com/andymai/ecsia/commit/57eb853796abec7a6266c6108eba01f982bebf7d))
* batteries-included umbrella package and examples ([ab7c12a](https://github.com/andymai/ecsia/commit/ab7c12ac6b52440c630bed189e92879d604ed6d7))
* **core:** first-class string and object component fields ([ee0ab69](https://github.com/andymai/ecsia/commit/ee0ab69fec7b0ce288ddd25a72fb38df2226325d))
* derive narrower queries from an existing query ([#10](https://github.com/andymai/ecsia/issues/10)) ([1ba68fe](https://github.com/andymai/ecsia/commit/1ba68fe7e9a0865df51d9a28ec192c0d1e114f8e))
* network replication helper — stream, receiver, and envelope over snapshots and deltas ([#22](https://github.com/andymai/ecsia/issues/22)) ([65153d8](https://github.com/andymai/ecsia/commit/65153d8c6362e47640fece7cc0f6f1cb56fb2add))
* pinned-columns API (bindColumns) — bind-once loops that out-iterate bitECS ([#8](https://github.com/andymai/ecsia/issues/8)) ([2ff5b5a](https://github.com/andymai/ecsia/commit/2ff5b5a039b4201f15bbcad9bfada70ed3c9deb4))
* prefab templates and IsA inheritance on integer pairs ([#20](https://github.com/andymai/ecsia/issues/20)) ([de8de13](https://github.com/andymai/ecsia/commit/de8de13360e8397507b2e74a7ab0019dc9e947e2))
* project scaffold and entity layer ([fc93556](https://github.com/andymai/ecsia/commit/fc93556dc1783ca6c294a290e78adda706f1c09e))
* relation-level pair observers + useTarget/useTargets react hooks ([#75](https://github.com/andymai/ecsia/issues/75)) ([5f66a58](https://github.com/andymai/ecsia/commit/5f66a58d6fc1a1a34b79b5da48eaad58c6218fc4))
* rename the umbrella package to @ecsia/kit ([#102](https://github.com/andymai/ecsia/issues/102)) ([63a0c61](https://github.com/andymai/ecsia/commit/63a0c616edda7ffc982760cab06f2735a09aedc7))
* topics — typed inter-system events, byte-identical under any worker count ([#18](https://github.com/andymai/ecsia/issues/18)) ([0702984](https://github.com/andymai/ecsia/commit/0702984e30cffbbc6cc85ad79eab9159fe3a721f))


### Bug Fixes

* guard one-word log packing against componentId overflow; type vec defaults as arrays ([#38](https://github.com/andymai/ecsia/issues/38)) ([6acdefe](https://github.com/andymai/ecsia/commit/6acdefe99bc5d237edd7228a5bac4f762c4a386d))
* stop the umbrella leaking core's __ seams as public API ([#29](https://github.com/andymai/ecsia/issues/29)) ([fa9e467](https://github.com/andymai/ecsia/commit/fa9e467f3778f6b5a700e3eb0393c8f363f6fca0))


### Performance

* iteration tuning, worker benchmark, column-growth aliasing fix ([d875ce8](https://github.com/andymai/ecsia/commit/d875ce803ceeeee213e25aa5fee9bbd12c00ddc9))


### Miscellaneous

* rename umbrella package to 'ecsia'; prepare 0.1.0 ([546ffc5](https://github.com/andymai/ecsia/commit/546ffc58f0bf3825b85d21cf559525c2dcc63cd3))

## [0.17.0](https://github.com/andymai/ecsia/compare/ecsia-v0.16.0...ecsia-v0.17.0) (2026-06-09)


### Miscellaneous

* **ecsia:** Synchronize ecsia versions


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @ecsia/core bumped to 0.17.0
    * @ecsia/schema bumped to 0.17.0
    * @ecsia/relations bumped to 0.17.0
    * @ecsia/scheduler bumped to 0.17.0
    * @ecsia/serialization bumped to 0.17.0

## [0.16.0](https://github.com/andymai/ecsia/compare/ecsia-v0.15.1...ecsia-v0.16.0) (2026-06-09)


### Miscellaneous

* **ecsia:** Synchronize ecsia versions


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @ecsia/core bumped to 0.16.0
    * @ecsia/schema bumped to 0.16.0
    * @ecsia/relations bumped to 0.16.0
    * @ecsia/scheduler bumped to 0.16.0
    * @ecsia/serialization bumped to 0.16.0

## [0.15.1](https://github.com/andymai/ecsia/compare/ecsia-v0.15.0...ecsia-v0.15.1) (2026-06-09)


### Miscellaneous

* **ecsia:** Synchronize ecsia versions


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @ecsia/core bumped to 0.15.1
    * @ecsia/schema bumped to 0.15.1
    * @ecsia/relations bumped to 0.15.1
    * @ecsia/scheduler bumped to 0.15.1
    * @ecsia/serialization bumped to 0.15.1

## [0.15.0](https://github.com/andymai/ecsia/compare/ecsia-v0.14.0...ecsia-v0.15.0) (2026-06-09)


### Miscellaneous

* **ecsia:** Synchronize ecsia versions


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @ecsia/core bumped to 0.15.0
    * @ecsia/schema bumped to 0.15.0
    * @ecsia/relations bumped to 0.15.0
    * @ecsia/scheduler bumped to 0.15.0
    * @ecsia/serialization bumped to 0.15.0

## [0.14.0](https://github.com/andymai/ecsia/compare/ecsia-v0.13.0...ecsia-v0.14.0) (2026-06-09)


### Miscellaneous

* **ecsia:** Synchronize ecsia versions


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @ecsia/core bumped to 0.14.0
    * @ecsia/schema bumped to 0.14.0
    * @ecsia/relations bumped to 0.14.0
    * @ecsia/scheduler bumped to 0.14.0
    * @ecsia/serialization bumped to 0.14.0

## [0.13.0](https://github.com/andymai/ecsia/compare/ecsia-v0.12.1...ecsia-v0.13.0) (2026-06-08)


### Miscellaneous

* **ecsia:** Synchronize ecsia versions


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @ecsia/core bumped to 0.13.0
    * @ecsia/schema bumped to 0.13.0
    * @ecsia/relations bumped to 0.13.0
    * @ecsia/scheduler bumped to 0.13.0
    * @ecsia/serialization bumped to 0.13.0

## [0.12.1](https://github.com/andymai/ecsia/compare/ecsia-v0.12.0...ecsia-v0.12.1) (2026-06-08)


### Miscellaneous

* **ecsia:** Synchronize ecsia versions


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @ecsia/core bumped to 0.12.1
    * @ecsia/schema bumped to 0.12.1
    * @ecsia/relations bumped to 0.12.1
    * @ecsia/scheduler bumped to 0.12.1
    * @ecsia/serialization bumped to 0.12.1

## [0.12.0](https://github.com/andymai/ecsia/compare/ecsia-v0.11.0...ecsia-v0.12.0) (2026-06-08)


### Miscellaneous

* **ecsia:** Synchronize ecsia versions


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @ecsia/core bumped to 0.12.0
    * @ecsia/schema bumped to 0.12.0
    * @ecsia/relations bumped to 0.12.0
    * @ecsia/scheduler bumped to 0.12.0
    * @ecsia/serialization bumped to 0.12.0

## [0.11.0](https://github.com/andymai/ecsia/compare/ecsia-v0.10.0...ecsia-v0.11.0) (2026-06-08)


### Miscellaneous

* **ecsia:** Synchronize ecsia versions


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @ecsia/core bumped to 0.11.0
    * @ecsia/schema bumped to 0.11.0
    * @ecsia/relations bumped to 0.11.0
    * @ecsia/scheduler bumped to 0.11.0
    * @ecsia/serialization bumped to 0.11.0

## [0.10.0](https://github.com/andymai/ecsia/compare/ecsia-v0.9.0...ecsia-v0.10.0) (2026-06-08)


### Features

* relation-level pair observers + useTarget/useTargets react hooks ([#75](https://github.com/andymai/ecsia/issues/75)) ([5f66a58](https://github.com/andymai/ecsia/commit/5f66a58d6fc1a1a34b79b5da48eaad58c6218fc4))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @ecsia/core bumped to 0.10.0
    * @ecsia/schema bumped to 0.10.0
    * @ecsia/relations bumped to 0.10.0
    * @ecsia/scheduler bumped to 0.10.0
    * @ecsia/serialization bumped to 0.10.0

## [0.9.0](https://github.com/andymai/ecsia/compare/ecsia-v0.8.0...ecsia-v0.9.0) (2026-06-07)


### Miscellaneous

* **ecsia:** Synchronize ecsia versions


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @ecsia/core bumped to 0.9.0
    * @ecsia/schema bumped to 0.9.0
    * @ecsia/relations bumped to 0.9.0
    * @ecsia/scheduler bumped to 0.9.0
    * @ecsia/serialization bumped to 0.9.0

## [0.8.0](https://github.com/andymai/ecsia/compare/ecsia-v0.7.12...ecsia-v0.8.0) (2026-06-06)


### Features

* auto-dispatch — scheduler.update() drives the threaded loop through a scheduler-owned pool ([#55](https://github.com/andymai/ecsia/issues/55)) ([57eb853](https://github.com/andymai/ecsia/commit/57eb853796abec7a6266c6108eba01f982bebf7d))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @ecsia/core bumped to 0.8.0
    * @ecsia/schema bumped to 0.8.0
    * @ecsia/relations bumped to 0.8.0
    * @ecsia/scheduler bumped to 0.8.0
    * @ecsia/serialization bumped to 0.8.0

## [0.7.12](https://github.com/andymai/ecsia/compare/ecsia-v0.7.11...ecsia-v0.7.12) (2026-06-06)


### Miscellaneous

* **ecsia:** Synchronize ecsia versions


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @ecsia/core bumped to 0.7.12
    * @ecsia/schema bumped to 0.7.12
    * @ecsia/relations bumped to 0.7.12
    * @ecsia/scheduler bumped to 0.7.12
    * @ecsia/serialization bumped to 0.7.12

## [0.7.11](https://github.com/andymai/ecsia/compare/ecsia-v0.7.10...ecsia-v0.7.11) (2026-06-06)


### Miscellaneous

* **ecsia:** Synchronize ecsia versions


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @ecsia/core bumped to 0.7.11
    * @ecsia/schema bumped to 0.7.11
    * @ecsia/relations bumped to 0.7.11
    * @ecsia/scheduler bumped to 0.7.11
    * @ecsia/serialization bumped to 0.7.11

## [0.7.10](https://github.com/andymai/ecsia/compare/ecsia-v0.7.9...ecsia-v0.7.10) (2026-06-06)


### Miscellaneous

* **ecsia:** Synchronize ecsia versions


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @ecsia/core bumped to 0.7.10
    * @ecsia/schema bumped to 0.7.10
    * @ecsia/relations bumped to 0.7.10
    * @ecsia/scheduler bumped to 0.7.10
    * @ecsia/serialization bumped to 0.7.10

## [0.7.9](https://github.com/andymai/ecsia/compare/ecsia-v0.7.8...ecsia-v0.7.9) (2026-06-06)


### Miscellaneous

* **ecsia:** Synchronize ecsia versions


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @ecsia/core bumped to 0.7.9
    * @ecsia/schema bumped to 0.7.9
    * @ecsia/relations bumped to 0.7.9
    * @ecsia/scheduler bumped to 0.7.9
    * @ecsia/serialization bumped to 0.7.9

## [0.7.8](https://github.com/andymai/ecsia/compare/ecsia-v0.7.7...ecsia-v0.7.8) (2026-06-06)


### Miscellaneous

* **ecsia:** Synchronize ecsia versions


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @ecsia/core bumped to 0.7.8
    * @ecsia/schema bumped to 0.7.8
    * @ecsia/relations bumped to 0.7.8
    * @ecsia/scheduler bumped to 0.7.8
    * @ecsia/serialization bumped to 0.7.8

## [0.7.7](https://github.com/andymai/ecsia/compare/ecsia-v0.7.6...ecsia-v0.7.7) (2026-06-06)


### Miscellaneous

* **ecsia:** Synchronize ecsia versions


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @ecsia/core bumped to 0.7.7
    * @ecsia/schema bumped to 0.7.7
    * @ecsia/relations bumped to 0.7.7
    * @ecsia/scheduler bumped to 0.7.7
    * @ecsia/serialization bumped to 0.7.7

## [0.7.6](https://github.com/andymai/ecsia/compare/ecsia-v0.7.5...ecsia-v0.7.6) (2026-06-06)


### Miscellaneous

* **ecsia:** Synchronize ecsia versions


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @ecsia/core bumped to 0.7.6
    * @ecsia/schema bumped to 0.7.6
    * @ecsia/relations bumped to 0.7.6
    * @ecsia/scheduler bumped to 0.7.6
    * @ecsia/serialization bumped to 0.7.6

## [0.7.5](https://github.com/andymai/ecsia/compare/ecsia-v0.7.4...ecsia-v0.7.5) (2026-06-06)


### Bug Fixes

* guard one-word log packing against componentId overflow; type vec defaults as arrays ([#38](https://github.com/andymai/ecsia/issues/38)) ([6acdefe](https://github.com/andymai/ecsia/commit/6acdefe99bc5d237edd7228a5bac4f762c4a386d))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @ecsia/core bumped to 0.7.5
    * @ecsia/schema bumped to 0.7.5
    * @ecsia/relations bumped to 0.7.5
    * @ecsia/scheduler bumped to 0.7.5
    * @ecsia/serialization bumped to 0.7.5

## [0.7.4](https://github.com/andymai/ecsia/compare/ecsia-v0.7.3...ecsia-v0.7.4) (2026-06-06)


### Miscellaneous

* **ecsia:** Synchronize ecsia versions


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @ecsia/core bumped to 0.7.4
    * @ecsia/schema bumped to 0.7.4
    * @ecsia/relations bumped to 0.7.4
    * @ecsia/scheduler bumped to 0.7.4
    * @ecsia/serialization bumped to 0.7.4

## [0.7.3](https://github.com/andymai/ecsia/compare/ecsia-v0.7.2...ecsia-v0.7.3) (2026-06-06)


### Miscellaneous

* **ecsia:** Synchronize ecsia versions


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @ecsia/core bumped to 0.7.3
    * @ecsia/schema bumped to 0.7.3
    * @ecsia/relations bumped to 0.7.3
    * @ecsia/scheduler bumped to 0.7.3
    * @ecsia/serialization bumped to 0.7.3

## [0.7.2](https://github.com/andymai/ecsia/compare/ecsia-v0.7.1...ecsia-v0.7.2) (2026-06-06)


### Bug Fixes

* stop the umbrella leaking core's __ seams as public API ([#29](https://github.com/andymai/ecsia/issues/29)) ([fa9e467](https://github.com/andymai/ecsia/commit/fa9e467f3778f6b5a700e3eb0393c8f363f6fca0))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @ecsia/core bumped to 0.7.2
    * @ecsia/schema bumped to 0.7.2
    * @ecsia/relations bumped to 0.7.2
    * @ecsia/scheduler bumped to 0.7.2
    * @ecsia/serialization bumped to 0.7.2

## [0.7.1](https://github.com/andymai/ecsia/compare/ecsia-v0.7.0...ecsia-v0.7.1) (2026-06-06)


### Miscellaneous

* **ecsia:** Synchronize ecsia versions


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @ecsia/core bumped to 0.7.1
    * @ecsia/schema bumped to 0.7.1
    * @ecsia/relations bumped to 0.7.1
    * @ecsia/scheduler bumped to 0.7.1
    * @ecsia/serialization bumped to 0.7.1

## [0.7.0](https://github.com/andymai/ecsia/compare/ecsia-v0.6.0...ecsia-v0.7.0) (2026-06-06)


### Miscellaneous

* **ecsia:** Synchronize ecsia versions


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @ecsia/core bumped to 0.7.0
    * @ecsia/schema bumped to 0.7.0
    * @ecsia/relations bumped to 0.7.0
    * @ecsia/scheduler bumped to 0.7.0
    * @ecsia/serialization bumped to 0.7.0

## [0.6.0](https://github.com/andymai/ecsia/compare/ecsia-v0.5.0...ecsia-v0.6.0) (2026-06-06)


### Features

* network replication helper — stream, receiver, and envelope over snapshots and deltas ([#22](https://github.com/andymai/ecsia/issues/22)) ([65153d8](https://github.com/andymai/ecsia/commit/65153d8c6362e47640fece7cc0f6f1cb56fb2add))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @ecsia/core bumped to 0.6.0
    * @ecsia/schema bumped to 0.6.0
    * @ecsia/relations bumped to 0.6.0
    * @ecsia/scheduler bumped to 0.6.0
    * @ecsia/serialization bumped to 0.6.0

## [0.5.0](https://github.com/andymai/ecsia/compare/ecsia-v0.4.0...ecsia-v0.5.0) (2026-06-06)


### Features

* prefab templates and IsA inheritance on integer pairs ([#20](https://github.com/andymai/ecsia/issues/20)) ([de8de13](https://github.com/andymai/ecsia/commit/de8de13360e8397507b2e74a7ab0019dc9e947e2))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @ecsia/core bumped to 0.5.0
    * @ecsia/schema bumped to 0.5.0
    * @ecsia/relations bumped to 0.5.0
    * @ecsia/scheduler bumped to 0.5.0
    * @ecsia/serialization bumped to 0.5.0

## [0.4.0](https://github.com/andymai/ecsia/compare/ecsia-v0.3.0...ecsia-v0.4.0) (2026-06-06)


### Features

* topics — typed inter-system events, byte-identical under any worker count ([#18](https://github.com/andymai/ecsia/issues/18)) ([0702984](https://github.com/andymai/ecsia/commit/0702984e30cffbbc6cc85ad79eab9159fe3a721f))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @ecsia/core bumped to 0.4.0
    * @ecsia/schema bumped to 0.4.0
    * @ecsia/relations bumped to 0.4.0
    * @ecsia/scheduler bumped to 0.4.0
    * @ecsia/serialization bumped to 0.4.0

## [0.3.0](https://github.com/andymai/ecsia/compare/ecsia-v0.2.0...ecsia-v0.3.0) (2026-06-05)


### Miscellaneous

* **ecsia:** Synchronize ecsia versions


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @ecsia/core bumped to 0.3.0
    * @ecsia/schema bumped to 0.3.0
    * @ecsia/relations bumped to 0.3.0
    * @ecsia/scheduler bumped to 0.3.0
    * @ecsia/serialization bumped to 0.3.0

## [0.2.0](https://github.com/andymai/ecsia/compare/ecsia-v0.1.0...ecsia-v0.2.0) (2026-06-05)


### Features

* derive narrower queries from an existing query ([#10](https://github.com/andymai/ecsia/issues/10)) ([1ba68fe](https://github.com/andymai/ecsia/commit/1ba68fe7e9a0865df51d9a28ec192c0d1e114f8e))
* pinned-columns API (bindColumns) — bind-once loops that out-iterate bitECS ([#8](https://github.com/andymai/ecsia/issues/8)) ([2ff5b5a](https://github.com/andymai/ecsia/commit/2ff5b5a039b4201f15bbcad9bfada70ed3c9deb4))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @ecsia/core bumped to 0.2.0
    * @ecsia/schema bumped to 0.2.0
    * @ecsia/relations bumped to 0.2.0
    * @ecsia/scheduler bumped to 0.2.0
    * @ecsia/serialization bumped to 0.2.0

## [0.1.0](https://github.com/andymai/ecsia/compare/ecsia-v0.1.0...ecsia-v0.1.0) (2026-06-05)


### Features

* derive narrower queries from an existing query ([#10](https://github.com/andymai/ecsia/issues/10)) ([1ba68fe](https://github.com/andymai/ecsia/commit/1ba68fe7e9a0865df51d9a28ec192c0d1e114f8e))
* pinned-columns API (bindColumns) — bind-once loops that out-iterate bitECS ([#8](https://github.com/andymai/ecsia/issues/8)) ([2ff5b5a](https://github.com/andymai/ecsia/commit/2ff5b5a039b4201f15bbcad9bfada70ed3c9deb4))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @ecsia/core bumped to 0.1.0
    * @ecsia/schema bumped to 0.1.0
    * @ecsia/relations bumped to 0.1.0
    * @ecsia/scheduler bumped to 0.1.0
    * @ecsia/serialization bumped to 0.1.0

## [0.1.0](https://github.com/andymai/ecsia/compare/ecsia-v0.1.0...ecsia-v0.1.0) (2026-06-05)


### Features

* pinned-columns API (bindColumns) — bind-once loops that out-iterate bitECS ([#8](https://github.com/andymai/ecsia/issues/8)) ([2ff5b5a](https://github.com/andymai/ecsia/commit/2ff5b5a039b4201f15bbcad9bfada70ed3c9deb4))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @ecsia/core bumped to 0.1.0
    * @ecsia/schema bumped to 0.1.0
    * @ecsia/relations bumped to 0.1.0
    * @ecsia/scheduler bumped to 0.1.0
    * @ecsia/serialization bumped to 0.1.0

## [0.1.0](https://github.com/andymai/ecsia/compare/ecsia-v0.1.0...ecsia-v0.1.0) (2026-06-05)


### Features

* pinned-columns API (bindColumns) — bind-once loops that out-iterate bitECS ([#8](https://github.com/andymai/ecsia/issues/8)) ([2ff5b5a](https://github.com/andymai/ecsia/commit/2ff5b5a039b4201f15bbcad9bfada70ed3c9deb4))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @ecsia/core bumped to 0.1.0
    * @ecsia/schema bumped to 0.1.0
    * @ecsia/relations bumped to 0.1.0
    * @ecsia/scheduler bumped to 0.1.0
    * @ecsia/serialization bumped to 0.1.0

## [0.1.0](https://github.com/andymai/ecsia/compare/ecsia-v0.1.0...ecsia-v0.1.0) (2026-06-05)


### ⚠ BREAKING CHANGES

* rename umbrella package to 'ecsia'; prepare 0.1.0
* API polish — naming unification and ergonomics

### Features

* API polish — naming unification and ergonomics ([53df674](https://github.com/andymai/ecsia/commit/53df6740f2240921a90b63b5cbb7b5942975eed8))
* batteries-included umbrella package and examples ([ab7c12a](https://github.com/andymai/ecsia/commit/ab7c12ac6b52440c630bed189e92879d604ed6d7))
* **core:** first-class string and object component fields ([ee0ab69](https://github.com/andymai/ecsia/commit/ee0ab69fec7b0ce288ddd25a72fb38df2226325d))
* project scaffold and entity layer ([fc93556](https://github.com/andymai/ecsia/commit/fc93556dc1783ca6c294a290e78adda706f1c09e))


### Performance

* iteration tuning, worker benchmark, column-growth aliasing fix ([d875ce8](https://github.com/andymai/ecsia/commit/d875ce803ceeeee213e25aa5fee9bbd12c00ddc9))


### Miscellaneous

* rename umbrella package to 'ecsia'; prepare 0.1.0 ([546ffc5](https://github.com/andymai/ecsia/commit/546ffc58f0bf3825b85d21cf559525c2dcc63cd3))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @ecsia/core bumped to 0.1.0
    * @ecsia/schema bumped to 0.1.0
    * @ecsia/relations bumped to 0.1.0
    * @ecsia/scheduler bumped to 0.1.0
    * @ecsia/serialization bumped to 0.1.0
