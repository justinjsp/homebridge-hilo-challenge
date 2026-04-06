# homebridge-hilo-challenge

[![npm](https://img.shields.io/npm/v/homebridge-hilo-challenge)](https://www.npmjs.com/package/homebridge-hilo-challenge)
[![npm](https://img.shields.io/npm/dt/homebridge-hilo-challenge)](https://www.npmjs.com/package/homebridge-hilo-challenge)

A [Homebridge](https://homebridge.io) plugin that exposes [Hilo](https://www.hiloenergie.com) (Hydro-Québec) demand response challenge phases as **HomeKit contact sensors**.

Two sensors are created:
- **Hilo Preheat** — opens during the pre-heat phase
- **Hilo Reduction** — opens during the reduction (peak demand) phase

When a sensor opens, it can trigger HomeKit automations — for example, automatically disabling EV chargers during a reduction event.

> **Seasonal operation:** The plugin only polls the Hilo API during challenge season (December 1 – March 31). Outside of that window it makes no API calls and the sensors remain inactive.

## Requirements

- A [Hilo](https://www.hiloenergie.com) account with at least one enrolled device (thermostat or water heater)
- The [homebridge-hilo](https://github.com/johannrichard/homebridge-hilo) plugin already installed and working (this plugin reuses the same refresh token)
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
  "refreshToken": "your-hilo-refresh-token",
  "locationId": "urn:hilo:crm:XXXXX-XXXXX:0",
  "pollInterval": 60
}
```

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `refreshToken` | ✅ | — | Your Hilo refresh token — copy from your homebridge-hilo plugin config |
| `locationId` | ❌ | auto | Your Hilo location URN. Found in homebridge-hilo logs: `Subscribed to updates for location urn:hilo:crm:...` |
| `pollInterval` | ❌ | `60` | How often (in seconds) to poll during challenge season (30–300) |

### Getting Your Refresh Token

1. Open your Homebridge `config.json`
2. Find the `homebridge-hilo` platform entry
3. Copy the `refreshToken` value into this plugin's config

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
| `RECOVERY` | both sensors closed |
| `OFF` / absent | both sensors closed |

## Automations

Use the **Hilo Reduction** sensor to automatically manage energy-intensive devices during peak demand:

- **When** Hilo Reduction sensor opens → **Turn off** EV charger(s), electric heaters, etc.
- **When** Hilo Reduction sensor closes → **Turn on** EV charger(s)

Pairs well with **[homebridge-grizzl-e](https://github.com/justinjsp/homebridge-grizzl-e)** for automatic EV charger control.

## Issues & Support

Please open an issue on [GitHub](https://github.com/justinjsp/homebridge-hilo-challenge/issues).

## Disclaimer

This plugin is an independent, community-developed project and is **not affiliated with, endorsed by, or supported by Hilo or Hydro-Québec** in any way. Hilo™ is a trademark of Hilo Énergie, a subsidiary of Hydro-Québec. All product names and trademarks are the property of their respective owners.

This plugin is provided **as-is, without any warranty of any kind**, express or implied. Use it at your own risk. The authors accept no responsibility for any damage, data loss, or other issues arising from its use.
