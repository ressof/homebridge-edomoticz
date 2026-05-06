import request from 'request';
import { _extend as extend } from 'node:util';

import { Helper } from './helper.js';

let baseHttpRequest = null;

class Domoticz {
  static initialize(useSSL, requestHeaders = {}) {
    const defaultRequestOptions = { headers: requestHeaders, json: true };

    if (useSSL) {
      defaultRequestOptions.agentOptions = { rejectUnauthorized: false };
    }

    baseHttpRequest = request.defaults(defaultRequestOptions);
  }

  static settings(accessory, completion, error) {
    if (!baseHttpRequest) return;

    const url = `${accessory.platform.apiBaseURL}type=command&param=getsettings`;

    baseHttpRequest.get({ url }, function (err, response, json) {
      if (!err && response?.statusCode === 200 && json !== undefined) {
        if (completion) completion(json);
      } else {
        Helper.LogConnectionError(accessory.platform, response, err);
        if (error) error(response, err);
      }
    });
  }

  static devices(baseURL, roomID, completion, error) {
    if (!baseHttpRequest) return;

    let url = `${baseURL}type=command&param=getdevices&used=true&order=Name`;
    if (roomID) url += `&plan=${roomID}`;

    baseHttpRequest.get({ url }, function (err, response, json) {
      if (!err && response?.statusCode === 200) {
        const devices = [];

        if (json?.result === undefined) {
          if (completion) completion(devices);
          return;
        }

        const sArray = Helper.sortByKey(json.result, 'Name');
        sArray.forEach((s) => devices.push(s));

        if (completion) completion(devices);
      } else {
        if (error) error(response, err);
      }
    });
  }

  static hardware(baseURL, completion, error) {
    if (!baseHttpRequest) return;

    const url = `${baseURL}type=command&param=gethardware`;

    baseHttpRequest.get({ url }, function (err, response, json) {
      if (!err && response?.statusCode === 200 && json?.result !== undefined) {
        const hardware = [];
        const sArray = Helper.sortByKey(json.result, 'Name');
        sArray.forEach((s) => hardware.push(s));

        if (completion) completion(hardware);
      } else {
        if (error) error(response, err);
      }
    });
  }

  static deviceStatus(accessory, completion, error) {
    if (!baseHttpRequest) return;

    const url = `${accessory.platform.apiBaseURL}type=command&param=getdevices&rid=${accessory.idx}`;

    baseHttpRequest.get({ url }, function (err, response, json) {
      if (!err && response?.statusCode === 200 && json !== undefined) {
        if (!json.result) {
          accessory.platform.forceLog(
            `Could not fetch data for ${accessory.name}. (Device might have been removed?)`
          );

          if (error) error(response, err);

          // Powerstate failed.. Device has probably been removed. Trigger a sync.
          if (accessory?.platform) {
            accessory.platform.synchronizeAccessories();
          }
          return;
        }

        accessory.platform.log(`Data received for ${accessory.name}.`);
        if (completion) completion(json);
      } else {
        Helper.LogConnectionError(accessory.platform, response, err);
        if (error) error(response, err);
      }
    });
  }

  static updateDeviceStatus(accessory, command, parameters = {}, completion) {
    // MQTT optimization path
    if (accessory.platform.mqtt && Domoticz.isMQTTSupportedCommand(command, parameters)) {
      const message = { command, idx: parseInt(accessory.idx, 10) };
      extend(message, parameters);
      accessory.platform.mqtt.send(message);

      if (completion) completion(true);
      return;
    }

    let url =
      `${accessory.platform.apiBaseURL}type=command&param=` +
      `${encodeURI(command)}&idx=${accessory.idx}`;

    for (const key in parameters) {
      url += `&${encodeURI(key)}=${encodeURI(parameters[key])}`;
    }

    Domoticz.updateWithURL(accessory, url, completion);
  }

  static updateWithURL(accessory, url, completion) {
    if (!baseHttpRequest) return;

    baseHttpRequest.put({ url, json: true }, function (err, response) {
      const success = !err;

      if (success) {
        accessory.platform.log(`${accessory.name} sent command succesfully.`);
      } else {
        Helper.LogConnectionError(accessory.platform, response, err);
      }

      if (completion) completion(success);
    });
  }

  static isMQTTSupportedCommand(command /*, parameters */) {
    if (command === 'setcolbrightnessvalue' || command === 'setkelvinlevel' || command === 'kodimediacommand') {
      return false;
    }
    return true;
  }
}

export { Domoticz };
export default Domoticz;
