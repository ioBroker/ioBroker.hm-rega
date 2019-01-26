/**
 *      HomeMatic ReGaHss Schnittstelle für Node.js
 *
 *      Version 0.7
 *
 *      Copyright (c) 2013, 2014 http://hobbyquaker.github.io
 *
 */
/*jshint -W061 */ // ignore "eval can be harmful"
'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const xml2js = require('xml2js');
const iconv = require('iconv-lite');
const request = require('request');
const parser = new xml2js.Parser({explicitArray: false});

class Rega {

    constructor(options) {
        this.logger = options.logger;
        this.options = options || {};
        this.pendingRequests = [];
        this.counter = 0;
        this.connected = false;
        this.secure = options.secure || false;
        this.username = options.username;
        this.pass = options.password;

        this.options.reconnectionInterval = this.options.reconnectionInterval || 30;

        this.init();
    } // endConstructor

    init() {
        if (this.options.ccuIp) {
            if (this.secure) {
                this.protocol = 'https://';
                this.protocolModule = https;
            } else {
                this.protocol = 'http://';
                this.protocolModule = http;
            } // endElse
            request({
                url: this.protocol + this.options.ccuIp + '/ise/checkrega.cgi',
                strictSSL: false
            }, (error, response, body) => {
                if (!error && response.statusCode === 200) {
                    if (body === 'OK') {
                        this.connected = true;
                        this.options.ready();
                    } else {
                        this.connected = false;
                        this.options.ready('ReGaHSS down');
                        // try again in X seconds
                        setTimeout(() => this.init(), this.options.reconnectionInterval * 1000);
                    }
                } else {
                    this.connected = false;
                    this.options.ready('CCU unreachable');
                    // try again in X seconds
                    setTimeout(() => this.init(), this.options.reconnectionInterval * 1000);
                }
            });
        } else {
            this.options.ready('No IP defined!');
        }
    } // endInit

    checkTime(callback) {
        const that = this;
        this.script('Write(system.Date("%F %X").ToTime().ToInteger());', (data, xml) => {
            const ccuTime = parseInt(data, 10);
            const localTime = Math.round(new Date().getTime() / 1000);
            const diff = localTime - ccuTime;
            if (diff > 10) {
                that.logger.warn('time difference local-ccu ' + diff.toString() + 's');
            } else {
                that.logger.info('time difference local-ccu ' + diff.toString() + 's');
            }
            if (typeof callback === 'function') callback(diff);
        });
    } // endCheckTime

    loadTranslation(lang, callback) {
        const that = this;

        if (!(lang === 'de' || lang === 'en' || lang === 'tr')) lang = 'de';

        request.get({
            url: this.protocol + that.options.ccuIp + '/webui/js/lang/' + lang + '/translate.lang.js',
            encoding: null,
            strictSSL: false
        }, (err, res, body) => {
            if (res.statusCode === 200) {
                try {
                    const langJSON = {};
                    const str = unescape(iconv.decode(body, 'ISO-8859-1'));
                    const jscode = str.replace(/jQuery\./g, '');

                    eval(jscode);

                    this.logger.debug(langJSON);
                    this.logger.info('loaded translate.lang.js');

                    request.get({
                        url: this.protocol + that.options.ccuIp + '/webui/js/lang/' + lang + '/translate.lang.stringtable.js',
                        encoding: null,
                        strictSSL: false
                    }, (err, res, body) => {
                        if (res.statusCode === 200) {
                            const str = unescape(iconv.decode(body, 'ISO-8859-1'));
                            const jscode = str.replace(/jQuery\./g, '');

                            try {
                                eval(jscode);
                            } catch (e) {
                                callback(langJSON);
                            }

                            this.logger.debug(langJSON);
                            this.logger.info('loaded translate.lang.stringtable.js');
                        } else {
                            callback(langJSON);
                            return;
                        }

                        request.get({
                            url: this.protocol + that.options.ccuIp + '/webui/js/lang/' + lang + '/translate.lang.extensionV.js',
                            encoding: null,
                            strictSSL: false
                        }, (err, res, body) => {
                            if (res.statusCode === 200) {
                                const str = unescape(iconv.decode(body, 'ISO-8859-1'));
                                const jscode = str.replace(/jQuery\./g, '');

                                try {
                                    eval(jscode);
                                } catch (e) {
                                    callback(langJSON);
                                    return;
                                }

                                this.logger.debug(langJSON);
                                this.logger.info('loaded translate.lang.extensionV.js');

                            }
                            callback(langJSON);
                        });
                    });

                } catch (e) {
                    this.logger.error('loadTranslation ' + e);
                    callback(null);
                }

            } else {
                callback(null);
            }
        });
    } // endLoadTranslation

    loadStringTable(language, callback) {
        const that = this;
        language = language || 'de';

        that.loadTranslation(language, (translation) => {
            request.get({
                url: this.protocol + that.options.ccuIp + '/config/stringtable_de.txt',
                encoding: null,
                strictSSL: false
            }, (err, res, body) => {
                const str = iconv.decode(body, 'ISO-8859-1');
                const dataArr = str.split('\n');
                const lang = {};
                for (let i = 0; i < dataArr.length; i++) {
                    const line = dataArr[i];
                    if (line && line !== '') {
                        const resultArr = line.match(/^([A-Z0-9_-]+)\|?([A-Z0-9_-]+)?=?([A-Z0-9_-]+)?[ \t]+(.+)$/);

                        if (resultArr) {
                            let text = resultArr[4];

                            if (translation && translation[language]) {
                                text = translation[language][text.replace(/\${([^}]*)}/, '$1')] || text;
                            }

                            if (!lang[resultArr[1]]) {
                                lang[resultArr[1]] = {};
                            }
                            if (resultArr[3]) {
                                if (!lang[resultArr[1]][resultArr[2]]) {
                                    lang[resultArr[1]][resultArr[2]] = {};
                                }
                                if (!lang[resultArr[1]][resultArr[2]][resultArr[3]]) {
                                    lang[resultArr[1]][resultArr[2]][resultArr[3]] = {};
                                }
                                lang[resultArr[1]][resultArr[2]][resultArr[3]].text = text;
                            } else if (resultArr[2]) {
                                if (!lang[resultArr[1]][resultArr[2]]) {
                                    lang[resultArr[1]][resultArr[2]] = {};
                                }
                                lang[resultArr[1]][resultArr[2]].text = text;
                            } else {
                                lang[resultArr[1]].text = text;
                            }
                        }

                    }
                }
                this.logger.info('stringtable loaded');
                callback(lang);
            });
        });
    } // endLoadStringTable

    runScriptFile(script, callback) {

        this.logger.debug('--> ' + script + '.fn');

        const that = this;
        fs.readFile(__dirname + '/../regascripts/' + script + '.fn', 'utf8', (err, data) => {
            if (err) {
                that.logger.error('runScriptFile ' + err);
                return false;
            }
            that.script(data, (stdout, xml) => callback(stdout, xml));
        });
    } // endRunScriptFile

    script(script, callback) {
        if (!this.connected) {
            if (this.pendingRequests.length) this.pendingRequests = [];
            if (callback) callback();
            return;
        }
        if (script) {
            for (let i = 0; i < this.pendingRequests.length; i++) {
                if (this.pendingRequests[i].script === script) {
                    this.logger.debug('Script ignored, because still pending.');
                    return;
                }
            }

            this.pendingRequests.push({script: script, callback: callback});

            if (this.pendingRequests.length > 1) {

                // do not show this message ofter than every 100 requests
                this.counter++;
                if ((this.counter % 100) === 0) this.logger.warn('Pending request for more than ' + (this.counter * 250) + ' ms');

                return;
            }
        } else if (!this.pendingRequests.length) {
            return;
        }

        this.counter = 0;
        this.logger.debug('--> ' + this.pendingRequests[0].script.slice(0, 80).replace(/\n/g, ' '));
        let auth = this.username + ':' + this.pass;
        auth = 'Basic ' + new Buffer(auth).toString('base64');

        const post_options = {
            host: this.options.ccuIp,
            port: this.options.port,
            path: '/rega.exe',
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Content-Length': this.pendingRequests[0].script.length,
                'Authorization': auth
            },
            rejectUnauthorized: false
        };
        const post_req = this.protocolModule.request(post_options, res => {
            let data = '';
            res.setEncoding('utf8');

            res.on('data', chunk => data += chunk.toString());

            res.on('end', () => {
                const pos = data.lastIndexOf('<xml>');
                const stdout = (data.substring(0, pos));
                const xml = (data.substring(pos));

                this.logger.debug('<-- ' + stdout);

                parser.parseString(xml, (err, result) => {
                    const task = this.pendingRequests.shift();

                    if (typeof task.callback === 'function') {
                        if (result && result.xml) {
                            task.callback(stdout, result.xml);
                        } else {
                            this.logger.error('<-- invalid response:');
                            this.logger.error(JSON.stringify(data));
                            task.callback(stdout);
                        }
                    }

                    // try next task
                    if (this.pendingRequests.length) {
                        setTimeout(() => this.script(), 50);
                    }
                });
            });
        });

        post_req.on('error', e => {
            this.logger.error('post request error: ' + e.message);
            // if (callback) callback(null, 'post request error: ' + e.message);
            this.connected = false;
            this.options.ready('CCU unreachable');

            // try to connect
            setTimeout(() => this.init(), this.options.reconnectionInterval * 1000);
        });

        post_req.write(iconv.encode(this.pendingRequests[0].script, 'ISO-8859-1'));
        post_req.end();
    } // endScript
}

module.exports = Rega;