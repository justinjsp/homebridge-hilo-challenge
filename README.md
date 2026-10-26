# homebridge-hilo-challenge

[![npm](https://img.shields.io/npm/v/homebridge-hilo-challenge)](https://www.npmjs.com/package/homebridge-hilo-challenge)
[![npm](https://img.shields.io/npm/dt/homebridge-hilo-challenge)](https://www.npmjs.com/package/homebridge-hilo-challenge)

A [Homebridge](https://homebridge.io) plugin that exposes [Hilo](https://www.hiloenergie.com) (Hydro-Québec) demand response challenge phases as **HomeKit contact sensors**.

Three sensors are created:
- **Hilo Preheat** — opens during the pre-heat phase
- **Hilo Reduction** — opens during the reduction (peak demand) phase
- **Hilo Recovery** — opens during the recovery phase that follows a reduction

When a sensor opens, it can trigger HomeKit automations — for example, automatically disabling EV chargers during a reduction event.

> **Seasonal operation:** Hilo challenges run from December 1 to March 31. Outside that window the plugin checks the Hilo API once at startup (to confirm the login works) and then makes no API calls; the sensors stay closed.

## Logging in to Hilo

This plugin has **its own Hilo login**. It does not need, read or use the token of [homebridge-hilo](https://github.com/SanterreJo/homebridge-hilo), so the two plugins run side by side without interfering: Hilo rotates refresh tokens each time they are used, and two plugins sharing one token would eventually sign each other out.

1. Install the plugin and open its **settings** in the Homebridge UI.
2. Choose **Log in to Hilo** and sign in with your Hilo account in the window that opens.
3. After signing in you land on a **My Home Assistant** page that asks for a Home Assistant URL. That's expected: the Hilo app only allows that address as a login return page, and you don't need Home Assistant. **Don't type anything on that page and don't click Save.**
4. Instead, copy the **whole address from the browser's address bar** at the top of that window. It starts with `https://my.home-assistant.io/redirect/`. Paste it into the settings page and choose **Finish** within a few minutes, before the code expires.

No restart is needed: the plugin picks up the login at its next poll.

**Where the token lives.** The refresh token is stored in `<storage path>/hilo-challenge/auth.json` (e.g. `~/.homebridge/hilo-challenge/auth.json`), mode `0600`, never in `config.json`. Each time Hilo rotates it, the plugin writes the new one there straight away, so it survives restarts. If Hilo ever rejects it (for example after a password change), the plugin logs an error and leaves the sensors closed until you log in again from the settings page. **Log out** on the settings page deletes the file.

**Trade-off.** You log in to Hilo once more, separately from homebridge-hilo. In return, each plugin owns its own session and neither can break the other.

> **Upgrading from 0.1.x:** the `refreshToken` field is no longer used (it held a copy of homebridge-hilo's token). Remove it, and log in from the settings page as above.

## Requirements

- A [Hilo](https://www.hiloenergie.com) account with at least one enrolled device (thermostat or water heater)
- Homebridge v1.6.0 or later
- Node.js v20 or later

[homebridge-hilo](https://github.com/SanterreJo/homebridge-hilo) is a good companion (it puts your Hilo devices in HomeKit), but it is not required.

## Installation

Search for **Hilo Challenge** in the Homebridge UI, or install manually:

```bash
npm install -g homebridge-hilo-challenge
```

## Configuration

Configure via the Homebridge UI, or add to your `config.json`:

```json
{
  "platform": "HiloChallenge",
  "name": "Hilo Challenge",
  "pollInterval": 60
}
```

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `locationId` | ❌ | first location | Only needed if your Hilo account has several locations. The numeric location ID or the `urn:hilo:crm:…` URN, both shown in the log at startup. |
| `pollInterval` | ❌ | `60` | How often (in seconds) the phase is checked and the state file updated (30–300) |

The login is not part of `config.json`; see [Logging in to Hilo](#logging-in-to-hilo).

### Location

The plugin looks up your location with Hilo's `/Automation/v1/api/Locations` endpoint and uses the first one. The log shows which:

```
Using Hilo location 12345 (urn:hilo:crm:12345-abcde:0)
```

If your account has several locations, put the ID or URN of the one you want in `locationId`. An ID that isn't on the account is reported in the log along with the locations found.

## How It Works

The plugin reads Hilo's challenge events API (`/GDService/v1/api/Locations/{id}/Events`), the same source the [Home Assistant Hilo integration](https://github.com/dvd-dev/hilo) uses. Each challenge comes with explicit start and end times for its phases:

| Phase window from Hilo | Sensor |
|---|---|
| `preheatStartDateUTC` – `preheatEndDateUTC` | Hilo Preheat opens |
| `reductionStartDateUTC` – `reductionEndDateUTC` | Hilo Reduction opens |
| `recoveryStartDateUTC` – `recoveryEndDateUTC` | Hilo Recovery opens |
| outside all windows | all sensors closed |

The schedule is fetched at most every 5 minutes; at every poll the current phase is worked out from it, so sensors open and close on time even between fetches or while Hilo is briefly unreachable. Challenges you opted out of in the Hilo app, and completed or cancelled ones, are ignored.

## Automations

Use the **Hilo Reduction** sensor to automatically manage energy-intensive devices during peak demand:

- **When** Hilo Reduction sensor opens → **Turn off** EV charger(s), electric heaters, etc.
- **When** Hilo Reduction sensor closes → **Turn on** EV charger(s)

Pairs well with **[homebridge-grizzl-e](https://github.com/justinjsp/homebridge-grizzl-e)** for automatic EV charger control.

## For Other Plugins

Other plugins can follow the challenge without talking to Hilo themselves (for example, homebridge-ecoflow-delta3). This plugin keeps a small JSON file in the Homebridge storage directory:

```
<storage path>/hilo-challenge/state.json     (e.g. ~/.homebridge/hilo-challenge/state.json)
```

It is written at startup and after every poll (including off-season, when no API call is made) atomically (temp file + rename, so it is never half-written) with mode `0644`.

```json
{
  "version": 1,
  "updatedAt": "2026-01-15T21:05:00.000Z",
  "season": true,
  "phase": "reduction",
  "phaseSince": "2026-01-15T21:00:00.000Z",
  "pollIntervalSeconds": 60,
  "error": null
}
```

| Field | Description |
|---|---|
| `version` | Format version — currently `1`. Changes that break readers will bump it. |
| `updatedAt` | ISO 8601 UTC time of this write. If it is much older than `pollIntervalSeconds`, treat the data as stale (the plugin isn't running). |
| `season` | `true` from December 1 to March 31, when challenges can happen |
| `phase` | `none`, `preheat`, `reduction` or `recovery` |
| `phaseSince` | ISO time the current phase was first seen, or `null` when `phase` is `none` |
| `pollIntervalSeconds` | How often the file is refreshed |
| `error` | Message from the last attempt to reach Hilo if it failed (including "Not logged in to Hilo…"), otherwise `null`. While Hilo is unreachable, `phase` keeps following the last schedule fetched; if none was ever fetched, `phase` and `phaseSince` keep their last known values. |

## Issues & Support

Please open an issue on [GitHub](https://github.com/justinjsp/homebridge-hilo-challenge/issues).

## Disclaimer

This plugin is an independent, community-developed project and is **not affiliated with, endorsed by, or supported by Hilo or Hydro-Québec** in any way. Hilo™ is a trademark of Hilo Énergie, a subsidiary of Hydro-Québec. All product names and trademarks are the property of their respective owners.

This plugin is provided **as-is, without any warranty of any kind**, express or implied. Use it at your own risk. The authors accept no responsibility for any damage, data loss, or other issues arising from its use.
