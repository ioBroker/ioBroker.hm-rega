/**
 *      HomeMatic ReGaHss interface for Node.js
 *
 *      Copyright (c) 2013, 2014 http://hobbyquaker.github.io
 */
import * as http from 'node:http';
import * as https from 'node:https';
import axios from 'axios';
import iconv from 'iconv-lite';
import { Parser } from 'xml2js';

const parser = new Parser({ explicitArray: false });

/** Reasons why the ReGaHSS is not usable - they are passed to the `ready` callback */
export type RegaError = 'ReGaHSS down' | 'CCU unreachable' | 'No IP defined!';

/** Callback of a single ReGa script execution. `stdout` is undefined if the script was dropped */
export type RegaCallback = (stdout?: string, xml?: Record<string, any>) => void;

export interface RegaOptions {
    /** IP address or hostname of the CCU */
    ccuIp: string;
    /** Port of the CCU web interface, used for the "is ReGaHSS alive" check */
    webinterfacePort: number;
    /** Port of the ReGaHSS remote script API (8181, 48181 for https) */
    port: number;
    /** Seconds between two reconnection attempts */
    reconnectionInterval: number;
    logger: ioBroker.Logger;
    /** Reads a ReGa script from the ioBroker file storage */
    readFile: (adapterName: string, fileName: string) => Promise<{ file: string | Buffer; mimeType?: string }>;
    secure: boolean;
    username: string;
    password: string;
    /** Called on every connection state change - without an error the CCU is up */
    ready: (err?: RegaError) => void;
}

interface PendingRequest {
    script: string;
    callback?: RegaCallback;
}

export class Rega {
    private readonly options: RegaOptions;
    private readonly logger: ioBroker.Logger;
    private readonly protocol: string;
    private readonly request: typeof https.request;
    private readonly reconnectionInterval: number;

    private pendingRequests: PendingRequest[] = [];
    private reconnectTimer: NodeJS.Timeout | null = null;
    private destroyed = false;

    public connected = false;

    public constructor(options: RegaOptions) {
        this.options = options;
        this.logger = options.logger;
        this.reconnectionInterval = options.reconnectionInterval || 30;

        if (options.secure) {
            this.protocol = 'https://';
            this.request = https.request;
        } else {
            this.protocol = 'http://';
            this.request = http.request;
        }

        this.init();
    }

    /** Stops all pending reconnection attempts */
    public destroy(): void {
        this.destroyed = true;
        this.connected = false;
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        this.pendingRequests = [];
    }

    /** Schedules the next connection attempt */
    private reconnect(): void {
        if (this.destroyed || this.reconnectTimer) {
            return;
        }
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.init();
        }, this.reconnectionInterval * 1000);
    }

    /** Checks if the ReGaHSS is up and informs the adapter via the `ready` callback */
    private init(): void {
        this.pendingRequests = [];

        if (this.destroyed) {
            return;
        }

        if (!this.options.ccuIp) {
            this.options.ready('No IP defined!');
            return;
        }

        const httpsAgent = new https.Agent({ rejectUnauthorized: false });

        // if a specific web-interface port provided, use it, else use default https/http
        axios(`${this.protocol + this.options.ccuIp}:${this.options.webinterfacePort}/ise/checkrega.cgi`, {
            httpsAgent,
        })
            .then(response => {
                if (this.destroyed) {
                    return;
                }
                if (response.data === 'OK') {
                    this.connected = true;
                    this.options.ready();
                } else {
                    this.connected = false;
                    this.options.ready('ReGaHSS down');
                    // try again in X seconds
                    this.reconnect();
                }
            })
            .catch(() => {
                if (this.destroyed) {
                    return;
                }
                this.connected = false;
                this.options.ready('CCU unreachable');
                // try again in X seconds
                this.reconnect();
            });
    }

    /**
     * Checks the time difference between ReGaHSS and this host
     *
     * @returns difference in seconds
     */
    public checkTime(): Promise<number> {
        return new Promise(resolve => {
            this.script('Write(system.Date("%F %X").ToTime().ToInteger());', data => {
                const ccuTime = parseInt(data ?? '', 10);
                const localTime = Math.round(Date.now() / 1000);
                const diff = localTime - ccuTime;
                if (diff > 10) {
                    this.logger.warn(`time difference local-ccu ${diff.toString()}s`);
                } else {
                    this.logger.info(`time difference local-ccu ${diff.toString()}s`);
                }
                resolve(diff);
            });
        });
    }

    /**
     * Runs a ReGa script which is stored in the ioBroker file storage
     *
     * @param script name of the script file without the `.fn` extension
     */
    public async runScriptFile(script: string): Promise<string | undefined> {
        this.logger.debug(`--> ${script}.fn`);

        try {
            const data = await this.options.readFile('hm-rega', `regascripts/${script}.fn`);
            const source = typeof data.file === 'string' ? data.file : data.file.toString('utf8');

            return await new Promise<string | undefined>(resolve => {
                this.script(source, stdout => resolve(stdout));
            });
        } catch (e) {
            this.logger.error(`runScriptFile ${(e as Error).message}`);
            return undefined;
        }
    }

    /**
     * Executes a ReGa script on the CCU.
     *
     * Only one request is in flight at a time, all others are queued. Calling it without a script
     * processes the next queued request.
     *
     * @param script the ReGa script
     * @param callback called with the stdout of the script
     */
    public script(script?: string, callback?: RegaCallback): void {
        if (!this.connected) {
            if (this.pendingRequests.length) {
                this.pendingRequests = [];
                this.logger.debug('Dropped all pending scripts because not connected');
            }
            if (callback) {
                callback();
            }
            return;
        }

        if (script) {
            for (const pendingRequest of this.pendingRequests) {
                if (pendingRequest.script === script) {
                    this.logger.warn(
                        `Script "${script.slice(0, 80).replace(/\n/g, ' ')}" ignored, because still pending.`,
                    );
                    return;
                }
            }

            this.pendingRequests.push({ script, callback });

            if (this.pendingRequests.length > 1) {
                this.logger.debug(`${this.pendingRequests.length} pending requests`);
                return;
            }
        } else if (!this.pendingRequests.length) {
            return;
        }

        const currentScript = this.pendingRequests[0].script;

        this.logger.debug(`--> ${currentScript.slice(0, 80).replace(/\n/g, ' ')}`);

        const auth = `Basic ${Buffer.from(`${this.options.username}:${this.options.password}`).toString('base64')}`;
        const timeout = 90 * 1000;
        const body = iconv.encode(currentScript, 'ISO-8859-1');

        const postReq = this.request(
            {
                host: this.options.ccuIp,
                port: this.options.port,
                path: '/rega.exe',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Content-Length': body.length,
                    Authorization: auth,
                },
                timeout,
                rejectUnauthorized: false,
            },
            res => {
                let data = '';
                res.setEncoding('utf8');

                res.on('data', chunk => (data += chunk.toString()));

                res.on('end', () => {
                    const pos = data.lastIndexOf('<xml>');
                    const stdout = data.substring(0, pos);
                    const xml = data.substring(pos);

                    this.logger.debug(`<-- ${stdout}`);

                    parser.parseString(xml, (_err: Error | null, result: Record<string, any> | undefined) => {
                        const task = this.pendingRequests.shift();

                        // if connection lost during the process, pending requests (task) will be empty
                        if (task && typeof task.callback === 'function') {
                            if (result?.xml) {
                                task.callback(stdout, result.xml);
                            } else {
                                if (!res.complete) {
                                    this.logger.error(
                                        'The connection has been closed before fully receiving the response data',
                                    );
                                    this.logger.error(`<-- Incomplete response: ${JSON.stringify(data)}`);
                                } else {
                                    this.logger.error(`<-- invalid response: ${JSON.stringify(data)}`);
                                }

                                this.connected = false;
                                this.options.ready('ReGaHSS down');

                                // try to reconnect
                                this.reconnect();
                            }
                        }

                        // try the next task
                        if (this.pendingRequests.length) {
                            setTimeout(() => this.script(), 50);
                        }
                    });
                });
            },
        );

        postReq.on('timeout', () => {
            this.logger.warn(`"${currentScript.slice(0, 80)}" timed out after ${timeout / 1000} seconds`);
            // timeout we abort request -> will emit error event
            postReq.destroy(new Error('Aborted due to timeout'));
        });

        postReq.on('error', e => {
            this.logger.error(`post request error: ${e.message}`);
            this.connected = false;
            this.options.ready('CCU unreachable');

            // try to reconnect
            this.reconnect();
        });

        postReq.write(body);
        postReq.end();
    }
}
