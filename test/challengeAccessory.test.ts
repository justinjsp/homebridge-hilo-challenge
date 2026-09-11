import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { HAP, Logger, PlatformAccessory } from 'homebridge';
import { HiloChallengeSensorAccessory, SensorPhase } from '../src/challengeAccessory';
import { ChallengePhaseName } from '../src/hiloApi';

const CONTACT_DETECTED = 0; // closed
const CONTACT_NOT_DETECTED = 1; // open

// Just enough of HAP and PlatformAccessory for the sensor accessory — no HAP server.
function fakeSensor(phase: SensorPhase) {
  let getter: () => unknown = () => undefined;
  const updates: unknown[] = [];
  const service = {
    setCharacteristic: () => service,
    getCharacteristic: () => ({ onGet: (fn: () => unknown) => { getter = fn; } }),
    updateCharacteristic: (_c: unknown, value: unknown) => { updates.push(value); return service; },
  };
  const hap = {
    Service: { AccessoryInformation: 'info', ContactSensor: 'contact' },
    Characteristic: {
      Manufacturer: 'm', Model: 'mo', SerialNumber: 's', Name: 'n',
      ContactSensorState: { CONTACT_DETECTED, CONTACT_NOT_DETECTED },
    },
  } as unknown as HAP;
  const accessory = {
    displayName: `Hilo ${phase}`,
    getService: () => service,
    addService: () => service,
  } as unknown as PlatformAccessory;
  const log = { info: () => undefined } as unknown as Logger;
  const sensor = new HiloChallengeSensorAccessory(hap, log, accessory, phase);
  return { sensor, state: () => getter(), updates };
}

test('each sensor is open during its own phase only', () => {
  const phases: ChallengePhaseName[] = ['none', 'preheat', 'reduction', 'recovery'];
  for (const sensorPhase of ['preheat', 'reduction', 'recovery'] as const) {
    const { sensor, state } = fakeSensor(sensorPhase);
    assert.equal(state(), CONTACT_DETECTED, 'closed before the first poll');
    for (const current of phases) {
      sensor.updatePhase(current);
      assert.equal(state(), current === sensorPhase ? CONTACT_NOT_DETECTED : CONTACT_DETECTED,
        `${sensorPhase} sensor during ${current}`);
    }
  }
});

test('the recovery sensor pushes a HomeKit update only when it changes', () => {
  const { sensor, updates } = fakeSensor('recovery');
  sensor.updatePhase('reduction');
  sensor.updatePhase('recovery');
  sensor.updatePhase('recovery');
  sensor.updatePhase('none');
  assert.deepEqual(updates, [CONTACT_NOT_DETECTED, CONTACT_DETECTED]);
});
