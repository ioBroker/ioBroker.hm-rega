// Augments the globally declared ioBroker types with everything this adapter adds.
// The attributes of `AdapterConfig` must be kept in sync with `native` in io-package.json
// and with admin/jsonConfig.json.

declare global {
    namespace ioBroker {
        interface AdapterConfig {
            /** IP address or hostname of the CCU */
            homematicAddress: string;
            /** Port of the ReGaHSS remote script API (8181, 48181 for https) */
            homematicPort: number;
            /** Port of the CCU web interface - 0 means 80 resp. 443 */
            webinterfacePort: number;
            /** Only used to build the link to the CCU in the admin - derived from `useHttps` */
            webinterfaceProtocol: string;
            /** Seconds between two reconnection attempts */
            reconnectionInterval: number;

            polling: boolean;
            pollingInterval: number;
            pollingIntervalDC: number;
            pollingTrigger: string;

            rfdEnabled: boolean;
            rfdAdapter: string;
            hs485dEnabled: boolean;
            hs485dAdapter: string;
            cuxdEnabled: boolean;
            cuxdAdapter: string;
            hmipEnabled: boolean;
            hmipAdapter: string;
            virtualDevicesEnabled: boolean;
            virtualDevicesAdapter: string;

            syncVariables: boolean;
            showInvSysVar: boolean;
            syncDutyCycle: boolean;
            syncPrograms: boolean;
            syncNames: boolean;
            syncRooms: boolean;
            enumRooms: string;
            syncFunctions: boolean;
            enumFunctions: string;
            syncFavorites: boolean;
            enumFavorites: string;

            useHttps: boolean;
            username: string;
            password: string;
        }

        /** Notification scopes of this adapter, see `notifications` in io-package.json */
        interface NotificationScopes {
            'hm-rega': 'lowbat';
        }
    }
}

// this is required so the above is treated as a module
export {};
