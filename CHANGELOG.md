# Changelog

All notable changes to **homebridge-hilo-challenge** are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **Hilo Recovery** contact sensor — open while Hilo reports the `RECOVERY` phase
  (previously recovery closed both sensors). The Preheat and Reduction sensors keep
  their UUIDs and behaviour.
- Shared state file for other plugins (e.g. homebridge-ecoflow-delta3) at
  `<Homebridge storage>/hilo-challenge/state.json`. Version 1 contract: `version`,
  `updatedAt`, `season`, `phase` (`none` / `preheat` / `reduction` / `recovery`),
  `phaseSince`, `pollIntervalSeconds` and `error`. Written atomically (mode 0644) at
  startup and after every poll, including off-season ones. A failed poll keeps the
  last known phase, sets `error` and still refreshes `updatedAt`. A phase written just
  before a restart is carried over at startup, so readers don't see it briefly end.
- Tests (`npm test`, Node's built-in test runner).

### Changed
- The Hilo refresh token is now read from homebridge-hilo's `Hilo` platform entry in
  Homebridge's `config.json` before every token refresh. Order: homebridge-hilo's
  token, then the last token Hilo rotated to us, then this plugin's own `refreshToken`
  (the oldest, since it never changes); a rejected token falls through to the next one.
- `refreshToken` is now optional — only a fallback. The platform starts when either
  it or a homebridge-hilo entry with a refresh token is present, and otherwise logs a
  clear error and does not start. The config UI header and field description say so.

### Fixed
- The copied `refreshToken` went stale once homebridge-hilo rotated it, so the plugin
  could fail to authenticate after a Homebridge restart. It now follows
  homebridge-hilo's current token.

## [0.1.6] - 2026-08-24

### Fixed
- `config.schema.json`: moved required-field validation to a schema-level
  `required` array — individual `"required": true` flags are invalid JSON Schema.
- `config.schema.json`: added the `name` property.

### Removed
- `homebridge` from `peerDependencies`; it belongs only in `devDependencies`
  (Homebridge is provided by the host at runtime).

## [0.1.5] - 2026-08-24

### Added
- `LICENSE` file (MIT).
- `supports-hap` keyword so the Homebridge UI shows the correct transport badge.
- Prominent `homebridge-hilo` prerequisite documentation in the README and in the
  config UI header (`headerDisplay`) — this plugin reuses the refresh token from
  `homebridge-hilo`, which must be installed and configured first.

### Changed
- The platform now validates the required `refreshToken` in its constructor. When
  it is missing it logs a clear error and does **not** start — no token refresh
  and no accessories are registered.

### Fixed
- Errors thrown from the `didFinishLaunching` startup handler are now caught and
  logged, preventing any unhandled promise rejection during startup.

## [0.1.4] - 2026-08-24

### Changed
- Declared Node.js 24 support and opened the `engines.node` range to `>=18.20.4`
  so future Node major versions load without a plugin update.
- Bumped `@types/node` to `^24`.
- Replaced the legacy `querystring` module with the standard `URLSearchParams`.

## [0.1.3] - 2026-04-06

### Added
- Homebridge v2.0 compatibility.

## [0.1.2] - 2026-04-05

### Added
- Initial release. Exposes Hilo (Hydro-Québec) demand-response challenge phases
  (preheat, reduction) as HomeKit contact sensors, using the Hilo GraphQL API for
  phase detection. Polls only during challenge season (December–March).
- Plugin icon and disclaimer of no affiliation with Hilo or Hydro-Québec.

[Unreleased]: https://github.com/justinjsp/homebridge-hilo-challenge/compare/v0.1.6...HEAD
[0.1.6]: https://github.com/justinjsp/homebridge-hilo-challenge/releases/tag/v0.1.6
[0.1.5]: https://github.com/justinjsp/homebridge-hilo-challenge/releases/tag/v0.1.5
[0.1.4]: https://github.com/justinjsp/homebridge-hilo-challenge/releases/tag/v0.1.4
[0.1.3]: https://github.com/justinjsp/homebridge-hilo-challenge/releases/tag/v0.1.3
[0.1.2]: https://github.com/justinjsp/homebridge-hilo-challenge/releases/tag/v0.1.2
