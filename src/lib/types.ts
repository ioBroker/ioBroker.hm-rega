/**
 * Shapes of the JSON documents which the ReGaHSS scripts in `regascripts/` print.
 *
 * Note that the CCU is not a strict JSON encoder: strings are escaped with `WriteURL()`
 * and numbers can be `-inf`/`nan`, so everything coming from there has to be treated
 * defensively before it is used.
 */

/** Value of a system variable or data point as delivered by the CCU */
export type RegaValue = string | number | boolean | null;

/** `devices.fn` - one entry per device and per channel */
export interface RegaDevice {
    Name: string;
    Interface: string;
}

/** `datapoints.fn` - `"<Interface>.<ADDRESS>:<CHANNEL>.<DATAPOINT>": value` */
export type RegaDatapoints = Record<string, RegaValue>;

/** `variables.fn` / `variablesInv.fn` */
export interface RegaVariable {
    Name: string;
    TypeName: string;
    DPInfo: string;
    Value: RegaValue;
    /** Missing for the pseudo variables 40 (alarms) and 41 (maintenance) */
    Timestamp?: string;
    ValueMin: number | null;
    ValueMax: number | null;
    ValueUnit: string;
    ValueType: number;
    ValueSubType: number;
    ValueList: string;
}

/** `polling.fn` / `pollingInv.fn` - `"<id>": [value, timestamp]` */
export type RegaPollResult = Record<string, [RegaValue, string]>;

/** `programs.fn` */
export interface RegaProgram {
    Name: string;
    TypeName: string;
    PrgInfo: string;
    Active: boolean;
    Timestamp: string;
    /**
     * Not delivered by `programs.fn` (it writes `PrgInfo`), but the adapter has always read
     * this attribute, so it is kept to not change the content of existing objects.
     */
    DPInfo?: string;
}

/** `alarms.fn` */
export interface RegaAlarm {
    Name: string;
    AlState: number;
    AlOccurrenceTime: string;
    LastTriggerTime: string;
    Operations: number;
    AlTriggerDP: number;
    Parent: number;
}

/** A channel reference inside an enum (room, function or favorite) */
export interface RegaChannelRef {
    Address: string;
    Interface: string;
}

/** `rooms.fn` and `functions.fn` */
export interface RegaEnum {
    Name: string;
    TypeName: string;
    EnumInfo: string;
    Channels: RegaChannelRef[];
}

/** One favorite list of one user - a channel can also be a plain ReGa ID (e.g. a variable) */
export interface RegaFavorite {
    id: number;
    Channels: (RegaChannelRef | number)[];
}

/** `favorites.fn` - `"<user>": { "<list name>": RegaFavorite }` */
export type RegaFavorites = Record<string, Record<string, RegaFavorite>>;

/** `system.fn` */
export interface RegaSystemInfo {
    ccuVersion?: string;
    regaVersion?: string;
    buildLabel?: string;
    countDevices?: number;
    countChannels?: number;
    countDatapoints?: number;
    countSystemVars?: number;
    countPrograms?: number;
}

/** `dutycycle.fn` after it has been converted by `convertDataToJSONArray()` */
export interface RegaDutyCycle {
    ADDRESS: string;
    CONNECTED: string;
    DEFAULT: string;
    DESCRIPTION: string;
    DUTY_CYCLE: string;
    FIRMWARE_VERSION: string;
    TYPE: string;
}

/** Minimal cache entry - only the attributes which are compared before writing a state */
export interface CachedState {
    val?: ioBroker.StateValue;
    ack?: boolean;
    ts?: number;
    lc?: number;
}

/** Unit information of a hm-rpc state, used to scale percent values */
export interface UnitWithRange {
    UNIT: string;
    MIN: number;
    MAX: number;
}

export type UnitInfo = string | UnitWithRange;
