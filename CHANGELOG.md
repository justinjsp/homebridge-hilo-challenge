# Changelog

All notable changes to **homebridge-hilo-challenge** are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.1] - 2026-10-26

### Fixed
- **Log in to Hilo did nothing in Safari.** The settings page waited for the login
  address before opening the login window, and Safari blocks a window opened after a
  wait. The window now opens on the click and goes to Hilo once the address is ready.
  If a browser still blocks it, the page shows a link to open the login instead.

- **Finish said "no login code" for a correct paste.** Once loaded, the My Home
  Assistant page rewrites its own address to `/redirect/_change/?redirect=…`, with the
  original address (and its login code) inside. The plugin now unwraps it.
- **Login errors were easy to miss.** They now show on the settings page under Finish,
  and the Homebridge log records why a login failed (never the login code).

### Changed
- **Clearer login steps** on the settings page and in the README: after signing in you
  land on a "My Home Assistant" page. Type nothing there and don't click Save; copy the
  address from the browser's address bar (it starts with
  `https://my.home-assistant.io/redirect/`) and paste it within a few minutes.

## [0.2.0] - 2026-10-26

### Added
- **Own Hilo login.** The plugin's settings page (custom Homebridge UI) has a
  "Log in to Hilo" button: sign in, then paste the address you land on. This gives the
  plugin its own Hilo session. Its refresh token is kept in
  `<Homebridge storage>/hilo-challenge/auth.json` (mode 0600, not `config.json`),
  replaced on disk each time Hilo rotates it, and re-read before every refresh, so a new
  login takes effect without a restart. A rotation never overwrites a newer login.
  "Log out" deletes the file.
- **Hilo Recovery** contact sensor, open during the recovery phase. The Preheat and
  Reduction sensors keep their UUIDs.
- Shared state file for other plugins (e.g. homebridge-ecoflow-delta3) at
  `<Homebridge storage>/hilo-challenge/state.json`. Version 1 contract: `version`,
  `updatedAt`, `season`, `phase` (`none` / `preheat` / `reduction` / `recovery`),
  `phaseSince`, `pollIntervalSeconds` and `error`. Written atomically (mode 0644) at
  startup and after every poll, including off-season ones. A phase written just
  before a restart is carried over at startup, so readers don't see it briefly end.
- Tests (`npm test`, Node's built-in test runner).

### Changed
- **Phase detection now uses Hilo's challenge events API**
  (`/GDService/v1/api/Locations/{id}/Events`), which gives explicit preheat, reduction
  and recovery start and end times, instead of the devices' `gDState` field. Only
  `ACTIVE` is a real `gDState` value, so the Preheat sensor could never open before.
  The schedule is fetched at most every 5 minutes and the phase is worked out from it
  at every poll, so transitions land on time and survive brief API outages. Events the
  user opted out of, and completed or cancelled ones, are ignored.
- **Location discovery uses `/Automation/v1/api/Locations`.** `locationId` is now only
  needed for accounts with several locations, and accepts the numeric ID or the URN.
- The platform always starts and registers its sensors. Without a login it logs how to
  log in, keeps the sensors closed and reports the reason in the state file's `error`.
- Off-season, the plugin checks the API once at startup, then makes no calls.
- Links now point to homebridge-hilo's current home, SanterreJo/homebridge-hilo.

### Removed
- **The plugin no longer uses homebridge-hilo's refresh token in any way**, neither
  read from `config.json` nor pasted into this plugin's `refreshToken` field. Hilo
  rotates refresh tokens on use, so sharing one could sign homebridge-hilo out. A
  leftover `refreshToken` is ignored with a warning. homebridge-hilo is no longer a
  prerequisite.
- The GraphQL `gDState` query.

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

[Unreleased]: https://github.com/justinjsp/homebridge-hilo-challenge/compare/v0.2.1...HEAD
[0.2.1]: https://github.com/justinjsp/homebridge-hilo-challenge/releases/tag/v0.2.1
[0.2.0]: https://github.com/justinjsp/homebridge-hilo-challenge/releases/tag/v0.2.0
[0.1.6]: https://github.com/justinjsp/homebridge-hilo-challenge/releases/tag/v0.1.6
[0.1.5]: https://github.com/justinjsp/homebridge-hilo-challenge/releases/tag/v0.1.5
[0.1.4]: https://github.com/justinjsp/homebridge-hilo-challenge/releases/tag/v0.1.4
[0.1.3]: https://github.com/justinjsp/homebridge-hilo-challenge/releases/tag/v0.1.3
[0.1.2]: https://github.com/justinjsp/homebridge-hilo-challenge/releases/tag/v0.1.2
