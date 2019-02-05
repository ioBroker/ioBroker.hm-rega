'use strict';

const path = require('path');
const {tests} = require('@iobroker/testing');

// Run tests
tests.integration(path.join(__dirname, '..'), {
    //            ~~~~~~~~~~~~~~~~~~~~~~~~~
    // This should be the adapter's root directory

    // If the adapter may call process.exit during startup, define here which exit codes are allowed.
    // By default, termination during startup is not allowed.
    allowedExitCodes: [11],
});