/* jshint -W097 */// jshint strict:false
/*jslint node: true */
"use strict";
var utils =    require(__dirname + '/lib/utils'); // Get common adapter utils

var adapter = utils.adapter({

    name: 'hm-rega',

    objectChange: function (id, obj) {
        adapter.log.debug('objectChange ' + id + ' ' + JSON.stringify(obj));
    },

    stateChange: function (id, state) {
        if (!state) return;

        // Read devices anew if hm-rpc updated the list of devices
        if (id == adapter.config.rfdAdapter    + '.updated' ||
            id == adapter.config.cuxdEnabled   + '.updated' ||
            id == adapter.config.hs485dEnabled + '.updated') {
            if (state.val) {
                setTimeout(function () {
                    getDevices();
                }, 1000);
                // Reset flag
                adapter.setForeignState(id, false, true);
            }
            return;
        }

        adapter.log.debug('stateChange ' + id + ' ' + JSON.stringify(state));
        if (id === pollingTrigger) {
            adapter.log.info('pollingTrigger');
            pollVariables();
        } else {
            var rid = id.split('.');
            if (rid[3] === 'ProgramExecute') {
                if (!state.ack && state.val) {
                    adapter.log.info('ProgramExecute ' + rid[2]);
                    rega.script('dom.GetObject(' + rid[2] + ').ProgramExecute();');
                }
            } else if (rid[3] === 'Active') {
                if (!state.ack) {
                    adapter.log.info('Active ' + rid[2] + ' ' + state.val);
                    rega.script('dom.GetObject(' + rid[2] + ').Active(' + JSON.stringify(state.val) + ')');
                }
            } else {
                if (rid[2] == 'alarms')      rid[2] = 40;
                if (rid[2] == 'maintenance') rid[2] = 41;

                if (regaStates[rid[2]] === undefined) {
                    adapter.log.info('Got unexpected ID: ' + id);
                    return;
                }

                if (regaStates[rid[2]] !== state.val || !state.ack) {
                    adapter.log.info('State ' + rid[2] + ' ' + state.val);
                    rega.script('dom.GetObject(' + rid[2] + ').State(' + JSON.stringify(state.val) + ')');
                }
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
var regaStates = {};
var pollingInterval;
var pollingTrigger;
var checkInterval = {};

var functionQueue = [];

function checkInit(id) {
    adapter.getForeignObject('system.adapter.' + id, function (err, obj) {
        if (obj && obj.native.checkInit && obj.native.checkInitTrigger) {
            var interval = parseInt(obj.native.checkInitInterval, 10);

            // Fix error in config
            if (obj.native.checkInitTrigger == 'BidCos-RF:50.PRESS_LONG') {
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

    functionQueue.push(getDatapoints);

    if (adapter.config.syncVariables) functionQueue.push(getVariables);
    if (adapter.config.syncPrograms)  functionQueue.push(getPrograms);
    if (adapter.config.syncNames)     functionQueue.push(getDevices);
    if (adapter.config.syncRooms)     functionQueue.push(getRooms);
    if (adapter.config.syncFunctions) functionQueue.push(getFunctions);
    if (adapter.config.syncFavorites) functionQueue.push(getFavorites);

    if (adapter.config.pollingTrigger) {
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
        checkInit(adapter.config.rfdAdapter);
    }
    if (adapter.config.cuxdAdapter   && adapter.config.cuxdEnabled) {
        adapter.subscribeForeignStates(adapter.config.cuxdAdapter   + '.updated');
        checkInit(adapter.config.rfdAdapter);
    }
    if (adapter.config.hs485dAdapter && adapter.config.hs485dEnabled)  {
        adapter.subscribeForeignStates(adapter.config.hs485dAdapter + '.updated');
        checkInit(adapter.config.rfdAdapter);
    }

    var Rega = require(__dirname + '/lib/rega.js');

    rega = new Rega({
        ccuIp:  adapter.config.homematicAddress,
        port:   adapter.config.homematicPort,
        logger: adapter.log,
        ready: function (err) {

            if (err == 'ReGaHSS ' + adapter.config.homematicAddress + ' down') {
                adapter.log.error('ReGaHSS down');
                ccuReachable = true;
                ccuRegaUp = false;

            } else if (err == 'CCU unreachable') {

                adapter.log.error('CCU ' + adapter.config.homematicAddress + ' unreachable');
                ccuReachable = false;
                ccuRegaUp = false;

            } else {

                adapter.log.info('ReGaHSS ' + adapter.config.homematicAddress + ' up');
                ccuReachable = true;
                ccuRegaUp = true;

                rega.checkTime(function () {
                    queue();
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
        try {
            data = JSON.parse(data);
        } catch(e) {
            adapter.log.error('Cannot parse answer for polling: ' + data);
            return;
        }
        for (var id in data) {
            var val = data[id][0];
            if (typeof val === 'string') val = unescape(val);
            regaStates[id] = val;
            var ts = Math.floor((new Date(data[id][1])).getTime() / 1000);
            if (id == 40) id = 'alarms';
            if (id == 41) id = 'maintenance';
            adapter.setState(adapter.namespace + '.' + id, {val: val, ack: true, lc: ts});
        }
    });
}

function pollProgramms() {
    rega.runScriptFile('programs', function (data) {
        try {
            data = JSON.parse(data);
        } catch(e) {
            adapter.log.error('Cannot parse answer for programs: ' + data);
            return;
        }
        for (var id in data) {
            regaStates[id] = data[id].Active;
            var ts = Math.floor((new Date(data[id][1])).getTime() / 1000);
            adapter.setState(adapter.namespace + '.' + id + '.Active', {val: regaStates[id], ack: true});
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
                data = JSON.parse(data);
            } catch(e) {
                adapter.log.error('Cannot parse answer for programs: ' + data);
                return;
            }
            var count = 0;
            for (var id in data) {
                count += 1;
                adapter.setObject(id, {
                    type: 'channel',
                    common: {
                        name: unescape(data[id].Name),
                        enabled: true
                    },
                    native: {
                        Name: unescape(data[id].Name),
                        TypeName: data[id].TypeName,
                        PrgInfo: unescape(data[id].DPInfo)
                    }
                });

                adapter.extendObject(id + '.ProgramExecute', {
                    type:   'state',
                    common: {
                        name:  unescape(data[id].Name)  + ' execute',
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
                        name: unescape(data[id].Name) + ' enabled',
                        type: 'boolean',
                        role: 'state.enabled',
                        read:   true,
                        write:  true
                    },
                    native: {

                    }
                });

                regaStates[id] = data[id].Active;
                var ts = Math.floor((new Date(data[id].Timestamp)).getTime() / 1000);

                adapter.setState(id + '.ProgramExecute', {val: false,           ack: true, lc: ts});
                adapter.setState(id + '.Active',         {val: data[id].Active, ack: true});

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
            data = JSON.parse(data);
        } catch(e) {
            adapter.log.error('Cannot parse answer for functions: ' + data);
            return;
        }
        for (var regaId in data) {
            var members = [];

            var memberObjs = data[regaId].Channels;

            for (var i = 0; i < memberObjs.length; i++) {
                var id;
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

            var name = unescape(data[regaId].Name);
            var desc = unescape(data[regaId].EnumInfo);
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

        adapter.setForeignObject(adapter.config.enumFunctions, {
            type: 'enum',
            common: {
                name: 'Functions',
                members: []
            },
            native: {

            }
        });

        if (typeof callback === 'function') callback();
    });
}

function getRooms(callback) {
    rega.runScriptFile('rooms', function (data) {
        try {
            data = JSON.parse(data);
        } catch(e) {
            adapter.log.error('Cannot parse answer for rooms: ' + data);
            return;
        }
        for (var regaId in data) {
            var members = [];

            var memberObjs = data[regaId].Channels;

            for (var i = 0; i < memberObjs.length; i++) {
                var id;
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
                id = id + memberObjs[i].Address.replace(':', '.');
                members.push(id);
            }

            var name = unescape(data[regaId].Name);
            var desc = unescape(data[regaId].EnumInfo);
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

        adapter.extendForeignObject(adapter.config.enumRooms, {
            type: 'enum',
            common: {
                name: 'Rooms',
                members: []
            },
            native: {

            }
        });

        if (typeof callback === 'function') callback();
    });
}

function getFavorites(callback) {
    rega.runScriptFile('favorites', function (data) {
        try {
            data = JSON.parse(data);
        } catch(e) {
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
                        id = id + channels[i].Address.replace(':', '.');
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
            data = JSON.parse(data);
        } catch(e) {
            require('fs').writeFile(__dirname + '/hm-rega-log.log', data);
            adapter.log.error('Cannot parse answer for datapoints: ' + data);
            return;
        }
        for (var dp in data) {
            var tmp = dp.split('.');
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
            adapter.setForeignState(id, {val: data[dp], ack: true});
        }
        adapter.log.info('got state values');
        if (typeof callback === 'function') callback();
    });
}

function _getDevicesFromRega(devices, channels, states, callback) {
    // Get all devices channels and states
    rega.runScriptFile('devices', function (data) {
        try {
            data = JSON.parse(data);
        } catch(e) {
            adapter.log.error('Cannot parse answer for devices: ' + data);
            return;
        }
        var objs = [];
        for (var addr in data) {
            var id;
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

            id += addr.replace(':', '.');
            var name = unescape(data[addr].Name);
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
                if (states[id]) {
                    for (var s in states[id]) {
                        if (!states[id][s]) objs.push({_id: id + '.' + s, common: {name: name + '.' + s}});
                    }
                }
            }
        }

        function queue() {
            if (objs.length > 1) {
                var obj = objs.pop();
                adapter.log.info('renamed ' + obj._id + ' to "' + obj.common.name + '"');
                adapter.extendForeignObject(obj._id, obj, function () {
                    queue();
                });
            } else {
                if (typeof callback === 'function') callback();
            }
        }

        queue();
    });

}

function getDevices(callback) {
    var count = 0;
    var channels = {};
    var devices  = {};
    var states   = {};
    var someEnabled = false;
    if (adapter.config.rfdEnabled) {
        someEnabled = true;
        count++;
        adapter.objects.getObjectView('system', 'device', {startkey: adapter.config.rfdAdapter + '.', endkey: adapter.config.rfdAdapter + '.\u9999'}, function (err, doc) {
            if (doc) {
                for (var i = 0; i < doc.rows.length; i++) {
                    devices[doc.rows[i].id] = doc.rows[i].value.common.name;
                }
            }
            adapter.objects.getObjectView('system', 'channel', {startkey: adapter.config.rfdAdapter + '.', endkey: adapter.config.rfdAdapter + '.\u9999'}, function (err, doc) {
                if (doc) {
                    for (var i = 0; i < doc.rows.length; i++) {
                        channels[doc.rows[i].id] = doc.rows[i].value.common.name;
                    }
                }
                adapter.objects.getObjectView('system', 'state', {startkey: adapter.config.rfdAdapter + '.', endkey: adapter.config.rfdAdapter + '.\u9999'}, function (err, doc) {
                    if (doc) {
                        for (var i = 0; i < doc.rows.length; i++) {
                            var parts = doc.rows[i].id.split('.');
                            var last = parts.pop();
                            var id = parts.join('.');
                            states[id] = states[id] || [];
                            states[id][last] = doc.rows[i].value.common.name;
                        }
                    }
                    count--;
                    if (!count)
                        _getDevicesFromRega(devices, channels, states, callback);
                });
            });
        });
    }
    if (adapter.config.hs485dEnabled) {
        someEnabled = true;
        count++;
        adapter.objects.getObjectView('system', 'device', {startkey: adapter.config.hs485dAdapter + '.', endkey: adapter.config.hs485dAdapter + '.\u9999'}, function (err, doc) {
            if (doc) {
                for (var i = 0; i < doc.rows.length; i++) {
                    devices[doc.rows[i].id] = doc.rows[i].value.common.name;
                }
            }
            adapter.objects.getObjectView('system', 'channel', {startkey: adapter.config.hs485dAdapter + '.', endkey: adapter.config.hs485dAdapter + '.\u9999'}, function (err, doc) {
                if (doc) {
                    for (var i = 0; i < doc.rows.length; i++) {
                        channels[doc.rows[i].id] = doc.rows[i].value.common.name;
                    }
                }
                adapter.objects.getObjectView('system', 'state', {startkey: adapter.config.hs485dAdapter + '.', endkey: adapter.config.hs485dAdapter + '.\u9999'}, function (err, doc) {
                    if (doc) {
                        for (var i = 0; i < doc.rows.length; i++) {
                            for (var i = 0; i < doc.rows.length; i++) {
                                var parts = doc.rows[i].id.split('.');
                                var last = parts.pop();
                                var id = parts.join('.');
                                states[id] = states[id] || [];
                                states[id][last] = doc.rows[i].value.common.name;
                            }
                        }
                    }
                    count--;
                    if (!count) _getDevicesFromRega(devices, channels, states, callback);
                });
            });
        });
    }
    if (adapter.config.cuxdEnabled) {
        someEnabled = true;
        count++;
        adapter.objects.getObjectView('system', 'device', {startkey: adapter.config.cuxdAdapter + '.', endkey: adapter.config.cuxdAdapter + '.\u9999'}, function (err, doc) {
            if (doc) {
                for (var i = 0; i < doc.rows.length; i++) {
                    devices[doc.rows[i].id] = doc.rows[i].value.common.name;
                }
            }
            adapter.objects.getObjectView('system', 'channel', {startkey: adapter.config.cuxdAdapter + '.', endkey: adapter.config.cuxdAdapter + '.\u9999'}, function (err, doc) {
                if (doc) {
                    for (var i = 0; i < doc.rows.length; i++) {
                        channels[doc.rows[i].id] = doc.rows[i].value.common.name;
                    }
                }
                adapter.objects.getObjectView('system', 'state', {startkey: adapter.config.cuxdAdapter + '.', endkey: adapter.config.cuxdAdapter + '.\u9999'}, function (err, doc) {
                    if (doc) {
                        for (var i = 0; i < doc.rows.length; i++) {
                            for (var i = 0; i < doc.rows.length; i++) {
                                var parts = doc.rows[i].id.split('.');
                                var last = parts.pop();
                                var id = parts.join('.');
                                states[id] = states[id] || [];
                                states[id][last] = doc.rows[i].value.common.name;
                            }
                        }
                    }
                    count--;
                    if (!count) _getDevicesFromRega(devices, channels, states, callback);
                });
            });
        });
    }

    if (!someEnabled && !count) _getDevicesFromRega(devices, channels, states, callback);
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
                data = JSON.parse(data);
            } catch(e) {
                adapter.log.error('Cannot parse answer for variables: ' + data);
                return;
            }
            var count = 0;
            var i;

            for (var id in data) {
                count += 1;

                var role = 'state';

                var obj = {
                    _id:  adapter.namespace + '.' + id,
                    type: 'state',
                    common: {
                        name:           unescape(data[id].Name),
                        type:           commonTypes[data[id].ValueType],
                        read:           true,
                        write:          true,
                        role:           role
                    },
                    native: {
                        Name:           unescape(data[id].Name),
                        TypeName:       data[id].TypeName,
                        DPInfo:         unescape(data[id].DPInfo),
                        ValueMin:       data[id].ValueMin,
                        ValueMax:       data[id].ValueMax,
                        ValueUnit:      data[id].ValueUnit,
                        ValueType:      data[id].ValueType,
                        ValueSubType:   data[id].ValueSubType,
                        ValueList:      unescape(data[id].ValueList)
                    }
                };
                if (data[id].ValueMin)  obj.common.min = data[id].ValueMin;
                if (data[id].ValueMax)  obj.common.min = data[id].ValueMax;
                if (data[id].ValueUnit) obj.common.min = data[id].ValueUnit;
                if (data[id].DPInfo)    obj.common.desc = unescape(data[id].DPInfo);

                if (data[id].ValueList) {
                    var statesArr = unescape(data[id].ValueList).split(';');
                    obj.common.states = {};
                    for (i = 0; i < statesArr.length; i++) {
                        obj.common.states[i] = statesArr[i];
                    }
                    if (data[id].ValueSubType === 29) {
                        obj.common.min = 0;
                        obj.common.max = statesArr.length - 1;
                    }

                }
                var val = data[id].Value;
                if (typeof val === 'string') val = unescape(val);
                regaStates[id] = val;
                var ts = Math.floor((new Date(data[id].Timestamp)).getTime() / 1000);

                if (id == 40) {
                    obj.role = 'indicator.alarms';
                    obj._id = adapter.namespace + '.alarms';
                    id = 'alarms';
                    adapter.extendObject(adapter.namespace + '.alarms', obj);
                    adapter.setState(adapter.namespace + '.alarms', {val: val, ack: true, lc: ts});
                } else if (id == 41) {
                    obj.role = 'indicator.maintenance';
                    obj._id = adapter.namespace + '.maintenance';
                    id = 'maintenance';
                    adapter.extendObject(adapter.namespace + '.maintenance', obj);
                    adapter.setState(adapter.namespace + '.maintenance', {val: val, ack: true, lc: ts});
                } else {
                    adapter.extendObject(adapter.namespace + '.' + id, obj);
                    adapter.setState(adapter.namespace + '.' + id, {val: val, ack: true, lc: ts});
                }

                if (response.indexOf(id) !== -1) {
                    response.splice(response.indexOf(id), 1);
                }

            }

            adapter.log.info('added/updated ' + count + ' variables');

            for (i = 0; i < response.length; i++) {
                adapter.delObject(response[i]);
            }
            adapter.log.info('deleted ' + response.length + ' variables');

            if (adapter.config.polling && adapter.config.pollingInterval > 0) {
                pollingInterval = setInterval(function () {
                    pollVariables();
                    pollProgramms();
                }, adapter.config.pollingInterval * 1000);
            }

            if (typeof callback === 'function') callback();

        });

    });

}

var stopCount = 0;
function stop(callback) {
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

