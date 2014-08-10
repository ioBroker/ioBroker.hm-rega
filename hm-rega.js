var adapter = require(__dirname + '/../../lib/adapter.js')({

    name:           'hm-rega',

    objectChange: function (id, obj) {
        adapter.log.debug('objectChange ' + id + ' ' + JSON.stringify(obj));

    },

    stateChange: function (id, state) {

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
var regaPending = 0;
var ccuReachable;
var ccuRegaUp;
var regaStates = {};
var pollingInterval;
var pollingTrigger;

var functionQueue = [];


function main() {

    if (adapter.config.syncVariables) functionQueue.push(getVariables);
    if (adapter.config.syncPrograms) functionQueue.push(getPrograms);
    if (adapter.config.syncNames) functionQueue.push(getDevices);
    if (adapter.config.syncRooms) functionQueue.push(getRooms);
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

    var Rega = require(__dirname + '/lib/rega.js');

    rega = new Rega({
        ccuIp: adapter.config.ip,
        port: adapter.config.port,
        logger: adapter.log,
        ready: function (err) {

            if (err == 'ReGaHSS ' + adapter.config.ip + ' down') {
                adapter.log.error('ReGaHSS down');
                ccuReachable = true;
                ccuRegaUp = false;

            } else if (err == 'CCU unreachable') {

                adapter.log.error('CCU ' + adapter.config.ip + ' unreachable');
                ccuReachable = false;
                ccuRegaUp = false;

            } else {

                adapter.log.info('ReGaHSS ' + adapter.config.ip + ' up');
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
        data = JSON.parse(data);
        for (var id in data) {
            var val = data[id][0];
            if (typeof val === 'string') val = unescape(val);
            regaStates[id] = val;
            var ts = Math.floor((new Date(data[id][1])).getTime() / 1000);
            adapter.setState(id, {val: val, ack: true, lc: ts});
        }
    });
}

function getPrograms(callback) {
    adapter.objects.getObjectView('hm-rega', 'programs', {startkey: 'hm-rega.' + adapter.instance + '.', endkey: 'hm-rega.' + adapter.instance + '.\u9999'}, function (err, doc) {

        // Todo catch errors
        var response = [];
        for (var i = 0; i < doc.rows.length; i++) {
            var id = doc.rows[i].value._id.split('.');
            id = id[id.length - 1];
            response.push(id);
        }
        adapter.log.info('got ' + doc.rows.length + ' programs');

        rega.runScriptFile('programs', function (data) {
            data = JSON.parse(data);
            var count = 0;
            for (var id in data) {
                count += 1;
                adapter.setObject(id, {
                    type: 'channel',
                    common: {
                        name: adapter.namespace + ' Program ' + unescape(data[id].Name),
                        children: [
                            adapter.namesapce + '.' + id + '.ProgramExecute',
                            adapter.namesapce + '.' + id + '.Active'
                        ],
                        enabled: true
                    },
                    native: {
                        Name: unescape(data[id].Name),
                        TypeName: data[id].TypeName,
                        PrgInfo: unescape(data[id].DPInfo)
                    }
                });

                adapter.setObject(id + '.ProgramExecute', {
                    type: 'state',
                    parent: adapter.namespace + '.' + id,
                    common: {
                        name: adapter.namespace + ' Program ' + unescape(data[id].Name)  + ' execute',
                        type: 'boolean',
                        read:   true,
                        write:  true
                    },
                    native: {

                    }
                });
                adapter.setObject(id + '.Active', {
                    type: 'state',
                    parent: adapter.namespace + '.' + id,
                    common: {
                        name: adapter.namespace + ' Program ' + unescape(data[id].Name) + ' enabled',
                        type: 'boolean',
                        read:   true,
                        write:  true
                    },
                    native: {

                    }
                });

                regaStates[id] = unescape(data[id].Value);
                var ts = Math.floor((new Date(data[id].Timestamp)).getTime() / 1000);

                adapter.setState(id + '.ProgramExecute', {val: false, ack: true, lc: ts});
                adapter.setState(id + '.Active', {val: data[id].Active, ack: true});

                if (response.indexOf(id) !== -1) {
                    response.splice(response.indexOf(id), 1);
                }

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
        // Todo Handle Errors
        data = JSON.parse(data);

        var functions = [];

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
                id = id + memberObjs[i].Address;
                members.push(id);
            }

            var name = unescape(data[regaId].Name);
            var desc = unescape(data[regaId].EnumInfo);
            functions.push(adapter.config.enumFunctions + '.' + name);
            adapter.setForeignObject(adapter.config.enumFunctions + '.' + name, {
                desc: desc,
                type: 'enum',
                parent: adapter.config.enumFunctions,
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

        adapter.log.info('added/updated ' + functions.length + ' functions to ' + adapter.config.enumFunctions);

        adapter.setForeignObject(adapter.config.enumFunctions, {
            type: 'enum',
            common: {
                name: 'Functions',
                members: functions
            },
            native: {

            }
        });

        if (typeof callback === 'function') callback();
    });
}

function getRooms(callback) {
    rega.runScriptFile('rooms', function (data) {
        // Todo Handle Errors
        data = JSON.parse(data);

        var rooms = [];

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
                id = id + memberObjs[i].Address;
                members.push(id);
            }

            var name = unescape(data[regaId].Name);
            var desc = unescape(data[regaId].EnumInfo);
            rooms.push(adapter.config.enumRooms + '.' + name);
            adapter.setForeignObject(adapter.config.enumRooms + '.' + name, {
                type: 'enum',
                parent: adapter.config.enumRooms,
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

        adapter.log.info('added/updated ' + rooms.length + ' rooms to ' + adapter.config.enumRooms);

        adapter.setForeignObject(adapter.config.enumRooms, {
            type: 'enum',
            common: {
                name: 'Rooms',
                members: rooms
            },
            native: {

            }
        });

        if (typeof callback === 'function') callback();
    });
}

function getFavorites(callback) {
    rega.runScriptFile('favorites', function (data) {
        // Todo Handle Errors
        data = JSON.parse(data);

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
                parent: adapter.config.enumFavorites,
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
                        id = id + channels[i].Address;
                        members.push(id);

                    }
                }
                c += 1;
                adapter.setForeignObject(adapter.config.enumFavorites + '.' + user + '.' + fav, {
                    type: 'enum',
                    parent: adapter.config.enumFavorites + '.' + user,
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

function getDevices(callback) {

    rega.runScriptFile('devices', function (data) {
        data = JSON.parse(data);
        for (var addr in data) {
            var id;
            switch (data[addr].Interface) {
                case 'BidCos-RF':
                    if (!adapter.config.rfdAdapter) continue;
                    id = adapter.config.rfdAdapter + '.';
                    break;
                case 'BidCos-Wired':
                    if (!adapter.config.hs485dAdapter) continue;
                    id = adapter.config.hs485dAdapter + '.';
                    break;
                case 'CUxD':
                    if (!adapter.config.cuxdAdapter) continue;
                    id = adapter.config.cuxdAdapter + '.';
                    break;
                default:
            }

            id += addr;
            adapter.log.info('extend ' + id + ' {"common":{"name":"' + unescape(data[addr].Name) + '"}}');
            adapter.extendForeignObject(id, {common: {name: unescape(data[addr].Name)}});

        }

        if (typeof callback === 'function') callback();

    });

}

function getVariables(callback) {
    var commonTypes = {
        2:  'boolean',
        4:  'number',
        16: 'number',
        20: 'string'
    };

    adapter.objects.getObjectView('hm-rega', 'variables', {startkey: 'hm-rega.' + adapter.instance + '.', endkey: 'hm-rega.' + adapter.instance + '.\u9999'}, function (err, doc) {
        // Todo catch errors
        var response = [];
        for (var i = 0; i < doc.rows.length; i++) {
            var id = doc.rows[i].value._id.split('.');
            id = id[id.length - 1];
            response.push(id);
        }
        adapter.log.info('got ' + doc.rows.length + ' variables');

        rega.runScriptFile('variables', function (data) {
            data = JSON.parse(data);
            var count = 0;
            for (var id in data) {
                count += 1;
                var obj = {
                    _id: adapter.namespace + '.' + id,
                    type: 'state',
                    common: {
                        name: adapter.namespace + ' Variable ' + unescape(data[id].Name),
                        type:   commonTypes[data[id].ValueType],
                        read:   true,
                        write:  true
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
                if (data[id].ValueMin) obj.common.min = data[id].ValueMin;
                if (data[id].ValueMax) obj.common.min = data[id].ValueMax;
                if (data[id].ValueUnit) obj.common.min = data[id].ValueUnit;
                if (data[id].DPInfo) obj.common.desc = unescape(data[id].DPInfo);
                if (data[id].ValueList) {
                    var statesArr = unescape(data[id].ValueList).split(';');
                    obj.common.states = {};
                    for (var i = 0; i < statesArr.length; i++) {
                        obj.common.states[i] = statesArr[i];
                    }
                    if (data[id].ValueSubType === 29) {
                        obj.common.min = 0;
                        obj.common.max = statesArr.length - 1;
                    }

                }

                adapter.setObject(id, obj);
                var val = data[id].Value;
                if (typeof val === 'string') val = unescape(val);
                regaStates[id] = val;
                var ts = Math.floor((new Date(data[id].Timestamp)).getTime() / 1000);
                adapter.setState(id, {val: val, ack: true, lc: ts});

                if (response.indexOf(id) !== -1) {
                    response.splice(response.indexOf(id), 1);
                }

            }

            adapter.log.info('added/updated ' + count + ' variables');

            for (var i = 0; i < response.length; i++) {
                adapter.delObject(response[i]);
            }
            adapter.log.info('deleted ' + response.length + ' variables');

            if (adapter.config.polling && adapter.config.pollingInterval > 0) {
                pollingInterval = setInterval(function () {
                    pollVariables();
                }, adapter.config.pollingInterval * 1000);
            }

            if (typeof callback === 'function') callback();

        });

    });

}

var firstStop = true;
function stop(callback) {
    if (firstStop) clearInterval(pollingInterval);
    if (rega.pendingRequests > 0) {
        if (firstStop) adapter.log.info('waiting for pending request');
        setTimeout(function () {
            stop(callback);
        }, 500);
    } else {
        callback();
    }
    firstStop = false;
}

