# ioBroker HomeMatic ReGaHSS Adapter

Connects HomeMatic CCU "Logic Layer" ("ReGaHSS") to ioBroker

## Purpose

This Adapter can keep HomeMatic-CCU-Variables in sync with ioBroker and offers the possibility to start
HomeMatic-CCU-Programs from ioBroker. Furthermore this adapter can be seen as a migration-helper, you can sync
device/channel-names, rooms, functions and favorites from the CCU to ioBroker (this is one way only, changes on ioBroker
side will be overwritten when synced again - so deactivate this features after the first sync).

## Install

This adapter needs one (ore more) already installed and initialized hm-rpc adapter to work.

### Configuration


## Changelog

### 0.1.2

* Fix common.children in getPrograms

### 0.1.1

* Fix common.name attribute

## Todo

* set connected state
* get initial values for all datapoints on adapter start

## License

The MIT License (MIT)

Copyright (c) 2014 hobbyquaker

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.

