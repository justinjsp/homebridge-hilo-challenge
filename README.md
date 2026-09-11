# homebridge-hilo-challenge

[![npm](https://img.shields.io/npm/v/homebridge-hilo-challenge)](https://www.npmjs.com/package/homebridge-hilo-challenge)
[![npm](https://img.shields.io/npm/dt/homebridge-hilo-challenge)](https://www.npmjs.com/package/homebridge-hilo-challenge)

A [Homebridge](https://homebridge.io) plugin that exposes [Hilo](https://www.hiloenergie.com) (Hydro-Québec) demand response challenge phases as **HomeKit contact sensors**.

Three sensors are created:
- **Hilo Preheat** — opens during the pre-heat phase
- **Hilo Reduction** — opens during the reduction (peak demand) phase
- **Hilo Recovery** — opens during the recovery phase that follows a reduction

When a sensor opens, it can trigger HomeKit automations — for example, automatically disabling EV chargers during a reduction event.

> **Seasonal operation:** The plugin only polls the Hilo API during challenge season (December 1 – March 31). Outside of that window it makes no API calls and the sensors remain inactive.

## ⚠️ Prerequisite: install `homebridge-hilo` first

This plugin **does not authenticate with Hilo on its own.** It reuses the refresh token obtained by the [**homebridge-hilo**](https://github.com/johannrichard/homebridge-hilo) plugin, and reads it **automatically** from your Homebridge `config.json` — nothing to copy.

**You must install and configure [homebridge-hilo](https://github.com/johannrichard/homebridge-hilo) before this plugin.** If it isn't already set up:

1. Install **homebridge-hilo** from the Homebridge UI and complete its login flow.
2. Confirm it's working (your Hilo devices appear in HomeKit).
3. Then install this plugin. It picks up homebridge-hilo's refresh token by itself (see [Refresh Token](#refresh-token) below).

Without a refresh token — from homebridge-hilo, or the optional fallback field — this plugin has nothing to authenticate with and will not register any sensors.

## Requirements

- A [Hilo](https://www.hiloenergie.com) account with at least one enrolled device (thermostat or water heater)
- The [homebridge-hilo](https://github.com/johannrichard/homebridge-hilo) plugin already installed and working (this plugin reuses its refresh token)
- Homebridge v1.6.0 or later
- Node.js v20 or later

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
  "locationId": "urn:hilo:crm:XXXXX-XXXXX:0",
  "pollInterval": 60
}
```

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `refreshToken` | ❌ | from homebridge-hilo | Fallback only — leave blank when homebridge-hilo is configured |
| `locationId` | ❌ | auto | Your Hilo location URN. Found in homebridge-hilo logs: `Subscribed to updates for location urn:hilo:crm:...` |
| `pollInterval` | ❌ | `60` | How often (in seconds) to poll during challenge season (30–300) |

### Refresh Token

homebridge-hilo rotates its refresh token and saves the new one back into `config.json`. Before every token refresh, this plugin reads the current token from the homebridge-hilo (`"platform": "Hilo"`) entry in `config.json`, so it never goes stale.

The `refreshToken` field is only a fallback — for example when homebridge-hilo isn't in the same Homebridge config. Tokens are tried in this order: homebridge-hilo's token, then the last token Hilo rotated to this plugin, then this plugin's `refreshToken` (the oldest, since it never changes). If one is rejected, the next is tried.

### Finding Your Location ID

If you leave `locationId` blank, the plugin will attempt to auto-discover it. If auto-discovery fails, you can find your location ID in the homebridge-hilo logs — look for a line like:

```
Subscribed to updates for location urn:hilo:crm:12345-abcde:0
```

Copy that full URN into the `locationId` field.

## How It Works

During challenge season (December–March), the plugin polls the Hilo GraphQL API every `pollInterval` seconds. It checks the `gDState` field on enrolled devices (thermostats, water heaters) to determine the current phase:

| `gDState` value | Sensor state |
|---|---|
| `PRE_HEAT` | Hilo Preheat opens |
| `ACTIVE` | Hilo Reduction opens |
| `RECOVERY` | Hilo Recovery opens |
| `OFF` / absent | all sensors closed |

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

It is written at startup and after every poll — including off-season, when no API call is made — atomically (temp file + rename, so it is never half-written) with mode `0644`.

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
| `error` | Message from the last poll if it failed, otherwise `null`. On a failed poll `phase` and `phaseSince` keep their last known values. |

## Issues & Support

Please open an issue on [GitHub](https://github.com/justinjsp/homebridge-hilo-challenge/issues).

## Disclaimer

This plugin is an independent, community-developed project and is **not affiliated with, endorsed by, or supported by Hilo or Hydro-Québec** in any way. Hilo™ is a trademark of Hilo Énergie, a subsidiary of Hydro-Québec. All product names and trademarks are the property of their respective owners.

This plugin is provided **as-is, without any warranty of any kind**, express or implied. Use it at your own risk. The authors accept no responsibility for any damage, data loss, or other issues arising from its use.
