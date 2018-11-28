/**
 *      HomeMatic ReGaHss Schnittstelle für Node.js
 *
 *      Version 0.7
 *
 *      Copyright (c) 2013, 2014 http://hobbyquaker.github.io
 *
 */
/*jshint -W061 */ // ignore "eval can be harmful"


var http =    require('http');
var https = require('https');
var fs =      require('fs');
var xml2js =  require('xml2js');
var iconv =   require('iconv-lite');
var request = require('request');
var extend =  require('extend');
var parser =  new xml2js.Parser({explicitArray: false});

var Rega = function (options) {
    if (!(this instanceof Rega)) return new Rega(options);

    this.logger          = options.logger;
    this.options         = options || {};
    this.pendingRequests = [];
    this.counter         = 0;
    this.connected       = false;
    this.secure          = options.secure || false;
    this.username        = options.username;
    this.pass            = options.password;

    var that = this;

    this.options.reconnectionInterval = this.options.reconnectionInterval || 30;

    this.init = function () {
        if (this.options.ccuIp) {
            if (this.secure) {
                this.protocol = 'https://';
                this.protocolModule = https;
            } else {
                this.protocol = 'http://';
                this.protocolModule = http;
            } // endElse
            request({url: this.protocol + this.options.ccuIp + '/ise/checkrega.cgi', strictSSL: false}, function (error, response, body) {
                if (!error && response.statusCode == 200) {
                    if (body == 'OK') {
                        this.connected = true;
                        this.options.ready();
                    } else {
                        this.connected = false;
                        this.options.ready('ReGaHSS down');
                        // try again in X seconds
                        setTimeout(function () {
                            this.init();
                        }.bind(this), this.options.reconnectionInterval * 1000);
                    }
                } else {
                    this.connected = false;
                    this.options.ready('CCU unreachable');
                    // try again in X seconds
                    setTimeout(function () {
                        this.init();
                    }.bind(this), this.options.reconnectionInterval * 1000);
                }
            }.bind(this));
        } else {
            this.options.ready('No IP defined!');
        }
    };
    this.checkTime = function (callback) {
        var that = this;
        this.script('Write(system.Date("%F %X").ToTime().ToInteger());', function (data, xml) {
            var ccuTime = parseInt(data, 10);
            var localTime = Math.round(new Date().getTime() / 1000);
            var diff = localTime - ccuTime;
            if (diff > 10) {
                that.logger.warn('time difference local-ccu ' + diff.toString() + 's');
            } else {
                that.logger.info('time difference local-ccu ' + diff.toString() + 's');
            }
            if (typeof callback === 'function') callback(diff);
        });
    };
    this.loadTranslation = function (lang, callback) {
        var that = this;

        if (!(lang == 'de' || lang == 'en' || lang == 'tr')) lang = 'de';

        request.get({url: this.protocol + that.options.ccuIp + '/webui/js/lang/' + lang + '/translate.lang.js', encoding: null, strictSSL: false}, (err, res, body) => {
            if (res.statusCode == 200) {
                try {
                    var HMIdentifier = {};
                    var langJSON = {};
                    var str = unescape(iconv.decode(body, 'ISO-8859-1'));
                    var jscode = str.replace(/jQuery\./g, "");

                    eval(jscode);

                    this.logger.debug(langJSON);
                    this.logger.info('loaded translate.lang.js');

                    request.get({url: this.protocol + that.options.ccuIp + '/webui/js/lang/' + lang + '/translate.lang.stringtable.js', encoding: null, strictSSL: false}, (err, res, body) => {
                        if (res.statusCode == 200) {
                            var str = unescape(iconv.decode(body, 'ISO-8859-1'));
                            var jscode = str.replace(/jQuery\./g, "");

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

                        request.get({url: this.protocol + that.options.ccuIp + '/webui/js/lang/' + lang + '/translate.lang.extensionV.js', encoding: null, strictSSL: false}, (err, res, body) => {
                            if (res.statusCode == 200) {
                                var str = unescape(iconv.decode(body, 'ISO-8859-1'));
                                var jscode = str.replace(/jQuery\./g, '');

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

    };
    this.loadStringTable = function (language, callback) {
        var that = this;
        language = language || "de";

        that.loadTranslation(language, function (translation) {
            request.get({url: this.protocol + that.options.ccuIp + '/config/stringtable_de.txt', encoding: null, strictSSL: false}, (err, res, body) => {
                var data = body;
                var str = iconv.decode(data, 'ISO-8859-1');
                var dataArr = str.split("\n");
                var lang = {};
                for (var i = 0; i < dataArr.length; i++) {
                    var line = dataArr[i];
                    if (line && line !== '') {
                        var resultArr = line.match(/^([A-Z0-9_-]+)\|?([A-Z0-9_-]+)?=?([A-Z0-9_-]+)?[ \t]+(.+)$/);

                        if (resultArr) {
                            var text = resultArr[4];

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
    };
    this.runScriptFile = function (script, callback) {

        this.logger.debug('--> ' + script + '.fn');

        var that = this;
        fs.readFile(__dirname + '/../regascripts/' + script + '.fn', 'utf8', function (err, data) {
            if (err) {
                that.logger.error('runScriptFile ' + err);
                return false;
            }
            that.script(data, function (stdout, xml) {
                callback(stdout, xml);
            });
        });
    };
    this.script = function (script, callback) {
        if (!this.connected) {
            if (this.pendingRequests.length) this.pendingRequests = [];
            if (callback) callback();
            return;
        }
        if (script) {
            for (var i = 0; i < this.pendingRequests.length; i++) {
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
            host:   this.options.ccuIp,
            port:   this.options.port,
            path:   '/rega.exe',
            method: 'POST',
            headers: {
                'Content-Type':   'application/x-www-form-urlencoded',
                'Content-Length': this.pendingRequests[0].script.length,
                'Authorization': auth
            },
            rejectUnauthorized: false
        };
        var post_req = this.protocolModule.request(post_options, function (res) {
            var data = '';
            res.setEncoding('utf8');

            res.on('data', function (chunk) {
                data += chunk.toString();
            });

            res.on('end', function () {
                var pos    = data.lastIndexOf('<xml>');
                var stdout = (data.substring(0, pos));
                var xml    = (data.substring(pos));

                this.logger.debug('<-- ' + stdout);

                parser.parseString(xml, function (err, result) {
                    var task = this.pendingRequests.shift();

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
                        setTimeout(function () {
                            this.script();
                        }.bind(this), 50);
                    }
                }.bind(this));
            }.bind(this));
        }.bind(this));

        post_req.on('error', function (e) {
            this.logger.error('post request error: ' + e.message);
            // if (callback) callback(null, 'post request error: ' + e.message);
            this.connected = false;
            this.options.ready('CCU unreachable');

            // try to connect
            setTimeout(function () {
                this.init();
            }.bind(this), this.options.reconnectionInterval * 1000);
        }.bind(this));

        post_req.write(this.pendingRequests[0].script);
        post_req.end();
    };

    (function _constructor() {
        that.init();
    })();
    return this;
};

module.exports = Rega;
