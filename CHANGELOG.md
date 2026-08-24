# Changelog

All notable changes to **homebridge-hilo-challenge** are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[0.1.5]: https://github.com/justinjsp/homebridge-hilo-challenge/releases/tag/v0.1.5
[0.1.4]: https://github.com/justinjsp/homebridge-hilo-challenge/releases/tag/v0.1.4
[0.1.3]: https://github.com/justinjsp/homebridge-hilo-challenge/releases/tag/v0.1.3
[0.1.2]: https://github.com/justinjsp/homebridge-hilo-challenge/releases/tag/v0.1.2
