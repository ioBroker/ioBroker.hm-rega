/*
 *
 * Copyright (c) 2014-2025 bluefox <dogafox@gmail.com>
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
import * as utils from '@iobroker/adapter-core';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { Rega, type RegaError } from './lib/rega';
import { words } from './lib/enumNames';
import { decrypt } from './lib/crypto';
import { chars, FORBIDDEN_CHARS, nameToString } from './lib/utils';
import type {
    CachedState,
    RegaAlarm,
    RegaChannelRef,
    RegaDatapoints,
    RegaDevice,
    RegaDutyCycle,
    RegaEnum,
    RegaFavorites,
    RegaPollResult,
    RegaProgram,
    RegaSystemInfo,
    RegaValue,
    RegaVariable,
    UnitInfo,
} from './lib/types';

/** IDs to detect lowbat alarms */
const LOWBAT_ALARM_IDS = ['LOWBAT_ALARM', 'LOW_BAT_ALARM'];
/** Constant which indicates that lowbat is active */
const LOWBAT_ACTIVE_INDICATOR = 1;
/** Default secret if `system.config` has none */
const DEFAULT_SECRET = 'Zgfr56gFe87jJOM';

/** ReGa `ValueType` to ioBroker `common.type` */
const COMMON_TYPES: Record<number, ioBroker.CommonType> = {
    2: 'boolean',
    4: 'number',
    16: 'number',
    20: 'string',
};

/**
 * An enum object as it is written by this adapter. `desc` on the root level is not an official
 * attribute, but `getFunctions()` has always written it, so it is kept.
 */
interface RegaEnumObject extends ioBroker.EnumObject {
    desc?: string;
}

/** Options of a `selectSendTo`/`autocompleteSendTo` control in admin/jsonConfig.json */
interface SelectOption {
    value: string;
    label: string;
}

class HmRega extends utils.Adapter {
    private rega: Rega | null = null;

    private ccuReachable = false;
    private ccuRegaUp = false;

    private pollingTimer: ioBroker.Interval | null = null;
    private pollingTimerDC: ioBroker.Interval | null = null;
    private afterReconnect: ioBroker.Timeout | null = null;
    private readonly checkInterval: Record<string, ioBroker.Interval> = {};

    /** Full ID of the state which triggers a variable poll */
    private pollingTrigger = '';
    /** Regex to match all configured hm-rpc objects of the configured instances */
    private hmRpcRegex = /^$/;

    /** Units of the hm-rpc states, freed after the initial `getDatapoints()` */
    private units: Record<string, UnitInfo> | null = {};
    /** Cache of the last written states to avoid unnecessary writes */
    private readonly states: Record<string, CachedState> = {};
    /** Cache of the already created objects */
    private readonly objects: Record<string, boolean> = {};
    /**
     * State cache won't have all DPs, because e.g., heating groups are not provided via getDatapoints
     */
    private existingStates: string[] = [];
    private existingDevices: string[] = [];

    private unloaded = false;

    public constructor(options: Partial<utils.AdapterOptions> = {}) {
        super({ ...options, name: 'hm-rega' });

        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('message', this.onMessage.bind(this));
        this.on('unload', this.onUnload.bind(this));
    }

    // -----------------------------------------------------------------------------------------
    // Lifecycle
    // -----------------------------------------------------------------------------------------

    private async onReady(): Promise<void> {
        if (this.config.useHttps) {
            // if https, then we need auth data
            try {
                const obj = await this.getForeignObjectAsync('system.config');
                const secret: string = obj?.native?.secret || DEFAULT_SECRET;

                this.config.password = decrypt(secret, this.config.password);
                this.config.username = decrypt(secret, this.config.username);
            } catch (e) {
                this.log.warn(`Could not decrypt credentials: ${(e as Error).message}`);
            }
        }

        await this.syncRegaScripts();

        this.hmRpcRegex = this.buildRpcRegex();

        this.main();
    }

    /**
     * Copies the ReGa scripts of this package into the file storage, so that a user can adapt them
     * without changing the installation. They are only overwritten if the shipped version changed.
     */
    private async syncRegaScripts(): Promise<void> {
        try {
            // update script files if necessary - first ensure meta object is there
            await this.setForeignObjectNotExistsAsync('hm-rega', {
                type: 'meta',
                common: {
                    name: 'hm-rega',
                    type: 'meta.folder',
                },
                native: {},
            });

            const scriptDir = join(__dirname, '..', 'regascripts');

            // read all files
            const regascripts = readdirSync(scriptDir);
            for (const regascript of regascripts) {
                const sourceFile = readFileSync(join(scriptDir, regascript), 'utf-8');
                let targetFile: { file: string | Buffer } | undefined;

                try {
                    targetFile = await this.readFileAsync('hm-rega', `regascripts/${regascript}`);
                } catch {
                    this.log.debug(`[REGASCRIPTS] Script ${regascript} does not exist in file storage yet`);
                }

                if (!targetFile || targetFile.file !== sourceFile) {
                    // update file storage
                    await this.writeFileAsync('hm-rega', `regascripts/${regascript}`, sourceFile, {
                        mimeType: 'text/plain',
                    });
                    this.log.info(`[REGASCRIPTS] Successfully updated ${regascript}`);
                } else {
                    this.log.debug(`[REGASCRIPTS] Script ${regascript} is already up-to-date`);
                }
            }
        } catch (e) {
            this.log.warn(`[REGASCRIPTS] Error updating scripts: ${(e as Error).message}`);
        }
    }

    /** Builds up the regex to match the objects of all configured hm-rpc instances */
    private buildRpcRegex(): RegExp {
        const instances: string[] = [];

        if (this.config.rfdEnabled && this.config.rfdAdapter) {
            instances.push(`(${this.config.rfdAdapter.split('.')[1]})`);
        }
        if (this.config.hs485dEnabled && this.config.hs485dAdapter) {
            instances.push(`(${this.config.hs485dAdapter.split('.')[1]})`);
        }
        if (this.config.cuxdEnabled && this.config.cuxdAdapter) {
            instances.push(`(${this.config.cuxdAdapter.split('.')[1]})`);
        }
        if (this.config.hmipEnabled && this.config.hmipAdapter) {
            instances.push(`(${this.config.hmipAdapter.split('.')[1]})`);
        }
        if (this.config.virtualDevicesEnabled && this.config.virtualDevicesAdapter) {
            instances.push(`(${this.config.virtualDevicesAdapter.split('.')[1]})`);
        }

        return new RegExp(`^hm-rpc\\.(${instances.join('|')})\\..+$`);
    }

    /** Periodically triggers a data point on the CCU, so that hm-rpc notices a broken connection */
    private checkInit(id: string): void {
        if (!id) {
            return;
        }

        void this.getForeignObject(`system.adapter.${id}`, (_err, obj) => {
            if (obj?.native?.checkInit && obj.native.checkInitTrigger) {
                const interval = parseInt(obj.native.checkInitInterval, 10);

                // Fix error in config
                if (obj.native.checkInitTrigger === 'BidCos-RF:50.PRESS_LONG') {
                    obj.native.checkInitTrigger = 'BidCos-RF.BidCoS-RF:50.PRESS_LONG';
                }

                const triggerId: string = obj.native.checkInitTrigger;

                if (!this.checkInterval[id]) {
                    const timer = this.setInterval(() => {
                        if (this.rega) {
                            // BidCos-RF.BidCoS-RF:50.PRESS_LONG
                            this.log.debug(`Set check init state ${triggerId} to true`);
                            this.rega.script(`dom.GetObject("${triggerId}").State(1);`);
                        }
                    }, interval * 500);

                    if (timer) {
                        this.checkInterval[id] = timer;
                    }
                }
            }
        });
    }

    private main(): void {
        this.config.reconnectionInterval = Math.round(Number(this.config.reconnectionInterval)) || 30;

        if (this.config.pollingTrigger) {
            this.config.pollingTrigger = this.config.pollingTrigger.replace(':', '.').replace(FORBIDDEN_CHARS, '_');

            if (this.config.pollingTrigger.match(/^BidCoS-RF/)) {
                this.pollingTrigger = `${this.config.rfdAdapter}.${this.config.pollingTrigger}`;
            } else {
                this.pollingTrigger = `${this.config.hs485dAdapter}.${this.config.pollingTrigger}`;
            }

            this.log.info(`subscribe ${this.pollingTrigger}`);
            this.subscribeForeignStates(this.pollingTrigger);
        }

        this.subscribeStates('*');

        const rpcInstances = [
            { adapter: this.config.rfdAdapter, enabled: this.config.rfdEnabled },
            { adapter: this.config.cuxdAdapter, enabled: this.config.cuxdEnabled },
            { adapter: this.config.hmipAdapter, enabled: this.config.hmipEnabled },
            { adapter: this.config.hs485dAdapter, enabled: this.config.hs485dEnabled },
            { adapter: this.config.virtualDevicesAdapter, enabled: this.config.virtualDevicesEnabled },
        ];

        for (const { adapter, enabled } of rpcInstances) {
            if (!adapter || !enabled) {
                continue;
            }
            this.subscribeForeignStates(`${adapter}.updated`);
            this.subscribeForeignStates(`${adapter}.info.connection`);
            this.subscribeForeignStates(`${adapter}.*_ALARM`);
            // the init check has always been done on the rfd instance only
            this.checkInit(this.config.rfdAdapter);
        }

        // if port is default, we can assume that ssl port is default too
        if (this.config.useHttps && (!this.config.homematicPort || Number(this.config.homematicPort) === 8181)) {
            this.config.homematicPort = 48181;
        }

        this.rega = new Rega({
            ccuIp: this.config.homematicAddress,
            webinterfacePort: Number(this.config.webinterfacePort) || (this.config.useHttps ? 443 : 80),
            port: Number(this.config.homematicPort),
            reconnectionInterval: this.config.reconnectionInterval,
            logger: this.log,
            readFile: (adapterName, fileName) => this.readFileAsync(adapterName, fileName),
            secure: this.config.useHttps,
            username: this.config.username,
            password: this.config.password,
            ready: err => void this.onRegaReady(err),
        });
    }

    /** Called by the ReGa connection on every connection state change */
    private async onRegaReady(err?: RegaError): Promise<void> {
        if (this.unloaded) {
            return;
        }

        if (err) {
            if (err === 'ReGaHSS down') {
                this.log.error(`ReGaHSS ${this.config.homematicAddress} down`);
                this.ccuReachable = true;
            } else if (err === 'CCU unreachable') {
                this.log.error(`CCU ${this.config.homematicAddress} unreachable`);
                this.ccuReachable = false;
            } else {
                this.log.error(err);
                this.ccuReachable = false;
            }

            this.ccuRegaUp = false;
            await this.updateConnectionStates(false);
            return;
        }

        this.log.info(`ReGaHSS ${this.config.homematicAddress} up`);
        this.ccuReachable = true;
        this.ccuRegaUp = true;
        await this.updateConnectionStates(true);

        await this.rega?.checkTime();

        if (this.config.syncVariables) {
            await this.getServiceMsgs();
        }

        // get Devices before datapoints to know which states exist
        await this.syncDevices();
        await this.getDatapoints();

        if (this.config.syncDutyCycle) {
            await this.getDutyCycle();
        }

        if (this.config.syncVariables) {
            await this.getVariables();
        }

        if (this.config.syncPrograms) {
            await this.getPrograms();
        }

        if (this.config.syncRooms && this.config.enumRooms) {
            await this.getRooms();
        }

        if (this.config.syncFunctions && this.config.enumFunctions) {
            await this.getFunctions();
        }

        if (this.config.syncFavorites && this.config.enumFavorites) {
            await this.getFavorites();
        }
    }

    private async updateConnectionStates(connected: boolean): Promise<void> {
        try {
            await this.setState('info.connection', connected, true);
            await this.setState('info.ccuReachable', this.ccuReachable, true);
            await this.setState('info.ccuRegaUp', this.ccuRegaUp, true);
        } catch {
            // ignore
        }
    }

    private onUnload(callback: () => void): void {
        this.unloaded = true;

        if (this.pollingTimer) {
            this.clearInterval(this.pollingTimer);
            this.pollingTimer = null;
        }
        if (this.pollingTimerDC) {
            this.clearInterval(this.pollingTimerDC);
            this.pollingTimerDC = null;
        }
        if (this.afterReconnect) {
            this.clearTimeout(this.afterReconnect);
            this.afterReconnect = null;
        }
        for (const id of Object.keys(this.checkInterval)) {
            this.clearInterval(this.checkInterval[id]);
            delete this.checkInterval[id];
        }

        this.rega?.destroy();
        this.rega = null;

        void (async () => {
            try {
                await this.setState('info.connection', false, true);
                await this.setState('info.ccuReachable', false, true);
                await this.setState('info.ccuRegaUp', false, true);
            } catch {
                // ignore
            }
            callback();
        })();
    }

    // -----------------------------------------------------------------------------------------
    // Event handlers
    // -----------------------------------------------------------------------------------------

    private async onStateChange(id: string, state: ioBroker.State | null | undefined): Promise<void> {
        if (!state || state.ack) {
            if (state && id === this.pollingTrigger) {
                this.log.info('pollingTrigger');
                if (this.config.syncVariables) {
                    void this.pollVariables();
                }
            }
        } else if (id.match(/_ALARM$/)) {
            this.setTimeout(() => this.acknowledgeAlarm(id), 100);
        } else if (this.isRpcState(id, 'updated')) {
            // Read devices anew if hm-rpc updated the list of devices
            if (state.val) {
                this.setTimeout(() => void this.syncDevices(), 1_000);
                try {
                    // Reset flag
                    await this.setForeignStateAsync(id, false, true);
                } catch {
                    // ignore
                }
            }
        } else if (this.isRpcState(id, 'info.connection')) {
            if (state.val) {
                if (!this.afterReconnect) {
                    this.log.debug(`Connection of "${id}" detected. Read variables anew in 60 seconds`);
                    this.afterReconnect =
                        this.setTimeout(() => {
                            this.afterReconnect = null;
                            if (this.config.syncVariables) {
                                void this.getVariables();
                            }
                        }, 60_000) ?? null;
                }
            } else if (this.afterReconnect) {
                this.log.debug(`Disconnection of "${id}" detected. Cancel read of variables`);
                this.clearTimeout(this.afterReconnect);
                this.afterReconnect = null;
            }
        } else {
            this.log.debug(`stateChange ${id} ${JSON.stringify(state)}`);

            const rid = id.split('.');

            if (rid[3] === 'ProgramExecute') {
                if (state.val) {
                    this.log.debug(`ProgramExecute ${rid[2]}`);
                    this.states[id] = { ack: false };
                    this.rega?.script(`dom.GetObject(${rid[2]}).ProgramExecute();`);
                }
            } else if (rid[3] === 'Active') {
                this.log.debug(`Active ${rid[2]} ${state.val}`);
                this.states[id] = { ack: false };
                this.rega?.script(`dom.GetObject(${rid[2]}).Active(${JSON.stringify(state.val)})`);
            } else {
                if (rid[2] === 'alarms') {
                    rid[2] = '40';
                }
                if (rid[2] === 'maintenance') {
                    rid[2] = '41';
                }

                if (!this.states[id] && id !== this.pollingTrigger) {
                    if (!id.match(/\.updated$/)) {
                        this.log.warn(`Got unexpected ID: ${id}`);
                    }
                    return;
                }

                this.log.debug(`Set state ${rid[2]}: ${state.val}`);
                this.states[id] = { ack: false };
                this.rega?.script(`dom.GetObject(${rid[2]}).State(${JSON.stringify(state.val)})`);
            }
        }
    }

    /** True if the given ID is the `suffix` state of one of the configured hm-rpc instances */
    private isRpcState(id: string, suffix: string): boolean {
        return (
            id === `${this.config.rfdAdapter}.${suffix}` ||
            id === `${this.config.virtualDevicesAdapter}.${suffix}` ||
            id === `${this.config.cuxdAdapter}.${suffix}` ||
            id === `${this.config.hmipAdapter}.${suffix}` ||
            id === `${this.config.hs485dAdapter}.${suffix}`
        );
    }

    private async onMessage(obj: ioBroker.Message): Promise<void> {
        if (!obj) {
            return;
        }

        this.log.debug(`[MSSG] Received: ${JSON.stringify(obj)}`);

        // requests of the admin configuration dialog
        if (obj.command === 'getCcuAddresses' || obj.command === 'getRpcInstances') {
            const options = await this.getRpcOptions(
                obj.command,
                obj.message as {
                    type: string;
                    ip: string;
                },
            );
            this.sendTo(obj.from, obj.command, options, obj.callback);
            return;
        }

        if (this.ccuRegaUp && this.rega) {
            this.rega.script(obj.message as string, data =>
                this.sendTo(obj.from, obj.command, { result: data, error: null }, obj.callback),
            );
        } else {
            this.sendTo(obj.from, obj.command, { result: null, error: 'Not connected' }, obj.callback);
        }
    }

    /**
     * Delivers the options of the `homematicAddress` and `<x>Adapter` controls of the admin UI
     *
     * @param command `getCcuAddresses` for the CCU addresses, `getRpcInstances` for the instances
     * @param message `{ type, ip }` - only used by `getRpcInstances`
     */
    private async getRpcOptions(
        command: string,
        message?: {
            type: string;
            ip: string;
        },
    ): Promise<SelectOption[]> {
        let instances: ioBroker.GetObjectViewItem<ioBroker.InstanceObject>[] = [];

        try {
            const doc = await this.getObjectViewAsync('system', 'instance', {
                startkey: 'system.adapter.hm-rpc.',
                endkey: 'system.adapter.hm-rpc.香',
            });
            instances = doc?.rows ?? [];
        } catch (e) {
            this.log.warn(`Could not read hm-rpc instances: ${(e as Error).message}`);
        }

        if (command === 'getCcuAddresses') {
            const addresses: string[] = [];
            for (const row of instances) {
                const address: string | undefined = row.value?.native?.homematicAddress;
                if (address && !addresses.includes(address)) {
                    addresses.push(address);
                }
            }
            return addresses.map(address => ({ value: address, label: address }));
        }

        const type: string | undefined = message?.type;
        const ip: string | undefined = message?.ip;
        const options: SelectOption[] = [{ value: '', label: 'none' }];

        for (const row of instances) {
            const native = row.value?.native;
            if (!native?.homematicAddress) {
                continue;
            }
            if (ip && native.homematicAddress !== ip) {
                continue;
            }
            if (type && native.daemon !== type && native.type !== type) {
                continue;
            }
            const id = row.id.replace('system.adapter.', '');
            options.push({ value: id, label: id });
        }

        return options;
    }

    // -----------------------------------------------------------------------------------------
    // Helpers
    // -----------------------------------------------------------------------------------------

    /** Decodes a string which the CCU has written with `WriteURL()` */
    private unescape(text: string): string;
    private unescape<T>(text: T): T;
    private unescape(text: unknown): unknown {
        if (typeof text !== 'string') {
            return text;
        }
        if (!text) {
            return '';
        }

        let result = text;
        for (const char of chars) {
            result = result.replace(char.regex, char.replace);
        }

        try {
            return decodeURI(result);
        } catch {
            this.log.error(`Cannot decode :${result}`);
            return result;
        }
    }

    /** Maps a CCU interface to the hm-rpc instance of that interface, if it is enabled */
    private instanceOfEnabledInterface(iface: string): string | null {
        switch (iface) {
            case 'BidCos-RF':
                return this.config.rfdEnabled ? this.config.rfdAdapter : null;
            case 'BidCos-Wired':
                return this.config.hs485dEnabled ? this.config.hs485dAdapter : null;
            case 'CUxD':
                return this.config.cuxdEnabled ? this.config.cuxdAdapter : null;
            case 'HmIP-RF':
                return this.config.hmipEnabled ? this.config.hmipAdapter : null;
            case 'VirtualDevices':
                return this.config.virtualDevicesEnabled ? this.config.virtualDevicesAdapter : null;
            default:
                return null;
        }
    }

    /**
     * Same as {@link instanceOfEnabledInterface}, but the enum synchronization has always looked at
     * the configured instance instead of the "enabled" flag (except for the virtual devices).
     */
    private instanceOfConfiguredInterface(iface: string): string | null {
        switch (iface) {
            case 'BidCos-RF':
                return this.config.rfdAdapter || null;
            case 'BidCos-Wired':
                return this.config.hs485dAdapter || null;
            case 'CUxD':
                return this.config.cuxdAdapter || null;
            case 'HmIP-RF':
                return this.config.hmipAdapter || null;
            case 'VirtualDevices':
                return this.config.virtualDevicesEnabled ? this.config.virtualDevicesAdapter : null;
            default:
                return null;
        }
    }

    /**
     * Merges the members of a freshly read enum into the existing one. Members of hm-rpc instances
     * which are no longer reported by the CCU are removed, everything else is kept.
     *
     * @param obj the enum as it was read from the CCU
     * @param addedText log text for a new member
     * @param removedText log text for a removed member
     * @returns false if the enum could not be read, in this case the synchronization is aborted
     */
    private async syncEnum(
        obj: RegaEnumObject,
        addedText: (member: string) => string,
        removedText: (member: string) => string,
    ): Promise<boolean> {
        let oldObj: RegaEnumObject | null | undefined;

        try {
            oldObj = (await this.getForeignObjectAsync(obj._id)) as RegaEnumObject | null | undefined;
        } catch (e) {
            this.log.error(`Could not update enum ${obj._id}: ${(e as Error).message}`);
            return false;
        }

        const newMembers = obj.common.members ?? [];
        let changed = false;

        if (!oldObj) {
            oldObj = obj;
            changed = true;
        } else {
            oldObj.common = oldObj.common || ({} as ioBroker.EnumCommon);
            oldObj.common.members = oldObj.common.members || [];

            for (const newMember of newMembers) {
                // Check if a new channel was added
                if (!oldObj.common.members.includes(newMember)) {
                    changed = true;
                    oldObj.common.members.push(newMember);
                    this.log.info(addedText(newMember));
                }
            }

            // do it reverse, because we delete own elements in loop
            for (let i = oldObj.common.members.length - 1; i >= 0; i--) {
                const oldMember = oldObj.common.members[i];
                // Check if a channel has been removed
                if (!newMembers.includes(oldMember) && this.hmRpcRegex.test(oldMember)) {
                    changed = true;
                    oldObj.common.members.splice(i, 1);
                    this.log.info(removedText(oldMember));
                }
            }
        }

        if (changed) {
            await this.setForeignObjectAsync(obj._id, oldObj);
        }

        return true;
    }

    /**
     * Converts the duty cycle output to a real JSON array string
     *
     * @param data duty cycle string as printed by `dutycycle.fn`
     */
    private static convertDataToJSONArray(data: string): string {
        data = data.replace(/\r/gm, '');
        data = data.replace(/\n/gm, '');
        data = data.replace(/\{/g, '');
        data = data.replace(/\}/g, '');

        const jsonArray: RegaDutyCycle[] = [];

        data.split('ADDRESS').forEach(item => {
            if (item !== null && item !== '' && item !== undefined) {
                const jsonObj = {} as RegaDutyCycle;

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

    /**
     * Adds a new object and sets its state afterward
     *
     * @param obj object to set
     * @param val state value to set
     */
    private async addNewStateOrObject(
        obj: ioBroker.SettableStateObject & { _id: string },
        val: RegaValue,
    ): Promise<void> {
        if (!this.objects[obj._id]) {
            this.objects[obj._id] = true;
            await this.extendForeignObjectAsync(obj._id, obj);
        }

        const value = typeof val === 'string' ? this.unescape(val) : val;

        if (!this.states[obj._id] || !this.states[obj._id].ack || this.states[obj._id].val !== value) {
            this.states[obj._id] = { val: value, ack: true };
            await this.setForeignStateAsync(obj._id, this.states[obj._id] as ioBroker.SettableState);
        }
    }

    /**
     * Updates a state in the cache and in the database
     *
     * @param fullId id of the state
     * @param val value of the state
     */
    private async updateNewState(fullId: string, val: RegaValue): Promise<void> {
        const value = typeof val === 'string' ? this.unescape(val) : val;

        if (!this.states[fullId] || !this.states[fullId].ack || this.states[fullId].val !== value) {
            this.states[fullId] = { val: value, ack: true };
            await this.setForeignStateAsync(fullId, value, true);
        }
    }

    // -----------------------------------------------------------------------------------------
    // Polling
    // -----------------------------------------------------------------------------------------

    /** Polls all variables (invisible too, if configured) and sets them to their according states */
    private async pollVariables(): Promise<void> {
        const raw = await this.rega?.runScriptFile(this.config.showInvSysVar ? 'pollingInv' : 'polling');
        if (!raw) {
            return;
        }

        let data: RegaPollResult;
        try {
            // CCU sometimes uses -inf or nan, we should handle them as null
            data = JSON.parse(raw.replace(/\n/gm, '').replace(/-inf|nan/g, 'null'));
        } catch {
            this.log.error(`Cannot parse answer for polling: ${raw}`);
            return;
        }

        for (let id of Object.keys(data)) {
            let val = data[id][0];
            const timestamp = new Date(data[id][1]).getTime();

            if (typeof val === 'string') {
                val = this.unescape(val);
            }

            id = this.unescape(id).replace(FORBIDDEN_CHARS, '_');

            if (id === '40') {
                id = 'alarms';
            } else if (id === '41') {
                // If number of alarms changed
                id = 'maintenance';
            }

            const fullId = `${this.namespace}.${id}`;

            if (id === 'maintenance' && (!this.states[fullId] || this.states[fullId].val !== val)) {
                // poll service messages but do not skip this id, because #servicemsgs should be set
                this.setTimeout(() => void this.pollServiceMsgs(), 1_000);
            }

            if (!this.objects[fullId]) {
                this.log.info(`Variable received for not-known dp ${id}, requesting Variables`);
                await this.getVariables();
                return;
            }

            const cached = this.states[fullId];

            if (!cached || !cached.ack || cached.val !== val || (cached.ts && cached.ts !== timestamp)) {
                this.states[fullId] = { val, ack: true, ts: timestamp };
                try {
                    await this.setForeignStateAsync(fullId, val, true);
                } catch {
                    // ignore
                }
            }
        }
    }

    /** Polls duty cycle, firmware version, rega version and the object counters */
    private async pollDutyCycle(): Promise<void> {
        const rawData = await this.rega?.runScriptFile('dutycycle');
        const rawSysInfo = await this.rega?.runScriptFile('system');

        if (!rawData) {
            return;
        }

        let sysInfo: RegaSystemInfo;
        try {
            sysInfo = JSON.parse(rawSysInfo!);
        } catch {
            this.log.error(`Cannot parse system info: ${rawSysInfo}`);
            return;
        }

        const ccuType = `CCU${typeof sysInfo.ccuVersion === 'string' ? sysInfo.ccuVersion.split('.')[0] : ''}`;

        let data: RegaDutyCycle[];
        try {
            data = JSON.parse(HmRega.convertDataToJSONArray(rawData));
        } catch {
            this.log.error(`Cannot parse answer for dutycycle: ${rawData}`);
            return;
        }

        for (const dp of data) {
            const id = this.unescape(dp.ADDRESS).replace(FORBIDDEN_CHARS, '_');
            const prefix = `${this.namespace}.${id}.0`;

            // DUTY_CYCLE State:
            if (dp.DUTY_CYCLE) {
                const dutyCycle = parseInt(dp.DUTY_CYCLE);
                await this.updateNewState(`${prefix}.DUTY_CYCLE`, dutyCycle === -1 ? null : dutyCycle);
                this.log.debug(`Dutycycle: ${prefix}.DUTY_CYCLE => ${dutyCycle}`);
            }

            // CONNECTED State:
            if (dp.CONNECTED) {
                await this.updateNewState(`${prefix}.CONNECTED`, parseInt(dp.CONNECTED));
                this.log.debug(`Dutycycle: ${prefix}.CONNECTED => ${parseInt(dp.CONNECTED)}`);
            }

            // DEFAULT State:
            if (dp.DEFAULT) {
                await this.updateNewState(`${prefix}.DEFAULT`, parseInt(dp.DEFAULT));
                this.log.debug(`Dutycycle: ${prefix}.DEFAULT => ${parseInt(dp.DEFAULT)}`);
            }

            // FIRMWARE_VERSION State:
            if (sysInfo.ccuVersion) {
                await this.updateNewState(`${prefix}.FIRMWARE_VERSION`, sysInfo.ccuVersion);
                this.log.debug(`Dutycycle: ${prefix}.FIRMWARE_VERSION => ${sysInfo.ccuVersion}`);
            }

            // Rega Version
            if (sysInfo.regaVersion) {
                await this.updateNewState(`${prefix}.regaVersion`, sysInfo.regaVersion);
                this.log.debug(`Rega Version: ${prefix}.regaVersion => ${sysInfo.regaVersion}`);
            }

            // Build Label Rega
            if (sysInfo.buildLabel) {
                await this.updateNewState(`${prefix}.buildLabel`, sysInfo.buildLabel);
                this.log.debug(`Build Label: ${prefix}.buildLabel => ${sysInfo.buildLabel}`);
            }

            // Count Devices
            if (sysInfo.countDevices) {
                await this.updateNewState(`${prefix}.countDevices`, sysInfo.countDevices);
                this.log.debug(`Count Devices: ${prefix}.countDevices => ${sysInfo.countDevices}`);
            }

            // Count Channels
            if (sysInfo.countChannels) {
                await this.updateNewState(`${prefix}.countChannels`, sysInfo.countChannels);
                this.log.debug(`Count Channels: ${prefix}.countChannels => ${sysInfo.countChannels}`);
            }

            // Count Datapoints
            if (sysInfo.countDatapoints) {
                await this.updateNewState(`${prefix}.countDatapoints`, sysInfo.countDatapoints);
                this.log.debug(`Count Datapoints: ${prefix}.countDatapoints => ${sysInfo.countDatapoints}`);
            }

            // Count Programs
            if (sysInfo.countPrograms) {
                await this.updateNewState(`${prefix}.countPrograms`, sysInfo.countPrograms);
                this.log.debug(`Count Programs: ${prefix}.countPrograms => ${sysInfo.countPrograms}`);
            }

            // Count System Variables
            if (sysInfo.countSystemVars) {
                await this.updateNewState(`${prefix}.countSystemVariables`, sysInfo.countSystemVars);
                this.log.debug(`Count System variables: ${prefix}.countSystemVariables => ${sysInfo.countSystemVars}`);
            }

            // CCU-Type - User can update e.g. Raspmatic w/o restarting adapter
            const obj: ioBroker.SettableDeviceObject & { _id: string } = {
                _id: `${this.namespace}.${id}`,
                type: 'device',
                common: {
                    name: ccuType,
                },
                native: {
                    ADDRESS: this.unescape(dp.ADDRESS),
                    TYPE: ccuType,
                },
            };

            const existing = await this.getObjectAsync(obj._id);
            if (!existing || !existing.common || obj.common.name !== existing.common.name) {
                void this.extendForeignObject(obj._id, obj);
            }
        }
    }

    /** Polls the programs from the CCU and sets their according enabled/activated states */
    private async pollPrograms(): Promise<void> {
        const raw = await this.rega?.runScriptFile('programs');
        if (!raw) {
            return;
        }

        let data: Record<string, RegaProgram>;
        try {
            data = JSON.parse(raw.replace(/\n/gm, ''));
        } catch {
            this.log.error(`Cannot parse answer for programs: ${raw}`);
            return;
        }

        for (const dp of Object.keys(data)) {
            const id = this.unescape(dp).replace(FORBIDDEN_CHARS, '_');
            const val = data[dp].Active;

            const fullId = `${this.namespace}.${id}.Active`;

            if (!this.objects[fullId]) {
                this.log.info(`Program received for not-known dp ${id}, requesting programs`);
                await this.getPrograms();
                return;
            }

            if (!this.states[fullId] || !this.states[fullId].ack || this.states[fullId].val !== val) {
                this.states[fullId] = { val, ack: true };
                try {
                    await this.setForeignStateAsync(fullId, this.states[fullId] as ioBroker.SettableState);
                } catch {
                    // ignore
                }
            }
        }
    }

    /** Polls all service messages from the CCU and sets the according alarm states */
    private async pollServiceMsgs(): Promise<void> {
        this.log.debug('polling service messages');

        const raw = await this.rega?.runScriptFile('alarms');
        if (!raw) {
            return;
        }

        let data: Record<string, RegaAlarm>;
        try {
            data = JSON.parse(raw.replace(/\n/gm, ''));
        } catch {
            this.log.error(`Cannot parse answer for alarms: ${raw}`);
            return;
        }

        const activeLowbatIds: string[] = [];

        for (const dp of Object.keys(data)) {
            let id = this.unescape(data[dp].Name);
            if (id.match(/^AL-/)) {
                id = id.substring(3);
            }

            const device = this.existingDevices.find(value => id.split(':')[0] === value.split('.')[2]);
            if (!device) {
                this.log.debug(`No instance found for ${id}`);
                continue;
            }

            const instanceNumber = device.split('.')[1];

            id = `hm-rpc.${instanceNumber}.${id.replace(':', '.').replace(FORBIDDEN_CHARS, '_')}_ALARM`;

            if (!this.objects[id]) {
                this.log.info(`Alarm DP received for not-known dp ${id}, requesting Service Messages`);
                await this.getServiceMsgs();
                return;
            }

            const state: CachedState = {
                val: data[dp].AlState,
                ack: true,
                lc: new Date(data[dp].AlOccurrenceTime).getTime(),
                ts: new Date(data[dp].LastTriggerTime).getTime(),
            };

            if (this.isLowBatAlarm(id) && state.val === LOWBAT_ACTIVE_INDICATOR) {
                const [adapterName, instance, deviceName] = id.split('.');
                activeLowbatIds.push(`${adapterName}.${instance}.${deviceName}`);
            }

            const cached = this.states[id];

            if (
                !cached ||
                !cached.ack ||
                cached.val !== state.val ||
                cached.lc !== state.lc ||
                cached.ts !== state.ts
            ) {
                this.states[id] = state;
                try {
                    await this.setForeignStateAsync(id, state as ioBroker.SettableState);
                } catch {
                    // ignore
                }
            }
        }

        return this.registerLowBatNotification(activeLowbatIds);
    }

    private isLowBatAlarm(id: string): boolean {
        return LOWBAT_ALARM_IDS.some(lowbatId => id.endsWith(`.${lowbatId}`));
    }

    /** Acknowledges an alarm on the CCU */
    private acknowledgeAlarm(id: string): void {
        this.log.debug(`[INFO] Acknowledge alarm ${id}`);
        this.states[id] = { ack: false };

        void this.getForeignObject(id, (_err, obj) => {
            if (obj?.native) {
                this.rega?.script(`dom.GetObject(${obj.native.DP}).AlReceipt();`);
                this.setTimeout(() => void this.pollServiceMsgs(), 1_000);
            }
        });
    }

    // -----------------------------------------------------------------------------------------
    // Synchronization
    // -----------------------------------------------------------------------------------------

    /** Gets all service messages from the CCU, creates the alarm objects and sets their states */
    private async getServiceMsgs(): Promise<void> {
        try {
            const res = await this.getObjectViewAsync('system', 'device', {
                startkey: 'hm-rpc.',
                endkey: 'hm-rpc.香',
            });
            this.existingDevices = res.rows.map(obj => obj.id);
        } catch (e) {
            this.log.error(`Could not determine existing devices: ${(e as Error).message}`);
        }

        this.log.debug('create service messages');

        const raw = await this.rega?.runScriptFile('alarms');
        if (!raw) {
            return;
        }

        let data: Record<string, RegaAlarm>;
        try {
            data = JSON.parse(raw.replace(/\n/gm, ''));
        } catch {
            this.log.error(`Cannot parse answer for alarms: ${raw}`);
            return;
        }

        const activeLowbatIds: string[] = [];

        for (const dp of Object.keys(data)) {
            let id = this.unescape(data[dp].Name);
            if (id.match(/^AL-/)) {
                id = id.substring(3);
            }

            const device = this.existingDevices.find(value => id.split(':')[0] === value.split('.')[2]);
            if (!device) {
                this.log.debug(`No instance found for ${id}`);
                continue;
            }

            const instanceNumber = device.split('.')[1];

            id = `hm-rpc.${instanceNumber}.${id.replace(':', '.').replace(FORBIDDEN_CHARS, '_')}_ALARM`;

            // create object if not created
            if (!this.objects[id]) {
                this.objects[id] = true;
                try {
                    const parent = await this.getForeignObjectAsync(id.substring(0, id.lastIndexOf('.')));
                    const name = parent?.common?.name ? `${nameToString(parent.common.name)}.${id.split('.')[4]}` : id;

                    const obj = await this.getForeignObjectAsync(id);
                    if (!obj || !obj.native || obj.native.DP !== dp || !obj.common || obj.common.type !== 'number') {
                        await this.setForeignObjectAsync(id, {
                            type: 'state',
                            common: {
                                name,
                                type: 'number',
                                role: 'indicator.alarm',
                                read: true,
                                write: true,
                                def: 0,
                                states: {
                                    0: 'NO ALARM',
                                    1: 'ALARM',
                                    2: 'ACKNOWLEDGED',
                                },
                            },
                            native: {
                                Name: name,
                                TypeName: 'ALARM',
                                DP: dp,
                            },
                        });
                    }
                } catch (e) {
                    this.log.error(`Could not update object of "${id}": ${(e as Error).message}`);
                }
            }

            const state: CachedState = {
                val: data[dp].AlState,
                ack: true,
                lc: new Date(data[dp].AlOccurrenceTime).getTime(),
                ts: new Date(data[dp].LastTriggerTime).getTime(),
            };

            if (this.isLowBatAlarm(id) && state.val === LOWBAT_ACTIVE_INDICATOR) {
                const [adapterName, instance, deviceName] = id.split('.');
                activeLowbatIds.push(`${adapterName}.${instance}.${deviceName}`);
            }

            const cached = this.states[id];

            if (
                !cached ||
                !cached.ack ||
                cached.val !== state.val ||
                cached.lc !== state.lc ||
                cached.ts !== state.ts
            ) {
                this.states[id] = state;
                try {
                    await this.setForeignStateAsync(id, state as ioBroker.SettableState);
                } catch (e) {
                    this.log.error(`Could not update state of "${id}": ${(e as Error).message}`);
                }
            }
        }

        return this.registerLowBatNotification(activeLowbatIds);
    }

    /**
     * Registers a notification for low battery devices if new devices are affected
     *
     * @param activeLowbatIds all devices which have a low battery level
     */
    private async registerLowBatNotification(activeLowbatIds: string[]): Promise<void> {
        const names = await Promise.all(
            activeLowbatIds.map(async id => {
                const obj = await this.getForeignObjectAsync(id);

                if (!obj) {
                    return id;
                }

                return nameToString(obj.common.name);
            }),
        );

        const namesStr = JSON.stringify(names);

        const lowbatState = await this.getStateAsync('info.lowbatDevices');
        await this.setState('info.lowbatDevices', namesStr, true);

        const knownDevices: string[] = typeof lowbatState?.val === 'string' ? JSON.parse(lowbatState.val) : [];
        const hasNewLowbat = names.some(name => !knownDevices.includes(name));

        if (!hasNewLowbat) {
            return;
        }

        await this.registerNotification('hm-rega', 'lowbat', names.join(', '));
    }

    /** Gets all programs from the CCU and creates the according objects and states */
    private async getPrograms(): Promise<void> {
        try {
            const doc = await this.getObjectViewAsync('hm-rega', 'programs', {
                startkey: `hm-rega.${this.instance}.`,
                endkey: `hm-rega.${this.instance}.香`,
            });

            const response: string[] = [];

            if (doc) {
                for (const row of doc.rows) {
                    const id = row.value?._id.split('.').pop();
                    if (id) {
                        response.push(id);
                    }
                }
                this.log.info(`got ${doc.rows.length} programs`);
            } else {
                this.log.info('got 0 programs');
            }

            const raw = await this.rega?.runScriptFile('programs');

            let data: Record<string, RegaProgram>;
            try {
                data = JSON.parse(raw!.replace(/\n/gm, ''));
            } catch {
                this.log.error(`Cannot parse answer for programs: ${raw}`);
                return;
            }

            let count = 0;

            for (const dp of Object.keys(data)) {
                const id = this.unescape(dp).replace(FORBIDDEN_CHARS, '_');
                count += 1;

                const name = this.unescape(data[dp].Name);

                let fullId = `${this.namespace}.${id}`;
                if (!this.objects[fullId]) {
                    this.objects[fullId] = true;
                    await this.setForeignObjectAsync(fullId, {
                        type: 'channel',
                        common: {
                            name,
                            enabled: true,
                        },
                        native: {
                            Name: name,
                            TypeName: data[dp].TypeName,
                            // `programs.fn` writes `PrgInfo`, this has always read `DPInfo`
                            PrgInfo: this.unescape(data[dp].DPInfo),
                        },
                    } as ioBroker.SettableChannelObject);
                }

                const val = data[dp].Active;

                fullId = `${this.namespace}.${id}.ProgramExecute`;

                if (!this.objects[fullId]) {
                    this.objects[fullId] = true;
                    await this.extendForeignObjectAsync(fullId, {
                        type: 'state',
                        common: {
                            name: `${name} execute`,
                            type: 'boolean',
                            role: 'action.execute',
                            read: true,
                            write: true,
                        },
                        native: {},
                    });
                }

                if (!this.states[fullId] || !this.states[fullId].ack || this.states[fullId].val !== false) {
                    this.states[fullId] = { val: false, ack: true };
                    await this.setForeignStateAsync(fullId, this.states[fullId] as ioBroker.SettableState);
                }

                fullId = `${this.namespace}.${id}.Active`;

                if (!this.objects[fullId]) {
                    this.objects[fullId] = true;
                    await this.extendForeignObjectAsync(fullId, {
                        type: 'state',
                        common: {
                            name: `${name} enabled`,
                            type: 'boolean',
                            role: 'state.enabled',
                            read: true,
                            write: true,
                        },
                        native: {},
                    });
                }

                if (!this.states[fullId] || !this.states[fullId].ack || this.states[fullId].val !== val) {
                    this.states[fullId] = { val, ack: true };
                    await this.setForeignStateAsync(fullId, this.states[fullId] as ioBroker.SettableState);
                }

                // if we already have the program from CCU locally, remove it
                if (response.includes(id)) {
                    response.splice(response.indexOf(id), 1);
                }
            }

            this.log.info(`added/updated ${count} programs`);

            // only left what has not been in data
            for (const entry of response) {
                await this.delObjectAsync(entry, { recursive: true });
            }
            this.log.info(`deleted ${response.length} programs`);
        } catch (e) {
            this.log.error(`Could not update programs: ${(e as Error).message}`);
        }
    }

    /** Gets all functions from the CCU and synchronizes them with the according enums */
    private async getFunctions(): Promise<void> {
        const raw = await this.rega?.runScriptFile('functions');

        this.log.info(`update functions to ${this.config.enumFunctions}`);

        let data: Record<string, RegaEnum>;
        try {
            data = JSON.parse(raw!.replace(/\n/gm, ''));
        } catch {
            this.log.error(`Cannot parse answer for functions: ${raw}`);
            return;
        }

        for (const regaId of Object.keys(data)) {
            const members = this.collectEnumMembers(data[regaId].Channels, iface =>
                this.instanceOfEnabledInterface(iface),
            );

            // if we have dots into it, we should replace it
            const name = this.unescape(data[regaId].Name).replace(/\./g, '_');
            const desc = this.unescape(data[regaId].EnumInfo);

            const obj: RegaEnumObject = {
                _id: `${this.config.enumFunctions}.${
                    words[name] ? words[name].en.replace(FORBIDDEN_CHARS, '_').replace(/\s/g, '_') : name
                }`,
                desc,
                type: 'enum',
                common: {
                    name: words[name] || name,
                    members,
                },
                native: {
                    Name: name,
                    TypeName: 'ENUM',
                    EnumInfo: desc,
                },
            };

            const ok = await this.syncEnum(
                obj,
                member => `${member} has been added to functions ${name}`,
                member => `${member} has been removed from functions ${name}`,
            );

            if (!ok) {
                return;
            }
        }

        await this.setForeignObjectNotExistsAsync(this.config.enumFunctions, {
            type: 'enum',
            common: {
                name: 'Functions',
                members: [],
            },
            native: {},
        });
    }

    /** Gets all rooms from the CCU and synchronizes them with the according enums */
    private async getRooms(): Promise<void> {
        const raw = await this.rega?.runScriptFile('rooms');

        this.log.info(`update rooms to ${this.config.enumRooms}`);

        let data: Record<string, RegaEnum>;
        try {
            data = JSON.parse(raw!.replace(/\n/gm, ''));
        } catch {
            this.log.error(`Cannot parse answer for rooms: ${raw}`);
            return;
        }

        // iterate over rooms
        for (const regaId of Object.keys(data)) {
            const members = this.collectEnumMembers(
                data[regaId].Channels,
                iface => this.instanceOfConfiguredInterface(iface),
                true,
            );

            // if we have dots into it, we should replace it
            const name = this.unescape(data[regaId].Name).replace(/\./g, '_');
            const desc = this.unescape(data[regaId].EnumInfo);

            const obj: RegaEnumObject = {
                _id: `${this.config.enumRooms}.${
                    words[name] ? words[name].en.replace(FORBIDDEN_CHARS, '_').replace(/\s/g, '_') : name
                }`,
                type: 'enum',
                common: {
                    name: words[name] || name,
                    desc,
                    members,
                },
                native: {
                    Name: name,
                    TypeName: 'ENUM',
                    EnumInfo: desc,
                },
            };

            const ok = await this.syncEnum(
                obj,
                member => `${member} has been added to room ${name}`,
                member => `${member} has been removed from room ${name}`,
            );

            if (!ok) {
                return;
            }
        }

        await this.setForeignObjectNotExistsAsync(this.config.enumRooms, {
            type: 'enum',
            common: {
                name: 'Rooms',
                members: [],
            },
            native: {},
        });
    }

    /** Gets all favorites of all users from the CCU and synchronizes them with the according enums */
    private async getFavorites(): Promise<void> {
        const raw = await this.rega?.runScriptFile('favorites');

        this.log.info(`update favorites to ${this.config.enumFavorites}`);

        let data: RegaFavorites;
        try {
            data = JSON.parse(raw!.replace(/\n/gm, ''));
        } catch {
            this.log.error(`Cannot parse answer for favorites: ${raw}`);
            return;
        }

        // Create enum favorites if non-existing (can be different to default)
        await this.setForeignObjectNotExistsAsync(this.config.enumFavorites, {
            type: 'enum',
            common: {
                name: 'Favorites',
            },
            native: {},
        });

        for (const rawUser of Object.keys(data)) {
            const user = this.unescape(rawUser).replace(FORBIDDEN_CHARS, '_');

            if (user === '') {
                this.log.debug('Skip favorites of empty user');
                continue;
            }

            try {
                // create every user even if no channels there
                await this.setForeignObjectNotExistsAsync(`${this.config.enumFavorites}.${user}`, {
                    type: 'enum',
                    common: {
                        name: `${user} Favorites`,
                    },
                    native: {},
                });
            } catch (e) {
                this.log.error(`Could not synchronize favorites of user "${user}": ${(e as Error).message}`);
            }

            // every user can have multiple favorite lists
            for (const fav of Object.keys(data[rawUser])) {
                const members: string[] = [];

                for (const channel of data[rawUser][fav].Channels) {
                    if (typeof channel === 'number') {
                        members.push(`${this.namespace}.${channel}`);
                        continue;
                    }

                    const prefix = this.instanceOfConfiguredInterface(channel.Interface);
                    if (prefix === null) {
                        continue;
                    }

                    members.push(
                        `${prefix}.${this.unescape(channel.Address).replace(':', '.').replace(FORBIDDEN_CHARS, '_')}`,
                    );
                }

                const favName = this.unescape(fav);

                const obj: RegaEnumObject = {
                    _id: `${this.config.enumFavorites}.${user}.${favName}`.replace(FORBIDDEN_CHARS, '_'),
                    type: 'enum',
                    common: {
                        name: favName,
                        members,
                    },
                    native: {
                        user,
                        id: data[rawUser][fav].id,
                        TypeName: 'FAVORITE',
                    },
                };

                const ok = await this.syncEnum(
                    obj,
                    member => `${member} has been added to favorites for "${user}" on list "${favName}"`,
                    member => `${member} has been removed from favorites for "${user}" on list "${favName}"`,
                );

                if (!ok) {
                    return;
                }
            }
        }
    }

    /**
     * Builds the member list of an enum out of the channels which the CCU reported
     *
     * @param channels channels of the enum
     * @param resolve maps a CCU interface to the configured hm-rpc instance
     * @param unescapeAddress true if the address has to be unescaped (rooms and favorites do it)
     */
    private collectEnumMembers(
        channels: RegaChannelRef[],
        resolve: (iface: string) => string | null,
        unescapeAddress = false,
    ): string[] {
        const members: string[] = [];

        for (const channel of channels) {
            const prefix = resolve(channel.Interface);
            if (prefix === null) {
                continue;
            }

            const address = unescapeAddress ? this.unescape(channel.Address) : channel.Address;
            members.push(`${prefix}.${address.replace(':', '.').replace(FORBIDDEN_CHARS, '_')}`);
        }

        return members;
    }

    /** Gets all data points from the CCU and sets the according states of the hm-rpc instances */
    private async getDatapoints(): Promise<void> {
        this.log.info('request state values');

        const raw = await this.rega?.runScriptFile('datapoints');

        let data: RegaDatapoints;
        try {
            data = JSON.parse(raw!.replace(/\n/gm, ''));
        } catch {
            this.log.error(`Cannot parse answer for datapoints: ${raw}`);
            return;
        }

        for (const dp of Object.keys(data)) {
            const tmp = this.unescape(dp).replace(FORBIDDEN_CHARS, '_').split('.');

            if (tmp[2] === 'PRESS_SHORT' || tmp[2] === 'PRESS_LONG') {
                continue;
            }

            const prefix = this.instanceOfEnabledInterface(tmp[0]);
            if (prefix === null) {
                continue;
            }

            const id = `${prefix}.${tmp[1].replace(':', '.').replace(FORBIDDEN_CHARS, '_')}.${tmp[2].replace(FORBIDDEN_CHARS, '_')}`;

            if (this.units === null) {
                this.log.error(
                    `Units is null at getDatapoints, (id: ${id}) please report this to developer with steps to reproduce`,
                );
                continue;
            }

            let value = data[dp];
            const unit = this.units[id];

            // same procedure as hm-rpc, only scales 100%
            if (unit === '100%' || (typeof unit === 'object' && unit.UNIT === '100%')) {
                value = Math.round(parseFloat(String(value)) * 100 * 1000) / 1000;
            }

            const state: CachedState = { val: this.unescape(value), ack: true };

            if (!this.states[id] || this.states[id].val !== state.val || !this.states[id].ack) {
                this.states[id] = state;
                // only set the state if it's a valid dp at RPC API and thus has an object
                if (this.existingStates.includes(id)) {
                    await this.setForeignStateAsync(id, state as ioBroker.SettableState);
                } else {
                    this.log.debug(
                        `Do not set "${JSON.stringify(state)}" to "${id}", because non-existing in corresponding adapter`,
                    );
                }
            }
        }

        this.log.info('Updated all datapoints');

        // free RAM
        this.units = null;
        this.existingStates = [];
    }

    /**
     * Reads all devices/channels from the CCU and renames the objects of the hm-rpc instances
     *
     * @param devices names of the known devices
     * @param channels names of the known channels
     * @param stateNames names of the known states per channel
     */
    private async getDevicesFromRega(
        devices: Record<string, string>,
        channels: Record<string, string>,
        stateNames: Record<string, Record<string, string>>,
    ): Promise<void> {
        // Get all devices, channels and states
        const raw = await this.rega?.runScriptFile('devices');

        let data: Record<string, RegaDevice>;
        try {
            data = JSON.parse(raw!.replace(/\n/gm, ''));
        } catch {
            this.log.error(`Cannot parse answer for devices: ${raw}`);
            return;
        }

        const objs: { _id: string; type: 'device' | 'channel' | 'state'; common: { name: string } }[] = [];

        for (const addr of Object.keys(data)) {
            const prefix = this.instanceOfEnabledInterface(data[addr].Interface);
            if (prefix === null) {
                continue;
            }

            const address = this.unescape(addr);
            const id = `${prefix}.${address.replace(':', '.').replace(FORBIDDEN_CHARS, '_')}`;
            let name = this.unescape(data[addr].Name);

            if (!addr.includes(':')) {
                // device
                if (devices[id] === undefined || (devices[id] !== name && this.config.syncNames)) {
                    objs.push({ _id: id, type: 'device', common: { name } });
                }
            } else {
                if (name.endsWith(` ${address}`)) {
                    // try to get name from a device
                    const parts = id.split('.');
                    const channelIndex = parts.pop();
                    const deviceId = parts.join('.');
                    if (devices[deviceId]) {
                        name = `${devices[deviceId]}:${channelIndex}`;
                    }
                }

                // channel
                if (channels[id] === undefined || (channels[id] !== name && this.config.syncNames)) {
                    objs.push({ _id: id, type: 'channel', common: { name } });
                } else if (!channels[id]) {
                    const parts = id.split('.');
                    const last = parts.pop();
                    const deviceId = parts.join('.');
                    if (devices[deviceId]) {
                        objs.push({ _id: id, type: 'channel', common: { name: `${devices[deviceId]}.${last}` } });
                    }
                }

                if (stateNames[id]) {
                    for (const s of Object.keys(stateNames[id])) {
                        const stateName = `${name}.${s}`;
                        if (!stateNames[id][s] || (stateNames[id][s] !== stateName && this.config.syncNames)) {
                            objs.push({
                                _id: `${id}.${s}`,
                                type: 'state',
                                common: { name: stateName },
                            });
                        }
                    }
                }
            }
        }

        // now rename all objects
        for (const obj of objs) {
            try {
                await this.extendForeignObjectAsync(obj._id, obj);
                this.log.info(`renamed ${obj._id} to "${obj.common.name}"`);
            } catch (e) {
                this.log.warn(`Could not rename object ${obj._id} to "${obj.common.name}": ${(e as Error).message}`);
            }
        }
    }

    /** Reads all states/channels/devices of the hm-rpc instances and renames them after the CCU */
    private async syncDevices(): Promise<void> {
        const channels: Record<string, string> = {};
        const devices: Record<string, string> = {};
        const stateNames: Record<string, Record<string, string>> = {};

        const promises: Promise<void>[] = [];

        if (this.config.rfdEnabled) {
            promises.push(this.addStatesFromInstance(this.config.rfdAdapter, devices, channels, stateNames));
        }
        if (this.config.hs485dEnabled) {
            promises.push(this.addStatesFromInstance(this.config.hs485dAdapter, devices, channels, stateNames));
        }
        if (this.config.cuxdEnabled) {
            promises.push(this.addStatesFromInstance(this.config.cuxdAdapter, devices, channels, stateNames));
        }
        if (this.config.hmipEnabled) {
            promises.push(this.addStatesFromInstance(this.config.hmipAdapter, devices, channels, stateNames));
        }
        if (this.config.virtualDevicesEnabled) {
            promises.push(this.addStatesFromInstance(this.config.virtualDevicesAdapter, devices, channels, stateNames));
        }

        await Promise.all(promises);

        await this.getDevicesFromRega(devices, channels, stateNames);
    }

    /**
     * Adds the state information (min, max, etc.) of a given instance
     *
     * @param instance instance to add the states from
     * @param devices names of the known devices
     * @param channels names of the known channels
     * @param stateNames names of the known states per channel
     */
    private async addStatesFromInstance(
        instance: string,
        devices: Record<string, string>,
        channels: Record<string, string>,
        stateNames: Record<string, Record<string, string>>,
    ): Promise<void> {
        try {
            const doc = await this.getObjectViewAsync('system', 'device', {
                startkey: `${instance}.`,
                endkey: `${instance}.香`,
            });

            if (doc?.rows) {
                for (const row of doc.rows) {
                    if (row.value) {
                        devices[row.id] = nameToString(row.value.common.name);
                    }
                }
            }
        } catch (e) {
            this.log.warn(`Could not add devices from instance ${instance}: ${(e as Error).message}`);
        }

        try {
            const doc = await this.getObjectViewAsync('system', 'channel', {
                startkey: `${instance}.`,
                endkey: `${instance}.香`,
            });

            if (doc?.rows) {
                for (const row of doc.rows) {
                    if (row.value) {
                        channels[row.id] = nameToString(row.value.common.name);
                    }
                }
            }
        } catch (e) {
            this.log.warn(`Could not add channels from instance ${instance}: ${(e as Error).message}`);
        }

        try {
            const doc = await this.getObjectViewAsync('system', 'state', {
                startkey: `${instance}.`,
                endkey: `${instance}.香`,
            });

            if (doc?.rows) {
                this.units = this.units || {};

                for (const row of doc.rows) {
                    if (!row.value) {
                        continue;
                    }

                    const parts = row.id.split('.');
                    const last = parts.pop()!;
                    const id = parts.join('.');

                    this.existingStates.push(row.id);

                    const native = row.value.native;

                    if (native?.UNIT) {
                        let unit: UnitInfo = this.unescape(native.UNIT as string);

                        if (unit === '%' && typeof native.MIN === 'number') {
                            const max = parseFloat(String(native.MAX));
                            unit = {
                                UNIT: '%',
                                MIN: parseFloat(String(native.MIN)),
                                MAX: max === 99 ? 100 : max,
                            };
                        }

                        this.units[row.id] = unit;
                    }

                    stateNames[id] = stateNames[id] || {};
                    stateNames[id][last] = nameToString(row.value.common.name);
                }
            }
        } catch (e) {
            this.log.warn(`Could not add states from instance ${instance}: ${(e as Error).message}`);
        }
    }

    /** Gets all variables from the CCU (also invisible ones if configured) and sets the states */
    private async getVariables(): Promise<void> {
        const doc = await this.getObjectViewAsync('hm-rega', 'variables', {
            startkey: `hm-rega.${this.instance}.`,
            endkey: `hm-rega.${this.instance}.香`,
        });

        const response: string[] = [];

        if (doc) {
            for (const row of doc.rows) {
                const id = row.value?._id.split('.').pop();
                if (id) {
                    response.push(id);
                }
            }
            this.log.info(`got ${doc.rows.length} variables`);
        } else {
            this.log.info('got 0 variables');
        }

        const raw = await this.rega?.runScriptFile(this.config.showInvSysVar ? 'variablesInv' : 'variables');

        let data: Record<string, RegaVariable>;
        try {
            // CCU sometimes uses -inf or nan, we should handle them as null
            data = JSON.parse(raw!.replace(/\n/gm, '').replace(/-inf|nan/g, 'null'));
        } catch {
            this.log.error(`Cannot parse answer for variables: ${raw}`);
            return;
        }

        let count = 0;

        for (const dp of Object.keys(data)) {
            let id = this.unescape(dp).replace(FORBIDDEN_CHARS, '_');
            count += 1;

            const name = this.unescape(data[dp].Name);
            const native = {
                Name: name,
                TypeName: this.unescape(data[dp].TypeName),
                DPInfo: this.unescape(data[dp].DPInfo),
                ValueMin: this.unescape(data[dp].ValueMin),
                ValueMax: this.unescape(data[dp].ValueMax),
                ValueUnit: this.unescape(data[dp].ValueUnit),
                ValueType: this.unescape(data[dp].ValueType),
                ValueSubType: this.unescape(data[dp].ValueSubType),
                ValueList: this.unescape(data[dp].ValueList),
            };

            const common: ioBroker.StateCommon = {
                name,
                type: COMMON_TYPES[data[dp].ValueType],
                read: true,
                write: true,
                role: 'state',
            };

            const obj: ioBroker.SettableStateObject & { _id: string; role?: string } = {
                _id: `${this.namespace}.${id}`,
                type: 'state',
                common,
                native,
            };

            if (data[dp].ValueMin || data[dp].ValueMin === 0) {
                common.min = native.ValueMin as number;
            }
            if (data[dp].ValueMax || data[dp].ValueMax === 0) {
                common.max = native.ValueMax as number;
            }
            if (data[dp].ValueUnit) {
                common.unit = native.ValueUnit;
            }
            if (data[dp].DPInfo) {
                common.desc = native.DPInfo;
            }

            if (data[dp].ValueList) {
                const statesArr = this.unescape(data[dp].ValueList).split(';');
                const states: Record<string, string> = {};
                statesArr.forEach((value, index) => {
                    states[String(index)] = value;
                });
                common.states = states;

                if (data[dp].ValueSubType === 29) {
                    common.min = 0;
                    common.max = statesArr.length - 1;
                }
            }

            let val = data[dp].Value;
            const timestamp = data[dp].Timestamp ? new Date(data[dp].Timestamp).getTime() : Date.now();

            if (typeof val === 'string') {
                val = this.unescape(val);
            }

            if (id === '40') {
                id = 'alarms';
                obj.role = `indicator.${id}`;
                obj._id = `${this.namespace}.${id}`;
            } else if (id === '41') {
                id = 'maintenance';
                obj.role = `indicator.${id}`;
                obj._id = `${this.namespace}.${id}`;
            }

            const fullId = obj._id;

            if (!this.objects[fullId]) {
                this.objects[fullId] = true;
                await this.extendForeignObjectAsync(fullId, obj);
            }

            const cached = this.states[fullId];

            if (!cached || !cached.ack || cached.val !== val || cached.ts !== timestamp) {
                this.states[fullId] = { val, ack: true, ts: timestamp };
                await this.setForeignStateAsync(fullId, this.states[fullId] as ioBroker.SettableState);
            }

            if (response.includes(id)) {
                response.splice(response.indexOf(id), 1);
            }
        }

        this.log.info(`added/updated ${count} variables`);

        for (const entry of response) {
            await this.delObjectAsync(entry);
        }
        this.log.info(`deleted ${response.length} variables`);

        const pollingInterval = Number(this.config.pollingInterval);

        if (this.config.polling && pollingInterval > 0) {
            if (!this.pollingTimer && (this.config.syncVariables || this.config.syncPrograms)) {
                this.pollingTimer =
                    this.setInterval(() => {
                        if (this.config.syncVariables) {
                            void this.pollVariables();
                        }
                        if (this.config.syncPrograms) {
                            void this.pollPrograms();
                        }
                    }, pollingInterval * 1_000) ?? null;
            }
        }
    }

    /** Gets duty cycle, versions and the object counters and creates the according objects */
    private async getDutyCycle(): Promise<void> {
        const rawData = await this.rega?.runScriptFile('dutycycle');
        const rawSysInfo = await this.rega?.runScriptFile('system');

        let data: RegaDutyCycle[];
        try {
            data = JSON.parse(HmRega.convertDataToJSONArray(rawData!));
        } catch {
            this.log.error(`Cannot parse answer for duty cycle: ${rawData}`);
            return;
        }

        let sysInfo: RegaSystemInfo;
        try {
            sysInfo = JSON.parse(rawSysInfo!);
        } catch {
            this.log.error(`Cannot parse system info: ${rawSysInfo}`);
            sysInfo = {};
        }

        const ccuType = `CCU${typeof sysInfo.ccuVersion === 'string' ? sysInfo.ccuVersion.split('.')[0] : ''}`;

        let count = 0;

        // iterate over JSON array
        for (const dp of data) {
            const id = this.unescape(dp.ADDRESS).replace(FORBIDDEN_CHARS, '_');
            const prefix = `${this.namespace}.${id}.0`;
            count += 1;

            const obj: ioBroker.SettableDeviceObject & { _id: string } = {
                _id: `${this.namespace}.${id}`,
                type: 'device',
                common: {
                    name: ccuType,
                },
                native: {
                    ADDRESS: this.unescape(dp.ADDRESS),
                    TYPE: ccuType,
                },
            };

            if (!this.objects[obj._id]) {
                this.objects[obj._id] = true;
                void this.extendForeignObject(obj._id, obj);
            }

            // DUTY_CYCLE State:
            if (dp.DUTY_CYCLE !== undefined) {
                const dutyCycle = parseInt(dp.DUTY_CYCLE);
                await this.addNewStateOrObject(
                    {
                        _id: `${prefix}.DUTY_CYCLE`,
                        type: 'state',
                        common: {
                            name: `${prefix}.DUTY_CYCLE`,
                            type: 'number',
                            read: true,
                            write: false,
                            role: 'value',
                            min: 0,
                            max: 100,
                            unit: '%',
                            desc: 'Dutycycle',
                        },
                        native: {
                            ID: 'DUTYCYCLE',
                            TYPE: 'INTEGER',
                            MIN: 0,
                            MAX: 100,
                            UNIT: '%',
                            DEFAULT: 0,
                            CONTROL: 'NONE',
                        },
                    },
                    dutyCycle === -1 ? null : dutyCycle,
                );
            }

            // CONNECTED State:
            if (dp.CONNECTED !== undefined) {
                await this.addNewStateOrObject(
                    {
                        _id: `${prefix}.CONNECTED`,
                        type: 'state',
                        common: {
                            name: `${prefix}.CONNECTED`,
                            type: 'number',
                            read: true,
                            write: false,
                            role: 'indicator.connected',
                            desc: 'connected',
                        },
                        native: {
                            ID: 'CONNECTED',
                            TYPE: 'BOOLEAN',
                            DEFAULT: false,
                            CONTROL: 'NONE',
                        },
                    },
                    parseInt(dp.CONNECTED),
                );
            }

            // DEFAULT State:
            if (dp.DEFAULT !== undefined) {
                await this.addNewStateOrObject(
                    {
                        _id: `${prefix}.DEFAULT`,
                        type: 'state',
                        common: {
                            name: `${prefix}.DEFAULT`,
                            type: 'number',
                            read: true,
                            write: false,
                            role: 'indicator',
                            desc: 'default',
                        },
                        native: {
                            ID: 'DEFAULT',
                            TYPE: 'BOOLEAN',
                            DEFAULT: false,
                            CONTROL: 'NONE',
                        },
                    },
                    parseInt(dp.DEFAULT),
                );
            }

            // FIRMWARE_VERSION State:
            if (sysInfo.ccuVersion !== undefined) {
                await this.addNewStateOrObject(
                    {
                        _id: `${prefix}.FIRMWARE_VERSION`,
                        type: 'state',
                        common: {
                            name: `${prefix}.FIRMWARE_VERSION`,
                            type: 'string',
                            read: true,
                            write: false,
                            role: 'text',
                            desc: 'firmware_version',
                        },
                        native: {
                            ID: 'FIRMWARE_VERSION',
                            TYPE: 'STRING',
                            DEFAULT: '',
                            CONTROL: 'NONE',
                        },
                    },
                    sysInfo.ccuVersion,
                );
            }

            // ReGaHss-Version
            if (sysInfo.regaVersion !== undefined) {
                await this.addNewStateOrObject(
                    {
                        _id: `${prefix}.regaVersion`,
                        type: 'state',
                        common: {
                            name: `${prefix}.regaVersion`,
                            type: 'string',
                            read: true,
                            write: false,
                            role: 'text',
                            desc: 'Version of ReGaHss',
                        },
                        native: {},
                    },
                    sysInfo.regaVersion,
                );
            }

            // Number of devices
            if (sysInfo.countDevices !== undefined) {
                await this.addNewStateOrObject(
                    {
                        _id: `${prefix}.countDevices`,
                        type: 'state',
                        common: {
                            name: `${prefix}.countDevices`,
                            type: 'number',
                            read: true,
                            write: false,
                            role: 'indicator.count',
                            desc: 'Total number of devices',
                        },
                        native: {},
                    },
                    sysInfo.countDevices,
                );
            }

            // Rega Build Label
            if (sysInfo.buildLabel !== undefined) {
                await this.addNewStateOrObject(
                    {
                        _id: `${prefix}.buildLabel`,
                        type: 'state',
                        common: {
                            name: `${prefix}.buildLabel`,
                            type: 'string',
                            read: true,
                            write: false,
                            role: 'text',
                            desc: 'Build Label of ReGaHss',
                        },
                        native: {},
                    },
                    sysInfo.buildLabel,
                );
            }

            // Number of channels
            if (sysInfo.countChannels !== undefined) {
                await this.addNewStateOrObject(
                    {
                        _id: `${prefix}.countChannels`,
                        type: 'state',
                        common: {
                            name: `${prefix}.countChannels`,
                            type: 'number',
                            read: true,
                            write: false,
                            role: 'indicator.count',
                            desc: 'Total number of channels',
                        },
                        native: {},
                    },
                    sysInfo.countChannels,
                );
            }

            // Number of data points
            if (sysInfo.countDatapoints !== undefined) {
                await this.addNewStateOrObject(
                    {
                        _id: `${prefix}.countDatapoints`,
                        type: 'state',
                        common: {
                            name: `${prefix}.countDatapoints`,
                            type: 'number',
                            read: true,
                            write: false,
                            role: 'indicator.count',
                            desc: 'Total number of data points',
                        },
                        native: {},
                    },
                    sysInfo.countDatapoints,
                );
            }

            // Number of system variables
            if (sysInfo.countSystemVars !== undefined) {
                await this.addNewStateOrObject(
                    {
                        _id: `${prefix}.countSystemVariables`,
                        type: 'state',
                        common: {
                            name: `${prefix}.countSystemVariables`,
                            type: 'number',
                            read: true,
                            write: false,
                            role: 'indicator.count',
                            desc: 'Total number of system variables',
                        },
                        native: {},
                    },
                    sysInfo.countSystemVars,
                );
            }

            // Number of programs
            if (sysInfo.countPrograms !== undefined) {
                await this.addNewStateOrObject(
                    {
                        _id: `${prefix}.countPrograms`,
                        type: 'state',
                        common: {
                            name: `${prefix}.countPrograms`,
                            type: 'number',
                            read: true,
                            write: false,
                            role: 'indicator.count',
                            desc: 'Total number of programs',
                        },
                        native: {},
                    },
                    sysInfo.countPrograms,
                );
            }
        }

        this.log.info(`added/updated ${count} objects`);

        const pollingIntervalDC = Number(this.config.pollingIntervalDC);

        if (this.config.syncDutyCycle && pollingIntervalDC > 0) {
            if (!this.pollingTimerDC) {
                this.pollingTimerDC =
                    this.setInterval(() => {
                        if (this.config.syncDutyCycle) {
                            void this.pollDutyCycle();
                        }
                    }, pollingIntervalDC * 1_000) ?? null;
            }
        }
    }
}

if (require.main !== module) {
    // Export the constructor in compact mode
    module.exports = (options: Partial<utils.AdapterOptions> | undefined) => new HmRega(options);
} else {
    // otherwise start the instance directly
    (() => new HmRega())();
}
