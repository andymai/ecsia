# Changelog

## [0.1.0](https://github.com/andymai/ecsia/compare/scheduler-v0.1.0...scheduler-v0.1.0) (2026-06-05)


### Miscellaneous

* **scheduler:** Synchronize ecsia versions


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @ecsia/core bumped to 0.1.0
    * @ecsia/schema bumped to 0.1.0

## [0.1.0](https://github.com/andymai/ecsia/compare/scheduler-v0.1.0...scheduler-v0.1.0) (2026-06-05)


### ⚠ BREAKING CHANGES

* rename scheduler.workers 'postMessage-fallback' to 'no-sab'
* rename umbrella package to 'ecsia'; prepare 0.1.0
* API polish — naming unification and ergonomics

### Features

* @ecsia/devtools — world inspector and schedule explainer ([2049f5b](https://github.com/andymai/ecsia/commit/2049f5b9f424207939957cdf35b04f96c3ad35d3))
* API polish — naming unification and ergonomics ([53df674](https://github.com/andymai/ecsia/commit/53df6740f2240921a90b63b5cbb7b5942975eed8))
* **core:** first-class string and object component fields ([ee0ab69](https://github.com/andymai/ecsia/commit/ee0ab69fec7b0ce288ddd25a72fb38df2226325d))
* project scaffold and entity layer ([fc93556](https://github.com/andymai/ecsia/commit/fc93556dc1783ca6c294a290e78adda706f1c09e))
* **reactivity:** observer-safe structural mutation under the scheduler ([338fbc7](https://github.com/andymai/ecsia/commit/338fbc74cb2e377c4955dafe2a40d9ad2efae7e0))
* **relations:** first-class entity relationships ([0874b91](https://github.com/andymai/ecsia/commit/0874b914b37230ebc11deada67f89d7a27e39fa9))
* rename scheduler.workers 'postMessage-fallback' to 'no-sab' ([69b6acb](https://github.com/andymai/ecsia/commit/69b6acb3f3059210fa45754489432cf65f744b78))
* **scheduler:** system access graph and single-threaded executor ([138f266](https://github.com/andymai/ecsia/commit/138f2669e85b2b499f0ce945d5468e81f8ea78c0))
* **scheduler:** worker-thread parallel execution ([83d1cf1](https://github.com/andymai/ecsia/commit/83d1cf1a0b74be72aca7f074a1edc7224bd6bc2f))


### Bug Fixes

* portable dev-mode detection; require Node &gt;=22.13 ([35a109e](https://github.com/andymai/ecsia/commit/35a109e43a7631f7f86ac75195e56f3d6b1de654))
* **scheduler:** rebind worker column views after column re-backing ([004cf34](https://github.com/andymai/ecsia/commit/004cf346123a22908fe1bcf3ba9ffdc816b7407d))


### Performance

* iteration tuning, worker benchmark, column-growth aliasing fix ([d875ce8](https://github.com/andymai/ecsia/commit/d875ce803ceeeee213e25aa5fee9bbd12c00ddc9))


### Miscellaneous

* rename umbrella package to 'ecsia'; prepare 0.1.0 ([546ffc5](https://github.com/andymai/ecsia/commit/546ffc58f0bf3825b85d21cf559525c2dcc63cd3))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @ecsia/core bumped to 0.1.0
    * @ecsia/schema bumped to 0.1.0
