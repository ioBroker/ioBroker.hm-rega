/* jshint -W097 */// jshint strict:false
/*jslint node: true */
"use strict";
var utils = require(__dirname + '/lib/utils'); // Get common adapter utils

var afterReconnect = null;

var adapter = utils.adapter({

    name: 'hm-rega',

    objectChange: function (id, obj) {
        adapter.log.debug('objectChange ' + id + ' ' + JSON.stringify(obj));
    },

    stateChange: function (id, state) {
        if (!state || state.ack) {
            if (state && id === pollingTrigger) {
                adapter.log.info('pollingTrigger');
                pollVariables();
            }
            return;
        }
        if (id.match(/_ALARM$/)) {
            setTimeout(acknowledgeAlarm, 100, id);
        } else
        // Read devices anew if hm-rpc updated the list of devices
        if (id === adapter.config.rfdAdapter    + '.updated' ||
            id === adapter.config.cuxdAdapter   + '.updated' ||
            id === adapter.config.hs485dAdapter + '.updated') {
            if (state.val) {
                setTimeout(function () {
                    getDevices();
                }, 1000);
                // Reset flag
                adapter.setForeignState(id, false, true);
            }
        } else
        if (id === adapter.config.rfdAdapter    + '.info.connection' ||
            id === adapter.config.cuxdAdapter   + '.info.connection' ||
            id === adapter.config.hs485dAdapter + '.info.connection') {
            if (state.val) {
                if (!afterReconnect) {
                    adapter.log.debug('Connection of "' + id + '" detected. Read variables anew in 60 seconds');
                    afterReconnect = setTimeout(function () {
                        afterReconnect = null;
                        getVariables();
                    }, 60000);
                }
            } else {
                if (afterReconnect) {
                    adapter.log.debug('Disonnection of "' + id + '" detected. Cancel read of variables');
                    clearTimeout(afterReconnect);
                    afterReconnect = null;
                }
            }
        } else {
            adapter.log.debug('stateChange ' + id + ' ' + JSON.stringify(state));

            var rid = id.split('.');
            if (rid[3] === 'ProgramExecute') {
                if (state.val) {
                    adapter.log.debug('ProgramExecute ' + rid[2]);
                    rega.script('dom.GetObject(' + rid[2] + ').ProgramExecute();');
                }
            } else if (rid[3] === 'Active') {
                adapter.log.debug('Active ' + rid[2] + ' ' + state.val);
                rega.script('dom.GetObject(' + rid[2] + ').Active(' + JSON.stringify(state.val) + ')');
            } else {
                if (rid[2] == 'alarms')      rid[2] = 40;
                if (rid[2] == 'maintenance') rid[2] = 41;

                if (regaStates[rid[2]] === undefined) {
                    if (!id.match(/\.updated$/)) adapter.log.warn('Got unexpected ID: ' + id);
                    return;
                }

                adapter.log.debug('Set state ' + rid[2] + ': ' + state.val);
                rega.script('dom.GetObject(' + rid[2] + ').State(' + JSON.stringify(state.val) + ')');
            }
        }
    },

    unload: stop,

    ready: function () {
        main();
    }
});

var rega;
var ccuReachable;
var ccuRegaUp;
var regaStates      = {};
var pollingInterval;
var pollingTrigger;
var checkInterval   = {};
var functionQueue   = [];
var units           = {};
var chars = [
    {regex: /%C4/g,     replace: 'Ä'},
    {regex: /%D6/g,     replace: 'Ö'},
    {regex: /%DC/g,     replace: 'Ü'},
    {regex: /%E4/g,     replace: 'ä'},
    {regex: /%F6/g,     replace: 'ö'},
    {regex: /%FC/g,     replace: 'ü'},
    {regex: /%DF/g,     replace: 'ß'},
    {regex: /%u20AC/g,  replace: 'Ђ'},
    {regex: /%20/g,     replace: ' '},
    {regex: /%5B/g,     replace: '['},
    {regex: /%5C/g,     replace: "'"},
    {regex: /%5D/g,     replace: ']'},
    {regex: /%5E/g,     replace: '^'},
    {regex: /%5F/g,     replace: '_'},
    {regex: /%60/g,     replace: '`'},
    {regex: /%21/g,     replace: '!'},
    {regex: /%22/g,     replace: '"'},
    {regex: /%23/g,     replace: '#'},
    {regex: /%24/g,     replace: '$'},
    {regex: /%25/g,     replace: '%'},
    {regex: /%26/g,     replace: '&'},
    {regex: /%27/g,     replace: "'"},
    {regex: /%3A/g,     replace: ':'},
    {regex: /%3B/g,     replace: ';'},
    {regex: /%3C/g,     replace: '<'},
    {regex: /%3D/g,     replace: '='},
    {regex: /%3E/g,     replace: '>'},
    {regex: /%3F/g,     replace: '?'},
    {regex: /%40/g,     replace: '@'},
    {regex: /%7B/g,     replace: '{'},
    {regex: /%7C/g,     replace: '|'},
    {regex: /%7D/g,     replace: '}'},
    {regex: /%7E/g,     replace: '~'},
    {regex: /%B0/g,     replace: 'º'},
    {regex: /%B4/g,     replace: ','},
    {regex: /%B5/g,     replace: 'µ'},
    {regex: /%BB/g,     replace: '»'},
    {regex: /%28/g,     replace: '('},
    {regex: /%29/g,     replace: ')'},
    {regex: /%2A/g,     replace: '*'},
    {regex: /%2B/g,     replace: '+'},
    {regex: /%2C/g,     replace: ','},
    {regex: /%2D/g,     replace: '-'},
    {regex: /%2E/g,     replace: '.'},
    {regex: /%2F/g,     replace: '/'},
    {regex: /%A6/g,     replace: '|'},
    {regex: /%A7/g,     replace: '§'},
    {regex: /%AB/g,     replace: '«'},
    {regex: /%/g,       replace: '%25'}


    /*{regex: /%08/g, replace: ''},
     {regex: /%09/g, replace: '\t'},
     {regex: /%0A/g, replace: '\n'},
     {regex: /%0D/g, replace: '\r'},
     {regex: /%30/g, replace: '0'},
     {regex: /%31/g, replace: '1'},
     {regex: /%32/g, replace: '2'},
     {regex: /%33/g, replace: '3'},
     {regex: /%34/g, replace: '4'},
     {regex: /%35/g, replace: '5'},
     {regex: /%36/g, replace: '6'},
     {regex: /%37/g, replace: '7'},
     {regex: /%38/g, replace: '8'},
     {regex: /%39/g, replace: '9'},
     {regex: /%41/g, replace: 'A'},
     {regex: /%42/g, replace: 'B'},
     {regex: /%43/g, replace: 'C'},
     {regex: /%44/g, replace: 'D'},
     {regex: /%45/g, replace: 'E'},
     {regex: /%46/g, replace: 'F'},
     {regex: /%47/g, replace: 'G'},
     {regex: /%48/g, replace: 'H'},
     {regex: /%49/g, replace: 'I'},
     {regex: /%4A/g, replace: 'J'},
     {regex: /%4B/g, replace: 'K'},
     {regex: /%4C/g, replace: 'L'},
     {regex: /%4D/g, replace: 'M'},
     {regex: /%4E/g, replace: 'N'},
     {regex: /%4F/g, replace: 'O'},
     {regex: /%50/g, replace: 'P'},
     {regex: /%51/g, replace: 'Q'},
     {regex: /%52/g, replace: 'R'},
     {regex: /%53/g, replace: 'S'},
     {regex: /%54/g, replace: 'T'},
     {regex: /%55/g, replace: 'U'},
     {regex: /%56/g, replace: 'V'},
     {regex: /%57/g, replace: 'W'},
     {regex: /%58/g, replace: 'X'},
     {regex: /%59/g, replace: 'Y'},
     {regex: /%5A/g, replace: 'Z'},
     {regex: /%61/g, replace: 'a'},
     {regex: /%62/g, replace: 'b'},
     {regex: /%63/g, replace: 'c'},
     {regex: /%64/g, replace: 'd'},
     {regex: /%65/g, replace: 'e'},
     {regex: /%66/g, replace: 'f'},
     {regex: /%67/g, replace: 'g'},
     {regex: /%68/g, replace: 'h'},
     {regex: /%69/g, replace: 'i'},
     {regex: /%6A/g, replace: 'j'},
     {regex: /%6B/g, replace: 'k'},
     {regex: /%6C/g, replace: 'l'},
     {regex: /%6D/g, replace: 'm'},
     {regex: /%6E/g, replace: 'n'},
     {regex: /%6F/g, replace: 'o'},
     {regex: /%70/g, replace: 'p'},
     {regex: /%71/g, replace: 'q'},
     {regex: /%72/g, replace: 'r'},
     {regex: /%73/g, replace: 's'},
     {regex: /%74/g, replace: 't'},
     {regex: /%75/g, replace: 'u'},
     {regex: /%76/g, replace: 'v'},
     {regex: /%77/g, replace: 'w'},
     {regex: /%78/g, replace: 'x'},
     {regex: /%79/g, replace: 'y'},
     {regex: /%7A/g, replace: 'z'},
     {regex: /%A2/g, replace: '¢'},
     {regex: /%A3/g, replace: '£'},
     {regex: /%A5/g, replace: '¥'},
     {regex: /%AC/g, replace: '¬'},
     {regex: /%AD/g, replace: '¯'},
     {regex: /%B1/g, replace: '±'},
     {regex: /%B2/g, replace: 'ª'},
     {regex: /%BC/g, replace: '¼'},
     {regex: /%BD/g, replace: '½'},
     {regex: /%BF/g, replace: '¿'},
     {regex: /%C0/g, replace: 'À'},
     {regex: /%C1/g, replace: 'Á'},
     {regex: /%C2/g, replace: 'Â'},
     {regex: /%C3/g, replace: 'Ã'},
     {regex: /%C4/g, replace: 'Ä'},
     {regex: /%C5/g, replace: 'Å'},
     {regex: /%C6/g, replace: 'Æ'},
     {regex: /%C7/g, replace: 'Ç'},
     {regex: /%C8/g, replace: 'È'},
     {regex: /%C9/g, replace: 'É'},
     {regex: /%CA/g, replace: 'Ê'},
     {regex: /%CB/g, replace: 'Ë'},
     {regex: /%CC/g, replace: 'Ì'},
     {regex: /%CD/g, replace: 'Í'},
     {regex: /%CE/g, replace: 'Î'},
     {regex: /%CF/g, replace: 'Ï'},
     {regex: /%D0/g, replace: 'Ð'},
     {regex: /%D1/g, replace: 'Ñ'},
     {regex: /%D2/g, replace: 'Ò'},
     {regex: /%D3/g, replace: 'Ó'},
     {regex: /%D4/g, replace: 'Ô'},
     {regex: /%D5/g, replace: 'Õ'},
     {regex: /%D6/g, replace: 'Ö'},
     {regex: /%D8/g, replace: 'Ø'},
     {regex: /%D9/g, replace: 'Ù'},
     {regex: /%DA/g, replace: 'Ú'},
     {regex: /%DB/g, replace: 'Û'},
     {regex: /%DC/g, replace: 'Ü'},
     {regex: /%DD/g, replace: 'Ý'},
     {regex: /%DE/g, replace: 'Þ'},
     {regex: /%DF/g, replace: 'ß'},
     {regex: /%E0/g, replace: 'à'},
     {regex: /%E1/g, replace: 'á'},
     {regex: /%E2/g, replace: 'â'},
     {regex: /%E3/g, replace: 'ã'},
     {regex: /%E4/g, replace: 'ä'},
     {regex: /%E5/g, replace: 'å'},
     {regex: /%E6/g, replace: 'æ'},
     {regex: /%E7/g, replace: 'ç'},
     {regex: /%E8/g, replace: 'è'},
     {regex: /%E9/g, replace: 'é'},
     {regex: /%EA/g, replace: 'ê'},
     {regex: /%EB/g, replace: 'ë'},
     {regex: /%EC/g, replace: 'ì'},
     {regex: /%ED/g, replace: 'í'},
     {regex: /%EE/g, replace: 'î'},
     {regex: /%EF/g, replace: 'ï'},
     {regex: /%F0/g, replace: 'ð'},
     {regex: /%F1/g, replace: 'ñ'},
     {regex: /%F2/g, replace: 'ò'},
     {regex: /%F3/g, replace: 'ó'},
     {regex: /%F4/g, replace: 'ô'},
     {regex: /%F5/g, replace: 'õ'},
     {regex: /%F6/g, replace: 'ö'},
     {regex: /%F7/g, replace: '÷'},
     {regex: /%F8/g, replace: 'ø'},
     {regex: /%F9/g, replace: 'ù'},
     {regex: /%FA/g, replace: 'ú'},
     {regex: /%FB/g, replace: 'û'},
     {regex: /%FD/g, replace: 'ý'},
     {regex: /%FE/g, replace: 'þ'},
     {regex: /%FF/g, replace: 'ÿ'}*/
];

function _unescape(text) {
    if (typeof text !== 'string') return text;
    if (!text) return '';
    for (var c = 0; c < chars.length; c++) {
        text = text.replace(chars[c].regex, chars[c].replace);
    }
    try {
        return decodeURI(text);
    } catch (err) {
        adapter.log.error('Cannot decode :' + text);
        return text;
    }
}

function checkInit(id) {
    adapter.getForeignObject('system.adapter.' + id, function (err, obj) {
        if (obj && obj.native.checkInit && obj.native.checkInitTrigger) {
            var interval = parseInt(obj.native.checkInitInterval, 10);

            // Fix error in config
            if (obj.native.checkInitTrigger === 'BidCos-RF:50.PRESS_LONG') {
                obj.native.checkInitTrigger = 'BidCos-RF.BidCoS-RF:50.PRESS_LONG';
            }

            var _id = obj.native.checkInitTrigger;
            if (!checkInterval[id]) {
                checkInterval[id] = setInterval(function () {
                    if (rega) {
                        //BidCos-RF.BidCoS-RF:50.PRESS_LONG
                        adapter.log.debug('Set check init state ' + _id + ' to true');
                        rega.script('dom.GetObject("' + _id + '").State(1);');
                    }
                }, interval * 500);
            }
        }
    });
}

function main() {
    adapter.config.reconnectionInterval = parseInt(adapter.config.reconnectionInterval, 10) || 30;

    if (adapter.config.pollingTrigger) {
        adapter.config.pollingTrigger = adapter.config.pollingTrigger.replace(':', '.');
        if (adapter.config.pollingTrigger.match(/^BidCoS-RF/)) {
            pollingTrigger = adapter.config.rfdAdapter + '.' + adapter.config.pollingTrigger;
        } else {
            pollingTrigger = adapter.config.hs485dAdapter + '.' + adapter.config.pollingTrigger;
        }
        adapter.log.info('subscribe ' + pollingTrigger);
        adapter.subscribeForeignStates(pollingTrigger);
    }

    adapter.subscribeStates('*');

    adapter.subscribeObjects('*');

    if (adapter.config.rfdAdapter    && adapter.config.rfdEnabled) {
        adapter.subscribeForeignStates(adapter.config.rfdAdapter    + '.updated');
        adapter.subscribeForeignStates(adapter.config.rfdAdapter    + '.info.connection');
        adapter.subscribeForeignStates(adapter.config.rfdAdapter + '.*_ALARM');
        checkInit(adapter.config.rfdAdapter);
    }
    if (adapter.config.cuxdAdapter   && adapter.config.cuxdEnabled) {
        adapter.subscribeForeignStates(adapter.config.cuxdAdapter   + '.updated');
        adapter.subscribeForeignStates(adapter.config.cuxdAdapter   + '.info.connection');
        checkInit(adapter.config.rfdAdapter);
    }
    if (adapter.config.hs485dAdapter && adapter.config.hs485dEnabled)  {
        adapter.subscribeForeignStates(adapter.config.hs485dAdapter + '.updated');
        adapter.subscribeForeignStates(adapter.config.hs485dAdapter + '.info.connection');
        checkInit(adapter.config.rfdAdapter);
    }

    var Rega = require(__dirname + '/lib/rega.js');

    rega = new Rega({
        ccuIp:  adapter.config.homematicAddress,
        port:   adapter.config.homematicPort,
        reconnectionInterval: adapter.config.reconnectionInterval,
        logger: adapter.log,
        ready:  function (err) {

            if (err == 'ReGaHSS ' + adapter.config.homematicAddress + ' down') {

                adapter.log.error('ReGaHSS down');
                ccuReachable = true;
                ccuRegaUp    = false;
                adapter.setState('info.connection',   false,        true);
                adapter.setState('info.ccuReachable', ccuReachable, true);
                adapter.setState('info.ccuRegaUp',    ccuRegaUp,    true);

            } else if (err == 'CCU unreachable') {

                adapter.log.error('CCU ' + adapter.config.homematicAddress + ' unreachable');
                ccuReachable = false;
                ccuRegaUp    = false;
                adapter.setState('info.connection',   false,        true);
                adapter.setState('info.ccuReachable', ccuReachable, true);
                adapter.setState('info.ccuRegaUp',    ccuRegaUp,    true);

            } else if (err) {

                adapter.log.error(err);
                ccuReachable = false;
                ccuRegaUp    = false;
                adapter.setState('info.connection',   false,        true);
                adapter.setState('info.ccuReachable', ccuReachable, true);
                adapter.setState('info.ccuRegaUp',    ccuRegaUp,    true);

            } else {

                adapter.log.info('ReGaHSS ' + adapter.config.homematicAddress + ' up');
                ccuReachable = true;
                ccuRegaUp    = true;
                adapter.setState('info.connection',   true,         true);
                adapter.setState('info.ccuReachable', ccuReachable, true);
                adapter.setState('info.ccuRegaUp',    ccuRegaUp,    true);

                if (!functionQueue.length) {
                    if (adapter.config.syncVariables) functionQueue.push(getServiceMsgs);
                    
                    functionQueue.push(getDatapoints);

                    if (adapter.config.syncVariables) functionQueue.push(getVariables);
                    if (adapter.config.syncPrograms)  functionQueue.push(getPrograms);
                    if (adapter.config.syncNames)     functionQueue.push(getDevices);
                    if (adapter.config.syncRooms)     functionQueue.push(getRooms);
                    if (adapter.config.syncFunctions) functionQueue.push(getFunctions);
                    if (adapter.config.syncFavorites) functionQueue.push(getFavorites);
                }

                rega.checkTime(function () {
                    setTimeout(queue, 0);
                });
            }
        }
    });
}

function queue() {
    if (functionQueue.length > 0) {
        var fn = functionQueue.pop();
        fn(queue);
    }
}

function pollVariables() {
    rega.runScriptFile('polling', function (data) {
        if (!data) return;

        try {
            data = JSON.parse(data.replace(/\n/gm, ''));
        } catch (e) {
            adapter.log.error('Cannot parse answer for polling: ' + data);
            return;
        }
        for (var id in data) {
            var val = data[id][0];

            if (typeof val === 'string') val = _unescape(val);

            id = _unescape(id);

            if (id == 40) {
                id = 'alarms';
            } else
            if (id == 41) {
                // If number of alarms changed
                if (regaStates[id] !== val) setTimeout(pollServiceMsgs, 1000);
                id = 'maintenance';
            }
            regaStates[id] = val;
            adapter.setState(adapter.namespace + '.' + id, val, true);
        }
    });
}

function pollPrograms() {
    rega.runScriptFile('programs', function (data) {
        if (!data) return;
        try {
            data = JSON.parse(data.replace(/\n/gm, ''));
        } catch (e) {
            adapter.log.error('Cannot parse answer for programs: ' + data);
            return;
        }
        for (var dp in data) {
            var id = _unescape(dp);
            regaStates[id] = data[dp].Active;
            adapter.setState(adapter.namespace + '.' + id + '.Active', regaStates[id], true);
        }
    });
}

function pollServiceMsgs() {
    if (!adapter.config.rfdEnabled || !adapter.config.rfdAdapter) {
        return;
    }

    adapter.log.debug('polling service messages');

    rega.runScriptFile('alarms', function (data) {
        if (!data) return;
        try {
            data = JSON.parse(data.replace(/\n/gm, ''));
        } catch (e) {
            adapter.log.error('Cannot parse answer for alarms: ' + data);
            return;
        }
        for (var dp in data) {
            var id = _unescape(data[dp].Name);
            if (id.match(/^AL-/)) id = id.substring(3);
            id = adapter.config.rfdAdapter + '.' + id.replace(':', '.') + '_ALARM';
            adapter.setForeignState(id, {
                val:    !!data[dp].AlState,
                ack:    true,
                lc:     new Date(data[dp].AlOccurrenceTime),
                ts:     new Date(data[dp].LastTriggerTime)
            });
        }
    });
}

// Acknowledge Alarm
function acknowledgeAlarm(id) {
    adapter.getForeignObject(id, function (err, obj) {
        if (obj && obj.native) {
            rega.script('dom.GetObject(' + obj.native.DP + ').AlReceipt();');
            setTimeout(function () {
                pollServiceMsgs();
            }, 1000);
        }
    });
}

function getServiceMsgs() {
    if (!adapter.config.rfdEnabled || !adapter.config.rfdAdapter) {
        return;
    }

    adapter.log.debug('create service messages');

    rega.runScriptFile('alarms', function (data) {
        if (!data) return;
        try {
            data = JSON.parse(data.replace(/\n/gm, ''));
        } catch (e) {
            adapter.log.error('Cannot parse answer for alarms: ' + data);
            return;
        }
        for (var dp in data) {
            var name = _unescape(data[dp].Name);
            var id = name;
            if (id.match(/^AL-/)) id = id.substring(3);

            id = adapter.config.rfdAdapter + '.' + id.replace(':', '.') + '_ALARM';

            adapter.setForeignObject(id, {
                type: 'state',
                common: {
                    name:  name,
                    type:  'boolean',
                    role:  'indicator.alarm',
                    read:  true,
                    write: true,
                    def:   false
                },
                native: {
                    Name:       name,
                    TypeName:   'ALARM',
                    DP:         dp
                }
            });

            adapter.setForeignState(id, {
                val:    !!data[dp].AlState,
                ack:    true,
                lc:     new Date(data[dp].AlOccurrenceTime),
                ts:     new Date(data[dp].LastTriggerTime)
            });
        }
    });
}

function getPrograms(callback) {
    adapter.objects.getObjectView('hm-rega', 'programs', {startkey: 'hm-rega.' + adapter.instance + '.', endkey: 'hm-rega.' + adapter.instance + '.\u9999'}, function (err, doc) {

        var response = [];

        if (!err && doc) {
            for (var i = 0; i < doc.rows.length; i++) {
                var id = doc.rows[i].value._id.split('.');
                id = id[id.length - 1];
                response.push(id);
            }
            adapter.log.info('got ' + doc.rows.length + ' programs');
        } else {
            adapter.log.info('got 0 programs');
        }

        rega.runScriptFile('programs', function (data) {
            try {
                data = JSON.parse(data.replace(/\n/gm, ''));
            } catch (e) {
                adapter.log.error('Cannot parse answer for programs: ' + data);
                return;
            }
            var count = 0;
            var id;
            for (var dp in data) {
                id = _unescape(dp);
                count += 1;
                adapter.setObject(id, {
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

                adapter.extendObject(id + '.ProgramExecute', {
                    type:   'state',
                    common: {
                        name:  _unescape(data[dp].Name)  + ' execute',
                        type:  'boolean',
                        role:  'action.execute',
                        read:  true,
                        write: true
                    },
                    native: {

                    }
                });
                adapter.extendObject(id + '.Active', {
                    type:  'state',
                    common: {
                        name: _unescape(data[dp].Name) + ' enabled',
                        type: 'boolean',
                        role: 'state.enabled',
                        read:   true,
                        write:  true
                    },
                    native: {

                    }
                });

                regaStates[id] = data[dp].Active;
                adapter.setState(id + '.ProgramExecute', false, true);
                adapter.setState(id + '.Active',         data[dp].Active, true);

                if (response.indexOf(id) !== -1) response.splice(response.indexOf(id), 1);
            }

            adapter.log.info('added/updated ' + count + ' programs');

            for (var i = 0; i < response.length; i++) {
                adapter.delObject(response[i]);
            }
            adapter.log.info('deleted ' + response.length + ' programs');

            if (typeof callback === 'function') callback();
        });
    });
}

function getFunctions(callback) {
    rega.runScriptFile('functions', function (data) {
        try {
            data = JSON.parse(data.replace(/\n/gm, ''));
        } catch (e) {
            adapter.log.error('Cannot parse answer for functions: ' + data);
            return;
        }
        for (var regaId in data) {
            var members = [];

            var memberObjs = data[regaId].Channels;

            var id;
            for (var i = 0; i < memberObjs.length; i++) {
                switch (memberObjs[i].Interface) {
                    case 'BidCos-RF':
                        if (!adapter.config.rfdEnabled) continue;
                        id = adapter.config.rfdAdapter + '.';
                        break;

                    case 'BidCos-Wired':
                        if (!adapter.config.hs485dEnabled) continue;
                        id = adapter.config.hs485dAdapter + '.';
                        break;

                    case 'CUxD':
                        if (!adapter.config.cuxdEnabled) continue;
                        id = adapter.config.cuxdAdapter + '.';
                        break;

                    default:
                        continue;

                }
                id = id + memberObjs[i].Address.replace(':', '.');
                members.push(id);
            }

            var name = _unescape(data[regaId].Name);
            var desc = _unescape(data[regaId].EnumInfo);
            adapter.setForeignObject(adapter.config.enumFunctions + '.' + name, {
                desc: desc,
                type: 'enum',
                common: {
                    name: name,
                    members: members
                },
                native: {
                    Name: name,
                    TypeName: 'ENUM',
                    EnumInfo: desc
                }
            });

        }

        adapter.log.info('added/updated functions to ' + adapter.config.enumFunctions);

        adapter.getForeignObject(adapter.config.enumFunctions, function (err, obj) {
            if (!obj || err) {
                adapter.setForeignObject(adapter.config.enumFunctions, {
                    type: 'enum',
                    common: {
                        name: 'Functions',
                        members: []
                    },
                    native: {

                    }
                });
            }
        });

        if (typeof callback === 'function') callback();
    });
}

function getRooms(callback) {
    rega.runScriptFile('rooms', function (data) {
        try {
            data = JSON.parse(data.replace(/\n/gm, ''));
        } catch (e) {
            adapter.log.error('Cannot parse answer for rooms: ' + data);
            return;
        }
        for (var regaId in data) {
            var members = [];

            var memberObjs = data[regaId].Channels;

            var id;
            for (var i = 0; i < memberObjs.length; i++) {
                switch (memberObjs[i].Interface) {
                    case 'BidCos-RF':
                        id = adapter.config.rfdAdapter + '.';
                        if (!adapter.config.rfdAdapter) continue;
                        break;

                    case 'BidCos-Wired':
                        id = adapter.config.hs485dAdapter + '.';
                        if (!adapter.config.hs485dAdapter) continue;
                        break;

                    case 'CUxD':
                        id = adapter.config.cuxdAdapter + '.';
                        if (!adapter.config.cuxdAdapter) continue;
                        break;

                    default:
                        continue;

                }
                id = id + _unescape(memberObjs[i].Address).replace(':', '.');
                members.push(id);
            }

            var name = _unescape(data[regaId].Name);
            var desc = _unescape(data[regaId].EnumInfo);
            adapter.setForeignObject(adapter.config.enumRooms + '.' + name, {
                type: 'enum',
                common: {
                    name: name,
                    desc: desc,
                    members: members
                },
                native: {
                    Name: name,
                    TypeName: 'ENUM',
                    EnumInfo: desc
                }
            });

        }

        adapter.log.info('added/updated rooms to ' + adapter.config.enumRooms);

        adapter.getForeignObject(adapter.config.enumRooms, function (err, obj) {
            if (!obj || err) {
                adapter.setForeignObject(adapter.config.enumRooms, {
                    type: 'enum',
                    common: {
                        name: 'Rooms',
                        members: []
                    },
                    native: {

                    }
                });
            }
        });

        if (typeof callback === 'function') callback();
    });
}

function getFavorites(callback) {
    rega.runScriptFile('favorites', function (data) {
        try {
            data = JSON.parse(data.replace(/\n/gm, ''));
        } catch (e) {
            adapter.log.error('Cannot parse answer for favorites: ' + data);
            return;
        }
        var favorites = {};

        adapter.setForeignObject(adapter.config.enumFavorites, {
            type: 'enum',
            common: {
                name: 'Favorites'
            },
            native: {}
        });

        var c = 0;

        for (var user in data) {
            user = _unescape(user);
            adapter.setForeignObject(adapter.config.enumFavorites + '.' + user, {
                type: 'enum',
                common: {
                    name: user + ' Favorites'
                },
                native: {}
            });


            for (var fav in data[user]) {
                var channels = data[user][fav].Channels;
                var members = [];
                for (var i = 0; i < channels.length; i++) {
                    if (typeof channels[i] === 'number') {
                        members.push(adapter.namespace + '.' + channels[i]);
                    } else {
                        var id;
                        switch (channels[i].Interface) {
                            case 'BidCos-RF':
                                id = adapter.config.rfdAdapter + '.';
                                if (!adapter.config.rfdAdapter) continue;
                                break;
                            case 'BidCos-Wired':
                                id = adapter.config.hs485dAdapter + '.';
                                if (!adapter.config.hs485dAdapter) continue;
                                break;
                            case 'CUxD':
                                id = adapter.config.cuxdAdapter + '.';
                                if (!adapter.config.cuxdAdapter) continue;
                                break;
                            default:
                                continue;

                        }
                        id = id + _unescape(channels[i].Address).replace(':', '.');
                        members.push(id);
                    }
                }
                c += 1;
                adapter.setForeignObject(adapter.config.enumFavorites + '.' + user + '.' + fav, {
                    type: 'enum',
                    common: {
                        name: fav,
                        members: members
                    },
                    native: {
                        id: data[user][fav].id,
                        TypeName: 'FAVORITE'
                    }
                });
            }

        }

        adapter.log.info('added/updated ' + c + ' favorites to ' + adapter.config.enumFavorites);


        if (typeof callback === 'function') callback();
    });
}

function getDatapoints(callback) {
    adapter.log.info('request state values');
    rega.runScriptFile('datapoints', function (data) {
        try {
            data = JSON.parse(data.replace(/\n/gm, ''));
        } catch (e) {
            require('fs').writeFile(__dirname + '/hm-rega-log.log', data);
            adapter.log.error('Cannot parse answer for datapoints: ' + data);
            return;
        }
        for (var dp in data) {
            //dp = _unescape(dp);
            //var tmp = dp.split('.');
            var tmp = (_unescape(dp)).split('.');


            if (tmp[2] === 'PRESS_SHORT' || tmp[2] === 'PRESS_LONG') continue;
            var id;
            switch (tmp[0]) {
                case 'BidCos-RF':
                    if (!adapter.config.rfdEnabled) continue;
                    id = adapter.config.rfdAdapter + '.';
                    break;

                case 'BidCos-Wired':
                    if (!adapter.config.hs485dEnabled) continue;
                    id = adapter.config.hs485dAdapter + '.';
                    break;

                case 'CUxD':
                    if (!adapter.config.cuxdEnabled) continue;
                    id = adapter.config.cuxdAdapter + '.';
                    break;

                default:
                    continue;
            }
            id += tmp[1].replace(':', '.') + '.' + tmp[2];

            // convert dimmer and blinds
            if (units[id] === '100%') data[dp] = parseFloat(data[dp]) * 100;

            adapter.setForeignState(id, {val: data[dp], ack: true});
        }
        adapter.log.info('got state values');
        if (typeof callback === 'function') callback();
        units = null;
    });
}

function _getDevicesFromRega(devices, channels, _states, callback) {
    // Get all devices channels and states
    rega.runScriptFile('devices', function (data) {
        try {
            data = JSON.parse(data.replace(/\n/gm, ''));
        } catch (e) {
            adapter.log.error('Cannot parse answer for devices: ' + data);
            return;
        }
        var objs = [];
        var id;
        for (var addr in data) {
            switch (data[addr].Interface) {
                case 'BidCos-RF':
                    if (!adapter.config.rfdEnabled) continue;
                    id = adapter.config.rfdAdapter + '.';
                    break;

                case 'BidCos-Wired':
                    if (!adapter.config.hs485dEnabled) continue;
                    id = adapter.config.hs485dAdapter + '.';
                    break;

                case 'CUxD':
                    if (!adapter.config.cuxdEnabled) continue;
                    id = adapter.config.cuxdAdapter + '.';
                    break;

                default:
                    continue;
            }

            id += _unescape(addr).replace(':', '.');
            var name = _unescape(data[addr].Name);
            if (addr.indexOf(':') == -1) {
                // device
                if (devices[id] === undefined || devices[id] != name) {
                    objs.push({_id: id, common: {name: name}});
                }
            } else {
                // channel
                if (channels[id] === undefined || channels[id] != name) {
                    objs.push({_id: id, common: {name: name}});
                } else if (!channels[id]) {
                    var dev = id.split('.');
                    var last = dev.pop();
                    dev = dev.join('.');
                    if (devices[dev]) objs.push({_id: id, common: {name: devices[dev] + '.' + last}});
                }
                if (_states[id]) {
                    for (var s in _states[id]) {
                        if (!_states[id][s]) objs.push({_id: id + '.' + s, common: {name: name + '.' + s}});
                    }
                }
            }
        }

        function _queue() {
            if (objs.length > 1) {
                var obj = objs.pop();
                adapter.log.info('renamed ' + obj._id + ' to "' + obj.common.name + '"');
                adapter.extendForeignObject(obj._id, obj, function () {
                    setTimeout(_queue, 0);
                });
            } else {
                if (typeof callback === 'function') callback();
            }
        }

        _queue();
    });
}

function getDevices(callback) {
    var count    = 0;
    var channels = {};
    var devices  = {};
    var _states  = {};
    var someEnabled = false;

    if (adapter.config.rfdEnabled) {
        someEnabled = true;
        count++;
        adapter.objects.getObjectView('system', 'device', {startkey: adapter.config.rfdAdapter + '.', endkey: adapter.config.rfdAdapter + '.\u9999'}, function (err, doc) {
            if (doc && doc.rows) {
                for (var i = 0; i < doc.rows.length; i++) {
                    devices[doc.rows[i].id] = doc.rows[i].value.common.name;
                }
            }
            adapter.objects.getObjectView('system', 'channel', {startkey: adapter.config.rfdAdapter + '.', endkey: adapter.config.rfdAdapter + '.\u9999'}, function (err, doc) {
                if (doc && doc.rows) {
                    for (var i = 0; i < doc.rows.length; i++) {
                        channels[doc.rows[i].id] = doc.rows[i].value.common.name;
                    }
                }
                adapter.objects.getObjectView('system', 'state', {startkey: adapter.config.rfdAdapter + '.', endkey: adapter.config.rfdAdapter + '.\u9999'}, function (err, doc) {
                    if (doc && doc.rows) {
                        units = units || {};
                        for (var i = 0; i < doc.rows.length; i++) {
                            var parts = doc.rows[i].id.split('.');
                            var last  = parts.pop();
                            var id    = parts.join('.');
                            if (doc.rows[i].value.native && doc.rows[i].value.native.UNIT) {
                                units[doc.rows[i].id] = _unescape(doc.rows[i].value.native.UNIT);
                            }
                            _states[id] = _states[id] || [];
                            _states[id][last] = doc.rows[i].value.common.name;
                        }
                    }
                    if (!--count) {
                        _getDevicesFromRega(devices, channels, _states, callback);
                    }
                });
            });
        });
    }
    if (adapter.config.hs485dEnabled) {
        someEnabled = true;
        count++;
        adapter.objects.getObjectView('system', 'device', {startkey: adapter.config.hs485dAdapter + '.', endkey: adapter.config.hs485dAdapter + '.\u9999'}, function (err, doc) {
            if (doc && doc.rows) {
                for (var i = 0; i < doc.rows.length; i++) {
                    devices[doc.rows[i].id] = doc.rows[i].value.common.name;
                }
            }
            adapter.objects.getObjectView('system', 'channel', {startkey: adapter.config.hs485dAdapter + '.', endkey: adapter.config.hs485dAdapter + '.\u9999'}, function (err, doc) {
                if (doc && doc.rows) {
                    for (var i = 0; i < doc.rows.length; i++) {
                        channels[doc.rows[i].id] = doc.rows[i].value.common.name;
                    }
                }
                adapter.objects.getObjectView('system', 'state', {startkey: adapter.config.hs485dAdapter + '.', endkey: adapter.config.hs485dAdapter + '.\u9999'}, function (err, doc) {
                    if (doc && doc.rows) {
                        for (var i = 0; i < doc.rows.length; i++) {
                            var parts = doc.rows[i].id.split('.');
                            var last = parts.pop();
                            var id = parts.join('.');
                            units[id] = doc.rows[i].value.native ? _unescape(doc.rows[i].value.native.UNIT) : undefined;
                            _states[id] = _states[id] || [];
                            _states[id][last] = doc.rows[i].value.common.name;
                        }
                    }
                    count--;
                    if (!count) _getDevicesFromRega(devices, channels, _states, callback);
                });
            });
        });
    }
    if (adapter.config.cuxdEnabled) {
        someEnabled = true;
        count++;
        adapter.objects.getObjectView('system', 'device', {startkey: adapter.config.cuxdAdapter + '.', endkey: adapter.config.cuxdAdapter + '.\u9999'}, function (err, doc) {
            if (doc && doc.rows) {
                for (var i = 0; i < doc.rows.length; i++) {
                    devices[doc.rows[i].id] = doc.rows[i].value.common.name;
                }
            }
            adapter.objects.getObjectView('system', 'channel', {startkey: adapter.config.cuxdAdapter + '.', endkey: adapter.config.cuxdAdapter + '.\u9999'}, function (err, doc) {
                if (doc && doc.rows) {
                    for (var i = 0; i < doc.rows.length; i++) {
                        channels[doc.rows[i].id] = doc.rows[i].value.common.name;
                    }
                }
                adapter.objects.getObjectView('system', 'state', {startkey: adapter.config.cuxdAdapter + '.', endkey: adapter.config.cuxdAdapter + '.\u9999'}, function (err, doc) {
                    if (doc && doc.rows) {
                        for (var i = 0; i < doc.rows.length; i++) {
                            var parts = doc.rows[i].id.split('.');
                            var last = parts.pop();
                            var id = parts.join('.');
                            units[id] = doc.rows[i].value.native ? _unescape(doc.rows[i].value.native.UNIT) : undefined;
                            _states[id] = _states[id] || [];
                            _states[id][last] = doc.rows[i].value.common.name;
                        }
                    }
                    count--;
                    if (!count) _getDevicesFromRega(devices, channels, _states, callback);
                });
            });
        });
    }

    if (!someEnabled && !count) _getDevicesFromRega(devices, channels, _states, callback);
}

function getVariables(callback) {
    var commonTypes = {
        2:  'boolean',
        4:  'number',
        16: 'number',
        20: 'string'
    };

    adapter.objects.getObjectView('hm-rega', 'variables', {startkey: 'hm-rega.' + adapter.instance + '.', endkey: 'hm-rega.' + adapter.instance + '.\u9999'}, function (err, doc) {
        var response = [];

        if (!err && doc) {
            for (var i = 0; i < doc.rows.length; i++) {
                var id = doc.rows[i].value._id.split('.');
                id = id[id.length - 1];
                response.push(id);
            }
            adapter.log.info('got ' + doc.rows.length + ' variables');
        } else {
            adapter.log.info('got 0 variables');
        }

        rega.runScriptFile('variables', function (data) {
            try {
                data = JSON.parse(data.replace(/\n/gm, ''));
            } catch (e) {
                adapter.log.error('Cannot parse answer for variables: ' + data);
                return;
            }
            var count = 0;
            var i;
            var id;

            for (var dp in data) {
                id = _unescape(dp);
                count += 1;

                var role = 'state';

                var obj = {
                    _id:  adapter.namespace + '.' + id,
                    type: 'state',
                    common: {
                        name:           _unescape(data[dp].Name),
                        type:           commonTypes[data[dp].ValueType],
                        read:           true,
                        write:          true,
                        role:           role
                    },
                    native: {
                        Name:           _unescape(data[dp].Name),
                        TypeName:       _unescape(data[dp].TypeName),
                        DPInfo:         _unescape(data[dp].DPInfo),
                        ValueMin:       _unescape(data[dp].ValueMin),
                        ValueMax:       _unescape(data[dp].ValueMax),
                        ValueUnit:      _unescape(data[dp].ValueUnit),
                        ValueType:      _unescape(data[dp].ValueType),
                        ValueSubType:   _unescape(data[dp].ValueSubType),
                        ValueList:      _unescape(data[dp].ValueList)
                    }
                };
                if (data[dp].ValueMin || data[dp].ValueMin === 0)  obj.common.min = obj.native.ValueMin;
                if (data[dp].ValueMax || data[dp].ValueMax === 0)  obj.common.max = obj.native.ValueMax;
                if (data[dp].ValueUnit) obj.common.unit = obj.native.ValueUnit;
                if (data[dp].DPInfo)    obj.common.desc = obj.native.DPInfo;

                if (data[dp].ValueList) {
                    var statesArr = _unescape(data[dp].ValueList).split(';');
                    obj.common.states = {};
                    for (i = 0; i < statesArr.length; i++) {
                        obj.common.states[i] = statesArr[i];
                    }
                    if (data[dp].ValueSubType === 29) {
                        obj.common.min = 0;
                        obj.common.max = statesArr.length - 1;
                    }

                }
                var val = data[dp].Value;

                if (typeof val === 'string') val = _unescape(val);

                regaStates[id] = val;
                if (id == 40) {
                    obj.role = 'indicator.alarms';
                    obj._id = adapter.namespace + '.alarms';
                    id = 'alarms';
                    adapter.extendObject(adapter.namespace + '.alarms', obj);
                    adapter.setState(adapter.namespace + '.alarms', val, true);
                } else if (id == 41) {
                    obj.role = 'indicator.maintenance';
                    obj._id = adapter.namespace + '.maintenance';
                    id = 'maintenance';
                    adapter.extendObject(adapter.namespace + '.maintenance', obj);
                    adapter.setState(adapter.namespace + '.maintenance', val, true);
                } else {
                    adapter.extendObject(adapter.namespace + '.' + id, obj);
                    adapter.setState(adapter.namespace + '.' + id, val, true);
                }

                if (response.indexOf(id) !== -1) response.splice(response.indexOf(id), 1);
            }

            adapter.log.info('added/updated ' + count + ' variables');

            for (i = 0; i < response.length; i++) {
                adapter.delObject(response[i]);
            }
            adapter.log.info('deleted ' + response.length + ' variables');

            if (adapter.config.polling && adapter.config.pollingInterval > 0) {
                if (!pollingInterval) {
                    pollingInterval = setInterval(function () {
                        pollVariables();
                        pollPrograms();
                    }, adapter.config.pollingInterval * 1000);
                }
            }

            if (typeof callback === 'function') callback();

        });
    });
}

var stopCount = 0;
function stop(callback) {
    adapter.setState('info.connection',   false, true);
    adapter.setState('info.ccuReachable', false, true);
    adapter.setState('info.ccuRegaUp',    false, true);

    if (!stopCount) clearInterval(pollingInterval);
    for (var id in checkInterval) {
        clearInterval(checkInterval[id]);
    }

    if (rega && rega.pendingRequests > 0 && stopCount < 5) {
        if (!stopCount) adapter.log.info('waiting for pending request');
        setTimeout(function () {
            stop(callback);
        }, 500);
    } else {
        callback();
    }
    stopCount++;
}

