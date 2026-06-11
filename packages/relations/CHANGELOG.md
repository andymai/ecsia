# Changelog

## [0.21.2](https://github.com/andymai/ecsia/compare/relations-v0.21.1...relations-v0.21.2) (2026-06-11)


### Miscellaneous

* **relations:** Synchronize ecsia versions


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @ecsia/core bumped to 0.21.2
    * @ecsia/schema bumped to 0.21.2

## [0.21.1](https://github.com/andymai/ecsia/compare/relations-v0.21.0...relations-v0.21.1) (2026-06-10)


### Bug Fixes

* rebuild exclusive-relation backref on replication delta apply ([#136](https://github.com/andymai/ecsia/issues/136)) ([8034d21](https://github.com/andymai/ecsia/commit/8034d218346440cdaee40660dd8941935ef1f3e7))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @ecsia/core bumped to 0.21.1
    * @ecsia/schema bumped to 0.21.1

## [0.21.0](https://github.com/andymai/ecsia/compare/relations-v0.20.0...relations-v0.21.0) (2026-06-10)


### Features

* export RelationsApi (the createRelations return type) ([#133](https://github.com/andymai/ecsia/issues/133)) ([06e6b87](https://github.com/andymai/ecsia/commit/06e6b87f2dcd66da7ee93f84fb184201da2002db))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @ecsia/core bumped to 0.21.0
    * @ecsia/schema bumped to 0.21.0

## [0.20.0](https://github.com/andymai/ecsia/compare/relations-v0.19.0...relations-v0.20.0) (2026-06-10)


### Miscellaneous

* **relations:** Synchronize ecsia versions


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @ecsia/core bumped to 0.20.0
    * @ecsia/schema bumped to 0.20.0

## [0.19.0](https://github.com/andymai/ecsia/compare/relations-v0.18.5...relations-v0.19.0) (2026-06-10)


### Features

* replicate relation payload schemas to workers (pair payloads survive the worker round-trip) ([#128](https://github.com/andymai/ecsia/issues/128)) ([f4d8c7a](https://github.com/andymai/ecsia/commit/f4d8c7ae12511557d118bf7fbeb007933a964478))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @ecsia/core bumped to 0.19.0
    * @ecsia/schema bumped to 0.19.0

## [0.18.5](https://github.com/andymai/ecsia/compare/relations-v0.18.4...relations-v0.18.5) (2026-06-10)


### Bug Fixes

* honor per-lane vec defaults on relation overflow rows; clarify 4 internal errors ([#120](https://github.com/andymai/ecsia/issues/120)) ([3da84e5](https://github.com/andymai/ecsia/commit/3da84e563ddaba59d3ee8a89c17d7c2c9e106ea6))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @ecsia/core bumped to 0.18.5
    * @ecsia/schema bumped to 0.18.5

## [0.18.4](https://github.com/andymai/ecsia/compare/relations-v0.18.3...relations-v0.18.4) (2026-06-10)


### Bug Fixes

* maintain row-filter query membership when an exclusive relation writes its eid ([#118](https://github.com/andymai/ecsia/issues/118)) ([0677a1a](https://github.com/andymai/ecsia/commit/0677a1a5d27ad84893ca95c76522954924eed817))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @ecsia/core bumped to 0.18.4
    * @ecsia/schema bumped to 0.18.4

## [0.18.3](https://github.com/andymai/ecsia/compare/relations-v0.18.2...relations-v0.18.3) (2026-06-10)


### Bug Fixes

* apply row filters on cold archetypes so each/count/has agree ([#116](https://github.com/andymai/ecsia/issues/116)) ([3691e8a](https://github.com/andymai/ecsia/commit/3691e8a1d51f2a59f85e55bc54d38ad050145738))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @ecsia/core bumped to 0.18.3
    * @ecsia/schema bumped to 0.18.3

## [0.18.2](https://github.com/andymai/ecsia/compare/relations-v0.18.1...relations-v0.18.2) (2026-06-10)


### Bug Fixes

* guard relation pair-ops mid-iteration + re-default reused overflow rows ([#114](https://github.com/andymai/ecsia/issues/114)) ([d66d65a](https://github.com/andymai/ecsia/commit/d66d65a21c934a0c045fe66a6b41fcc4df66a227))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @ecsia/core bumped to 0.18.2
    * @ecsia/schema bumped to 0.18.2

## [0.18.1](https://github.com/andymai/ecsia/compare/relations-v0.18.0...relations-v0.18.1) (2026-06-10)


### Bug Fixes

* make relation access declarable in a system (rel.access) so the planner serializes it ([#106](https://github.com/andymai/ecsia/issues/106)) ([b0b44c0](https://github.com/andymai/ecsia/commit/b0b44c01308317c8fb566886453b59baf52b4154))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @ecsia/core bumped to 0.18.1
    * @ecsia/schema bumped to 0.18.1

## [0.18.0](https://github.com/andymai/ecsia/compare/relations-v0.17.0...relations-v0.18.0) (2026-06-10)


### Miscellaneous

* **relations:** Synchronize ecsia versions


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @ecsia/core bumped to 0.18.0
    * @ecsia/schema bumped to 0.18.0

## [0.17.0](https://github.com/andymai/ecsia/compare/relations-v0.16.0...relations-v0.17.0) (2026-06-09)


### Features

* dev guards for stale pooled views — pair accessors and topic events ([#100](https://github.com/andymai/ecsia/issues/100)) ([960ceea](https://github.com/andymai/ecsia/commit/960ceeafc98d9c9378aeb418cccdcdbc66b55cc3))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @ecsia/core bumped to 0.17.0
    * @ecsia/schema bumped to 0.17.0

## [0.16.0](https://github.com/andymai/ecsia/compare/relations-v0.15.1...relations-v0.16.0) (2026-06-09)


### Miscellaneous

* **relations:** Synchronize ecsia versions


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @ecsia/core bumped to 0.16.0
    * @ecsia/schema bumped to 0.16.0

## [0.15.1](https://github.com/andymai/ecsia/compare/relations-v0.15.0...relations-v0.15.1) (2026-06-09)


### Bug Fixes

* exclusive relations on a cold-archetype subject silently corrupted ([#96](https://github.com/andymai/ecsia/issues/96)) ([ae629f4](https://github.com/andymai/ecsia/commit/ae629f46e5ebef174da10e142b168bd490c35858))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @ecsia/core bumped to 0.15.1
    * @ecsia/schema bumped to 0.15.1

## [0.15.0](https://github.com/andymai/ecsia/compare/relations-v0.14.0...relations-v0.15.0) (2026-06-09)


### Miscellaneous

* **relations:** Synchronize ecsia versions


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @ecsia/core bumped to 0.15.0
    * @ecsia/schema bumped to 0.15.0

## [0.14.0](https://github.com/andymai/ecsia/compare/relations-v0.13.0...relations-v0.14.0) (2026-06-09)


### Features

* clearer, actionable error messages across the public API ([#92](https://github.com/andymai/ecsia/issues/92)) ([58e1cd1](https://github.com/andymai/ecsia/commit/58e1cd13e0069d94139753517a19d9d773051d15))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @ecsia/core bumped to 0.14.0
    * @ecsia/schema bumped to 0.14.0

## [0.13.0](https://github.com/andymai/ecsia/compare/relations-v0.12.1...relations-v0.13.0) (2026-06-08)


### Miscellaneous

* **relations:** Synchronize ecsia versions


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @ecsia/core bumped to 0.13.0
    * @ecsia/schema bumped to 0.13.0

## [0.12.1](https://github.com/andymai/ecsia/compare/relations-v0.12.0...relations-v0.12.1) (2026-06-08)


### Miscellaneous

* **relations:** Synchronize ecsia versions


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @ecsia/core bumped to 0.12.1
    * @ecsia/schema bumped to 0.12.1

## [0.12.0](https://github.com/andymai/ecsia/compare/relations-v0.11.0...relations-v0.12.0) (2026-06-08)


### Miscellaneous

* **relations:** Synchronize ecsia versions


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @ecsia/core bumped to 0.12.0
    * @ecsia/schema bumped to 0.12.0

## [0.11.0](https://github.com/andymai/ecsia/compare/relations-v0.10.0...relations-v0.11.0) (2026-06-08)


### Miscellaneous

* **relations:** Synchronize ecsia versions


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @ecsia/core bumped to 0.11.0
    * @ecsia/schema bumped to 0.11.0

## [0.10.0](https://github.com/andymai/ecsia/compare/relations-v0.9.0...relations-v0.10.0) (2026-06-08)


### Features

* relation-level pair observers + useTarget/useTargets react hooks ([#75](https://github.com/andymai/ecsia/issues/75)) ([5f66a58](https://github.com/andymai/ecsia/commit/5f66a58d6fc1a1a34b79b5da48eaad58c6218fc4))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @ecsia/core bumped to 0.10.0
    * @ecsia/schema bumped to 0.10.0

## [0.9.0](https://github.com/andymai/ecsia/compare/relations-v0.8.0...relations-v0.9.0) (2026-06-07)


### Miscellaneous

* **relations:** Synchronize ecsia versions


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @ecsia/core bumped to 0.9.0
    * @ecsia/schema bumped to 0.9.0

## [0.8.0](https://github.com/andymai/ecsia/compare/relations-v0.7.12...relations-v0.8.0) (2026-06-06)


### Miscellaneous

* **relations:** Synchronize ecsia versions


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @ecsia/core bumped to 0.8.0
    * @ecsia/schema bumped to 0.8.0

## [0.7.12](https://github.com/andymai/ecsia/compare/relations-v0.7.11...relations-v0.7.12) (2026-06-06)


### Miscellaneous

* **relations:** Synchronize ecsia versions


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @ecsia/core bumped to 0.7.12
    * @ecsia/schema bumped to 0.7.12

## [0.7.11](https://github.com/andymai/ecsia/compare/relations-v0.7.10...relations-v0.7.11) (2026-06-06)


### Miscellaneous

* **relations:** Synchronize ecsia versions


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @ecsia/core bumped to 0.7.11
    * @ecsia/schema bumped to 0.7.11

## [0.7.10](https://github.com/andymai/ecsia/compare/relations-v0.7.9...relations-v0.7.10) (2026-06-06)


### Miscellaneous

* **relations:** Synchronize ecsia versions


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @ecsia/core bumped to 0.7.10
    * @ecsia/schema bumped to 0.7.10

## [0.7.9](https://github.com/andymai/ecsia/compare/relations-v0.7.8...relations-v0.7.9) (2026-06-06)


### Miscellaneous

* **relations:** Synchronize ecsia versions


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @ecsia/core bumped to 0.7.9
    * @ecsia/schema bumped to 0.7.9

## [0.7.8](https://github.com/andymai/ecsia/compare/relations-v0.7.7...relations-v0.7.8) (2026-06-06)


### Miscellaneous

* **relations:** Synchronize ecsia versions


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @ecsia/core bumped to 0.7.8
    * @ecsia/schema bumped to 0.7.8

## [0.7.7](https://github.com/andymai/ecsia/compare/relations-v0.7.6...relations-v0.7.7) (2026-06-06)


### Miscellaneous

* **relations:** Synchronize ecsia versions


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @ecsia/core bumped to 0.7.7
    * @ecsia/schema bumped to 0.7.7

## [0.7.6](https://github.com/andymai/ecsia/compare/relations-v0.7.5...relations-v0.7.6) (2026-06-06)


### Miscellaneous

* **relations:** Synchronize ecsia versions


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @ecsia/core bumped to 0.7.6
    * @ecsia/schema bumped to 0.7.6

## [0.7.5](https://github.com/andymai/ecsia/compare/relations-v0.7.4...relations-v0.7.5) (2026-06-06)


### Miscellaneous

* **relations:** Synchronize ecsia versions


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @ecsia/core bumped to 0.7.5
    * @ecsia/schema bumped to 0.7.5

## [0.7.4](https://github.com/andymai/ecsia/compare/relations-v0.7.3...relations-v0.7.4) (2026-06-06)


### Miscellaneous

* **relations:** Synchronize ecsia versions


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @ecsia/core bumped to 0.7.4
    * @ecsia/schema bumped to 0.7.4

## [0.7.3](https://github.com/andymai/ecsia/compare/relations-v0.7.2...relations-v0.7.3) (2026-06-06)


### Bug Fixes

* depthOf returns stale depths for descendants after a re-target or detach ([#32](https://github.com/andymai/ecsia/issues/32)) ([ec9a91c](https://github.com/andymai/ecsia/commit/ec9a91cafe71d8b872f57b8997ccc2c3a2da52b6))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @ecsia/core bumped to 0.7.3
    * @ecsia/schema bumped to 0.7.3

## [0.7.2](https://github.com/andymai/ecsia/compare/relations-v0.7.1...relations-v0.7.2) (2026-06-06)


### Miscellaneous

* **relations:** Synchronize ecsia versions


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @ecsia/core bumped to 0.7.2
    * @ecsia/schema bumped to 0.7.2

## [0.7.1](https://github.com/andymai/ecsia/compare/relations-v0.7.0...relations-v0.7.1) (2026-06-06)


### Miscellaneous

* **relations:** Synchronize ecsia versions


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @ecsia/core bumped to 0.7.1
    * @ecsia/schema bumped to 0.7.1

## [0.7.0](https://github.com/andymai/ecsia/compare/relations-v0.6.0...relations-v0.7.0) (2026-06-06)


### Miscellaneous

* **relations:** Synchronize ecsia versions


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @ecsia/core bumped to 0.7.0
    * @ecsia/schema bumped to 0.7.0

## [0.6.0](https://github.com/andymai/ecsia/compare/relations-v0.5.0...relations-v0.6.0) (2026-06-06)


### Miscellaneous

* **relations:** Synchronize ecsia versions


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @ecsia/core bumped to 0.6.0
    * @ecsia/schema bumped to 0.6.0

## [0.5.0](https://github.com/andymai/ecsia/compare/relations-v0.4.0...relations-v0.5.0) (2026-06-06)


### Features

* prefab templates and IsA inheritance on integer pairs ([#20](https://github.com/andymai/ecsia/issues/20)) ([de8de13](https://github.com/andymai/ecsia/commit/de8de13360e8397507b2e74a7ab0019dc9e947e2))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @ecsia/core bumped to 0.5.0
    * @ecsia/schema bumped to 0.5.0

## [0.4.0](https://github.com/andymai/ecsia/compare/relations-v0.3.0...relations-v0.4.0) (2026-06-06)


### Miscellaneous

* **relations:** Synchronize ecsia versions


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @ecsia/core bumped to 0.4.0
    * @ecsia/schema bumped to 0.4.0

## [0.3.0](https://github.com/andymai/ecsia/compare/relations-v0.2.0...relations-v0.3.0) (2026-06-05)


### Features

* field-level serialization control (persist flags) + schemaHash-gated deltas ([#16](https://github.com/andymai/ecsia/issues/16)) ([37df715](https://github.com/andymai/ecsia/commit/37df71551bbda819dc81de7171869d912fc67935))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @ecsia/core bumped to 0.3.0
    * @ecsia/schema bumped to 0.3.0

## [0.2.0](https://github.com/andymai/ecsia/compare/relations-v0.1.0...relations-v0.2.0) (2026-06-05)


### Features

* wildcard reverse queries — subjectsOf(Wildcard, target) ([#11](https://github.com/andymai/ecsia/issues/11)) ([0e4295b](https://github.com/andymai/ecsia/commit/0e4295b064d1bd21fab45abbab9d61a0009b22a0))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @ecsia/core bumped to 0.2.0
    * @ecsia/schema bumped to 0.2.0

## [0.1.0](https://github.com/andymai/ecsia/compare/relations-v0.1.0...relations-v0.1.0) (2026-06-05)


### Features

* wildcard reverse queries — subjectsOf(Wildcard, target) ([#11](https://github.com/andymai/ecsia/issues/11)) ([0e4295b](https://github.com/andymai/ecsia/commit/0e4295b064d1bd21fab45abbab9d61a0009b22a0))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @ecsia/core bumped to 0.1.0
    * @ecsia/schema bumped to 0.1.0

## [0.1.0](https://github.com/andymai/ecsia/compare/relations-v0.1.0...relations-v0.1.0) (2026-06-05)


### Features

* wildcard reverse queries — subjectsOf(Wildcard, target) ([#11](https://github.com/andymai/ecsia/issues/11)) ([0e4295b](https://github.com/andymai/ecsia/commit/0e4295b064d1bd21fab45abbab9d61a0009b22a0))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @ecsia/core bumped to 0.1.0
    * @ecsia/schema bumped to 0.1.0

## [0.1.0](https://github.com/andymai/ecsia/compare/relations-v0.1.0...relations-v0.1.0) (2026-06-05)


### Miscellaneous

* **relations:** Synchronize ecsia versions


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @ecsia/core bumped to 0.1.0
    * @ecsia/schema bumped to 0.1.0

## [0.1.0](https://github.com/andymai/ecsia/compare/relations-v0.1.0...relations-v0.1.0) (2026-06-05)


### ⚠ BREAKING CHANGES

* rename umbrella package to 'ecsia'; prepare 0.1.0
* API polish — naming unification and ergonomics

### Features

* API polish — naming unification and ergonomics ([53df674](https://github.com/andymai/ecsia/commit/53df6740f2240921a90b63b5cbb7b5942975eed8))
* batteries-included umbrella package and examples ([ab7c12a](https://github.com/andymai/ecsia/commit/ab7c12ac6b52440c630bed189e92879d604ed6d7))
* project scaffold and entity layer ([fc93556](https://github.com/andymai/ecsia/commit/fc93556dc1783ca6c294a290e78adda706f1c09e))
* **reactivity:** observer-safe structural mutation under the scheduler ([338fbc7](https://github.com/andymai/ecsia/commit/338fbc74cb2e377c4955dafe2a40d9ad2efae7e0))
* **relations:** first-class entity relationships ([0874b91](https://github.com/andymai/ecsia/commit/0874b914b37230ebc11deada67f89d7a27e39fa9))
* **serialization:** snapshots, deltas, and worker bootstrap ([566057e](https://github.com/andymai/ecsia/commit/566057eeb64d418f101d1a6b1c9ad0a1fb0507fd))
* **serialization:** structural change section in deltas ([47915af](https://github.com/andymai/ecsia/commit/47915af5311e48dc7ba597e5bf180c71ab8728b6))


### Miscellaneous

* rename umbrella package to 'ecsia'; prepare 0.1.0 ([546ffc5](https://github.com/andymai/ecsia/commit/546ffc58f0bf3825b85d21cf559525c2dcc63cd3))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @ecsia/core bumped to 0.1.0
    * @ecsia/schema bumped to 0.1.0
