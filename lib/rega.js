/**
 *      HomeMatic ReGaHss Schnittstelle für Node.js
 *
 *      Version 0.7
 *
 *      Copyright (c) 2013, 2014 http://hobbyquaker.github.io
 *
 */
'use strict';

const http = require('node:http');
const https = require('node:https');
const xml2js = require('xml2js');
const iconv = require('iconv-lite');
const axios = require('axios');
const parser = new xml2js.Parser({ explicitArray: false });

class Rega {
    constructor(options) {
        this.options = options || {};
        this.logger = this.options.logger;
        this.connected = false;
        this.username = this.options.username;
        this.pass = this.options.password;
        this.readFileAsync = this.options.readFileAsync;

        this.options.reconnectionInterval = this.options.reconnectionInterval || 30;

        if (this.options.secure) {
            this.protocol = 'https://';
            this.protocolModule = https;
        } else {
            this.protocol = 'http://';
            this.protocolModule = http;
        } // endElse

        this.init();
    } // endConstructor

    init() {
        this.pendingRequests = [];

        if (this.options.ccuIp) {
            const httpsAgent = new https.Agent({
                rejectUnauthorized: false
            });

            // if a specific web-interface port provided, use it, else use default https/http
            axios(`${this.protocol + this.options.ccuIp}:${this.options.webinterfacePort}/ise/checkrega.cgi`, {
                httpsAgent
            })
                .then(response => {
                    if (response.data === 'OK') {
                        this.connected = true;
                        this.options.ready();
                    } else {
                        this.connected = false;
                        this.options.ready('ReGaHSS down');
                        // try again in X seconds
                        setTimeout(() => this.init(), this.options.reconnectionInterval * 1000);
                    }
                })
                .catch(() => {
                    this.connected = false;
                    this.options.ready('CCU unreachable');
                    // try again in X seconds
                    setTimeout(() => this.init(), this.options.reconnectionInterval * 1000);
                });
        } else {
            this.options.ready('No IP defined!');
        }
    } // endInit

    /**
     * Check the time difference between Rega and System
     *
     * @return {Promise<number>}
     */
    checkTime() {
        return new Promise(resolve => {
            this.script('Write(system.Date("%F %X").ToTime().ToInteger());', data => {
                const ccuTime = parseInt(data, 10);
                const localTime = Math.round(new Date().getTime() / 1000);
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
     *  run a script file from a file system by given path
     *
     * @param {string} script path to script
     * @returns {Promise<string>}
     */
    async runScriptFile(script) {
        this.logger.debug(`--> ${script}.fn`);

        try {
            const data = await this.readFileAsync('hm-rega', `regascripts/${script}.fn`);
            return new Promise(resolve => {
                this.script(data.file, stdout => resolve(stdout));
            });
        } catch (e) {
            this.logger.error(`runScriptFile ${e}`);
        }
    } // endRunScriptFile

    script(script, callback) {
        if (!this.connected) {
            if (this.pendingRequests.length) {
                this.pendingRequests = [];
                this.logger.debug(`Dropped all pending scripts because not connected`);
            } // endIf
            if (callback) {
                callback();
            }
            return;
        }

        if (script) {
            for (const pendingRequest of this.pendingRequests) {
                if (pendingRequest.script === script) {
                    this.logger.warn(
                        `Script "${script.slice(0, 80).replace(/\n/g, ' ')}" ignored, because still pending.`
                    );
                    return;
                } // endIf
            } // endFor

            this.pendingRequests.push({ script: script, callback: callback });

            if (this.pendingRequests.length > 1) {
                this.logger.debug(`${this.pendingRequests.length} pending requests`);
                return;
            } // endIf
        } else if (!this.pendingRequests.length) {
            return;
        }

        this.logger.debug(`--> ${this.pendingRequests[0].script.slice(0, 80).replace(/\n/g, ' ')}`);
        let auth = `${this.username}:${this.pass}`;
        auth = `Basic ${Buffer.from(auth).toString('base64')}`;
        const timeout = 90 * 1000;

        const post_options = {
            host: this.options.ccuIp,
            port: this.options.port,
            path: '/rega.exe',
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Content-Length': this.pendingRequests[0].script.length,
                Authorization: auth
            },
            timeout: timeout,
            rejectUnauthorized: false
        };

        const post_req = this.protocolModule.request(post_options, res => {
            let data = '';
            res.setEncoding('utf8');

            res.on('data', chunk => (data += chunk.toString()));

            res.on('end', () => {
                const pos = data.lastIndexOf('<xml>');
                const stdout = data.substring(0, pos);
                const xml = data.substring(pos);

                this.logger.debug(`<-- ${stdout}`);

                parser.parseString(xml, (err, result) => {
                    const task = this.pendingRequests.shift();

                    // if connection lost during the process, pending requests (task) will be empty
                    if (task && typeof task.callback === 'function') {
                        if (result && result.xml) {
                            task.callback(stdout, result.xml);
                        } else {
                            if (!res.complete) {
                                this.logger.error(
                                    'The connection has been closed before fully receiving the response data'
                                );
                                this.logger.error(`<-- Incomplete response: ${JSON.stringify(data)}`);
                            } else {
                                this.logger.error(`<-- invalid response: ${JSON.stringify(data)}`);
                            }

                            this.connected = false;
                            this.options.ready('ReGaHSS down');

                            // try to reconnect
                            setTimeout(() => this.init(), this.options.reconnectionInterval * 1000);
                            // task.callback(stdout);
                        }
                    }

                    // try the next task
                    if (this.pendingRequests.length) {
                        setTimeout(() => this.script(), 50);
                    }
                });
            });
        });

        post_req.on('timeout', () => {
            this.logger.warn(
                `"${this.pendingRequests[0].script.slice(0, 80)}" timed out after ${timeout / 1000} seconds`
            );
            // timeout we abort request -> will emit error event
            post_req.destroy(new Error('Aborted due to timeout'));
        });

        post_req.on('error', e => {
            this.logger.error(`post request error: ${e.message}`);
            this.connected = false;
            this.options.ready('CCU unreachable');

            // try to reconnect
            setTimeout(() => this.init(), this.options.reconnectionInterval * 1000);
        });

        post_req.write(iconv.encode(this.pendingRequests[0].script, 'ISO-8859-1'));
        post_req.end();
    } // endScript
}

module.exports = Rega;
