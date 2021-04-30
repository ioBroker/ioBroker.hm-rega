/*
 *
 * Copyright (c) 2014-2019 bluefox <dogafox@gmail.com>
 *
 * Copyright (c) 2014 hobbyquaker
 *
 * The MIT License (MIT)
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 */
/* jshint -W097 */
/* jshint strict: false */
/* jslint node: true */
'use strict';
const utils = require('@iobroker/adapter-core');
const words = require('./lib/enumNames');
const crypto = require(`${__dirname}/lib/crypto`); // get cryptography functions
const Rega = require(`${__dirname}/lib/rega`);
const helper = require(`${__dirname}/lib/utils`);
const fs = require('fs');

const adapterName = require('./package.json').name.split('.').pop();
let afterReconnect = null;
const FORBIDDEN_CHARS = /[\][*,;'"`<>\\?]/g;
const HM_RPC_REGEX = new RegExp('^hm-rpc[.]\\d+[.]+.+');
let adapter;

function startAdapter(options) {
    options = options || {};

    Object.assign(options, {

        name: adapterName,

        stateChange: async (id, state) => {
            if (!state || state.ack) {
                if (state && id === pollingTrigger) {
                    adapter.log.info('pollingTrigger');
                    if (adapter.config.syncVariables) {
                        pollVariables();
                    }
                }
            } else if (id.match(/_ALARM$/)) {
                setTimeout(acknowledgeAlarm, 100, id);
            } else if (id === `${adapter.config.rfdAdapter}.updated` ||
                id === `${adapter.config.virtualDevicesAdapter}.updated` ||
                id === `${adapter.config.cuxdAdapter}.updated` ||
                id === `${adapter.config.hmipAdapter}.updated` ||
                id === `${adapter.config.hs485dAdapter}.updated`) {
                // Read devices anew if hm-rpc updated the list of devices
                if (state.val) {
                    setTimeout(() => getDevices(), 1000);
                    try {
                        // Reset flag
                        await adapter.setForeignStateAsync(id, false, true);
                    } catch {
                        // ignore
                    }
                }
            } else if (id === `${adapter.config.rfdAdapter}.info.connection` ||
                id === `${adapter.config.virtualDevicesAdapter}.info.connection` ||
                id === `${adapter.config.cuxdAdapter}.info.connection` ||
                id === `${adapter.config.hmipAdapter}.info.connection` ||
                id === `${adapter.config.hs485dAdapter}.info.connection`) {
                if (state.val) {
                    if (!afterReconnect) {
                        adapter.log.debug(`Connection of "${id}" detected. Read variables anew in 60 seconds`);
                        afterReconnect = setTimeout(() => {
                            afterReconnect = null;
                            if (adapter.config.syncVariables) {
                                getVariables();
                            }
                        }, 60000);
                    }
                } else {
                    if (afterReconnect) {
                        adapter.log.debug(`Disconnection of "${id}" detected. Cancel read of variables`);
                        clearTimeout(afterReconnect);
                        afterReconnect = null;
                    }
                }
            } else {
                adapter.log.debug(`stateChange ${id} ${JSON.stringify(state)}`);

                const rid = id.split('.');
                if (rid[3] === 'ProgramExecute') {
                    if (state.val) {
                        adapter.log.debug(`ProgramExecute ${rid[2]}`);
                        states[id] = {ack: false};
                        rega.script(`dom.GetObject(${rid[2]}).ProgramExecute();`);
                    }
                } else if (rid[3] === 'Active') {
                    adapter.log.debug(`Active ${rid[2]} ${state.val}`);
                    states[id] = {ack: false};
                    rega.script(`dom.GetObject(${rid[2]}).Active(${JSON.stringify(state.val)})`);
                } else {
                    if (rid[2] === 'alarms') {
                        rid[2] = 40;
                    }
                    if (rid[2] === 'maintenance') {
                        rid[2] = 41;
                    }

                    if (!states[id] && id !== pollingTrigger) {
                        if (!id.match(/\.updated$/)) {
                            adapter.log.warn(`Got unexpected ID: ${id}`);
                        }
                        return;
                    }

                    adapter.log.debug(`Set state ${rid[2]}: ${state.val}`);
                    states[id] = {ack: false};
                    rega.script(`dom.GetObject(${rid[2]}).State(${JSON.stringify(state.val)})`);
                }
            }
        },

        unload: stop,

        message: obj => {
            adapter.log.debug(`[MSSG] Received: ${JSON.stringify(obj)}`);
            if (ccuRegaUp) {
                rega.script(obj.message, data => {
                    adapter.sendTo(obj.from, obj.command, {result: data, error: null}, obj.callback);
                });
            } else {
                adapter.sendTo(obj.from, obj.command, {result: null, error: 'Not connected'}, obj.callback);
            } // endElse
        },

        ready: async () => {
            if (adapter.config.useHttps) {
                // if https, then we need auth data
                try {
                    const obj = await adapter.getForeignObjectAsync('system.config');

                    if (obj && obj.native && obj.native.secret) {
                        adapter.config.password = crypto.decrypt(obj.native.secret, adapter.config.password);
                        adapter.config.username = crypto.decrypt(obj.native.secret, adapter.config.username);
                    } else {
                        adapter.config.password = crypto.decrypt('Zgfr56gFe87jJOM', adapter.config.password);
                        adapter.config.username = crypto.decrypt('Zgfr56gFe87jJOM', adapter.config.username);
                    } // endElse
                } catch (e) {
                    adapter.log.warn(`Could not decrypt credentials: ${e}`);
                }
            } // endIf

            try {
                // update script files if necessary - first ensure meta object is there
                await adapter.setForeignObjectNotExistsAsync('hm-rega', {
                    type: 'meta',
                    common: {
                        name: 'hm-rega'
                    }
                });

                // read all files
                const regascripts = fs.readdirSync(`${__dirname}/regascripts/`);
                for (const regascript of regascripts) {
                    const sourceFile = fs.readFileSync(`${__dirname}/regascripts/${regascript}`, 'utf-8');
                    let targetFile;
                    try {
                        targetFile = await adapter.readFileAsync('hm-rega', `regascripts/${regascript}`, 'utf-8');
                    } catch (e) {
                        adapter.log.debug(`[REGASCRIPTS] Script ${regascript} does not exist in file storage yet`);
                    }

                    if (!targetFile || targetFile.file !== sourceFile) {
                        // update file storage
                        await adapter.writeFileAsync('hm-rega', `regascripts/${regascript}`, sourceFile, 'utf-8');
                        adapter.log.info(`[REGASCRIPTS] Successfully updated ${regascript}`);
                    } else {
                        adapter.log.debug(`[REGASCRIPTS] Script ${regascript} is already up-to-date`);
                    }
                } // endFor
            } catch (e) {
                adapter.log.warn(`[REGASCRIPTS] Error updating scripts: ${e}`);
            }

            main();
        }
    });

    adapter = new utils.Adapter(options);

    return adapter;
} // endStartAdapter

let rega;
let ccuReachable;
let ccuRegaUp;
let pollingInterval;
let pollingIntervalDC;
let pollingTrigger;
const checkInterval = {};
let units = {};
const states = {};
const objects = {};
let existingStates = [];

function _unescape(text) {
    if (typeof text !== 'string') {
        return text;
    }
    if (!text) {
        return '';
    }
    for (const char of helper.chars) {
        text = text.replace(char.regex, char.replace);
    }
    try {
        return decodeURI(text);
    } catch (err) {
        adapter.log.error(`Cannot decode :${text}`);
        return text;
    }
}

function checkInit(id) {
    adapter.getForeignObject(`system.adapter.${id}`, (err, obj) => {
        if (obj && obj.native && obj.native.checkInit && obj.native.checkInitTrigger) {
            const interval = parseInt(obj.native.checkInitInterval, 10);

            // Fix error in config
            if (obj.native.checkInitTrigger === 'BidCos-RF:50.PRESS_LONG') {
                obj.native.checkInitTrigger = 'BidCos-RF.BidCoS-RF:50.PRESS_LONG';
            }

            const _id = obj.native.checkInitTrigger;
            if (!checkInterval[id]) {
                checkInterval[id] = setInterval(() => {
                    if (rega) {
                        //BidCos-RF.BidCoS-RF:50.PRESS_LONG
                        adapter.log.debug(`Set check init state ${_id} to true`);
                        rega.script(`dom.GetObject("${_id}").State(1);`);
                    }
                }, interval * 500);
            }
        }
    });
}

function main() {
    adapter.config.reconnectionInterval = parseInt(adapter.config.reconnectionInterval, 10) || 30;

    if (adapter.config.pollingTrigger) {
        adapter.config.pollingTrigger = adapter.config.pollingTrigger.replace(':', '.').replace(FORBIDDEN_CHARS, '_');
        if (adapter.config.pollingTrigger.match(/^BidCoS-RF/)) {
            pollingTrigger = `${adapter.config.rfdAdapter}.${adapter.config.pollingTrigger}`;
        } else {
            pollingTrigger = `${adapter.config.hs485dAdapter}.${adapter.config.pollingTrigger}`;
        }
        adapter.log.info(`subscribe ${pollingTrigger}`);
        adapter.subscribeForeignStates(pollingTrigger);
    }

    adapter.subscribeStates('*');

    if (adapter.config.rfdAdapter && adapter.config.rfdEnabled) {
        adapter.subscribeForeignStates(`${adapter.config.rfdAdapter}.updated`);
        adapter.subscribeForeignStates(`${adapter.config.rfdAdapter}.info.connection`);
        adapter.subscribeForeignStates(`${adapter.config.rfdAdapter}.*_ALARM`);
        checkInit(adapter.config.rfdAdapter);
    }
    if (adapter.config.cuxdAdapter && adapter.config.cuxdEnabled) {
        adapter.subscribeForeignStates(`${adapter.config.cuxdAdapter}.updated`);
        adapter.subscribeForeignStates(`${adapter.config.cuxdAdapter}.info.connection`);
        adapter.subscribeForeignStates(`${adapter.config.cuxdAdapter}.*_ALARM`);
        checkInit(adapter.config.rfdAdapter);
    }
    if (adapter.config.hmipAdapter && adapter.config.hmipEnabled) {
        adapter.subscribeForeignStates(`${adapter.config.hmipAdapter}.updated`);
        adapter.subscribeForeignStates(`${adapter.config.hmipAdapter}.info.connection`);
        adapter.subscribeForeignStates(`${adapter.config.hmipAdapter}.*_ALARM`);
        checkInit(adapter.config.rfdAdapter);
    }
    if (adapter.config.hs485dAdapter && adapter.config.hs485dEnabled) {
        adapter.subscribeForeignStates(`${adapter.config.hs485dAdapter}.updated`);
        adapter.subscribeForeignStates(`${adapter.config.hs485dAdapter}.info.connection`);
        adapter.subscribeForeignStates(`${adapter.config.hs485dAdapter}.*_ALARM`);
        checkInit(adapter.config.rfdAdapter);
    }
    if (adapter.config.virtualDevicesAdapter && adapter.config.virtualDevicesEnabled) {
        adapter.subscribeForeignStates(`${adapter.config.virtualDevicesAdapter}.updated`);
        adapter.subscribeForeignStates(`${adapter.config.virtualDevicesAdapter}.info.connection`);
        adapter.subscribeForeignStates(`${adapter.config.virtualDevicesAdapter}.*_ALARM`);
        checkInit(adapter.config.rfdAdapter);
    }
    // if port is default, we can assume that ssl port is default too
    if (adapter.config.useHttps && (!adapter.config.homematicPort || adapter.config.homematicPort === 8181)) {
        adapter.config.homematicPort = 48181;
    } // endIf

    rega = new Rega({
        ccuIp: adapter.config.homematicAddress,
        webinterfacePort: adapter.config.webinterfacePort || (adapter.config.useHttps ? 443 : 80),
        port: adapter.config.homematicPort,
        reconnectionInterval: adapter.config.reconnectionInterval,
        logger: adapter.log,
        readFileAsync: adapter.readFileAsync,
        secure: adapter.config.useHttps,
        username: adapter.config.username,
        password: adapter.config.password,

        ready: async err => {

            if (err === 'ReGaHSS down') {
                adapter.log.error(`ReGaHSS ${adapter.config.homematicAddress} down`);
                ccuReachable = true;
                ccuRegaUp = false;
                try {
                    await adapter.setStateAsync('info.connection', false, true);
                    await adapter.setStateAsync('info.ccuReachable', ccuReachable, true);
                    await adapter.setStateAsync('info.ccuRegaUp', ccuRegaUp, true);
                } catch {
                    // ignore
                }

            } else if (err === 'CCU unreachable') {
                adapter.log.error(`CCU ${adapter.config.homematicAddress} unreachable`);
                ccuReachable = false;
                ccuRegaUp = false;
                try {
                    await adapter.setStateAsync('info.connection', false, true);
                    await adapter.setStateAsync('info.ccuReachable', ccuReachable, true);
                    await adapter.setStateAsync('info.ccuRegaUp', ccuRegaUp, true);
                } catch {
                    // ignore
                }
            } else if (err) {
                adapter.log.error(err);
                ccuReachable = false;
                ccuRegaUp = false;
                try {
                    await adapter.setStateAsync('info.connection', false, true);
                    await adapter.setStateAsync('info.ccuReachable', ccuReachable, true);
                    await adapter.setStateAsync('info.ccuRegaUp', ccuRegaUp, true);
                } catch {
                    // ignore
                }
            } else {
                adapter.log.info(`ReGaHSS ${adapter.config.homematicAddress} up`);
                ccuReachable = true;
                ccuRegaUp = true;
                try {
                    await adapter.setStateAsync('info.connection', true, true);
                    await adapter.setStateAsync('info.ccuReachable', ccuReachable, true);
                    await adapter.setStateAsync('info.ccuRegaUp', ccuRegaUp, true);
                } catch {
                    // ignore
                }

                await rega.checkTime();

                if (adapter.config.syncVariables) {
                    await getServiceMsgs();
                }

                // get Devices before datapoints to know which states exist
                await getDevices();
                await getDatapoints();

                if (adapter.config.syncDutyCycle) {
                    await getDutyCycle();
                }

                if (adapter.config.syncVariables) {
                    await getVariables();
                }

                if (adapter.config.syncPrograms) {
                    await getPrograms();
                }

                if (adapter.config.syncRooms && adapter.config.enumRooms) {
                    await getRooms();
                }

                if (adapter.config.syncFunctions && adapter.config.enumFunctions) {
                    await getFunctions();
                }

                if (adapter.config.syncFavorites && adapter.config.enumFavorites) {
                    await getFavorites();
                }
            }

        }
    });
}

/**
 * poll all variables (invisible too, if configured) and set them to their according states
 *
 * @returns {Promise<void>}
 */
async function pollVariables() {
    let data = await rega.runScriptFile(adapter.config.showInvSysVar ? 'pollingInv' : 'polling');
    if (!data) {
        return;
    }

    try {
        // CCU sometimes uses -inf or nan, we should handle them as null
        data = JSON.parse(data.replace(/\n/gm, '').replace(/-inf|nan/g, null));
    } catch (e) {
        adapter.log.error(`Cannot parse answer for polling: ${data}`);
        return;
    }
    for (let id of Object.keys(data)) {
        let val = data[id][0];
        const timestamp = new Date(data[id][1]).getTime();

        if (typeof val === 'string') {
            val = _unescape(val);
        }

        id = _unescape(id).replace(FORBIDDEN_CHARS, '_');

        if (id === '40') {
            id = 'alarms';
        } else if (id === '41') {
            // If number of alarms changed
            id = 'maintenance';
        }
        const fullId = `${adapter.namespace}.${id}`;

        if ((id === 'maintenance') && (!states[fullId] || states[fullId].val !== val)) {
            setTimeout(pollServiceMsgs, 1000);
        }

        if (!objects[fullId]) {
            adapter.log.info(`Variable received for not-known dp ${id}, requesting Variables`);
            await getVariables();
            return;
        }

        if (!states[fullId] || !states[fullId].ack || states[fullId].val !== val || (states[fullId].ts && states[fullId].ts !== timestamp)) {
            states[fullId] = {val: val, ack: true, ts: timestamp};
            try {
                await adapter.setForeignStateAsync(fullId, val, true);
            } catch {
                // ignore
            }
        }
    }
}

/**
 * polls duty cycle, firmware version, rega versions, device/channel/dp counters and sets according states
 *
 * @returns {Promise<void>}
 */
async function pollDutyCycle() {
    let data = await rega.runScriptFile('dutycycle');
    let sysInfo = await rega.runScriptFile('system');
    if (!data) {
        return;
    }

    try {
        sysInfo = JSON.parse(sysInfo);
    } catch (e) {
        adapter.log.error(`Cannot parse system info: ${sysInfo}`);
        return;
    } // endTryCatch

    const ccuType = `CCU${typeof sysInfo.ccuVersion === 'string' ? sysInfo.ccuVersion.split('.')[0] : ''}`;

    try {
        data = JSON.parse(convertDataToJSONArray(data));
    } catch (e) {
        adapter.log.error(`Cannot parse answer for dutycycle: ${data}`);
        return;
    }

    let id;
    for (const dp of data) {
        id = _unescape(dp.ADDRESS).replace(FORBIDDEN_CHARS, '_');

        // DUTY_CYCLE State:
        if (dp.DUTY_CYCLE) {
            updateNewState(`${adapter.namespace}.${id}.0.DUTY_CYCLE`, parseInt(dp.DUTY_CYCLE));
            adapter.log.debug(`Dutycycle: ${adapter.namespace}.${id}.0.DUTY_CYCLE => ${parseInt(dp.DUTY_CYCLE)}`);
        }

        // CONNECTED State:
        if (dp.CONNECTED) {
            updateNewState(`${adapter.namespace}.${id}.0.CONNECTED`, dp.CONNECTED);
            adapter.log.debug(`Dutycycle: ${adapter.namespace}.${id}.0.CONNECTED => ${dp.CONNECTED}`);
        }

        // DEFAULT State:
        if (dp.DEFAULT) {
            updateNewState(`${adapter.namespace}.${id}.0.DEFAULT`, dp.DEFAULT);
            adapter.log.debug(`Dutycycle: ${adapter.namespace}.${id}.0.DEFAULT => ${dp.DEFAULT}`);
        }

        // FIRMWARE_VERSION State:
        if (sysInfo.ccuVersion) {
            updateNewState(`${adapter.namespace}.${id}.0.FIRMWARE_VERSION`, sysInfo.ccuVersion);
            adapter.log.debug(`Dutycycle: ${adapter.namespace}.${id}.0.FIRMWARE_VERSION => ${sysInfo.ccuVersion}`);
        }

        // Rega Version
        if (sysInfo.regaVersion) {
            updateNewState(`${adapter.namespace}.${id}.0.regaVersion`, sysInfo.regaVersion);
            adapter.log.debug(`Rega Version: ${adapter.namespace}.${id}.0.regaVersion => ${sysInfo.regaVersion}`);
        }

        // Build Label Rega
        if (sysInfo.buildLabel) {
            updateNewState(`${adapter.namespace}.${id}.0.buildLabel`, sysInfo.buildLabel);
            adapter.log.debug(`Build Label: ${adapter.namespace}.${id}.0.buildLabel => ${sysInfo.buildLabel}`);
        }

        // Count Devices
        if (sysInfo.countDevices) {
            updateNewState(`${adapter.namespace}.${id}.0.countDevices`, sysInfo.countDevices);
            adapter.log.debug(`Count Devices: ${adapter.namespace}.${id}.0.countDevices => ${sysInfo.countDevices}`);
        }

        // Count Channels
        if (sysInfo.countChannels) {
            updateNewState(`${adapter.namespace}.${id}.0.countChannels`, sysInfo.countChannels);
            adapter.log.debug(`Count Channels: ${adapter.namespace}.${id}.0.countChannels => ${sysInfo.countChannels}`);
        }

        // Count Datapoints
        if (sysInfo.countDatapoints) {
            updateNewState(`${adapter.namespace}.${id}.0.countDatapoints`, sysInfo.countDatapoints);
            adapter.log.debug(`Count Datapoints: ${adapter.namespace}.${id}.0.countDatapoints => ${sysInfo.countDatapoints}`);
        }

        // Count Programs
        if (sysInfo.countPrograms) {
            updateNewState(`${adapter.namespace}.${id}.0.countPrograms`, sysInfo.countPrograms);
            adapter.log.debug(`Count Programs: ${adapter.namespace}.${id}.0.countPrograms => ${sysInfo.countPrograms}`);
        }

        // Count System Variables
        if (sysInfo.countSystemVars) {
            updateNewState(`${adapter.namespace}.${id}.0.countSystemVariables`, sysInfo.countSystemVars);
            adapter.log.debug(`Count System variables: ${adapter.namespace}.${id}.0.countSystemVariables => ${sysInfo.countSystemVars}`);
        }

        // CCU-Type - User can update e. g. Raspmatic w/o restarting adapter
        const obj = {
            _id: `${adapter.namespace}.${id}`,
            type: 'device',
            common: {
                name: ccuType
            },
            native: {
                ADDRESS: _unescape(dp.ADDRESS),
                TYPE: ccuType
            }
        };

        const _obj = await adapter.getObjectAsync(obj._id);
        if (!_obj || !_obj.common || (obj.common.name !== _obj.common.name)) {
            adapter.extendForeignObject(obj._id, obj);
        }
    }
} // endPollDutyCycle

/**
 * poll programs from CCU and set their according enabled/activated states
 *
 * @returns {Promise<void>}
 */
async function pollPrograms() {
    let data = await rega.runScriptFile('programs');
    if (!data) {
        return;
    }
    try {
        data = JSON.parse(data.replace(/\n/gm, ''));
    } catch (e) {
        adapter.log.error(`Cannot parse answer for programs: ${data}`);
        return;
    }
    for (const dp of Object.keys(data)) {
        const id = _unescape(dp).replace(FORBIDDEN_CHARS, '_');
        const val = data[dp].Active;

        const fullId = `${adapter.namespace}.${id}.Active`;

        if (!objects[fullId]) {
            adapter.log.info(`Program received for not-known dp ${id}, requesting programs`);
            await getPrograms();
            return;
        }

        if (!states[fullId] ||
                !states[fullId].ack ||
                states[fullId].val !== val
        ) {
            states[fullId] = {val: val, ack: true};
            try {
                await adapter.setForeignStateAsync(fullId, states[fullId]);
            } catch {
                // ignore
            }
        }
    }
}

/**
 * poll all service messages from ccu and set the according alarm states
 *
 * @returns {Promise<void>}
 */
async function pollServiceMsgs() {

    adapter.log.debug('polling service messages');

    let data = await rega.runScriptFile('alarms');
    if (!data) {
        return;
    }
    try {
        data = JSON.parse(data.replace(/\n/gm, ''));
    } catch (e) {
        adapter.log.error(`Cannot parse answer for alarms: ${data}`);
        return;
    }
    for (const dp of Object.keys(data)) {
        let id = _unescape(data[dp].Name);
        if (id.match(/^AL-/)) {
            id = id.substring(3);
        }

        let instanceNumber;
        try {
            instanceNumber = Object.keys(states).find(value => id.split(':')[0] === value.split('.')[2]).split('.')[1];
        } catch {
            // instance not found -> "split" raises
            continue;
        } // endTryCatch

        id = `hm-rpc.${instanceNumber}.${id.replace(':', '.').replace(FORBIDDEN_CHARS, '_')}_ALARM`;

        if (!objects[id]) {
            adapter.log.info(`Alarm DP received for not-known dp ${id}, requesting Service Messages`);
            await getServiceMsgs();
            return;
        }

        const state = {
            val: data[dp].AlState,
            ack: true,
            lc: new Date(data[dp].AlOccurrenceTime).getTime(),
            ts: new Date(data[dp].LastTriggerTime).getTime()
        };

        if (!states[id] ||
                !states[id].ack ||
                states[id].val !== state.val ||
                states[id].lc !== state.lc ||
                states[id].ts !== state.ts
        ) {
            states[id] = state;
            try {
                await adapter.setForeignStateAsync(id, state);
            } catch {
                // ignore
            }
        }
    }
}

// Acknowledge Alarm
function acknowledgeAlarm(id) {
    adapter.log.debug(`[INFO] Acknowledge alarm ${id}`);
    states[id] = {ack: false};
    adapter.getForeignObject(id, (err, obj) => {
        if (obj && obj.native) {
            rega.script(`dom.GetObject(${obj.native.DP}).AlReceipt();`);
            setTimeout(pollServiceMsgs, 1000);
        }
    });
}

/**
 * Get all service messages from the CCU and set states accordingly
 *
 * @returns {Promise<void>}
 */
async function getServiceMsgs() {

    adapter.log.debug('create service messages');

    let data = await rega.runScriptFile('alarms');
    if (!data) {
        return;
    }
    try {
        data = JSON.parse(data.replace(/\n/gm, ''));
    } catch (e) {
        adapter.log.error(`Cannot parse answer for alarms: ${data}`);
        return;
    }
    for (const dp of Object.keys(data)) {
        let id = _unescape(data[dp].Name);
        if (id.match(/^AL-/)) {
            id = id.substring(3);
        }

        let instanceNumber;

        try {
            instanceNumber = Object.keys(states).find(value => id.split(':')[0] === value.split('.')[2]).split('.')[1];
        } catch {
            // instance not found -> "split" raises
            continue;
        } // endTryCatch

        id = `hm-rpc.${instanceNumber}.${id.replace(':', '.').replace(FORBIDDEN_CHARS, '_')}_ALARM`;

        // create object if not created
        if (!objects[id]) {
            objects[id] = true;
            try {
                const _obj = await adapter.getForeignObjectAsync(id.substring(0, id.lastIndexOf('.')));
                const name = _obj && _obj.common && _obj.common.name ? `${_obj.common.name}.${id.split('.')[4]}` : id;

                const obj = await adapter.getForeignObjectAsync(id);
                if (!obj || !obj.native || obj.native.DP !== dp || !obj.common || obj.common.type !== 'number') {
                    await adapter.setForeignObjectAsync(id, {
                        type: 'state',
                        common: {
                            name: name,
                            type: 'number',
                            role: 'indicator.alarm',
                            read: true,
                            write: true,
                            def: 0,
                            states: {
                                0: 'NO ALARM',
                                1: 'ALARM',
                                2: 'ACKNOWLEDGED'
                            }
                        },
                        native: {
                            Name: name,
                            TypeName: 'ALARM',
                            DP: dp
                        }
                    });
                }
            } catch (e) {
                adapter.log.error(`Could not update object of "${id}": ${e.message}`);
            }
        } // endIf

        const state = {
            val: data[dp].AlState,
            ack: true,
            lc: new Date(data[dp].AlOccurrenceTime).getTime(),
            ts: new Date(data[dp].LastTriggerTime).getTime()
        };

        if (!states[id] || !states[id].ack || states[id].val !== state.val ||
                states[id].lc !== state.lc || states[id].ts !== state.ts) {
            states[id] = state;
            try {
                await adapter.setForeignStateAsync(id, state);
            } catch (e) {
                adapter.log.error(`Could not update state of "${id}": ${e.message}`);
            }
        } // endIf
    } // endFor
}

/**
 * Get all programs from the CCU and sync it with enums accordingly
 *
 * @param {function()} [callback]
 */
async function getPrograms(callback) {
    adapter.getObjectView('hm-rega', 'programs', {
        startkey: `hm-rega.${adapter.instance}.`,
        endkey: `hm-rega.${adapter.instance}.\u9999`
    }, async (err, doc) => {

        const response = [];

        if (!err && doc) {
            for (const row of doc.rows) {
                const id = row.value._id.split('.').pop();
                response.push(id);
            } // endFor
            adapter.log.info(`got ${doc.rows.length} programs`);
        } else {
            adapter.log.info('got 0 programs');
        } // endElse

        let data = await rega.runScriptFile('programs');
        try {
            data = JSON.parse(data.replace(/\n/gm, ''));
        } catch (e) {
            adapter.log.error(`Cannot parse answer for programs: ${data}`);
            return void (typeof callback === 'function' && callback());
        }
        let count = 0;
        let id;
        for (const dp of Object.keys(data)) {
            id = _unescape(dp).replace(FORBIDDEN_CHARS, '_');
            count += 1;
            let fullId = `${adapter.namespace}.${id}`;
            if (!objects[fullId]) {
                objects[fullId] = true;
                await adapter.setForeignObjectAsync(fullId, {
                    type: 'channel',
                    common: {
                        name: _unescape(data[dp].Name),
                        enabled: true
                    },
                    native: {
                        Name: _unescape(data[dp].Name),
                        TypeName: data[dp].TypeName,
                        PrgInfo: _unescape(data[dp].DPInfo)
                    }
                });
            }

            const val = data[dp].Active;

            fullId = `${adapter.namespace}.${id}.ProgramExecute`;

            if (!objects[fullId]) {
                objects[fullId] = true;
                await adapter.extendForeignObjectAsync(fullId, {
                    type: 'state',
                    common: {
                        name: `${_unescape(data[dp].Name)} execute`,
                        type: 'boolean',
                        role: 'action.execute',
                        read: true,
                        write: true
                    },
                    native: {}
                });
            }

            if (!states[fullId] ||
                    !states[fullId].ack ||
                    states[fullId].val !== false
            ) {
                states[fullId] = {val: false, ack: true};
                await adapter.setForeignStateAsync(fullId, states[fullId]);
            }

            fullId = `${adapter.namespace}.${id}.Active`;
            if (!objects[fullId]) {
                objects[fullId] = true;
                await adapter.extendForeignObjectAsync(fullId, {
                    type: 'state',
                    common: {
                        name: `${_unescape(data[dp].Name)} enabled`,
                        type: 'boolean',
                        role: 'state.enabled',
                        read: true,
                        write: true
                    },
                    native: {}
                });
            }

            if (!states[fullId] || !states[fullId].ack || states[fullId].val !== val) {
                states[fullId] = {val: val, ack: true};
                await adapter.setForeignStateAsync(fullId, states[fullId]);
            }

            if (response.indexOf(id) !== -1) {
                response.splice(response.indexOf(id), 1);
            }
        }

        adapter.log.info(`added/updated ${count} programs`);

        for (const entry of response) {
            await adapter.delObjectAsync(entry);
        }
        adapter.log.info(`deleted ${response.length} programs`);

        if (typeof callback === 'function') {
            callback();
        }
    });
}

/**
 * Get all functions from the CCU and sync it with enums accordingly
 *
 * @returns Promise<void>
 */
async function getFunctions() {
    let data = await rega.runScriptFile('functions');
    adapter.log.info(`update functions to ${adapter.config.enumFunctions}`);

    try {
        data = JSON.parse(data.replace(/\n/gm, ''));
    } catch (e) {
        adapter.log.error(`Cannot parse answer for functions: ${data}`);
        return;
    }

    for (const regaId of Object.keys(data)) {
        const members = [];
        const memberObjs = data[regaId].Channels;

        let id;
        for (const memberObj of memberObjs) {
            switch (memberObj.Interface) {
                case 'BidCos-RF':
                    if (!adapter.config.rfdEnabled) {
                        continue;
                    }
                    id = `${adapter.config.rfdAdapter}.`;
                    break;

                case 'BidCos-Wired':
                    if (!adapter.config.hs485dEnabled) {
                        continue;
                    }
                    id = `${adapter.config.hs485dAdapter}.`;
                    break;

                case 'CUxD':
                    if (!adapter.config.cuxdEnabled) {
                        continue;
                    }
                    id = `${adapter.config.cuxdAdapter}.`;
                    break;

                case 'HmIP-RF':
                    if (!adapter.config.hmipEnabled) {
                        continue;
                    }
                    id = `${adapter.config.hmipAdapter}.`;
                    break;

                case 'VirtualDevices':
                    if (!adapter.config.virtualDevicesEnabled) {
                        continue;
                    }
                    id = `${adapter.config.virtualDevicesAdapter}.`;
                    break;

                default:
                    continue;

            }
            id = id + memberObj.Address.replace(':', '.').replace(FORBIDDEN_CHARS, '_');
            members.push(id);
        } // endFor

        const name = _unescape(data[regaId].Name);
        const desc = _unescape(data[regaId].EnumInfo);

        const obj = {
            _id: `${adapter.config.enumFunctions}.${words[name] ? words[name].en.replace(FORBIDDEN_CHARS, '_').replace(/\s/g, '_') : name}`,
            desc: desc,
            type: 'enum',
            common: {
                name: words[name] || name,
                members: members
            },
            native: {
                Name: name,
                TypeName: 'ENUM',
                EnumInfo: desc
            }
        };

        let oldObj;
        try {
            oldObj = await adapter.getForeignObjectAsync(obj._id);
        } catch (e) {
            adapter.log.error(`Could not update enum ${obj._id}: ${e}`);
            return;
        }

        let changed = false;
        if (!oldObj) {
            oldObj = obj;
            changed = true;
        } else {
            obj.common = obj.common || {};
            obj.common.members = obj.common.members || [];
            oldObj.common = oldObj.common || {};
            oldObj.common.members = oldObj.common.members || [];
            for (const newMember of obj.common.members) {
                // Check if new channel added
                if (oldObj.common.members.indexOf(newMember) === -1) {
                    changed = true;
                    oldObj.common.members.push(newMember);
                    adapter.log.info(`${newMember} has been added to functions ${name}`);
                } // endIf
            } // endFor

            // do it reverse, because we delete own elements in loop
            for (let i = oldObj.common.members.length; i >= 0; i--) {
                const oldMember = oldObj.common.members[i];
                // Check if channel has been removed
                if (obj.common.members.indexOf(oldMember) === -1 && HM_RPC_REGEX.test(oldMember)) {
                    changed = true;
                    oldObj.common.members.splice(i, 1);
                    adapter.log.info(`${oldMember} has been removed from functions ${name}`);
                } // endIf
            } // endFor
        } // endElse
        if (changed) {
            await adapter.setForeignObjectAsync(obj._id, oldObj);
        } // endIf
    } // endFor

    await adapter.setForeignObjectNotExistsAsync(adapter.config.enumFunctions, {
        type: 'enum',
        common: {
            name: 'Functions',
            members: []
        },
        native: {}
    });
}

/**
 * Get all rooms from the CCU and sync it with enums accordingly
 *
 * @returns Promise<void>
 */
async function getRooms() {
    let data = await rega.runScriptFile('rooms');

    adapter.log.info(`update rooms to ${adapter.config.enumRooms}`);

    try {
        data = JSON.parse(data.replace(/\n/gm, ''));
    } catch (e) {
        adapter.log.error(`Cannot parse answer for rooms: ${data}`);
        return;
    }
    // iterate over rooms
    for (const regaId of Object.keys(data)) {
        const members = [];

        const memberObjs = data[regaId].Channels;

        let id;
        for (const memberObj of memberObjs) {
            switch (memberObj.Interface) {
                case 'BidCos-RF':
                    id = `${adapter.config.rfdAdapter}.`;
                    if (!adapter.config.rfdAdapter) {
                        continue;
                    }
                    break;

                case 'BidCos-Wired':
                    id = `${adapter.config.hs485dAdapter}.`;
                    if (!adapter.config.hs485dAdapter) {
                        continue;
                    }
                    break;

                case 'CUxD':
                    id = `${adapter.config.cuxdAdapter}.`;
                    if (!adapter.config.cuxdAdapter) {
                        continue;
                    }
                    break;

                case 'HmIP-RF':
                    id = `${adapter.config.hmipAdapter}.`;
                    if (!adapter.config.hmipAdapter) {
                        continue;
                    }
                    break;

                case 'VirtualDevices':
                    id = `${adapter.config.virtualDevicesAdapter}.`;
                    if (!adapter.config.virtualDevicesEnabled) {
                        continue;
                    }
                    break;

                default:
                    continue;

            }
            id = id + _unescape(memberObj.Address).replace(':', '.').replace(FORBIDDEN_CHARS, '_');
            members.push(id);
        }

        const name = _unescape(data[regaId].Name);
        const desc = _unescape(data[regaId].EnumInfo);

        const obj = {
            _id: `${adapter.config.enumRooms}.${words[name] ? words[name].en.replace(FORBIDDEN_CHARS, '_').replace(/\s/g, '_') : name}`,
            type: 'enum',
            common: {
                name: words[name] || name,
                desc: desc,
                members: members
            },
            native: {
                Name: name,
                TypeName: 'ENUM',
                EnumInfo: desc
            }
        };

        let oldObj;
        try {
            oldObj = await adapter.getForeignObjectAsync(obj._id);
        } catch (e) {
            adapter.log.error(`Could not update enum ${obj._id}: ${e}`);
            return;
        }

        let changed = false;
        if (!oldObj) {
            oldObj = obj;
            changed = true;
        } else {
            oldObj.common = oldObj.common || {};
            oldObj.common.members = oldObj.common.members || [];
            for (const newMember of obj.common.members) {
                // Check if new room added
                if (oldObj.common.members.indexOf(newMember) === -1) {
                    changed = true;
                    oldObj.common.members.push(newMember);
                    adapter.log.info(`${newMember} has been added to room ${name}`);
                } // endIf
            } // endFor

            // do it reverse, because we delete own elements in loop
            for (let i = oldObj.common.members.length; i >= 0; i--) {
                const oldMember = oldObj.common.members[i];
                // Check if room has been removed
                if (obj.common.members.indexOf(oldMember) === -1 && HM_RPC_REGEX.test(oldMember)) {
                    changed = true;
                    oldObj.common.members.splice(i, 1);
                    adapter.log.info(`${oldMember} has been removed from room ${name}`);
                } // endIf
            } // endFor
        } // endElse

        if (changed) {
            await adapter.setForeignObjectAsync(obj._id, oldObj);
        } // endIf
    } // endFor

    await adapter.setForeignObjectNotExistsAsync(adapter.config.enumRooms, {
        type: 'enum',
        common: {
            name: 'Rooms',
            members: []
        },
        native: {}
    });
} // endGetRooms

/**
 * Get all favorites from the CCU and sync it with enums accordingly
 *
 * @returns Promise<void>
 */
async function getFavorites() {
    let data = await rega.runScriptFile('favorites');
    adapter.log.info(`update favorites to ${adapter.config.enumFavorites}`);

    try {
        data = JSON.parse(data.replace(/\n/gm, ''));
    } catch (e) {
        adapter.log.error(`Cannot parse answer for favorites: ${data}`);
        return;
    }

    // Create enum favorites if non existing (can be different to default)
    await adapter.setForeignObjectNotExistsAsync(adapter.config.enumFavorites, {
        type: 'enum',
        common: {
            name: 'Favorites'
        },
        native: {}
    });

    for (const _user of Object.keys(data)) {
        const user = _unescape(_user).replace(FORBIDDEN_CHARS, '_');
        try {
            // create every user even if no channels there
            await adapter.setForeignObjectNotExistsAsync(`${adapter.config.enumFavorites}.${user}`, {
                type: 'enum',
                common: {
                    name: `${user} Favorites`
                },
                native: {}
            });
        } catch (e) {
            adapter.log.error(`Could not synchronize favorites of user "${user}": ${e}`);
        }

        // every user can have multiple favorite lists

        for (const fav of Object.keys(data[_user])) {
            const channels = data[_user][fav].Channels;
            const members = [];
            for (const channel of channels) {
                if (typeof channel === 'number') {
                    members.push(`${adapter.namespace}.${channel}`);
                } else {
                    let id;
                    switch (channel.Interface) {
                        case 'BidCos-RF':
                            id = `${adapter.config.rfdAdapter}.`;
                            if (!adapter.config.rfdAdapter) {
                                continue;
                            }
                            break;
                        case 'BidCos-Wired':
                            id = `${adapter.config.hs485dAdapter}.`;
                            if (!adapter.config.hs485dAdapter) {
                                continue;
                            }
                            break;
                        case 'CUxD':
                            id = `${adapter.config.cuxdAdapter}.`;
                            if (!adapter.config.cuxdAdapter) {
                                continue;
                            }
                            break;
                        case 'HmIP-RF':
                            id = `${adapter.config.hmipAdapter}.`;
                            if (!adapter.config.hmipAdapter) {
                                continue;
                            }
                            break;
                        case 'VirtualDevices':
                            id = `${adapter.config.virtualDevicesAdapter}.`;
                            if (!adapter.config.virtualDevicesEnabled) {
                                continue;
                            }
                            break;
                        default:
                            continue;

                    }
                    id = id + _unescape(channel.Address).replace(':', '.').replace(FORBIDDEN_CHARS, '_');
                    members.push(id);
                }
            }

            const obj = {
                _id: `${adapter.config.enumFavorites}.${user}.${_unescape(fav)}`.replace(FORBIDDEN_CHARS, '_'),
                type: 'enum',
                common: {
                    name: _unescape(fav),
                    members: members
                },
                native: {
                    user: user,
                    id: data[_user][fav].id,
                    TypeName: 'FAVORITE'
                }
            };

            let oldObj;
            try {
                oldObj = await adapter.getForeignObjectAsync(obj._id);
            } catch (e) {
                adapter.log.error(`Could not update enum ${obj._id}: ${e}`);
                return;
            }

            let changed = false;
            if (!oldObj) {
                oldObj = obj;
                changed = true;
            } else {
                oldObj.common = oldObj.common || {};
                oldObj.common.members = oldObj.common.members || [];
                for (const newMember of obj.common.members) {
                    // Check if new channel added
                    if (oldObj.common.members.indexOf(newMember) === -1) {
                        changed = true;
                        oldObj.common.members.push(newMember);
                        adapter.log.info(`${newMember} has been added to favorites for "${user}" on list "${_unescape(fav)}"`);
                    } // endIf
                } // endFor

                // do it reverse, because we delete own elements in loop
                for (let i = oldObj.common.members.length; i >= 0; i--) {
                    const oldMember = oldObj.common.members[i];
                    // Check if channel has been removed
                    if (obj.common.members.indexOf(oldMember) === -1 && HM_RPC_REGEX.test(oldMember)) {
                        changed = true;
                        oldObj.common.members.splice(i, 1);
                        adapter.log.info(`${oldMember} has been removed from favorites for "${user}" on list "${_unescape(fav)}"`);
                    } // endIf
                } // endFor
            } // endElse
            if (changed) {
                await adapter.setForeignObjectAsync(obj._id, oldObj);
            } // endIf
        } // endFor
    } // endFor
} // endGetFavorites

/**
 * get all datapoints from the ccu and set the according states if configured
 *
 * @returns Promise<void>
 */
async function getDatapoints() {
    adapter.log.info('request state values');
    let data = await rega.runScriptFile('datapoints');
    try {
        data = JSON.parse(data.replace(/\n/gm, ''));
    } catch (e) {
        adapter.log.error(`Cannot parse answer for datapoints: ${data}`);
        return;
    }
    for (const dp of Object.keys(data)) {
        const tmp = _unescape(dp).replace(FORBIDDEN_CHARS, '_').split('.');

        if (tmp[2] === 'PRESS_SHORT' || tmp[2] === 'PRESS_LONG') {
            continue;
        }
        let id;
        switch (tmp[0]) {
            case 'BidCos-RF':
                if (!adapter.config.rfdEnabled) {
                    continue;
                }
                id = `${adapter.config.rfdAdapter}.`;
                break;

            case 'BidCos-Wired':
                if (!adapter.config.hs485dEnabled) {
                    continue;
                }
                id = `${adapter.config.hs485dAdapter}.`;
                break;

            case 'CUxD':
                if (!adapter.config.cuxdEnabled) {
                    continue;
                }
                id = `${adapter.config.cuxdAdapter}.`;
                break;

            case 'HmIP-RF':
                if (!adapter.config.hmipEnabled) {
                    continue;
                }
                id = `${adapter.config.hmipAdapter}.`;
                break;

            case 'VirtualDevices':
                if (!adapter.config.virtualDevicesEnabled) {
                    continue;
                }
                id = `${adapter.config.virtualDevicesAdapter}.`;
                break;

            default:
                continue;
        }
        id += `${tmp[1].replace(':', '.').replace(FORBIDDEN_CHARS, '_')}.${tmp[2].replace(FORBIDDEN_CHARS, '_')}`;

        // convert dimmer and blinds
        if (units[id] && typeof units[id] === 'object') {
            // data[dp] = ((parseFloat(data[dp]) - units[id].MIN) / (units[id].MAX - units[id].MIN)) * 100;
            const max = units[id].MAX;
            // check if we need to scale
            if (max === 1 || max === 1.005 || max === 1.01) {
                data[dp] = parseFloat(data[dp]) * 100;
            } else {
                // round to xx.yy
                data[dp] = Math.round(data[dp] * 100) / 100;
            }
        } else if (units[id] === '100%' || units[id] === '%') {
            data[dp] = Math.round(parseFloat(data[dp]) * 100 * 1000) / 1000;
        }

        const state = {val: _unescape(data[dp]), ack: true};

        if (!states[id] ||
                states[id].val !== state.val ||
                !states[id].ack) {
            states[id] = state;
            // only set the state if it's a valid dp at RPC API and thus has an object
            if (existingStates.includes(id)) {
                await adapter.setForeignStateAsync(id, state);
            } else {
                adapter.log.debug(`Do not set "${JSON.stringify(state)}" to "${id}", because non-existing in corresponding adapter`);
            }
        } // endIf
    } // endFor

    adapter.log.info('Updated all datapoints');
    // free RAM
    units = null;
    existingStates = [];
}

/**
 * Gets all devices, channels, states and renames them
 * @param {string[]} devices
 * @param {string[]} channels
 * @param {string[]} _states
 * @private
 */
async function _getDevicesFromRega(devices, channels, _states) {
    // Get all devices channels and states
    let data = await rega.runScriptFile('devices');
    try {
        data = JSON.parse(data.replace(/\n/gm, ''));
    } catch (e) {
        adapter.log.error(`Cannot parse answer for devices: ${data}`);
        return;
    }
    const objs = [];
    let id;
    for (const addr of Object.keys(data)) {
        switch (data[addr].Interface) {
            case 'BidCos-RF':
                if (!adapter.config.rfdEnabled) {
                    continue;
                }
                id = `${adapter.config.rfdAdapter}.`;
                break;

            case 'BidCos-Wired':
                if (!adapter.config.hs485dEnabled) {
                    continue;
                }
                id = `${adapter.config.hs485dAdapter}.`;
                break;

            case 'CUxD':
                if (!adapter.config.cuxdEnabled) {
                    continue;
                }
                id = `${adapter.config.cuxdAdapter}.`;
                break;

            case 'HmIP-RF':
                if (!adapter.config.hmipEnabled) {
                    continue;
                }
                id = `${adapter.config.hmipAdapter}.`;
                break;

            case 'VirtualDevices':
                if (!adapter.config.virtualDevicesEnabled) {
                    continue;
                }
                id = `${adapter.config.virtualDevicesAdapter}.`;
                break;

            default:
                continue;
        }

        id += _unescape(addr).replace(':', '.').replace(FORBIDDEN_CHARS, '_');
        const name = _unescape(data[addr].Name);
        if (addr.indexOf(':') === -1) {
            // device
            if (devices[id] === undefined || (devices[id] !== name && adapter.config.syncNames)) {
                objs.push({_id: id, type: 'device', common: {name: name}});
            }
        } else {
            // channel
            if (channels[id] === undefined || (channels[id] !== name && adapter.config.syncNames)) {
                objs.push({_id: id, type: 'channel', common: {name: name}});
            } else if (!channels[id]) {
                let dev = id.split('.');
                const last = dev.pop();
                dev = dev.join('.');
                if (devices[dev]) {
                    objs.push({_id: id, type:'channel', common: {name: `${devices[dev]}.${last}`}});
                }
            }
            if (_states[id]) {
                for (const s of Object.keys(_states[id])) {
                    const stateName = `${name}.${s}`;
                    if (!_states[id][s] || (_states[id][s] !== stateName && adapter.config.syncNames)) {
                        objs.push({
                            _id: `${id}.${s}`,
                            type: 'state',
                            common: {name: stateName}
                        });
                    }
                }
            }
        }
    }

    // now rename all objects
    for (const obj of objs) {
        try {
            await adapter.extendForeignObjectAsync(obj._id, obj);
            adapter.log.info(`renamed ${obj._id} to "${obj.common.name}"`);
        } catch (e) {
            adapter.log.warn(`Could not rename object ${obj._id} to "${obj.common.name}": ${e}`);
        }
    }
}

/**
 * Get all states/channels/devices from instance and request their name from REGA API and does renaming
 *
 * @return {Promise<void>}
 */
async function getDevices() {
    const promises = [];
    const channels = {};
    const devices = {};
    const _states = {};

    if (adapter.config.rfdEnabled) {
        promises.push(addStatesFromInstance(adapter.config.rfdAdapter));
    }
    if (adapter.config.hs485dEnabled) {
        promises.push(addStatesFromInstance(adapter.config.hs485dAdapter));
    }
    if (adapter.config.cuxdEnabled) {
        promises.push(addStatesFromInstance(adapter.config.cuxdAdapter));
    }
    if (adapter.config.hmipEnabled) {
        promises.push(addStatesFromInstance(adapter.config.hmipAdapter));
    }
    if (adapter.config.virtualDevicesEnabled) {
        promises.push(addStatesFromInstance(adapter.config.virtualDevicesAdapter));
    }

    await Promise.all(promises);

    await _getDevicesFromRega(devices, channels, _states);

    /**
     * adds the state information (min, max, etc.) from a given instance
     *
     * @param {string} instance instance to add the states from
     * @returns {Promise<void>}
     */
    async function addStatesFromInstance(instance) {
        try {
            const doc = await adapter.getObjectViewAsync('system', 'device', {
                startkey: `${instance}.`,
                endkey: `${instance}.\u9999`
            });

            if (doc && doc.rows) {
                for (const row of doc.rows) {
                    if (row.value) {
                        devices[row.id] = row.value.common.name;
                    }
                }
            }
        } catch (e) {
            adapter.log.warn(`Could not add devices from instance ${instance}: ${e}`);
        }

        try {
            const doc = await adapter.getObjectViewAsync('system', 'channel', {
                startkey: `${instance}.`,
                endkey: `${instance}.\u9999`
            });

            if (doc && doc.rows) {
                for (const row of doc.rows) {
                    if (row.value) {
                        channels[row.id] = row.value.common.name;
                    }
                }
            }
        } catch (e) {
            adapter.log.warn(`Could not add channels from instance ${instance}: ${e}`);
        }

        try {
            const doc = await adapter.getObjectViewAsync('system', 'state', {
                startkey: `${instance}.`,
                endkey: `${instance}.\u9999`
            });

            if (doc && doc.rows) {
                units = units || {};
                for (const row of doc.rows) {
                    const parts = row.id.split('.');
                    const last = parts.pop();
                    const id = parts.join('.');
                    existingStates.push(row.id);

                    if (row.value && row.value.native && row.value.native.UNIT) {
                        const _id = row.id;
                        units[_id] = _unescape(row.value.native.UNIT);
                        if ((units[_id] === '%') &&
                            typeof row.value.native.MIN === 'number') {
                            units[_id] = {
                                UNIT: '%',
                                MIN: parseFloat(row.value.native.MIN),
                                MAX: parseFloat(row.value.native.MAX)
                            };
                            if (units[_id].MAX === 99) {
                                units[_id].MAX = 100;
                            }
                        }
                    }
                    _states[id] = _states[id] || [];
                    _states[id][last] = row.value.common.name;
                }
            }
        } catch (e) {
            adapter.log.warn(`Could not add states from instance ${instance}: ${e}`);
        }
    } // endAddStatesFromInstance
} // endGetDevices

/**
 * get all variables from ccu (also invisible if configured) and set states accordingly
 *
 * @returns Promise<void>
 */
async function getVariables() {
    const commonTypes = {
        2: 'boolean',
        4: 'number',
        16: 'number',
        20: 'string'
    };

    const doc  = await adapter.getObjectViewAsync('hm-rega', 'variables', {
        startkey: `hm-rega.${adapter.instance}.`,
        endkey: `hm-rega.${adapter.instance}.\u9999`
    });
    const response = [];

    if (doc) {
        for (const row of doc.rows) {
            const id = row.value._id.split('.').pop();
            response.push(id);
        }
        adapter.log.info(`got ${doc.rows.length} variables`);
    } else {
        adapter.log.info('got 0 variables');
    }

    let data = await rega.runScriptFile(adapter.config.showInvSysVar ? 'variablesInv' : 'variables');
    try {
        // CCU sometimes uses -inf or nan, we should handle them as null
        data = JSON.parse(data.replace(/\n/gm, '').replace(/-inf|nan/g, null));
    } catch (e) {
        adapter.log.error(`Cannot parse answer for variables: ${data}`);
        return;
    }
    let count = 0;
    let id;

    for (const dp of Object.keys(data)) {
        id = _unescape(dp).replace(FORBIDDEN_CHARS, '_');
        count += 1;

        const role = 'state';

        const obj = {
            _id: `${adapter.namespace}.${id}`,
            type: 'state',
            common: {
                name: _unescape(data[dp].Name),
                type: commonTypes[data[dp].ValueType],
                read: true,
                write: true,
                role: role
            },
            native: {
                Name: _unescape(data[dp].Name),
                TypeName: _unescape(data[dp].TypeName),
                DPInfo: _unescape(data[dp].DPInfo),
                ValueMin: _unescape(data[dp].ValueMin),
                ValueMax: _unescape(data[dp].ValueMax),
                ValueUnit: _unescape(data[dp].ValueUnit),
                ValueType: _unescape(data[dp].ValueType),
                ValueSubType: _unescape(data[dp].ValueSubType),
                ValueList: _unescape(data[dp].ValueList)
            }
        };
        if (data[dp].ValueMin || data[dp].ValueMin === 0) {
            obj.common.min = obj.native.ValueMin;
        }
        if (data[dp].ValueMax || data[dp].ValueMax === 0) {
            obj.common.max = obj.native.ValueMax;
        }
        if (data[dp].ValueUnit) {
            obj.common.unit = obj.native.ValueUnit;
        }
        if (data[dp].DPInfo) {
            obj.common.desc = obj.native.DPInfo;
        }

        if (data[dp].ValueList) {
            const statesArr = _unescape(data[dp].ValueList).split(';');
            obj.common.states = {};
            for (const i in statesArr) {
                obj.common.states[i] = statesArr[i];
            }
            if (data[dp].ValueSubType === 29) {
                obj.common.min = 0;
                obj.common.max = statesArr.length - 1;
            }

        }

        let val = data[dp].Value;
        const timestamp = data[dp].Timestamp ? new Date(data[dp].Timestamp).getTime() : new Date().getTime();

        if (typeof val === 'string') {
            val = _unescape(val);
        }

        if (id === '40') {
            id = 'alarms';
            obj.role = `indicator.${id}`;
            obj._id = `${adapter.namespace}.${id}`;
        } else if (id === '41') {
            id = 'maintenance';
            obj.role = `indicator.${id}`;
            obj._id = `${adapter.namespace}.${id}`;
        }
        const fullId = obj._id;

        if (!objects[fullId]) {
            objects[fullId] = true;
            await adapter.extendForeignObjectAsync(fullId, obj);
        }

        if (!states[fullId] || !states[fullId].ack ||
                    states[fullId].val !== val || states[fullId].ts !== timestamp) {
            states[fullId] = {val: val, ack: true, ts: timestamp};
            await adapter.setForeignStateAsync(fullId, states[fullId]);
        }

        if (response.indexOf(id) !== -1) {
            response.splice(response.indexOf(id), 1);
        }
    }

    adapter.log.info(`added/updated ${count} variables`);

    for (const entry of response) {
        await adapter.delObjectAsync(entry);
    }
    adapter.log.info(`deleted ${response.length} variables`);

    if (adapter.config.polling && adapter.config.pollingInterval > 0) {
        if (!pollingInterval && (adapter.config.syncVariables || adapter.config.syncPrograms)) {
            pollingInterval = setInterval(() => {
                if (adapter.config.syncVariables) {
                    pollVariables();
                }
                if (adapter.config.syncPrograms) {
                    pollPrograms();
                }
            }, adapter.config.pollingInterval * 1000);
        }
    }
}

/**
 * get duty cycle, firmware version, rega versions, device/channel/dp counters, set states and create initial objects
 *
 * @returns {Promise<void>}
 */
async function getDutyCycle() {
    let data = await rega.runScriptFile('dutycycle');
    let sysInfo = await rega.runScriptFile('system');
    try {
        data = JSON.parse(convertDataToJSONArray(data));
    } catch (e) {
        adapter.log.error(`Cannot parse answer for dutycycle: ${data}`);
        return;
    }
    let count = 0;
    let id;
    try {
        sysInfo = JSON.parse(sysInfo);
    } catch (e) {
        adapter.log.error(`Cannot parse system info: ${sysInfo}`);
        sysInfo = {};
    } // endTryCatch

    const ccuType = `CCU${typeof sysInfo.ccuVersion === 'string' ? sysInfo.ccuVersion.split('.')[0] : ''}`;

    // iterate over JSON array
    for (const dp of data) {
        id = _unescape(dp.ADDRESS).replace(FORBIDDEN_CHARS, '_');
        count += 1;

        const obj = {
            _id: `${adapter.namespace}.${id}`,
            type: 'device',
            common: {
                name: ccuType
            },
            native: {
                ADDRESS: _unescape(dp.ADDRESS),
                TYPE: ccuType
            }
        };

        if (!objects[obj._id]) {
            objects[obj._id] = true;
            adapter.extendForeignObject(obj._id, obj);
        }

        //DUTY_CYCLE State:
        if (dp.DUTY_CYCLE !== undefined) {
            const stateDutycycle = {
                _id: `${adapter.namespace}.${id}.0.DUTY_CYCLE`,
                type: 'state',
                common: {
                    name: `${adapter.namespace}.${id}.0.DUTY_CYCLE`,
                    type: 'number',
                    read: true,
                    write: false,
                    role: 'value',
                    min: 0,
                    max: 100,
                    unit: '%',
                    desc: 'Dutycycle'
                },
                native: {
                    ID: 'DUTYCYCLE',
                    TYPE: 'INTEGER',
                    MIN: 0,
                    MAX: 100,
                    UNIT: '%',
                    DEFAULT: 0,
                    CONTROL: 'NONE'
                }
            };
            await addNewStateOrObject(stateDutycycle, parseInt(dp.DUTY_CYCLE));
        }

        //CONNECTED State:
        if (dp.CONNECTED !== undefined) {
            const stateConnected = {
                _id: `${adapter.namespace}.${id}.0.CONNECTED`,
                type: 'state',
                common: {
                    name: `${adapter.namespace}.${id}.0.CONNECTED`,
                    type: 'number',
                    read: true,
                    write: false,
                    role: 'indicator.connected',
                    desc: 'conected'
                },
                native: {
                    ID: 'CONNECTED',
                    TYPE: 'BOOLEAN',
                    DEFAULT: false,
                    CONTROL: 'NONE'
                }
            };
            await addNewStateOrObject(stateConnected, dp.CONNECTED);
        }

        //DEFAULT State:
        if (dp.DEFAULT !== undefined) {
            const stateDefault = {
                _id: `${adapter.namespace}.${id}.0.DEFAULT`,
                type: 'state',
                common: {
                    name: `${adapter.namespace}.${id}.0.DEFAULT`,
                    type: 'number',
                    read: true,
                    write: false,
                    role: 'indicator',
                    desc: 'default'
                },
                native: {
                    ID: 'DEFAULT',
                    TYPE: 'BOOLEAN',
                    DEFAULT: false,
                    CONTROL: 'NONE'
                }
            };
            await addNewStateOrObject(stateDefault, dp.DEFAULT);
        }

        // FIRMWARE_VERSION State:
        if (sysInfo.ccuVersion !== undefined) {
            const stateFirmware = {
                _id: `${adapter.namespace}.${id}.0.FIRMWARE_VERSION`,
                type: 'state',
                common: {
                    name: `${adapter.namespace}.${id}.0.FIRMWARE_VERSION`,
                    type: 'string',
                    read: true,
                    write: false,
                    role: 'text',
                    desc: 'firmware_version'
                },
                native: {
                    ID: 'FIRMWARE_VERSION',
                    TYPE: 'STRING',
                    DEFAULT: '',
                    CONTROL: 'NONE'
                }
            };
            await addNewStateOrObject(stateFirmware, sysInfo.ccuVersion);
        }

        // ReGaHss-Version
        if (sysInfo.regaVersion !== undefined) {
            const regaVersion = {
                _id: `${adapter.namespace}.${id}.0.regaVersion`,
                type: 'state',
                common: {
                    name: `${adapter.namespace}.${id}.0.regaVersion`,
                    type: 'string',
                    read: true,
                    write: false,
                    role: 'text',
                    desc: 'Version of ReGaHss'
                },
                native: {}
            };
            await addNewStateOrObject(regaVersion, sysInfo.regaVersion);
        }

        // Number of devices
        if (sysInfo.countDevices !== undefined) {
            const countDevices = {
                _id: `${adapter.namespace}.${id}.0.countDevices`,
                type: 'state',
                common: {
                    name: `${adapter.namespace}.${id}.0.countDevices`,
                    type: 'string',
                    read: true,
                    write: false,
                    role: 'indicator.count',
                    desc: 'Total number of devices'
                },
                native: {}
            };
            await addNewStateOrObject(countDevices, sysInfo.countDevices);
        }

        // Rega Build Label
        if (sysInfo.buildLabel !== undefined) {
            const buildLabel = {
                _id: `${adapter.namespace}.${id}.0.buildLabel`,
                type: 'state',
                common: {
                    name: `${adapter.namespace}.${id}.0.buildLabel`,
                    type: 'string',
                    read: true,
                    write: false,
                    role: 'text',
                    desc: 'Build Label of ReGaHss'
                },
                native: {}
            };
            await addNewStateOrObject(buildLabel, sysInfo.buildLabel);
        }

        // Number of channels
        if (sysInfo.countChannels !== undefined) {
            const countChannels = {
                _id: `${adapter.namespace}.${id}.0.countChannels`,
                type: 'state',
                common: {
                    name: `${adapter.namespace}.${id}.0.countChannels`,
                    type: 'string',
                    read: true,
                    write: false,
                    role: 'indicator.count',
                    desc: 'Total number of channels'
                },
                native: {}
            };
            await addNewStateOrObject(countChannels, sysInfo.countChannels);
        }

        // Number of datapoints
        if (sysInfo.countDatapoints !== undefined) {
            const countDatapoints = {
                _id: `${adapter.namespace}.${id}.0.countDatapoints`,
                type: 'state',
                common: {
                    name: `${adapter.namespace}.${id}.0.countDatapoints`,
                    type: 'string',
                    read: true,
                    write: false,
                    role: 'indicator.count',
                    desc: 'Total number of datapoints'
                },
                native: {}
            };
            await addNewStateOrObject(countDatapoints, sysInfo.countDatapoints);
        }

        // Number of datapoints
        if (sysInfo.countSystemVars !== undefined) {
            const countSysVars = {
                _id: `${adapter.namespace}.${id}.0.countSystemVariables`,
                type: 'state',
                common: {
                    name: `${adapter.namespace}.${id}.0.countSystemVariables`,
                    type: 'string',
                    read: true,
                    write: false,
                    role: 'indicator.count',
                    desc: 'Total number of system variables'
                },
                native: {}
            };
            await addNewStateOrObject(countSysVars, sysInfo.countSystemVars);
        }

        // Number of programs
        if (sysInfo.countPrograms !== undefined) {
            const countPrograms = {
                _id: `${adapter.namespace}.${id}.0.countPrograms`,
                type: 'state',
                common: {
                    name: `${adapter.namespace}.${id}.0.countPrograms`,
                    type: 'string',
                    read: true,
                    write: false,
                    role: 'indicator.count',
                    desc: 'Total number of programs'
                },
                native: {}
            };
            await addNewStateOrObject(countPrograms, sysInfo.countPrograms);
        }
    } // endFor

    adapter.log.info(`added/updated ${count} objects`);

    if (adapter.config.syncDutyCycle && adapter.config.pollingIntervalDC > 0) {
        if (!pollingIntervalDC) {
            pollingIntervalDC = setInterval(() => {
                if (adapter.config.syncDutyCycle) {
                    pollDutyCycle();
                }
            }, adapter.config.pollingIntervalDC * 1000);
        }
    }
} // endGetDutyCycle

/**
 * Add new object and set state afterwards
 *
 * @param {object} obj - object to set
 * @param {any} val - state val to set
 * @return {Promise<void>}
 */
async function addNewStateOrObject(obj, val) {
    if (!objects[obj._id]) {
        objects[obj._id] = true;
        await adapter.extendForeignObjectAsync(obj._id, obj);
    }

    if (typeof val === 'string') {
        val = _unescape(val);
    }
    if (!states[obj._id] || !states[obj._id].ack || states[obj._id].val !== val) {
        states[obj._id] = {val: val, ack: true};
        await adapter.setForeignStateAsync(obj._id, states[obj._id]);
    }
}

/**
 * Update state in cache and db
 *
 * @param {string} fullId - id of state
 * @param {any} val - value of state
 * @return {Promise<void>}
 */
async function updateNewState(fullId, val) {
    if (typeof val === 'string') {
        val = _unescape(val);
    }
    if (!states[fullId] || !states[fullId].ack || states[fullId].val !== val) {
        states[fullId] = {val: val, ack: true};
        await adapter.setForeignStateAsync(fullId, val, true);
    }
}

/**
 * Converts the Duty Cycle output to a real JSON array string
 *
 * @param {string} data - duty cycle string
 * @return {string}
 */
function convertDataToJSONArray(data) {
    data = data.replace(/\r/gm, '');
    data = data.replace(/\n/gm, '');
    data = data.replace(/{/g, '');
    data = data.replace(/}/g, '');
    const jsonArray = [];
    data.split('ADDRESS').forEach(item => {
        if (item !== null && item !== '' && item !== undefined) {
            const jsonObj = {};

            let splitter = item.split('CONNECTED');
            jsonObj.ADDRESS = splitter[0].trim();

            splitter = splitter[1].split('DEFAULT');
            jsonObj.CONNECTED = splitter[0].trim();

            splitter = splitter[1].split('DESCRIPTION');
            jsonObj.DEFAULT = splitter[0].trim();

            splitter = splitter[1].split('DUTY_CYCLE');
            jsonObj.DESCRIPTION = splitter[0].trim();

            splitter = splitter[1].split('FIRMWARE_VERSION');
            jsonObj.DUTY_CYCLE = splitter[0].trim();

            splitter = splitter[1].split('TYPE');
            jsonObj.FIRMWARE_VERSION = splitter[0].trim();

            jsonObj.TYPE = splitter[1].trim();

            jsonArray.push(jsonObj);
        }
    });
    return JSON.stringify(jsonArray);
}

let stopCount = 0;

async function stop(callback) {
    try {
        await adapter.setStateAsync('info.connection', false, true);
        await adapter.setStateAsync('info.ccuReachable', false, true);
        await adapter.setStateAsync('info.ccuRegaUp', false, true);
    } catch {
        // ignore
    }

    if (!stopCount) {
        clearInterval(pollingInterval);
        clearInterval(pollingIntervalDC);
    }
    for (const id of Object.keys(checkInterval)) {
        clearInterval(checkInterval[id]);
    }

    if (rega && rega.pendingRequests > 0 && stopCount < 5) {
        if (!stopCount) {
            adapter.log.info('waiting for pending request');
        }
        setTimeout(stop, 500, callback);
    } else {
        callback();
    }
    stopCount++;
}

if (module === require.main) {
    // start the instance directly
    startAdapter();
} else {
    // If started as allInOne/compact mode => return function to create instance
    module.exports = startAdapter;
}
