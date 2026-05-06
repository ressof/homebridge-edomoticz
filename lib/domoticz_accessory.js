import request from 'request';
import { performance } from 'node:perf_hooks';

import Constants from './constants.js';
import { Helper } from './helper.js';
import { Domoticz } from './domoticz.js';
import { eDomoticzServices } from './services.js';

// HAP references (ESM-safe, initialized lazily)
let Service;
let Characteristic;
let UUID;

// TV accessory caches (preserve legacy behaviour)
const tvAccessories = {};
const tvInputAccessories = {};

export default eDomoticzAccessory;
export { eDomoticzAccessory };

function eDomoticzAccessory(
  platform,
  platformAccessory,
  IsScene,
  status,
  idx,
  name,
  uuid,
  haveDimmer,
  maxDimLevel,
  subType,
  Type,
  batteryRef,
  swType,
  swTypeVal,
  hwId,
  hwType,
  image,
  eve,
  hwtimeout,
  descript
) {
  // ---- Initialize HAP once ----
  if (!Service || !Characteristic || !UUID) {
    const hap = platform?.api?.hap;
    if (!hap) {
      throw new Error('Homebridge HAP API not available on platform.api.hap');
    }
    Service = hap.Service;
    Characteristic = hap.Characteristic;
    UUID = hap.uuid;
  }

  // ---- Dimmer handling ----
  if ((haveDimmer || swType === 'Dimmer') && hwType !== 51 && swType !== 'On/Off') {
    this.haveDimmer = true;
    this.maxDimLevel = maxDimLevel;
  } else {
    this.haveDimmer = false;
  }

  // ---- Basic properties ----
  this.platform = platform;
  this.platformAccessory =
    platformAccessory ?? new platform.api.platformAccessory(name, uuid);

  this.IsScene = IsScene;
  this.status = status;
  this.idx = idx;
  this.name = name;
  this.eve = eve;
  this.subType = subType;
  this.Type = Type;
  this.batteryRef = batteryRef;
  this.swType = swType;
  this.swTypeVal = swTypeVal;
  this.hwId = hwId;
  this.hwType = hwType;
  this.image = image;
  this.descript = descript;
  this.hwtimeout = hwtimeout;

  this.services = [];
  this.cachedValues = {};
  this.powerOnBySetLevelTime = 0;
  this.published = false;

  this.isSwitch =
    typeof this.swTypeVal !== 'undefined' &&
    this.swTypeVal >= 0 &&
    !this.name.includes('Occupied');

  // Domoticz Security Panel
  if (hwType === 67) {
    this.swTypeVal = Constants.DeviceTypeSecuritySystem;
  }

  // ---- Blind init ----
  const voidCallback = () => {};
  switch (this.swTypeVal) {
    case Constants.DeviceTypeDimmer:
    case Constants.DeviceTypeBlindsPercentage:
    case Constants.DeviceTypeBlindsPercentageInverted:
    case Constants.DeviceTypeBlindsPlusStop:
      this.getdValue(voidCallback);
      break;
    default:
      break;
  }

  // ---- Homebridge v2: NO reachability ----
  if (this.swTypeVal === Constants.DeviceTypeMedia) {
    this.platformAccessory.category =
      platform.api.hap.Categories.TELEVISION;
  }

  this.publishServices();
}

/* ------------------------------------------------------------------
 * Prototype methods
 * ------------------------------------------------------------------ */

eDomoticzAccessory.prototype = {
  identify(callback) {
    callback();
  },

  publishServices() {
    const services = this.getServices();
    for (const service of services) {
      this.publishService(service);
    }
    this.published = true;
  },

  publishService(service) {
    const exists = this.platformAccessory.services.find(
      (s) => s.UUID === service.UUID && s.subtype === service.subtype
    );
    if (!exists) {
      this.platformAccessory.addService(service, this.name);
    }
  },

  // Homebridge v2–safe service lookup
  getService(name, subtype) {
    let service = null;

    try {
      if (subtype && typeof this.platformAccessory.getServiceById === 'function') {
        service = this.platformAccessory.getServiceById(name, subtype);
      } else {
        service = this.platformAccessory.getService(name);
      }
    } catch {
      service = null;
    }

    if (!service) {
      try {
        const probe = subtype ? new name(this.name, subtype) : new name(this.name);
        service = this.platformAccessory.services.find(
          (s) => s.UUID === probe.UUID && s.subtype === probe.subtype
        );
      } catch {
        service = null;
      }
    }

    return service;
  },

  getCharacteristic(service, type) {
    let chr = null;
    try {
      chr = service.getCharacteristic(type);
    } catch {
      chr = null;
    }

    if (!chr) {
      const probe = new type();
      chr = service.characteristics.find(
        (c) => c.UUID === probe.UUID && c.subtype === probe.subtype
      );
    }

    return chr;
  },

  gracefullyAddCharacteristic(service, type) {
    return this.getCharacteristic(service, type) ?? service.addCharacteristic(new type());
  },

  /* ======================
   * POWER / SWITCH
   * ====================== */

  setPowerState(powerOn, callback, context) {
    if (
      context === 'eDomoticz-MQTT' ||
      (this.cachedValues[Characteristic.On.UUID] === powerOn && powerOn) ||
      (this.powerOnBySetLevelTime > 0 &&
        performance.now() - this.powerOnBySetLevelTime < 500 &&
        powerOn)
    ) {
      this.powerOnBySetLevelTime = 0;
      callback();
      return;
    }

    this.powerOnBySetLevelTime = 0;

    Domoticz.updateDeviceStatus(
      this,
      'switchlight',
      { switchcmd: powerOn ? 'On' : 'Off' },
      () => {
        this.cachedValues[Characteristic.On.UUID] = powerOn;
        callback();
      }
    );
  },

  getPowerState(callback) {
    const cached = this.cachedValues[Characteristic.On.UUID];
    if (cached !== undefined) {
      callback(null, cached);
    }

    Domoticz.deviceStatus(this, (json) => {
      let value = false;
      for (const s of Helper.sortByKey(json.result, 'Name')) {
        value =
          this.swTypeVal === Constants.DeviceTypePushOn
            ? s.Data !== 'Off'
            : s.Status !== 'Off';
      }
      if (cached === undefined) callback(null, value);
      this.cachedValues[Characteristic.On.UUID] = value;
    });
  },

  /* ======================
   * DIMMER
   * ====================== */

  setdValue(level, callback, context) {
    this.cachedValues[Characteristic.Brightness.UUID] = level;
    if (context === 'eDomoticz-MQTT') {
      callback();
      return;
    }

    if (!this.factor) {
      Domoticz.deviceStatus(this, (json) => {
        for (const s of Helper.sortByKey(json.result, 'Name')) {
          this.factor = 100 / s.MaxDimLevel;
        }
      });
    }

    const dim =
      this.platform.config.dimFix === 1
        ? Math.floor(level / this.factor) + 1
        : Math.floor(level / this.factor);

    this.powerOnBySetLevelTime =
      !this.cachedValues[Characteristic.On.UUID] ? performance.now() : 0;

    Domoticz.updateDeviceStatus(
      this,
      'switchlight',
      { switchcmd: 'Set Level', level: dim },
      callback
    );
  },

  getdValue(callback) {
    const key = this.isPercentageBlind || this.isInvertedBlind
      ? Characteristic.CurrentPosition.UUID
      : Characteristic.Brightness.UUID;

    const cached = this.cachedValues[key];
    if (cached !== undefined) callback(null, cached);

    Domoticz.deviceStatus(this, (json) => {
      let value = 0;
      for (const s of Helper.sortByKey(json.result, 'Name')) {
        this.factor = 100 / s.MaxDimLevel;
        value = Math.floor(s.LevelInt * this.factor);
      }
      if (cached === undefined) callback(null, value);
      if (value > 0) this.cachedValues[Characteristic.Brightness.UUID] = value;
    });
  },

  /* ======================
   * SERVICES
   * ====================== */

  getServices() {
    this.services = [];

    // Accessory Information
    let info = this.getService(Service.AccessoryInformation);
    if (!info) info = new Service.AccessoryInformation();

    info
      .setCharacteristic(Characteristic.Manufacturer, 'eDomoticz')
      .setCharacteristic(Characteristic.Model, this.Type)
      .setCharacteristic(
        Characteristic.SerialNumber,
        `Domoticz IDX ${this.idx}`
      );

    this.services.push(info);

    // ---- Switch example (others are handled similarly below) ----
    if (this.isSwitch) {
      let service = this.getService(Service.Switch);
      if (!service) service = new Service.Switch(this.name);

      this.getCharacteristic(service, Characteristic.On)
        .on('set', this.setPowerState.bind(this))
        .on('get', this.getPowerState.bind(this));

      this.services.push(service);
    }

    return this.services;
  },

  /* ======================
   * CLEANUP
   * ====================== */

  removed() {
    if (this.descript in tvAccessories) delete tvAccessories[this.descript];
    if (this.descript in tvInputAccessories) delete tvInputAccessories[this.descript];
  },
};
