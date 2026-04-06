import { API } from 'homebridge';
import { HiloChallengePlatform, PLATFORM_NAME } from './platform';

export = (api: API): void => {
  api.registerPlatform(PLATFORM_NAME, HiloChallengePlatform);
};
