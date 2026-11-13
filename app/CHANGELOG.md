# Changelog

## [1.0.0](https://github.com/Twigpine/openlaunch/releases/tag/v1.0.0) (2026-11-13)

The first versioned release. The site footer shows the running version, linked to its release notes, and
`/api/health` reports the version and commit.

### Features

* **market cap:** the site's Market cap sort hides launches whose starting and current valuations are both $10M or more
  but have almost no outside trading; "Include all valuations" shows every launch, and the API keeps its order unless
  asked with `mcap=filtered` ([#89](https://github.com/Twigpine/openlaunch/pull/89), by @oniisanlabs)
* versioned releases, a guarded deploy, and the version in the footer ([#147](https://github.com/Twigpine/openlaunch/pull/147))

### Bug fixes

* **indexer:** the sync cursor never moves backwards with two indexers, missing traders are healed fairly, and a slow
  clean-up step no longer holds up indexing ([#114](https://github.com/Twigpine/openlaunch/pull/114), by @Ayush7614)

### Security

* **rpc:** RPC provider URLs are kept out of every error message and log line ([#146](https://github.com/Twigpine/openlaunch/pull/146))
* **api:** request bodies are size-capped before they are read, one trusted client-IP rule, and rate-limit buckets are
  evicted instead of wiped ([#113](https://github.com/Twigpine/openlaunch/pull/113), by @Ayush7614)
